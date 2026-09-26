/**
 * stats.js 夹具验证（一次性脚本，node 直跑，不入 files）：
 *   node stats.fixtures.mjs
 * 覆盖：usage 校验跳过、fork 继承去重、路由跟踪、周一起始/跨月桶、
 *       日→周→月滚算求和一致、任意 from/to 自定义范围截断。
 */
import {
  normalizeUsage, foldEvent, accumulate, rollup,
  dayKeyOf, mondayKeyOf, monthKeyOf, bucketKeysBetween, addDays, dataSpanOf,
} from './stats.js'

let passed = 0
const fails = []
function check(name, cond, detail) {
  if (cond) { passed += 1 } else { fails.push(name + (detail ? ' — ' + detail : '')) }
}

// ── 1. usage 校验 ──
check('valid usage', normalizeUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })?.total === 15)
check('derive total without totalTokens', normalizeUsage({ inputTokens: 10, outputTokens: 5 })?.total === 15)
check('cache buckets fold into prompt', (() => {
  const u = normalizeUsage({ inputTokens: 3, outputTokens: 2, cacheReadTokens: 7, cacheWriteTokens: 0, totalTokens: 12 })
  return u !== null && u.total === 12
})())
check('reject negative', normalizeUsage({ inputTokens: -1, outputTokens: 5 }) === null)
check('reject fractional', normalizeUsage({ inputTokens: 1.5, outputTokens: 5 }) === null)
check('reject missing input', normalizeUsage({ outputTokens: 5 }) === null)
check('reject reasoning > output', normalizeUsage({ inputTokens: 1, outputTokens: 2, reasoningTokens: 9 }) === null)
check('reject total below known prompt', normalizeUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 12 }) === null)
check('reject contradictory cache totals', (() => {
  // knownPrompt = 3+7+2=12, output=2 → total 必须 14；给 15 拒绝
  return normalizeUsage({ inputTokens: 3, outputTokens: 2, cacheReadTokens: 7, cacheWriteTokens: 2, totalTokens: 15 }) === null
})())
check('reject null usage', normalizeUsage(null) === null)

// ── 2. 折叠：路由跟踪 + 消息归属 + 尝试归属 ──
const T = Date.now()
function ev(seq, type, time, data) { return { seq, type, time, data } }

const ctx = { seq: 0, cut: 0, route: undefined }
let hit = foldEvent(ctx, ev(1, 'request/header', T, {
  header: { config: { provider: 'deepseek', model: 'deepseek-chat' } },
}))
check('header not counted as usage', hit === null && ctx.route?.model === 'deepseek-chat')

hit = foldEvent(ctx, ev(2, 'assistant/message', T, {
  message: { source: { kind: 'model', provider: 'openai', model: 'gpt-5' } },
  usage: { inputTokens: 100, outputTokens: 20 },
  stream: [],
}))
check('message uses message.source route', hit?.modelKey === 'openai/gpt-5' && hit.usage.total === 120 && hit.kind === 'msg')

hit = foldEvent(ctx, ev(3, 'assistant/attempt', T, {
  stream: [{ type: 'chunk', time: T, chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } } }],
}))
check('attempt uses header route', hit?.modelKey === 'deepseek/deepseek-chat' && hit.kind === 'attempt' && hit.usage.total === 10)

hit = foldEvent(ctx, ev(4, 'assistant/message', T, {
  message: { source: { kind: 'model', provider: '', model: '' } },
  usage: { inputTokens: 1, outputTokens: 1 },
  stream: [],
}))
check('empty source falls back to header route', hit?.modelKey === 'deepseek/deepseek-chat')

hit = foldEvent(ctx, ev(5, 'assistant/message', T, {
  message: { source: { kind: 'model', provider: 'x', model: 'y' } },
  stream: [{ type: 'chunk', time: T, chunk: { type: 'usage', usage: { inputTokens: 4, outputTokens: 1 } } }],
}))
check('usage from stream chunk when data.usage absent', hit?.usage.total === 5)

// ── 3. fork 继承前缀去重 ──
const fork = { seq: 0, cut: 10, route: undefined }
const inherited = foldEvent(fork, ev(5, 'assistant/message', T, {
  message: { source: { kind: 'model', provider: 'p', model: 'm' } },
  usage: { inputTokens: 999, outputTokens: 1 },
  stream: [],
}))
check('inherited prefix skipped', inherited === null && fork.seq === 5)
const owned = foldEvent(fork, ev(11, 'assistant/message', T, {
  message: { source: { kind: 'model', provider: 'p', model: 'm' } },
  usage: { inputTokens: 1, outputTokens: 1 },
  stream: [],
}))
check('owned event after cut counted', owned !== null)

// 截断内的 header 仍要跟踪（保证截断后的 attempt 归属正确）
const fork2 = { seq: 10, cut: 10, route: undefined }
foldEvent(fork2, ev(3, 'request/header', T, { header: { config: { provider: 'a', model: 'b' } } }))
check('header inside prefix still tracked', fork2.route?.model === 'b')
const forkAttempt = foldEvent(fork2, ev(11, 'assistant/attempt', T, {
  stream: [{ type: 'chunk', time: T, chunk: { type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } } }],
}))
check('post-cut attempt attributed', forkAttempt?.modelKey === 'a/b')

// ── 4. 时间桶：周一起始 / 跨月 / 日键 ──
// 2026-09-24 是周三 → 周一 2026-09-21
check('monday of wednesday', mondayKeyOf('2026-09-24') === '2026-09-21')
check('monday of monday', mondayKeyOf('2026-09-21') === '2026-09-21')
check('monday of sunday crosses week', mondayKeyOf('2026-09-27') === '2026-09-21')
check('month key', monthKeyOf('2026-09-30') === '2026-09')
check('addDays across month', addDays('2026-09-30', 1) === '2026-10-01')
check('addDays across year', addDays('2026-01-01', -1) === '2025-12-31')

