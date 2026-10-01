/**
 * client.js 离线冒烟（一次性脚本，node 直跑，不入 files）：
 *   node client.smoke.mjs
 * client 半是浏览器代码、本机没有 React，所以这里自带一个「迷你 React 运行时」：
 *   只实现 createElement / useState / useRef / useMemo / Fragment 与真实树遍历（**不跑 useEffect**，
 *   状态由测试直接注入），配合假的 fetch / document，把「渲染 → 导出 → 价目表」全流程真跑一遍。
 * 覆盖：汇总卡（含金额/命中率）、折线+柱状图渲染、CSV 生成、导出弹层、价目表读取/模板/保存、
 *       以及空数据/错误态不崩。不做视觉断言（像素要看真界面）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

let passed = 0
const fails = []
function check(name, cond, detail) {
  if (cond) passed += 1
  else fails.push(name + (detail ? ' — ' + detail : ''))
}

// ── 迷你 React ──
const hookStates = []
let cursor = 0
const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    const kids = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
    const merged = { ...(props || {}) }
    if (kids.length) merged.children = kids.length === 1 ? kids[0] : kids
    if (typeof type === 'function') return type(merged)
    return { type: String(type), props: merged }
  },
  useState(init) {
    const i = cursor++
    if (!(i in hookStates)) hookStates[i] = typeof init === 'function' ? init() : init
    return [hookStates[i], (v) => { hookStates[i] = typeof v === 'function' ? v(hookStates[i]) : v }]
  },
  useRef(v) {
    const i = cursor++
    if (!(i in hookStates)) hookStates[i] = { current: v }
    return hookStates[i]
  },
  useMemo(fn) { cursor += 1; return fn() },
  useEffect() { /* 冒烟测试不跑副作用：状态直接注入 */ },
  useCallback(fn) { return fn },
}

// ── 假宿主环境 ──
const fetchCalls = []
let savedPricesText = null
const pricesText = '{\n  "currency": "¥",\n  "models": { "p/model": { "input": 1, "output": 2 } }\n}'
const payload = () => ({
  granularity: 'day',
  range: { fromDay: '2026-09-30', toDay: '2026-10-01' },
  buckets: [
    { key: '2026-09-30', total: 1000, byModel: { 'p/model': { input: 600, output: 400, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 1000, calls: 2 } } },
    { key: '2026-10-01', total: 500, byModel: { 'p/model': { input: 300, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 500, calls: 1 } } },
  ],
  models: [
    { key: 'p/model', provider: 'p', model: 'model', input: 900, output: 600, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 1500, calls: 3, share: 1, cost: 0.0021 },
    { key: 'p/model2', provider: 'p', model: 'model2', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, calls: 0, share: 0, cost: null },
  ],
  totals: { input: 900, output: 600, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 1500, calls: 3 },
  dataSpan: { minDay: '2026-09-30', maxDay: '2026-10-01' },
  empty: false,
  cost: { currency: '¥', total: 0.0021, pricedModels: 1, unpricedModels: 0, pricedTokens: 1500, unpricedTokens: 0 },
  prices: { path: 'C:/tmp/token-usage-prices.json', configured: true, exists: true, currency: '¥', models: 1, hasDefault: false, error: null },
  generatedAt: Date.now(),
})
const statusPayload = () => ({
  backfill: null, rebuilding: false, storageOk: true, storageError: null,
  dataSpan: { minDay: '2026-09-30', maxDay: '2026-10-01' },
  prices: payload().prices, orphanSessions: 49, buffers: { sessions: 0, events: 0, dropped: 0, failed: 0 },
  generatedAt: Date.now(),
})
let failRebuild = false
const configTextStub = '{\n  "refreshSeconds": 30,\n  "budget": { "daily": 10 },\n  "retentionDays": 0\n}'
let savedConfigText = null
const errorPayload = {
  ok: false,
  error: 'unauthenticated',
  hint: '缺少/失效的 dsh-auth-* cookie',
  seen: { host: '127.0.0.1:19387', origin: '', site: '', cookie: 'missing' },
}
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body)
  fetchCalls.push(body)
  const reply = (data) => ({ ok: true, status: 200, json: async () => ({ ok: true, data }) })
  if (body.action === 'stats') return reply(payload())
  if (body.action === 'status') return reply(statusPayload())
  if (body.action === 'prices') return reply({ ...payload().prices, text: pricesText })
  if (body.action === 'prices.save') { savedPricesText = body.args.text; return reply({ ...payload().prices, text: body.args.text }) }
  if (body.action === 'config') {
    return reply({ path: 'C:/tmp/token-usage-config.json', exists: true, error: null, refreshSeconds: 30, budget: { daily: 10, monthly: 0 }, retentionDays: 0, text: configTextStub })
  }
  if (body.action === 'config.save') {
    savedConfigText = body.args.text
    return reply({ path: 'C:/tmp/token-usage-config.json', exists: true, error: null, refreshSeconds: 30, budget: { daily: 10, monthly: 0 }, retentionDays: 0, prunedDays: 0, text: body.args.text })
  }
  if (body.action === 'summary') {
    return reply({
      day: '2026-10-01',
      today: { totals: { total: 12345, input: 1, output: 1, cacheRead: 1, cacheWrite: 0, reasoning: 0, calls: 2 }, cost: { currency: '¥', total: 1.5 } },
      month: { fromDay: '2026-10-01', totals: { total: 12345, input: 1, output: 1, cacheRead: 1, cacheWrite: 0, reasoning: 0, calls: 2 }, cost: { currency: '¥', total: 1.5 } },
      budget: { daily: 10, monthly: 0, currency: '¥' },
    })
  }
  if (body.action === 'rebuild') {
    if (failRebuild) return { ok: false, status: 401, json: async () => errorPayload }
    if (body.args && body.args.confirm === true) return reply({ started: true })
    return reply({ started: false, needsConfirm: true, orphanSessions: 49 })
  }
  return reply({})
}
function makeEl(tag) {
  return {
    tagName: tag, style: {}, attrs: {}, children: [],
    setAttribute(k, v) { this.attrs[k] = v },
    appendChild(c) { this.children.push(c); return c },
    removeChild(c) { this.children = this.children.filter((x) => x !== c) },
    get parentNode() { return this._parent || null },
    click() {}, remove() {},
  }
}
globalThis.document = {
  head: makeEl('head'),
  body: makeEl('body'),
  visibilityState: 'visible',
  createElement: makeEl,
  addEventListener() {},
  removeEventListener() {},
}
globalThis.window = globalThis
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText() {} } },
  configurable: true,
  writable: true,
})
globalThis.Blob = class { constructor(parts) { this.parts = parts } }
globalThis.URL.createObjectURL = () => 'blob:stub'
globalThis.URL.revokeObjectURL = () => {}

