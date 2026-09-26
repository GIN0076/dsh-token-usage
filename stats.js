/**
 * @local/token-usage —— 纯聚合函数（Host 与 node 夹具共用，零依赖）。
 *
 * 口径（方案 §三）：
 *  - 计费事件：assistant/message（data.usage 或流末 usage chunk，路由取 message.source）、
 *    assistant/attempt（流末 usage chunk，路由取会话最近 request/header）、
 *    compaction/summary（data.usage，路由同上，无路由归 compaction/unknown）；
 *  - 非法计数整体跳过（与 token-meter fail-closed 一致）：计数须为安全非负整数、
 *    reasoning ≤ output、totalTokens 须与已知桶自洽；
 *  - 事件时间落本地日桶；周桶 = 周一起始；月桶 = 自然月；
 *  - fork 继承前缀：事件 seq ≤ inheritedEventCount 跳过折叠（水位仍推进）。
 */

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const MONTH_RE = /^(\d{4})-(\d{2})$/

/** 安全非负整数计数判定。 */
export function isSafeCount(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
}

function pad2(n) { return (n < 10 ? '0' : '') + n }

/** 'YYYY-MM-DD' → 本地 Date（非法返回 null）。 */
export function parseDay(day) {
  const m = typeof day === 'string' ? DAY_RE.exec(day) : null
  if (!m) return null
  const y = +m[1], mo = +m[2], d = +m[3]
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  const date = new Date(y, mo - 1, d)
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null
  return date
}

/** Date → 'YYYY-MM-DD'（本地）。 */
export function formatDay(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
}

/** epoch ms → 本地日键。 */
export function dayKeyOf(ms) {
  const d = new Date(ms)
  return Number.isFinite(ms) ? formatDay(d) : null
}

/** 'YYYY-MM-DD' ± n 天 → 新日键（非法输入返回 null）。 */
export function addDays(day, n) {
  const d = parseDay(day)
  if (!d) return null
  d.setDate(d.getDate() + n)
  return formatDay(d)
}

/** 'YYYY-MM-DD' → 所在周的周一日键（周一为一周之始）。 */
export function mondayKeyOf(day) {
  const d = parseDay(day)
  if (!d) return null
  const back = (d.getDay() + 6) % 7 // 周一=0 … 周日=6
  d.setDate(d.getDate() - back)
  return formatDay(d)
}

/** 'YYYY-MM-DD' → 'YYYY-MM'。 */
export function monthKeyOf(day) {
  return typeof day === 'string' && DAY_RE.test(day) ? day.slice(0, 7) : null
}

/** epoch ms → 按粒度的桶键。 */
export function bucketKeyOf(ms, granularity) {
  const day = dayKeyOf(ms)
  if (!day) return null
  if (granularity === 'week') return mondayKeyOf(day)
  if (granularity === 'month') return monthKeyOf(day)
  return day
}

/**
 * 归一化 usage：非法整体返回 null（fail-closed）。
 * totalTokens 缺省时按 knownPrompt + output 推导（桶缺省视为 0）。
 * @returns {{input:number, output:number, total:number, cacheRead:number, cacheWrite:number, reasoning:number} | null}
 */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens } = usage
  if (!isSafeCount(inputTokens) || !isSafeCount(outputTokens)) return null
  if (cacheReadTokens !== undefined && !isSafeCount(cacheReadTokens)) return null
  if (cacheWriteTokens !== undefined && !isSafeCount(cacheWriteTokens)) return null
  if (reasoningTokens !== undefined && (!isSafeCount(reasoningTokens) || reasoningTokens > outputTokens)) return null

  const knownPrompt = inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
  if (!isSafeCount(knownPrompt)) return null

  let total
  if (totalTokens !== undefined) {
    if (!isSafeCount(totalTokens)) return null
    const exactPrompt = totalTokens - outputTokens
    if (!isSafeCount(exactPrompt) || exactPrompt < knownPrompt) return null
    // 两个缓存桶都在场时 total 必须严格自洽（与 token-meter 一致）。
    if (cacheReadTokens !== undefined && cacheWriteTokens !== undefined && exactPrompt !== knownPrompt) return null
    total = totalTokens
  } else {
    total = knownPrompt + outputTokens
    if (!isSafeCount(total)) return null
  }

  return {
    input: inputTokens,
    output: outputTokens,
    total,
    cacheRead: cacheReadTokens ?? 0,
    cacheWrite: cacheWriteTokens ?? 0,
    reasoning: reasoningTokens ?? 0,
  }
}

/** 从 assistant 流记录里取最后一份 usage chunk（压缩记录为 {type:'chunk', chunk}）。 */
export function lastStreamUsage(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let i = stream.length - 1; i >= 0; i--) {
    const rec = stream[i]
    if (rec && rec.type === 'chunk' && rec.chunk && rec.chunk.type === 'usage') return rec.chunk.usage
  }
  return undefined
}

