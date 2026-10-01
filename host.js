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
import { statSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { accumulate, dataSpanOf, foldEvent, rollup, parseDay, normalizePriceTable, addDays, dayKeyOf } from './stats.js'

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
  let orphanSessions = 0                   // 水位里「日志已不存在」的会话数（重建前提示用）
  let rebuilding = false
  let hydrated = false                     // 水合完成前不排补扫（防与磁盘水位双计）
  let domain = null
  let storageOk = false
  const dirtyDaily = new Set()             // `${day}\0${modelKey}`
  const dirtyWatermarks = new Set()        // enc(sessionId)
  let flushTimer = null
  let scanChain = Promise.resolve()        // 扫描串行链：启动回填 / 单会话补扫 / 重建

  const dailyTable = (handle = domain) => handle.table('daily')
  const watermarkTable = (handle = domain) => handle.table('watermark')

  function markDirtyDaily(day, modelKey) { dirtyDaily.add(day + '\0' + modelKey) }
  function markDirtyWatermark(key) { dirtyWatermarks.add(key) }

  /** 异步落盘一批脏行。put/delete 在调用时同步入 domain 写链，因此先全部入链再统一等待——
   *  收尾路径据此保证 close() 排空的是已入链的完整一批。
   *  @param handle - 目标域；缺省用当前 domain。卸载路径必须在 domain 置空之前显式传入，
   *                  否则 `if (!handle) return` 会让最后一次落盘变成空操作（v1.0.0 的 bug）。 */
  async function flushBatch(handle = domain) {
    if (!handle) return
    const dayRows = [...dirtyDaily]
    const wmRows = [...dirtyWatermarks]
    dirtyDaily.clear()
    dirtyWatermarks.clear()
    if (!dayRows.length && !wmRows.length) return
    const ops = []
    try {
      const dt = dailyTable(handle)
      const wt = watermarkTable(handle)
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

  // ── 回填健壮性（v1.2.0）：失败退避重试 + 缓冲上限 ──
  // v1.1.x 的坑：缓冲只在「首次创建」时排一次回填，失败后不再重试——坏会话的事件只堆不折、无上限。
  // 关键事实：缓冲里的事件是日志里已有内容的副本，backfillOne 会从日志全量重折叠（floor=水位），
  // 所以**丢缓冲不丢数据**（前提是回填最终成功），据此设上限是安全的。
  const BUFFER_LIMIT = 2000
  const BACKFILL_RETRY_MS = [2000, 8000, 30000, 120000]
  const backfillBusy = new Set()        // 已排队/在跑的会话（去重）
  const backfillFails = new Map()       // sessionId -> 尝试次数
  let bufferedDropped = 0

  /** 排一次会话回填：去重 + 失败退避重试（超限后放弃并明确记日志）。 */
  function scheduleBackfill(sessionId) {
    if (known.has(sessionId) || backfillBusy.has(sessionId)) return
    backfillBusy.add(sessionId)
    enqueueScan(() => backfillOne(sessionId, false)).then(() => {
      backfillBusy.delete(sessionId)
      backfillFails.delete(sessionId)
    }, (error) => {
      backfillBusy.delete(sessionId)
      const attempts = (backfillFails.get(sessionId) || 0) + 1
      backfillFails.set(sessionId, attempts)
      ctx.logger.warn('token-usage: backfill failed for ' + String(sessionId) + ' (attempt ' + attempts + '): ' + String(error))
      if (attempts <= BACKFILL_RETRY_MS.length) {
        const delay = BACKFILL_RETRY_MS[Math.min(attempts - 1, BACKFILL_RETRY_MS.length - 1)]
        ctx.timeout(() => scheduleBackfill(sessionId), delay)
      } else {
        ctx.logger.error('token-usage: giving up backfill for ' + String(sessionId) + ' after ' + attempts
          + ' attempts — its live events stay buffered (cap ' + BUFFER_LIMIT + '); use Rebuild to retry')
      }
    })
  }

  /** 未回填会话的缓冲水位（诊断用）。 */
  function bufferStats() {
    let events = 0
    for (const [, buf] of buffers) events += buf.length
    return { sessions: buffers.size, events, dropped: bufferedDropped, failed: backfillFails.size }
  }

  /** 当前存储里「日志已不存在」的会话数（= 历史里不可重建的部分）。 */
  function orphansFrom(records) {
    const alive = new Set(records.map((r) => r.header.id))
    let orphans = 0
    for (const [, row] of watermarks) if (!alive.has(row.sessionId)) orphans += 1
    return orphans
  }

  async function countOrphanSessions() {
    try {
      return orphansFrom(await ctx.sessionQuery.listSessions())
    } catch (error) {
      ctx.logger.warn('token-usage: orphan scan failed (treated as 0): ' + String(error))
      return 0
    }
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
    orphanSessions = orphansFrom(records)
    try {
      for (const record of records) {
        const id = record.header.id
        try {
          await enqueueScan(() => backfillOne(id, false))
        } catch (error) {
          // 单会话失败不阻断整体；登记失败交由退避重试 / 收尾清扫。
          backfillFails.set(id, (backfillFails.get(id) || 0) + 1)
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
        scheduleBackfill(id)
      }
      // 主循环里折过的失败会话（没有缓冲的也要给机会）
      for (const id of backfillFails.keys()) scheduleBackfill(id)
      // 保留期清理（默认关闭）在回填之后跑一次
      try { pruneByRetention() } catch (error) { ctx.logger.warn('token-usage: retention prune failed: ' + String(error)) }
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
          if (!b) { b = []; buffers.set(sessionId, b); scheduleBackfill(sessionId) }
          pushBuffered(sessionId, b, event)
        }
      }
      scheduleFlush()
    }
  }

  // ── 实时折叠入口 ──
  /** 往未回填会话的缓冲里塞事件；超上限丢最旧（缓冲只是日志的副本，回填会从日志重折叠）。 */
  function pushBuffered(sessionId, buf, event) {
    if (buf.length >= BUFFER_LIMIT) {
      buf.shift()
      bufferedDropped += 1
      if (bufferedDropped === 1 || bufferedDropped % 500 === 0) {
        ctx.logger.warn('token-usage: buffer for ' + String(sessionId) + ' hit the ' + BUFFER_LIMIT
          + '-event cap; dropping oldest (total dropped ' + bufferedDropped + ') — backfill will refold from the log')
      }
    }
    buf.push(event)
  }

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
          if (hydrated) scheduleBackfill(sessionId)
        }
        pushBuffered(sessionId, b, event)
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

  // ── 价目表（可选，v1.1.0）：用户自备 JSON，插件**不内置任何价格** ──
  // 路径 ~/.dsh/token-usage-prices.json（DSH_HOME 可覆盖）。单价单位 = 每百万 token，
  // 币种取自表里的 currency。没有文件/表为空 = 未配置 → 界面不显示金额（不猜、不用别人的价）。
  const PRICES_PATH = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'token-usage-prices.json')
  let prices = null          // normalizePriceTable 结果；null = 未配置
  let pricesText = ''        // 文件原文（供面板编辑器回显）
  let pricesError = null     // 面向用户的解析错误
  let pricesSig = '\u0000unloaded'

  function pricesInfo() {
    return {
      path: PRICES_PATH,
      configured: !!prices,
      exists: pricesText !== '',
      currency: prices ? prices.currency : null,
      models: prices ? Object.keys(prices.models).length : 0,
      hasDefault: !!(prices && prices.default),
      error: pricesError,
    }
  }

  /** 读价目表（按 mtime+长度做签名，未变则跳过；force 用于保存后强制重读）。 */
  function readPrices(force) {
    let raw = null
    let mtime = -1
    try {
      mtime = statSync(PRICES_PATH).mtimeMs
      raw = readFileSync(PRICES_PATH, 'utf8')
    } catch {
      raw = null
    }
    const sig = raw === null ? 'missing' : mtime + ':' + raw.length
    if (!force && sig === pricesSig) return
    pricesSig = sig
    pricesText = raw === null ? '' : raw
    pricesError = null
    if (raw === null || !raw.trim()) { prices = null; return }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      prices = null
      pricesError = 'JSON 解析失败：' + String((error && error.message) || error)
      return
    }
    prices = normalizePriceTable(parsed)
    if (!prices) pricesError = '表里没有可用价格：需要 models{"provider/model":{input,output}} 或 default{input,output}（单位=每百万 token）'
  }

  // ── 配置文件（v1.3.0）：~/.dsh/token-usage-config.json，面板内可编辑 ──
  // 保持零依赖：不走插件 Config schema（那要 import 宿主包，桌面 asar 形态下得额外 pnpm 装依赖），
  // 与价目表同款——用户可读可改的 JSON 文件。
  const CONFIG_PATH = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'token-usage-config.json')
  const CONFIG_DEFAULTS = { refreshSeconds: 60, budget: { daily: 0, monthly: 0 }, retentionDays: 0 }
  let config = normalizeConfig(null)
  let configText = ''
  let configError = null
  let configSig = '\u0000unloaded'

  function clampNumber(v, min, max, fallback) {
    return (typeof v === 'number' && Number.isFinite(v)) ? Math.min(max, Math.max(min, Math.round(v))) : fallback
  }

  /** 归一化配置：越界/非法一律取默认（配置写坏了插件也得照常跑）。 */
  function normalizeConfig(raw) {
    const base = { ...CONFIG_DEFAULTS, budget: { ...CONFIG_DEFAULTS.budget } }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base
    base.refreshSeconds = clampNumber(raw.refreshSeconds, 15, 3600, CONFIG_DEFAULTS.refreshSeconds)
    base.retentionDays = clampNumber(raw.retentionDays, 0, 3650, CONFIG_DEFAULTS.retentionDays)
    const b = (raw.budget && typeof raw.budget === 'object' && !Array.isArray(raw.budget)) ? raw.budget : {}
    for (const k of ['daily', 'monthly']) {
      const v = b[k]
      base.budget[k] = (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? v : 0
    }
    return base
  }

  function configInfo() {
    return { path: CONFIG_PATH, exists: configText !== '', error: configError, ...config }
  }

  /** 读配置（mtime+长度签名缓存；force 用于保存后强制重读）。 */
  function readConfig(force) {
    let raw = null
    let mtime = -1
    try {
      mtime = statSync(CONFIG_PATH).mtimeMs
      raw = readFileSync(CONFIG_PATH, 'utf8')
    } catch {
      raw = null
    }
    const sig = raw === null ? 'missing' : mtime + ':' + raw.length
    if (!force && sig === configSig) return
    configSig = sig
    configText = raw === null ? '' : raw
    configError = null
    if (raw === null || !raw.trim()) { config = normalizeConfig(null); return }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      config = normalizeConfig(null)
      configError = 'JSON 解析失败，已回落默认值：' + String((error && error.message) || error)
      return
    }
    config = normalizeConfig(parsed)
  }

  /** 保留期清理（默认关闭；只删本地聚合行，事实源是会话日志，重建永远能长回来）。 */
  function pruneByRetention() {
    const days = config.retentionDays
    if (!days) return 0
    const cutoff = addDays(dayKeyOf(Date.now()), -days)
    if (!cutoff) return 0
    let removed = 0
    for (const day of Object.keys(daily)) {
      if (day >= cutoff) continue
      for (const modelKey of Object.keys(daily[day])) markDirtyDaily(day, modelKey)
      delete daily[day]
      removed += 1
    }
    if (removed) {
      ctx.logger.warn('token-usage: retention ' + days + 'd pruned ' + removed + ' day bucket(s) older than ' + cutoff)
      scheduleFlush()
    }
    return removed
  }

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
      readPrices(false)
      const result = rollup(daily, { granularity: String(args.granularity || 'day'), fromDay, toDay, prices: prices || undefined })
      return { ok: true, data: { ...result, prices: pricesInfo(), generatedAt: Date.now() } }
    }
    if (action === 'status') {
      readPrices(false)
      readConfig(false)
      return { ok: true, data: { backfill, rebuilding, storageOk, storageError, storageProbe, dataSpan: dataSpanOf(daily), prices: pricesInfo(), config: configInfo(), buffers: bufferStats(), orphanSessions, generatedAt: Date.now() } }
    }
    if (action === 'config') {
      readConfig(false)
      return { ok: true, data: { ...configInfo(), text: configText } }
    }
    if (action === 'config.save') {
      const text = typeof body.text === 'string' ? body.text : (typeof args.text === 'string' ? args.text : '')
      if (text.length > MAX_BODY_BYTES) return { ok: false, error: '配置过大（>64KB）' }
      const trimmed = text.trim()
      if (trimmed && trimmed !== '{}') {
        try { JSON.parse(trimmed) } catch (error) {
          return { ok: false, error: 'JSON 解析失败：' + String((error && error.message) || error) }
        }
      }
      try {
        if (!trimmed || trimmed === '{}') {
          try { unlinkSync(CONFIG_PATH) } catch { /* 本来就没有 */ }
        } else {
          const tmp = CONFIG_PATH + '.tmp'
          writeFileSync(tmp, text, 'utf8')
          renameSync(tmp, CONFIG_PATH)
        }
      } catch (error) {
        return { ok: false, error: '写入失败：' + String((error && error.message) || error) }
      }
      configSig = '\u0000unloaded'
      readConfig(true)
      const pruned = pruneByRetention()
      return { ok: true, data: { ...configInfo(), text: configText, prunedDays: pruned } }
    }
    if (action === 'summary') {
      // 预算要用「今天 / 本月」的口径，与当前面板区间无关
      readPrices(false)
      readConfig(false)
      const today = dayKeyOf(Date.now())
      const monthStart = today.slice(0, 7) + '-01'
      const dayRollup = rollup(daily, { granularity: 'day', fromDay: today, toDay: today, prices: prices || undefined })
      const monthRollup = rollup(daily, { granularity: 'day', fromDay: monthStart, toDay: today, prices: prices || undefined })
      return {
        ok: true,
        data: {
          day: today,
          today: { totals: dayRollup.totals, cost: dayRollup.cost || null },
          month: { fromDay: monthStart, totals: monthRollup.totals, cost: monthRollup.cost || null },
          budget: { ...config.budget, currency: prices ? prices.currency : null },
          generatedAt: Date.now(),
        },
      }
    }
    if (action === 'prices') {
      readPrices(false)
      return { ok: true, data: { ...pricesInfo(), text: pricesText } }
    }
    if (action === 'prices.save') {
      const text = typeof body.text === 'string' ? body.text : (typeof args.text === 'string' ? args.text : '')
      if (text.length > MAX_BODY_BYTES) return { ok: false, error: '价格表过大（>64KB）' }
      const trimmed = text.trim()
      if (trimmed && trimmed !== '{}') {
        let parsed
        try { parsed = JSON.parse(trimmed) } catch (error) {
          return { ok: false, error: 'JSON 解析失败：' + String((error && error.message) || error) }
        }
        if (!normalizePriceTable(parsed)) {
          return { ok: false, error: '没有可用价格：需要 models{"provider/model":{input,output}} 或 default{input,output}（单位=每百万 token）' }
        }
      }
      try {
        if (!trimmed || trimmed === '{}') {
          try { unlinkSync(PRICES_PATH) } catch { /* 本来就没有 */ }
        } else {
          const tmp = PRICES_PATH + '.tmp'
          writeFileSync(tmp, text, 'utf8')
          renameSync(tmp, PRICES_PATH)   // 原子替换，防写坏半个文件
        }
      } catch (error) {
        return { ok: false, error: '写入失败：' + String((error && error.message) || error) }
      }
      pricesSig = '\u0000unloaded'
      readPrices(true)
      return { ok: true, data: { ...pricesInfo(), text: pricesText } }
    }
    if (action === 'rebuild') {
      if (rebuilding) return { ok: true, data: { started: false } }
      // v1.2.0 防呆：存储里有「日志已不存在」的历史时，先要一次显式确认——
      // rebuild 会清空存储并只重扫现存日志，那部分历史将永久消失（不可重建）。
      if (args.confirm !== true) {
        const orphans = await countOrphanSessions()
        if (orphans > 0) {
          return { ok: true, data: { started: false, needsConfirm: true, orphanSessions: orphans } }
        }
      }
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
        // 请求事实（诊断用；**不回显 cookie 值**，只回有无）
        const seen = {
          host: String((req.headers && req.headers.host) || ''),
          origin: String((req.headers && req.headers.origin) || ''),
          site: String((req.headers && req.headers['sec-fetch-site']) || ''),
          cookie: /(?:^|;\s*)dsh-auth-/.test(String((req.headers && req.headers.cookie) || '')) ? 'present' : 'missing',
        }
        // 连接鉴权（与 open-in-app 同款：cookie/token 校验）。宿主是信任判定的**唯一权威**。
        const connection = Reflect.get(ctx, 'connection')
        if (connection && typeof connection.requestRejection === 'function') {
          const rejection = connection.requestRejection(req)
          if (rejection) {
            sendJson(res, rejection, {
              ok: false,
              error: rejection === 401 ? 'unauthenticated' : 'untrusted request',
              hint: rejection === 401
                ? '缺少/失效的 dsh-auth-* cookie：请从桌面 App 内访问（浏览器直连需带 token 换 cookie），然后硬刷新页面'
                : 'Host/Origin 未通过宿主信任判定：请从本机 127.0.0.1 访问，不要用外部域名或伪造来源',
              seen,
            })
            return
          }
        }
        // 自办栅栏仅作兜底（composition 里没有 connection 服务时）——桌面壳转发会剥掉 Origin，
        // 所以这里只认「Host 是回环」+「带 Origin 时必须同源」。
        const hostName = seen.host.replace(/:\d+$/, '')
        const loopback = hostName === '127.0.0.1' || hostName === 'localhost' || hostName === '[::1]' || hostName === '::1'
        if (!loopback) {
          sendJson(res, 403, { ok: false, error: 'untrusted host', hint: 'Host 不是回环地址（127.0.0.1/localhost）', seen })
          return
        }
        if (seen.origin && seen.origin !== 'http://' + seen.host && seen.origin !== 'https://' + seen.host) {
          sendJson(res, 403, { ok: false, error: 'cross-origin', hint: 'Origin 与 Host 不同源', seen })
          return
        }
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          sendJson(res, 405, { ok: false, error: 'method not allowed', hint: '本路由只接受 POST（application/json）', seen })
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
      // 先把这一拍脏行同步入链（flushBatch 首个 await 之前完成「标脏清点 + 全部 put/delete」），
      // 再 close() 排空整批——顺序不可倒置。句柄显式传入：v1.0.0 先置空 domain 再调 flushBatch()，
      // 撞上 `if (!handle) return` 直接空转，最后一次落盘从未发生。
      try { void flushBatch(dom) } catch { /* ignore */ }
      domain = null
      try {
        void dom.close().catch((error) => { ctx.logger.warn('token-usage: domain close failed: ' + String(error)) })
      } catch (error) { ctx.logger.warn('token-usage: domain close threw: ' + String(error)) }
    }
    if (flushTimer !== null) { try { flushTimer() } catch { /* ignore */ } flushTimer = null }
    try { offEvents() } catch { /* ignore */ }
    // offRoute 是 ctx.inject 的 fiber（非函数），不手动调用——父 ctx dispose 时级联清理。
  }
}