// ── 载入 client.js 并拿到插件对象 ──
let factory = null
globalThis.__ModuleLoader__ = { load({ id, factory: f }) { factory = f } }
await import('file:///' + join(here, 'client.js').replace(/\\/g, '/'))
check('module registered on __ModuleLoader__', typeof factory === 'function')
const plugin = factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
check('factory returns plugin object', !!(plugin && typeof plugin.apply === 'function'))

// ── 挂载：假 ctx ──
let registered = null
const styleTag = { setAttribute() {}, parentNode: null }
const ctx = {
  locale: {
    register: () => () => {},
    bind: () => (key) => key,
    getSnapshot: () => ({ active: 'zh' }),
  },
  slots: {
    inject: (name, fn) => fn(),
    register: (spec, Component) => { registered = { spec, Component }; return () => {} },
  },
}
const dispose = plugin.apply(ctx)
check('apply registers settings.section', registered && registered.spec.name === 'settings.section' && registered.spec.id === 'token-usage')
check('apply returns a disposer', typeof dispose === 'function')

function render() {
  cursor = 0
  return registered.Component({})
}
function texts(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) texts(n, out); return out }
  if (node.props) texts(node.props.children, out)
  return out
}
function find(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) find(n, pred, out); return out }
  if (pred(node)) out.push(node)
  if (node.props) find(node.props.children, pred, out)
  return out
}
const buttons = (tree) => find(tree, (n) => n.type === 'button')
const textareas = (tree) => find(tree, (n) => n.type === 'textarea')
const click = (tree, label) => {
  const btn = buttons(tree).find((b) => texts(b).includes(label))
  if (!btn) throw new Error('button not found: ' + label)
  btn.props.onClick({ target: {}, currentTarget: {} })
}

// ── 1. 首屏（data=null）不崩 ──
let tree = render()
check('first render (no data) survives', texts(tree).length > 0)
check('loading state text present', texts(tree).some((s) => s.includes('loading')))

// ── 2. 注入 data + status 后：卡片 / 图表渲染 ──
hookStates[4] = payload()      // data
hookStates[5] = statusPayload() // status
hookStates[7] = false           // loading
tree = render()
const flat = texts(tree).join(' | ')
check('summary total rendered', flat.includes('1.5K') || flat.includes('1,500') || flat.includes('1500'), flat.slice(0, 160))
check('cost card rendered with currency', flat.includes('¥') && flat.includes('0.0021'), '')
check('hit rate card rendered', flat.includes('0.0%'))
check('bar chart model row rendered', flat.includes('p/model'))
check('line chart svg rendered', find(tree, (n) => n.type === 'polyline').length >= 1)
check('no empty-state when data present', !flat.includes('empty'))