/** 空计数行。 */
export function emptyCounts() {
  return {
    input: 0, output: 0, total: 0,
    cacheRead: 0, cacheWrite: 0, reasoning: 0,
    msgs: 0, attempts: 0, summaries: 0,
  }
}

/**
 * 单条命中累加进 day → model → counts 结构。
 * @param daily - 可变聚合体 { [dayKey]: { [modelKey]: counts } }。
 * @param hit - foldEvent 的返回（dayKey/modelKey/usage/kind）。
 */
export function accumulate(daily, hit) {
  let day = daily[hit.dayKey]
  if (!day) day = daily[hit.dayKey] = {}
  let row = day[hit.modelKey]
  if (!row) row = day[hit.modelKey] = emptyCounts()
  const u = hit.usage
  row.input += u.input
  row.output += u.output
  row.total += u.total
  row.cacheRead += u.cacheRead
  row.cacheWrite += u.cacheWrite
  row.reasoning += u.reasoning
  if (hit.kind === 'msg') row.msgs += 1
  else if (hit.kind === 'attempt') row.attempts += 1
  else if (hit.kind === 'summary') row.summaries += 1
}

/**
 * 折叠一条事件进会话水位上下文。
 *
 * ctx（原地更新）：{ seq: 已见最高 seq, cut: fork 继承截断 seq, route: 最近 header 路由 }。
 * 水位推进与 usage 折叠解耦：seq ≤ max(seq, cut) 的事件不计 usage（继承前缀防双计），
 * 但 request/header / request/context 的路由始终跟踪（继承前缀里的路由也要跟上）。
 *
 * @param ctx - 会话折叠上下文（可变）。
 * @param event - 一条 SessionEvent。
 * @returns usage 命中 { dayKey, modelKey, usage, kind }，无 usage 返回 null。
 */
export function foldEvent(ctx, event) {
  if (!event || typeof event.seq !== 'number' || !Number.isSafeInteger(event.seq) || event.seq < 0) return null
  const watermark = isSafeCount(ctx.seq) ? ctx.seq : 0
  const cut = isSafeCount(ctx.cut) ? ctx.cut : 0
  if (event.seq > ctx.seq) ctx.seq = event.seq
  const floor = Math.max(watermark, cut)
  const data = event.data

  // 路由跟踪：无条件处理（继承前缀内的 header 也参与，保证截断后的路由正确）。
  if (event.type === 'request/header') {
    const c = data && data.header && data.header.config
    if (c && typeof c.provider === 'string' && c.provider && typeof c.model === 'string' && c.model) {
      ctx.route = { provider: c.provider, model: c.model }
    }
    return null
  }
  if (event.type === 'request/context') {
    if (data && typeof data.provider === 'string' && data.provider && typeof data.model === 'string' && data.model) {
      ctx.route = { provider: data.provider, model: data.model }
    }
    return null
  }

  if (event.seq <= floor) return null

  const dayKey = dayKeyOf(event.time)
  if (!dayKey) return null
  const routeKey = (route) => route ? route.provider + '/' + route.model : null

  if (event.type === 'assistant/message') {
    const usage = normalizeUsage(data && data.usage) ?? normalizeUsage(lastStreamUsage(data && data.stream))
    if (!usage) return null
    const src = data && data.message && data.message.source
    const route = (src && typeof src.provider === 'string' && src.provider && typeof src.model === 'string' && src.model)
      ? { provider: src.provider, model: src.model }
      : ctx.route
    return { dayKey, modelKey: routeKey(route) ?? 'unknown/unknown', usage, kind: 'msg' }
  }
  if (event.type === 'assistant/attempt') {
    const usage = normalizeUsage(lastStreamUsage(data && data.stream))
    if (!usage) return null
    return { dayKey, modelKey: routeKey(ctx.route) ?? 'unknown/unknown', usage, kind: 'attempt' }
  }
  if (event.type === 'compaction/summary') {
    const usage = normalizeUsage(data && data.usage)
    if (!usage) return null
    return { dayKey, modelKey: routeKey(ctx.route) ?? 'compaction/unknown', usage, kind: 'summary' }
  }
  return null
}

/** 聚合体的数据跨度（最小/最大日键）；空返回 null。 */
export function dataSpanOf(daily) {
  const keys = Object.keys(daily || {})
  if (!keys.length) return null
  keys.sort()
  return { minDay: keys[0], maxDay: keys[keys.length - 1] }
}

/**
 * 生成 [fromDay, toDay] 覆盖的连续桶键（含空桶，保证折线连续）。
 * @throws RangeError 桶数超过 5000（防呆）。
 */
