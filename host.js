/**
 * @local/token-usage —— Host 半：词元用量采集、聚合、持久化与 RPC。
 *
 * 架构（方案 §二/§四）：
 *  ① 折叠：ctx.on('session/event') 实时折叠 post-commit 事件；
 *     启动时 sessionQuery.listSessions → readSession 回填（水位幂等，bytes 未变则跳过）；
 *  ② 聚合：stats.js 纯函数，内存态 { day: { modelKey: counts } } 为权威，storage-domain
 *     （token_usage 域，per-record + backup-and-skip）做持久化，去抖 2s 落盘；
 *  ③ RPC：/token-usage-rpc 前缀路由（连接鉴权 + 回环 + 同源栅栏），stats/status/rebuild；
 *  ④ 重建：暂停实时折叠 → 全量清空重扫 → 缓冲补折（水位防双计/漏计）。
 *
 * fork 去重：readSession 的 inheritedEventCount 为继承截断（事件 seq 连续从 1 起），
 * seq ≤ cut 不计 usage；实时路径不受影响——seed/setup 窗口事件从不经 session/event 重发。
 */
import { accumulate, dataSpanOf, foldEvent, rollup, parseDay } from './stats.js'

export const name = 'token-usage'
// connection：RPC 鉴权必需——Context 是严格代理，未 inject 的服务属性访问会抛错
// （open-in-app 同款做法）；web profile 必有该行。
export const inject = ['sessionQuery', 'storageDomain', 'timer', 'connection']

const RPC_PATH = '/token-usage-rpc'
const MAX_BODY_BYTES = 64 * 1024
const FLUSH_DELAY_MS = 2000
const FIELDS = ['input', 'output', 'total', 'cacheRead', 'cacheWrite', 'reasoning', 'msgs', 'attempts', 'summaries']

/** 安全非负整数（存储边界防呆，与 stats.js 同口径）。 */
function isSafeCount(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
}

/** 任意串 → path-safe 键段（per-record 布局键须 [a-zA-Z0-9_-]+）。 */
function enc(s) {
  return Buffer.from(String(s), 'utf8').toString('base64url')
}

/** 日行存储解析：形状错抛出（backup-and-skip），数值漂移自愈为 0（派生数据可重建）。 */
function parseDailyRow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('token-usage: daily row is not an object')
  if (typeof raw.day !== 'string' || !parseDay(raw.day)) throw new Error('token-usage: daily row has bad day')
  if (typeof raw.provider !== 'string' || typeof raw.model !== 'string') throw new Error('token-usage: daily row lacks route')
  const row = { day: raw.day, provider: raw.provider, model: raw.model }
  for (const f of FIELDS) row[f] = isSafeCount(raw[f]) ? raw[f] : 0
  return row
}

/** 水位行存储解析。 */
function parseWatermarkRow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('token-usage: watermark row is not an object')
  if (typeof raw.sessionId !== 'string' || !raw.sessionId) throw new Error('token-usage: watermark row lacks sessionId')
  if (!isSafeCount(raw.seq)) throw new Error('token-usage: watermark row has bad seq')
  const row = { sessionId: raw.sessionId, seq: raw.seq }
  if (raw.route && typeof raw.route === 'object'
    && typeof raw.route.provider === 'string' && raw.route.provider
    && typeof raw.route.model === 'string' && raw.route.model) {
    row.route = { provider: raw.route.provider, model: raw.route.model }
  }
  if (raw.bytes !== undefined) {
    if (!isSafeCount(raw.bytes)) throw new Error('token-usage: watermark row has bad bytes')
    row.bytes = raw.bytes
  }
  return row
}

/**
 * token_usage 域声明（不依赖 storage-domain 包导入——零依赖 bundle；spec 为纯数据，
 * valueSchema 只需 .parse，facility 在读取边界调用）。
 */
const TOKEN_USAGE_DOMAIN = {
  name: 'token_usage',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    daily: { valueSchema: { parse: parseDailyRow } },
    watermark: { valueSchema: { parse: parseWatermarkRow } },
  },
}

/** 日行的存储键：`YYYY-MM-DD-<b64(provider/model)>`（解析无歧义：日键定宽前缀）。 */
function dailyStorageKey(day, modelKey) {
  return day + '-' + enc(modelKey)
}