// ── 3. 导出：CSV 内容 + 弹层 ──
click(tree, 'exportBtn')
tree = render()
const exportArea = textareas(tree)[0]
check('export sheet opened', !!exportArea)
const csv = exportArea ? String(exportArea.props.value) : ''
check('CSV has header line', csv.includes('bucket,model,input,output,cacheRead,cacheWrite,reasoning,total,calls,cost'), csv.slice(0, 120))
check('CSV has per-bucket model row', csv.includes('2026-09-30,p/model,600,400,0,0,0,1000,2,'), '')
check('CSV has model totals block', csv.includes('# model totals'))
check('CSV ends with grand total line', csv.split('\r\n').some((l) => l.startsWith('# total,900,600,')))
check('CSV carries cost currency note', csv.includes('currency=¥'))
// 切 JSON
click(tree, 'export.json')
tree = render()
const jsonText = String(textareas(tree)[0].props.value)
check('JSON export is parseable and carries range', (() => {
  try { const o = JSON.parse(jsonText); return o.range.fromDay === '2026-09-30' && o.models[0].key === 'p/model' } catch { return false }
})())

// ── 4. 价目表：读取 → 模板 → 保存 ──
hookStates[10] = null  // 关掉上一个弹层（sheet）
tree = render()
click(tree, 'pricesBtn')
const opened = fetchCalls.some((c) => c.action === 'prices')
check('prices sheet issues a prices RPC', opened)
await new Promise((r) => setTimeout(r, 0))
tree = render()
const pricesArea = textareas(tree)[0]
check('prices sheet shows file content', pricesArea && String(pricesArea.props.value).includes('"p/model"'))

click(tree, 'prices.template')
tree = render()
const templateText = String(textareas(tree)[0].props.value)
check('template prefilled with current models', (() => {
  try { const o = JSON.parse(templateText); return o.models['p/model'] && o.models['p/model'].input === 0 && o.currency === '¥' } catch { return false }
})(), templateText.slice(0, 80))

click(tree, 'prices.save')
await new Promise((r) => setTimeout(r, 0))
check('save sends prices.save with the edited text', savedPricesText !== null && savedPricesText.includes('"p/model"'))

// ── 4.5 逐桶反馈 + 粒度切换不动区间（v1.1.1）──
hookStates[10] = null   // 关掉弹层
hookStates[0] = 'day'
hookStates[1] = '30d'
hookStates[4] = payload()
hookStates[5] = statusPayload()
hookStates[6] = null
hookStates[7] = false
tree = render()
const cardTexts = find(tree, (n) => n.props && n.props.className === 'tu-card').map((c) => texts(c).join('='))
check('bucket-count card present with current bucket count',
  cardTexts.some((s) => s === 'buckets=' + payload().buckets.length), JSON.stringify(cardTexts))
const chartTitle = texts(tree).join(' ')
check('chart title carries the bucket count', chartTitle.includes('buckets.count'))
check('chart title carries the range span in days', chartTitle.includes('span.days'))
const presetBefore = hookStates[1]
click(tree, 'g.week')
check('granularity switch applies the new granularity', hookStates[0] === 'week')
check('granularity switch leaves the range preset untouched', hookStates[1] === presetBefore, String(hookStates[1]))

// ── 4.6 重建二次确认 + RPC 错误体（v1.2.0）──
hookStates[4] = payload()
hookStates[5] = statusPayload()
hookStates[6] = null
hookStates[7] = false
hookStates[10] = null
tree = render()
check('orphan-history hint shown in the toolbar', texts(tree).some((s) => s.includes('status.orphan')))
const rebuildCallsBefore = fetchCalls.filter((c) => c.action === 'rebuild').length
click(tree, 'rebuild')
await new Promise((r) => setTimeout(r, 0))
tree = render()
check('rebuild without confirm opens the confirmation sheet',
  texts(tree).some((s) => s === 'rebuild.warn.title'))
check('rebuild was not started before confirmation',
  fetchCalls.filter((c) => c.action === 'rebuild').length === rebuildCallsBefore + 1)
click(tree, 'rebuild.warn.ok')
await new Promise((r) => setTimeout(r, 0))
const rebuildCalls = fetchCalls.filter((c) => c.action === 'rebuild')
check('confirming sends confirm:true', rebuildCalls.length === rebuildCallsBefore + 2
  && rebuildCalls[rebuildCalls.length - 1].args && rebuildCalls[rebuildCalls.length - 1].args.confirm === true)
check('confirmation sheet closed after rebuild starts', !texts(render()).some((s) => s === 'rebuild.warn.title'))
// RPC 失败：错误文案必须带 body 里的 hint 与 seen
failRebuild = true
hookStates[6] = null
click(render(), 'rebuild')
await new Promise((r) => setTimeout(r, 0))
const errText = String(hookStates[6] || '')
check('rpc failure surfaces HTTP status + hint + seen',
  errText.includes('HTTP 401') && errText.includes('dsh-auth-') && errText.includes('cookie=missing'), errText)