export function bucketKeysBetween(granularity, fromDay, toDay) {
  const keys = []
  if (granularity === 'month') {
    let y = +fromDay.slice(0, 4), m = +fromDay.slice(5, 7)
    const ey = +toDay.slice(0, 4), em = +toDay.slice(5, 7)
    while (y < ey || (y === ey && m <= em)) {
      keys.push(y + '-' + pad2(m))
      m += 1
      if (m > 12) { m = 1; y += 1 }
      if (keys.length > 5000) throw new RangeError('token-usage: range too large')
    }
    return keys
  }
  if (granularity === 'week') {
    let cur = mondayKeyOf(fromDay)
    const end = mondayKeyOf(toDay)
    while (cur && end && cur <= end) {
      keys.push(cur)
      cur = addDays(cur, 7)
      if (keys.length > 5000) throw new RangeError('token-usage: range too large')
    }
    return keys
  }
  let cur = fromDay
  while (cur && cur <= toDay) {
    keys.push(cur)
    cur = addDays(cur, 1)
    if (keys.length > 5000) throw new RangeError('token-usage: range too large')
  }
  return keys
}

/** 某一日键归属的桶键。 */
export function bucketKeyOfDay(granularity, day) {
  if (granularity === 'week') return mondayKeyOf(day)
  if (granularity === 'month') return monthKeyOf(day)
  return day
}

function emptyTotals() {
  return { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0 }
}

function addTo(dst, src, calls) {
  dst.input += src.input
  dst.output += src.output
  dst.total += src.total
  dst.cacheRead += src.cacheRead
  dst.cacheWrite += src.cacheWrite
  dst.reasoning += src.reasoning
  dst.calls += calls
}

/**
 * 区间聚合：连续桶 + 模型排名 + 总计。
 *
 * @param daily - 聚合体 { dayKey: { modelKey: counts } }。
 * @param options - { granularity: 'day'|'week'|'month', fromDay?, toDay? }（缺省跨度 = 数据最早日至今天）。
 * @returns { granularity, range, buckets, models, totals, dataSpan, empty }
 */
export function rollup(daily, { granularity, fromDay, toDay }) {
  if (granularity !== 'day' && granularity !== 'week' && granularity !== 'month') {
    throw new Error('token-usage: unknown granularity ' + String(granularity))
  }
  const span = dataSpanOf(daily)
  const today = dayKeyOf(Date.now())
  let start = fromDay || (span ? span.minDay : today)
  let end = toDay || today
  if (!parseDay(start)) start = today
  if (!parseDay(end)) end = today
  if (start > end) { const t = start; start = end; end = t }

  const keys = bucketKeysBetween(granularity, start, end)
  const bucketMap = new Map()
  for (const k of keys) bucketMap.set(k, { key: k, total: 0, byModel: {} })

  const modelTotals = Object.create(null)
  let inRangeRows = 0
  for (const day of Object.keys(daily)) {
    if (day < start || day > end) continue
    const models = daily[day]
    const bk = bucketKeyOfDay(granularity, day)
    const bucket = bucketMap.get(bk)
    if (!bucket) continue
    inRangeRows += 1
    for (const modelKey of Object.keys(models)) {
      const c = models[modelKey]
      if (!c || typeof c !== 'object') continue
      const calls = (c.msgs | 0) + (c.attempts | 0) + (c.summaries | 0)
      bucket.total += c.total | 0
      let bm = bucket.byModel[modelKey]
      if (!bm) bm = bucket.byModel[modelKey] = emptyTotals()
      addTo(bm, c, calls)
      let mt = modelTotals[modelKey]
      if (!mt) mt = modelTotals[modelKey] = emptyTotals()
      addTo(mt, c, calls)
    }
  }

  const totals = emptyTotals()
  const models = []
  for (const modelKey of Object.keys(modelTotals)) {
    const mt = modelTotals[modelKey]
    totals.input += mt.input
    totals.output += mt.output
    totals.total += mt.total
    totals.cacheRead += mt.cacheRead
    totals.cacheWrite += mt.cacheWrite
    totals.reasoning += mt.reasoning
    totals.calls += mt.calls
    const slash = modelKey.indexOf('/')
    models.push({
      key: modelKey,
      provider: slash > 0 ? modelKey.slice(0, slash) : '',
      model: slash > 0 ? modelKey.slice(slash + 1) : modelKey,
      ...mt,
    })
  }
  models.sort((a, b) => b.total - a.total)
  const grand = totals.total || 0
  for (const m of models) m.share = grand > 0 ? m.total / grand : 0

  return {
    granularity,
    range: { fromDay: start, toDay: end },
    buckets: keys.map(k => bucketMap.get(k)),
    models,
    totals,
    dataSpan: span,
    empty: inRangeRows === 0,
  }
}
