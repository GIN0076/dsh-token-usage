/**
 * client.js 文案夹具（一次性脚本，node 直跑，不入 files）：
 *   node client.i18n.fixtures.mjs
 * 静态检查三件事（client 半是浏览器代码，Node 里跑不了 React，只能抽文本核对）：
 *   ① 派发出去的每个 t('key') 在 zh / en 里都存在（漏了就界面上显示原始 key）；
 *   ② zh 与 en 的键集合完全一致（防只加一半）；
 *   ③ 同名占位符两边一致（'{n}'/'{msg}'/'{path}' 少一个就填空）。
 * 只做静态文本核对，不执行组件。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'client.js'), 'utf8')
const lines = source.split('\n')

let passed = 0
const fails = []
function check(name, cond, detail) {
  if (cond) passed += 1
  else fails.push(name + (detail ? ' — ' + detail : ''))
}

/** 截取 `const <name> = {` 到下一个「只有缩进 + }」的块，抽出全部键值对（同一行多个也算）。 */
function parseDict(name) {
  const start = lines.findIndex((l) => l.trim().startsWith('const ' + name + ' = {'))
  if (start < 0) throw new Error('字典未找到: ' + name)
  let end = start + 1
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s{0,6}\}\s*$/.test(lines[i])) { end = i; break }
  }
  const block = lines.slice(start + 1, end).join('\n')
  const out = new Map()
  const pair = /(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[^,}\n]+)/g
  let m
  while ((m = pair.exec(block)) !== null) {
    out.set(m[1] !== undefined ? m[1] : m[2], m[3])
  }
  return out
}

const zh = parseDict('zh')
const en = parseDict('en')
check('zh dictionary parsed', zh.size > 20, 'size=' + zh.size)
check('en dictionary parsed', en.size > 20, 'size=' + en.size)

// ① 用到的键（只认字面量；`t('g.' + g)` 这类动态键由前缀白名单覆盖）
const used = new Set()
for (const m of source.matchAll(/\bt\(\s*'([^']+)'\s*\)/g)) used.add(m[1])
for (const m of source.matchAll(/\bt\(\s*"([^"]+)"\s*\)/g)) used.add(m[1])
const dynamicPrefixes = ['g.', 'r.']   // t('g.' + g) / t('r.' + p.id)
for (const key of used) {
  if (dynamicPrefixes.some((p) => key.startsWith(p))) continue
  check('zh has used key ' + key, zh.has(key))
  check('en has used key ' + key, en.has(key))
}

// ② 键集合一致（两个方向都报，方便定位）
const onlyZh = [...zh.keys()].filter((k) => !en.has(k))
const onlyEn = [...en.keys()].filter((k) => !zh.has(k))
check('zh/en key sets match', onlyZh.length === 0 && onlyEn.length === 0,
  'zh-only=' + JSON.stringify(onlyZh) + ' en-only=' + JSON.stringify(onlyEn))

// ③ 占位符一致
const placeholders = (v) => [...String(v).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
for (const key of zh.keys()) {
  if (!en.has(key)) continue
  check('placeholders match for ' + key, placeholders(zh.get(key)) === placeholders(en.get(key)),
    'zh=' + placeholders(zh.get(key)) + ' en=' + placeholders(en.get(key)))
}

// ④ 动态前缀至少各有真实键（防前缀写错）
for (const p of dynamicPrefixes) {
  check('dynamic prefix ' + p + ' has keys', [...zh.keys()].some((k) => k.startsWith(p)))
}

if (fails.length) {
  console.error('FAIL ' + fails.length + ' / ' + (passed + fails.length))
  for (const f of fails) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log('OK  ' + passed + ' checks passed')