failRebuild = false
hookStates[6] = null

// ── 4.7 C 档：维度切换 / 排序 / 预算卡 / 设置弹层（v1.3.0）──
hookStates[4] = payload()
hookStates[5] = statusPayload()
hookStates[6] = null
hookStates[7] = false
hookStates[10] = null
hookStates[11] = 'model'
hookStates[12] = 'tokens'
hookStates[13] = null
tree = render()
const cardOf = (tr, key) => find(tr, (n) => n.props && n.props.className === 'tu-card')
  .map((c) => texts(c).join('=')).find((s) => s.startsWith(key + '=')) || ''
check('model view counts every model', cardOf(tree, 'modelCount') === 'modelCount=2', cardOf(tree, 'modelCount'))
// 切「按厂商」：同一 provider 的两个模型要合并成 1
const dimBtn = buttons(tree).find((b) => texts(b).includes('dim.provider'))
check('provider switch present', !!dimBtn)
dimBtn.props.onClick({ target: {}, currentTarget: {} })
tree = render()
check('provider view merges models of one provider', cardOf(tree, 'modelCount') === 'modelCount=1', cardOf(tree, 'modelCount'))
check('provider switch is reflected in the ranking header', texts(tree).some((s) => s.includes('rank.title')))
// 排序开关（有价目表时出现）：切到按金额
const sortBtn = buttons(tree).find((b) => texts(b).join('').startsWith('sort.tokens'))
check('sort toggle present when priced', !!sortBtn)
sortBtn.props.onClick({ target: {}, currentTarget: {} })
tree = render()
check('sort toggle flips to cost', buttons(tree).some((b) => texts(b).join('').startsWith('sort.cost')))
// 预算卡：今日/本月 + 预算（超支不加红，因为 1.5 < 10）
hookStates[13] = {
  day: '2026-10-01',
  today: { totals: { total: 12345 }, cost: { currency: '¥', total: 1.5 } },
  month: { fromDay: '2026-10-01', totals: { total: 12345 }, cost: { currency: '¥', total: 1.5 } },
  budget: { daily: 10, monthly: 0, currency: '¥' },
}
tree = render()
check('today card rendered', cardOf(tree, 'today') !== '', cardOf(tree, 'today'))
check('month card rendered', cardOf(tree, 'month') !== '')
check('budget card shows spent / limit', /budget=¥1\.50 \/ ¥10\.00/.test(cardOf(tree, 'budget')), cardOf(tree, 'budget'))
// 超支 → 值上加 tu-over（红）
hookStates[13] = { ...hookStates[13], today: { totals: { total: 1 }, cost: { currency: '¥', total: 99.5 } } }
tree = render()
const overCard = find(tree, (n) => n.props && String(n.props.className || '').includes('tu-over'))
check('over-budget turns red', overCard.length > 0)
// 设置弹层：打开 → 模板 → 保存
hookStates[13] = null
tree = render()
click(tree, 'setBtn')
await new Promise((r) => setTimeout(r, 0))
tree = render()
check('config sheet opens', textareas(tree).length > 0)
const cfgArea = textareas(tree)[0]
check('config sheet shows the file text', String(cfgArea.props.value).includes('refreshSeconds'))
click(tree, 'config.template')
tree = render()
check('config template is valid JSON with defaults', (() => {
  try { const o = JSON.parse(String(textareas(tree)[0].props.value)); return o.refreshSeconds === 60 && o.budget && o.budget.daily === 0 } catch { return false }
})())
click(tree, 'config.save')
await new Promise((r) => setTimeout(r, 0))
check('config save posts the edited text', savedConfigText !== null && savedConfigText.includes('refreshSeconds'))

// ── 5. 空区间 / 错误态不崩 ──
hookStates[4] = { ...payload(), empty: true, buckets: [], models: [], totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, calls: 0 }, cost: null }
hookStates[10] = null
tree = render()
check('empty range renders empty state', texts(tree).join(' ').includes('empty'))
hookStates[4] = null
hookStates[6] = 'boom'   // error
tree = render()
// t() 在冒烟里是恒等函数，'error.head' 里的 {msg} 不会被替换 → 这里只断言错误分支被渲染 + 有重试按钮
check('error state renders without data', texts(tree).join(' ').includes('error.head'))
check('error state offers a retry button', buttons(tree).some((b) => texts(b).includes('retry')))

if (fails.length) {
  console.error('FAIL ' + fails.length + ' / ' + (passed + fails.length))
  for (const f of fails) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log('OK  ' + passed + ' checks passed')