export function apply(ctx) {
  // ── 内存权威态 ──
  const daily = Object.create(null)        // { day: { modelKey: counts } }
  const watermarks = new Map()             // enc(sessionId) -> { sessionId, seq, route?, bytes? }
  const known = new Set()                  // 本进程已完成回填的 sessionId（实时折叠的前提）
  const buffers = new Map()                // 未回填会话的在途事件缓冲 sessionId -> SessionEvent[]
  let globalBuffer = null                  // 重建期间：所有事件的缓冲（null = 不在重建）
  let backfill = null                      // { done, total } 启动回填进度
  let rebuilding = false
  let hydrated = false                     // 水合完成前不排补扫（防与磁盘水位双计）
  let domain = null
  let storageOk = false
  const dirtyDaily = new Set()             // `${day}\0${modelKey}`
  const dirtyWatermarks = new Set()        // enc(sessionId)
  let flushTimer = null
  let scanChain = Promise.resolve()        // 扫描串行链：启动回填 / 单会话补扫 / 重建

  const dailyTable = () => domain.table('daily')
  const watermarkTable = () => domain.table('watermark')

  function markDirtyDaily(day, modelKey) { dirtyDaily.add(day + '\0' + modelKey) }
  function markDirtyWatermark(key) { dirtyWatermarks.add(key) }

  /** 异步落盘一批脏行。put/delete 在调用时同步入 domain 写链，因此先全部入链再统一等待——
   *  收尾路径据此保证 close() 排空的是已入链的完整一批。 */
  async function flushBatch() {
    if (!domain) return
    const dayRows = [...dirtyDaily]
    const wmRows = [...dirtyWatermarks]
    dirtyDaily.clear()
    dirtyWatermarks.clear()
    if (!dayRows.length && !wmRows.length) return
    const ops = []
    try {
      const dt = dailyTable()
      const wt = watermarkTable()
      for (const k of dayRows) {
        const sep = k.indexOf('\0')
        const day = k.slice(0, sep)
        const modelKey = k.slice(sep + 1)
        const row = daily[day] && daily[day][modelKey]
        if (row) {
          ops.push(dt.put(dailyStorageKey(day, modelKey), {
            day, provider: modelKey.indexOf('/') > 0 ? modelKey.slice(0, modelKey.indexOf('/')) : '',
            model: modelKey.indexOf('/') > 0 ? modelKey.slice(modelKey.indexOf('/') + 1) : modelKey,
            ...row,
          }))
        } else {
          ops.push(dt.delete(dailyStorageKey(day, modelKey)))
        }
      }
      for (const key of wmRows) {
        const row = watermarks.get(key)
        if (row) ops.push(wt.put(key, row))
        else ops.push(wt.delete(key))
      }
    } catch (error) {
      for (const k of dayRows) dirtyDaily.add(k)
      for (const k of wmRows) dirtyWatermarks.add(k)
      ctx.logger.warn('token-usage: flush enqueue failed (will retry): ' + String(error))
      return
    }
    try {
      await Promise.all(ops)
    } catch (error) {
      // 落盘失败只影响持久化；内存权威态完好，重建可纠正。重新标脏等下一轮。
      for (const k of dayRows) dirtyDaily.add(k)
      for (const k of wmRows) dirtyWatermarks.add(k)
      ctx.logger.warn('token-usage: flush failed (will retry): ' + String(error))
    }
  }

  function scheduleFlush() {
    if (flushTimer !== null || !domain) return
    flushTimer = ctx.timeout(() => {
      flushTimer = null
      flushBatch().then(() => {
        if (dirtyDaily.size || dirtyWatermarks.size) scheduleFlush()
      }, (error) => { ctx.logger.warn('token-usage: flush error: ' + String(error)) })
    }, FLUSH_DELAY_MS)
  }

  /** 折叠一条实时事件（已知会话）。 */
  function foldLive(sessionId, event) {
    const key = enc(sessionId)
    const stored = watermarks.get(key)
    if (stored && event.seq <= stored.seq) return
    const fctx = { seq: stored ? stored.seq : 0, cut: 0, route: stored ? stored.route : undefined }
    const hit = foldEvent(fctx, event)
    if (hit) { accumulate(daily, hit); markDirtyDaily(hit.dayKey, hit.modelKey) }
    const next = { sessionId, seq: fctx.seq }
    if (fctx.route) next.route = fctx.route
    if (stored && typeof stored.bytes === 'number') next.bytes = stored.bytes
    watermarks.set(key, next)
    markDirtyWatermark(key)
    scheduleFlush()
  }

  /** 抽干某会话的在途缓冲（回填完成后调用；floor = 水位，天然幂等）。 */
  function drainBuffer(sessionId) {
    const buf = buffers.get(sessionId)
    if (!buf) return
    buffers.delete(sessionId)
    const key = enc(sessionId)
    const stored = watermarks.get(key)
    const fctx = { seq: stored ? stored.seq : 0, cut: 0, route: stored ? stored.route : undefined }
    for (const event of buf) {
      const hit = foldEvent(fctx, event)
      if (hit) { accumulate(daily, hit); markDirtyDaily(hit.dayKey, hit.modelKey) }
    }
    const next = { sessionId, seq: fctx.seq }
    if (fctx.route) next.route = fctx.route
    if (stored && typeof stored.bytes === 'number') next.bytes = stored.bytes
    watermarks.set(key, next)
    markDirtyWatermark(key)
    scheduleFlush()
  }

  /**
   * 回填一个会话：bytes 未变且有水位则跳过（单宿主重启间隙无新事件）；
   * 否则 readSession 全量折叠（水位 + inheritedEventCount 截断防双计/防 fork 重复）。
   */
  async function backfillOne(sessionId, force) {
    if (known.has(sessionId)) return
    const key = enc(sessionId)
    const persistence = ctx.get('sessionPersistence')
    let stat
    if (persistence) {
      try { stat = await persistence.stat(sessionId) } catch { stat = undefined }
    }
    const stored = watermarks.get(key)
    if (!force && stored && stat && typeof stored.bytes === 'number' && stat.sizeBytes === stored.bytes) {
      known.add(sessionId)
      drainBuffer(sessionId)
      return
    }
    const snap = await ctx.sessionQuery.readSession(sessionId)
    const fctx = { seq: stored ? stored.seq : 0, cut: snap.inheritedEventCount || 0, route: stored ? stored.route : undefined }
    for (const event of snap.events) {
      const hit = foldEvent(fctx, event)
      if (hit) { accumulate(daily, hit); markDirtyDaily(hit.dayKey, hit.modelKey) }
    }
    const next = { sessionId, seq: fctx.seq }
    if (fctx.route) next.route = fctx.route
    if (stat && typeof stat.sizeBytes === 'number') next.bytes = stat.sizeBytes
    watermarks.set(key, next)
    markDirtyWatermark(key)
    scheduleFlush()
    // 先记水位再标 known，再抽缓冲：单线程内无交错，不存在空窗。
    known.add(sessionId)
    drainBuffer(sessionId)
  }

  function enqueueScan(job) {
    scanChain = scanChain.then(job, job)
    return scanChain
  }

  /** 启动全量回填（尊重 bytes 快跳，进度可见）。 */
  async function runBootBackfill() {
    let records
    try {
      records = await ctx.sessionQuery.listSessions()
    } catch (error) {
      ctx.logger.warn('token-usage: listSessions failed, backfill skipped: ' + String(error))
      return
    }
    backfill = { done: 0, total: records.length }
    try {
      for (const record of records) {
        const id = record.header.id
        try {
          await enqueueScan(() => backfillOne(id, false))
        } catch (error) {
          // 单会话失败不阻断整体；保持 unknown，下一条实时事件会重排补扫。
          ctx.logger.warn('token-usage: backfill failed for ' + String(id) + ': ' + String(error))
        }
        backfill.done += 1
        await new Promise((resolve) => { ctx.timeout(resolve, 0) })
      }
    } finally {
      backfill = null
      // 快照期间（或 listSessions 失败时）积压的未知会话缓冲：清扫补扫，防止饿死。
      for (const [id, buf] of buffers) {
        if (known.has(id) || !buf.length) { buffers.delete(id); continue }
        enqueueScan(() => backfillOne(id, false)).catch((error) => {
          ctx.logger.warn('token-usage: sweep backfill failed for ' + String(id) + ': ' + String(error))
        })
      }
    }
  }

  /** 重建：清空内存与存储 → 强制全量重扫 → 抽干重建期缓冲。 */
  async function doRebuild() {
    globalBuffer = []
    try {
      for (const day of Object.keys(daily)) delete daily[day]
      watermarks.clear()
      dirtyDaily.clear()
      dirtyWatermarks.clear()
      known.clear()
      if (domain) {
        try {
          const dt = dailyTable()
          for (const [k] of dt.entries()) await dt.delete(k)
          const wt = watermarkTable()
          for (const [k] of wt.entries()) await wt.delete(k)
        } catch (error) {
          ctx.logger.warn('token-usage: rebuild clear failed: ' + String(error))
        }
      }
      let records = []
      try { records = await ctx.sessionQuery.listSessions() } catch (error) {
        ctx.logger.warn('token-usage: rebuild listSessions failed: ' + String(error))
      }
      backfill = { done: 0, total: records.length }
      for (const record of records) {
        const id = record.header.id
        try {
          // 链内直接折叠——此处已在扫描链上，再 enqueueScan 并等待会链头等链尾死锁。
          await backfillOne(id, true)
        } catch (error) {
          ctx.logger.warn('token-usage: rebuild fold failed for ' + String(id) + ': ' + String(error))
        }
        backfill.done += 1
        await new Promise((resolve) => { ctx.timeout(resolve, 0) })
      }
      backfill = null
    } finally {
      const buffered = globalBuffer || []
      globalBuffer = null
      rebuilding = false
      for (const [sessionId, event] of buffered) {
        if (known.has(sessionId)) foldLive(sessionId, event)
        else {
          let b = buffers.get(sessionId)
          if (!b) { b = []; buffers.set(sessionId, b); enqueueScan(() => backfillOne(sessionId, false)).catch(() => {}) }
          b.push(event)
        }
      }
      scheduleFlush()
    }
  }

  // ── 实时折叠入口 ──
  const offEvents = ctx.on('session/event', (session, event) => {
    try {
      const sessionId = session.id
      if (globalBuffer) { globalBuffer.push([sessionId, event]); return }
      if (!known.has(sessionId)) {
        let b = buffers.get(sessionId)
        if (!b) {
          b = []
          buffers.set(sessionId, b)
          // 水合前不排补扫（启动回填会覆盖并抽干这些缓冲），只等回填来取。
          if (hydrated) {
            enqueueScan(() => backfillOne(sessionId, false)).catch((error) => {
              ctx.logger.warn('token-usage: deferred backfill failed: ' + String(error))
            })
          }
        }
        b.push(event)
        return
      }
      foldLive(sessionId, event)
    } catch (error) {
      ctx.logger.warn('token-usage: live fold failed: ' + String(error))
    }
  })

  // ── 持久化域 ──
  // open 重试 + 懒恢复：快速 remove→install 时旧代际的 dom.close() 是异步排空的，
  // 新代际立刻 open 会撞 'already-open'（facility 的 reserved 在 close 完成才释放）。
  // 瞬态失败先在限定窗口内重试；仍失败则内存态照常工作，后续 status/stats 请求
  // 再懒重试 attachStorage（避免"启动时一次性 open、失败即永久内存态"）。
  let storageError = null
  let storageBusy = false
  let bootRan = false
  const storageProbe = { attempts: 0, ghostSeen: 0, reclaimOk: 0, reclaimErr: null }

  function isTransient(error) {
    // DomainError: code='already-open'（连字符），message="... is already open"（空格）——两者都要查，
    // 只查 message 的 includes('already-open') 会永远误判为非瞬态（2026-09-25 实测坑）。
    const code = String((error && error.code) || '')
    const msg = String((error && error.message) || error)
    return code.includes('already-open') || msg.includes('already-open') || msg.includes('already open')
  }

  async function openDomain() {
    let last
    for (let attempt = 0; attempt < 20; attempt++) {
      storageProbe.attempts += 1
      try {
        return await ctx.storageDomain.open(TOKEN_USAGE_DOMAIN)
      } catch (error) {
        last = error
        if (!isTransient(error)) throw error
        // 幽灵域接管：历史 disposer bug（ctx.inject 返回 fiber 被当函数调 → TypeError
        // 中断 close）会让死代际永久占住 reserved。同 facility 是单例，get() 能取到
        // 那个泄漏 handle——close 它释放 reserved，再重试 open。持有者必是死 fiber：
        // 同名 bundle 行唯一，活着的只有本 fiber，而它还没 open 成功。
        try {
          const ghost = ctx.storageDomain.get(TOKEN_USAGE_DOMAIN.name)
          if (ghost) {
            storageProbe.ghostSeen += 1
            await ghost.close()
            storageProbe.reclaimOk += 1
            storageProbe.reclaimErr = null
            continue
          }
          storageProbe.reclaimErr = 'ghost-not-found'
        } catch (closeErr) {
          storageProbe.reclaimErr = String((closeErr && closeErr.message) || closeErr)
        }
        await new Promise((resolve) => { ctx.timeout(resolve, 300) })
      }
    }
    throw last
  }

  /** 磁盘水合进内存（仅冷启动且内存为空时——内存已有回填结果时 hydrate 会双计）。 */
  function hydrateFromDisk() {
    for (const [, row] of dailyTable().entries()) {
      const modelKey = row.provider + '/' + row.model
      let day = daily[row.day]
      if (!day) day = daily[row.day] = Object.create(null)
      let target = day[modelKey]
      if (!target) {
        target = day[modelKey] = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, msgs: 0, attempts: 0, summaries: 0 }
      }
      for (const f of FIELDS) target[f] += row[f]
    }
    for (const [key, row] of watermarkTable().entries()) watermarks.set(key, row)
  }

  /** 内存已有数据时全量标脏：以内存（更新的全量回填结果）覆盖磁盘旧行。 */
  function markAllDirty() {
    for (const day of Object.keys(daily)) {
      for (const modelKey of Object.keys(daily[day])) markDirtyDaily(day, modelKey)
    }
    for (const key of watermarks.keys()) markDirtyWatermark(key)
  }

  /** open + 水合/覆盖，幂等；供启动与懒恢复共用。 */
  async function attachStorage() {
    if (domain || storageBusy) return
    storageBusy = true
    try {
      const dom = await openDomain()
      domain = dom
      storageOk = true
      storageError = null
      const memoryHasData = Object.keys(daily).length > 0
      if (memoryHasData) {
        // 重装竞态路径：内存是刚跑完的全量回填，磁盘是旧代际快照——跳过 hydrate 防双计，
        // 全量标脏让内存覆盖磁盘。水位同理以内存为准（内存水位 ≥ 磁盘水位）。
        markAllDirty()
      } else {
        try {
          hydrateFromDisk()
        } catch (error) {
          ctx.logger.warn('token-usage: hydrate failed (storage discarded, rebuild available): ' + String(error))
          for (const day of Object.keys(daily)) delete daily[day]
          watermarks.clear()
        }
      }
      scheduleFlush()
    } catch (error) {
      storageOk = false
      storageError = String((error && error.message) || error)
      ctx.logger.error('token-usage: storage domain unavailable, running memory-only (will retry): ' + String(error))
    } finally {
      storageBusy = false
      hydrated = true
      // 回填只跑一次：懒恢复成功时也不重跑（backfillOne 对 known 会话早退，但进度条会重置）。
      if (!bootRan) {
        bootRan = true
        void runBootBackfill()
      }
    }
  }

  const ready = attachStorage()

  // ── RPC 路由 ──
  function sendJson(res, status, payload) {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  }

  function normDay(value) {
    if (value === undefined || value === null || value === '') return undefined
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !parseDay(value)) return null
    return value
  }

  async function dispatch(body) {
    // 等水合完成：stats/status 读到的是磁盘水位对齐后的权威态，而不是空壳。
    await ready
    // 懒恢复：启动时 open 撞 already-open 失败的，后续请求再试（旧代际 close 此刻多半已排空）。
    if (!domain && !storageBusy) await attachStorage()
    const action = body && typeof body.action === 'string' ? body.action : ''
    const args = body && body.args && typeof body.args === 'object' ? body.args : {}
    if (action === 'stats') {
      const fromDay = normDay(args.fromDay)
      const toDay = normDay(args.toDay)
      if (fromDay === null || toDay === null) return { ok: false, error: 'bad date' }
      const result = rollup(daily, { granularity: String(args.granularity || 'day'), fromDay, toDay })
      return { ok: true, data: { ...result, generatedAt: Date.now() } }
    }
    if (action === 'status') {
      return { ok: true, data: { backfill, rebuilding, storageOk, storageError, storageProbe, dataSpan: dataSpanOf(daily), generatedAt: Date.now() } }
    }
    if (action === 'rebuild') {
      if (rebuilding) return { ok: true, data: { started: false } }
      rebuilding = true
      // doRebuild 自身作为链上 job 执行（其内部已改为直接折叠，不再自排链）。
      enqueueScan(doRebuild).catch((error) => {
        rebuilding = false
        globalBuffer = null
        ctx.logger.error('token-usage: rebuild crashed: ' + String(error))
      })
      return { ok: true, data: { started: true } }
    }
    return { ok: false, error: 'unknown action: ' + action }
  }

  const offRoute = ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: RPC_PATH,
      handler: async (req, res) => {
        // 连接鉴权（与 open-in-app 同款：cookie/token 校验，401/403 直接终止）
        const connection = Reflect.get(ctx, 'connection')
        if (connection && typeof connection.requestRejection === 'function') {
          const rejection = connection.requestRejection(req)
          if (rejection) { res.statusCode = rejection; res.end(); return }
        }
        // 回环 Host + 同源 Origin 栅栏（防 DNS rebinding / 跨站 CSRF）
        const hostHeader = String(req.headers.host || '')
        const origin = req.headers.origin ? String(req.headers.origin) : ''
        const hostName = hostHeader.replace(/:\d+$/, '')
        const loopback = hostName === '127.0.0.1' || hostName === 'localhost' || hostName === '[::1]' || hostName === '::1'
        if (!loopback) { res.statusCode = 403; res.end('forbidden'); return }
        if (origin && origin !== 'http://' + hostHeader && origin !== 'https://' + hostHeader) {
          res.statusCode = 403; res.end('forbidden'); return
        }
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('allow', 'POST')
          res.end()
          return
        }
        const essence = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase()
        if (essence !== 'application/json') { sendJson(res, 415, { ok: false, error: 'content-type must be application/json' }); return }
        const chunks = []
        let size = 0
        let tooLarge = false
        try {
          for await (const chunk of req) {
            size += chunk.length
            if (size > MAX_BODY_BYTES) { tooLarge = true; break }
            chunks.push(chunk)
          }
        } catch {
          sendJson(res, 400, { ok: false, error: 'bad body' })
          return
        }
        if (tooLarge) { sendJson(res, 413, { ok: false, error: 'body too large' }); return }
        let body
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { body = null }
        if (body === null || typeof body !== 'object') { sendJson(res, 400, { ok: false, error: 'bad json' }); return }
        try {
          const result = await dispatch(body)
          sendJson(res, 200, result)
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }), 'token-usage: rpc route')
  })

  // ── 生命周期 ──
  // 逐 step 隔离 + close 优先：历史上 `offRoute()`（ctx.inject 返回的是 fiber，
  // 不是函数）抛 TypeError 中断了整个 disposer，dom.close() 永不执行 → reserved
  // 泄漏 → 后续代际 already-open。子 fiber 由父 ctx dispose 级联清理，无需手动调。
  void ready
  return () => {
    if (domain) {
      const dom = domain
      domain = null
      // flushBatch 首个 await 之前同步完成「标脏清点 + 全部 put/delete 入写链」，
      // 随后 close() 排空已入链的整批——顺序不可倒置。
      try { void flushBatch() } catch { /* ignore */ }
      try {
        void dom.close().catch((error) => { ctx.logger.warn('token-usage: domain close failed: ' + String(error)) })
      } catch (error) { ctx.logger.warn('token-usage: domain close threw: ' + String(error)) }
    }
    if (flushTimer !== null) { try { flushTimer() } catch { /* ignore */ } flushTimer = null }
    try { offEvents() } catch { /* ignore */ }
    // offRoute 是 ctx.inject 的 fiber（非函数），不手动调用——父 ctx dispose 时级联清理。
  }
}