const weekKeys = bucketKeysBetween('week', '2026-09-24', '2026-10-12')
check('week buckets span', weekKeys.length === 4 && weekKeys[0] === '2026-09-21' && weekKeys[3] === '2026-10-12',
  JSON.stringify(weekKeys))
const monthKeys = bucketKeysBetween('month', '2026-08-15', '2027-01-05')
check('month buckets span year', monthKeys.length === 6 && monthKeys[0] === '2026-08' && monthKeys[5] === '2027-01',
  JSON.stringify(monthKeys))
const dayKeys = bucketKeysBetween('day', '2026-02-27', '2026-03-02')
check('day buckets across month', dayKeys.length === 4 && dayKeys[3] === '2026-03-02', JSON.stringify(dayKeys))

// ── 5. 累加 + 滚算一致性（日合计 == 周合计 == 月合计）──
const daily = {}
function put(day, model, counts) {
  daily[day] = daily[day] || {}
  const row = daily[day][model] = daily[day][model] || { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, msgs: 0, attempts: 0, summaries: 0 }
  for (const k of Object.keys(counts)) row[k] += counts[k]
}
put('2026-09-21', 'p/m', { total: 100, input: 80, output: 20, msgs: 1 })
put('2026-09-24', 'p/m', { total: 200, input: 160, output: 40, msgs: 2 })
put('2026-09-27', 'p/m', { total: 50, input: 40, output: 10, attempts: 1 })
put('2026-10-01', 'q/n', { total: 300, input: 240, output: 60, msgs: 3 })

const rDay = rollup(daily, { granularity: 'day', fromDay: '2026-09-21', toDay: '2026-10-07' })
const rWeek = rollup(daily, { granularity: 'week', fromDay: '2026-09-21', toDay: '2026-10-07' })
const rMonth = rollup(daily, { granularity: 'month', fromDay: '2026-09-21', toDay: '2026-10-07' })
const sum = (r) => r.buckets.reduce((a, b) => a + b.total, 0)
check('day sum = 650', sum(rDay) === 650, String(sum(rDay)))
check('week sum = day sum', sum(rWeek) === sum(rDay))
check('month sum = day sum', sum(rMonth) === sum(rDay))
check('week bucket 09-21 holds 350 (21+24+27)', rWeek.buckets[0].total === 350, String(rWeek.buckets[0].total))
check('week bucket 09-28 holds 300 (Oct 1 falls in Mon 09-28 week)', rWeek.buckets[1].total === 300, String(rWeek.buckets[1].total))
check('month bucket 2026-09 holds 350', rMonth.buckets.find(b => b.key === '2026-09')?.total === 350)
check('models ranked desc', rDay.models[0].key === 'p/m' && rDay.models[0].total === 350 && rDay.models[1].key === 'q/n',
  JSON.stringify(rDay.models.map(m => [m.key, m.total])))
check('share sums to 1', Math.abs(rDay.models.reduce((a, m) => a + m.share, 0) - 1) < 1e-9)
check('totals match', rDay.totals.total === 650 && rDay.totals.calls === 7)
check('empty buckets present (continuity)', rDay.buckets.length === 17 && rDay.buckets[0].total === 100,
  String(rDay.buckets.length))
check('dataSpan', dataSpanOf(daily).minDay === '2026-09-21' && dataSpanOf(daily).maxDay === '2026-10-01')

// ── 6. 自定义范围截断：范围外日行不计入 ──
const rCustom = rollup(daily, { granularity: 'day', fromDay: '2026-09-25', toDay: '2026-09-30' })
check('custom range excludes out-of-range', sum(rCustom) === 50, String(sum(rCustom)))
check('custom range buckets generated', rCustom.buckets.length === 6 && rCustom.buckets.every(b => ['2026-09-25','2026-09-26','2026-09-27','2026-09-28','2026-09-29','2026-09-30'].includes(b.key)))

// 范围反向（start > end）应交换而不是报错
const rSwap = rollup(daily, { granularity: 'day', fromDay: '2026-09-30', toDay: '2026-09-25' })
check('reversed range swaps', rSwap.range.fromDay === '2026-09-25' && rSwap.range.toDay === '2026-09-30')

// 缺省范围 = 数据最早日至今天（fromDay/toDay 缺省）
const rAll = rollup(daily, { granularity: 'day' })
check('default range starts at span min', rAll.range.fromDay === '2026-09-21')

// 非法粒度报错
let threw = false
try { rollup(daily, { granularity: 'quarter' }) } catch { threw = true }
check('unknown granularity throws', threw)

// accumulate 与 emptyCounts 联动
const acc = {}
accumulate(acc, { dayKey: '2026-09-24', modelKey: 'a/b', usage: normalizeUsage({ inputTokens: 2, outputTokens: 3 }), kind: 'msg' })
accumulate(acc, { dayKey: '2026-09-24', modelKey: 'a/b', usage: normalizeUsage({ inputTokens: 1, outputTokens: 1 }), kind: 'attempt' })
check('accumulate sums', acc['2026-09-24']['a/b'].total === 7 && acc['2026-09-24']['a/b'].msgs === 1 && acc['2026-09-24']['a/b'].attempts === 1)

// dayKeyOf 本地时区
const midnight = new Date(2026, 8, 24, 0, 0, 0).getTime()
check('dayKeyOf local midnight', dayKeyOf(midnight) === '2026-09-24')

// ── 结果 ──
if (fails.length) {
  console.error('FAIL ' + fails.length + ' / ' + (passed + fails.length))
  for (const f of fails) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log('OK  ' + passed + ' checks passed')
