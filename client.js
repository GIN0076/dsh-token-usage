/**
 * @local/token-usage —— Client 半：设置面板「词元用量」分区。
 *
 * 静态 bundle 格式：classic script 注册到 __ModuleLoader__，factory 为 CJS 形式、
 * 返回插件对象（对齐 cordis-plugin-development 的 decoration 模板）。
 *
 * 结构：顶栏（日/周/月分段 + 预设区间下拉 + 自定义起止日期 + 重新统计 + 状态行）
 *       → 汇总卡行 → 趋势折线图（每模型细线 + 合计粗线 + 悬浮十字线明细 + 图例开关）
 *       → 模型排名柱状图（横向条 + 占比）。
 * 全部样式只用 --dsw-alias-* 主题 token；系列色为数据可视化固定调色板（稳定哈希）。
 * 数据通道：同源 POST /token-usage-rpc（stats / status / rebuild）。
 */
window.__ModuleLoader__.load({
  id: '@local/token-usage',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useMemo } = React

    const NS = 'settings.tokenUsage'
    const RPC = '/token-usage-rpc'
    const PALETTE = ['#4f8ef7', '#22b07d', '#f5a623', '#e0566b', '#9b6bff', '#2bb3c0', '#e35d9a', '#6b7fd7']

    const zh = {
      nav: '词元用量',
      title: '词元用量统计',
      granularity: '粒度',
      'g.day': '日', 'g.week': '周', 'g.month': '月',
      range: '区间',
      'r.7d': '近 7 天', 'r.30d': '近 30 天', 'r.12w': '近 12 周', 'r.12m': '近 12 个月',
      'r.all': '全部', 'r.custom': '自定义',
      from: '开始', to: '结束',
      dateHint: '请选择起止日期，且开始不晚于结束',
      rebuild: '重新统计',
      rebuilding: '重建中…',
      backfill: '历史统计生成中 {done}/{total}',
      idle: '就绪',
      noStorage: '存储不可用，仅内存统计（重启后需重新统计）',
      total: '总词元',
      input: '输入',
      output: '输出',
      cacheRead: '缓存读',
      calls: '请求数',
      modelCount: '模型数',
      empty: '该区间暂无用量数据',
      loading: '统计生成中…',
      'error.head': '统计服务不可用：{msg}',
      retry: '重试',
      tokens: '词元',
      'legend.total': '合计',
      share: '占比',
      model: '模型',
      'date.weekOf': '{d} 起一周',
      'chart.hover': '悬浮查看明细',
      'chart.toggle': '点击图例开关该模型',
      'g.note': '切换分组方式：合计数字是整段区间的总量，不随粒度变化；变的是折线图怎么分组',
      buckets: '桶数',
      'buckets.count': '共 {n} 个桶',
      'buckets.note': '当前粒度（日/周/月）下的分组数——切换粒度时它立刻变化',
      'span.days': '{n} 天',
      cacheWrite: '缓存写',
      reasoning: '推理',
      hitRate: '缓存命中',
      'hitRate.note': '缓存读 ÷（输入+缓存读+缓存写）',
      cost: '成本',
      'cost.note': '按你填的价目表估算（每百万 token 单价）',
      'cost.partial': '{n} 个模型没价格，金额只算了有价的部分',
      exportBtn: '导出',
      'export.title': '导出当前区间',
      'export.csv': 'CSV',
      'export.json': 'JSON',
      'export.note': 'CSV 按「桶 × 模型」逐行展开（金额按各桶占比摊到行上）；JSON 为服务端原始聚合结果。',
      copy: '复制',
      copied: '已复制',
      download: '下载文件',
      close: '关闭',
      pricesBtn: '价目表',
      'prices.title': '价目表（可选）',
      'prices.note': '单位=每百万 token 的价格，币种取 currency（缺省 ¥）；cacheRead/cacheWrite 不填则按 input 价计。保存到 {path}。清空并保存即关闭金额显示。',
      'prices.template': '填入模板',
      'prices.save': '保存',
      'prices.saved': '已保存',
      'prices.failed': '保存失败：{msg}',
      'prices.bad': '价目表有问题：{msg}',
      'status.auto': '可见时每 60 秒自动刷新',
      'status.orphan': '历史里有 {n} 个会话的日志已不存在：这部分还能看，但「重新统计」会把它丢掉',
      'rebuild.warn.title': '确认「重新统计」？',
      'rebuild.warn.body': '检测到 {n} 个会话的用量来自已经不在的会话日志，这部分**无法重建**。重建会清空统计并只重扫现存日志——那些历史会被永久丢弃，确定继续吗？',
      'rebuild.warn.ok': '确认重建',
      'rebuild.warn.cancel': '取消',
      setBtn: '设置',
      'config.title': '设置（可选）',
      'config.note': 'refreshSeconds=刷新间隔秒数（15–3600）；budget.daily/monthly=预算金额，0=关闭（要先配价目表才有金额）；retentionDays=保留期，0=不清理，>0 会**永久删除**更早的日聚合行。保存到 {path}',
      'config.template': '填入模板',
      'config.save': '保存',
      'config.saved': '已保存',
      'config.failed': '保存失败：{msg}',
      'config.bad': '配置有问题：{msg}',
      today: '今日',
      month: '本月',
      budget: '预算',
      'budget.note': '{period}成本 {spent} / 预算 {limit}',
      'budget.over': '已超预算',
      'dim.model': '按模型',
      'dim.provider': '按厂商',
      'rank.title': '排行 · 占比',
      'sort.tokens': '按用量',
      'sort.cost': '按金额',
      others: '{n} 个其他模型',
    }
    const en = {
      nav: 'Token Usage',
      title: 'Token Usage',
      granularity: 'Granularity',
      'g.day': 'Day', 'g.week': 'Week', 'g.month': 'Month',
      range: 'Range',
      'r.7d': 'Last 7 days', 'r.30d': 'Last 30 days', 'r.12w': 'Last 12 weeks', 'r.12m': 'Last 12 months',
      'r.all': 'All time', 'r.custom': 'Custom',
      from: 'From', to: 'To',
      dateHint: 'Pick a start and end date; start must not be after end',
      rebuild: 'Rebuild',
      rebuilding: 'Rebuilding…',
      backfill: 'Building history {done}/{total}',
      idle: 'Ready',
      noStorage: 'Storage unavailable; in-memory stats only (rebuild after restart)',
      total: 'Total tokens',
      input: 'Input',
      output: 'Output',
      cacheRead: 'Cache read',
      calls: 'Calls',
      modelCount: 'Models',
      empty: 'No usage in this range',
      loading: 'Loading…',
      'error.head': 'Usage service unavailable: {msg}',
      retry: 'Retry',
      tokens: 'Tokens',
      'legend.total': 'Total',
      share: 'Share',
      model: 'Model',
      'date.weekOf': 'Week of {d}',
      'chart.hover': 'Hover for details',
      'chart.toggle': 'Click a legend chip to toggle',
      'g.note': 'Switch the grouping: the totals cover the whole range and do not change with granularity; only the line chart regroups',
      buckets: 'Buckets',
      'buckets.count': '{n} buckets',
      'buckets.note': 'Groups at the current granularity (day / week / month) — changes the moment you switch',
      'span.days': '{n} days',
      cacheWrite: 'Cache write',
      reasoning: 'Reasoning',
      hitRate: 'Cache hit',
      'hitRate.note': 'cache read ÷ (input + cache read + cache write)',
      cost: 'Cost',
      'cost.note': 'Estimated from your price table (per million tokens)',
      'cost.partial': '{n} model(s) unpriced — the total only covers priced models',
      exportBtn: 'Export',
      'export.title': 'Export current range',
      'export.csv': 'CSV',
      'export.json': 'JSON',
      'export.note': 'CSV expands every bucket × model row (cost allocated by each row\'s share); JSON is the raw server-side rollup.',
      copy: 'Copy',
      copied: 'Copied',
      download: 'Download',
      close: 'Close',
      pricesBtn: 'Prices',
      'prices.title': 'Price table (optional)',
      'prices.note': 'Unit = price per million tokens, currency from `currency` (default ¥). cacheRead/cacheWrite fall back to the input price. Saved to {path}. Clear and save to hide cost.',
      'prices.template': 'Insert template',
      'prices.save': 'Save',
      'prices.saved': 'Saved',
      'prices.failed': 'Save failed: {msg}',
      'prices.bad': 'Price table problem: {msg}',
      'status.auto': 'auto-refreshes every 60s while visible',
      'status.orphan': '{n} session log(s) behind this history are gone: you can still read it, but Rebuild would drop it',
      'rebuild.warn.title': 'Rebuild anyway?',
      'rebuild.warn.body': 'Usage from {n} session(s) comes from logs that no longer exist, so it **cannot be rebuilt**. Rebuild clears the store and rescans only the logs present now — that history would be lost permanently. Continue?',
      'rebuild.warn.ok': 'Rebuild anyway',
      'rebuild.warn.cancel': 'Cancel',
      setBtn: 'Settings',
      'config.title': 'Settings (optional)',
      'config.note': 'refreshSeconds = auto-refresh interval (15–3600); budget.daily/monthly = amount, 0 disables (cost needs a price table); retentionDays = 0 keeps everything, >0 **permanently deletes** older daily rows. Saved to {path}',
      'config.template': 'Insert template',
      'config.save': 'Save',
      'config.saved': 'Saved',
      'config.failed': 'Save failed: {msg}',
      'config.bad': 'Config problem: {msg}',
      today: 'Today',
      month: 'This month',
      budget: 'Budget',
      'budget.note': '{period} cost {spent} / budget {limit}',
      'budget.over': 'Over budget',
      'dim.model': 'By model',
      'dim.provider': 'By provider',
      'rank.title': 'Ranking · share',
      'sort.tokens': 'By tokens',
      'sort.cost': 'By cost',
      others: '{n} other models',
    }

    const PRESETS = [
      { id: '7d', days: 7 },
      { id: '30d', days: 30 },
      { id: '12w', days: 84 },
      { id: '12m', days: 365 },
      { id: 'all' },
      { id: 'custom' },
    ]
    const GRANULARITIES = ['day', 'week', 'month']

    // ── 样式（随插件停用移除）──
    function styleText() {
      return '' +
        '.tu-wrap{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);min-width:0;}' +
        '.tu-wrap *{box-sizing:border-box;}' +
        '.tu-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}' +
        '.tu-title{font-size:14px;font-weight:700;}' +
        '.tu-seg{display:inline-flex;gap:2px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:2px;}' +
        '.tu-seg button{font-size:12px;border:none;background:none;color:var(--dsw-alias-label-secondary);padding:3px 12px;border-radius:5px;cursor:pointer;}' +
        '.tu-seg button:hover{color:var(--dsw-alias-label-primary);}' +
        '.tu-seg button.tu-on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600;}' +
        '.tu-select,.tu-date{font-size:12.5px;padding:4px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}' +
        '.tu-select:focus,.tu-date:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}' +
        '.tu-dates{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;}' +
        '.tu-dates label{font-size:12px;color:var(--dsw-alias-label-secondary);}' +
        '.tu-spacer{flex:1;}' +
        '.tu-btn{font-size:12.5px;padding:4px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;}' +
        '.tu-btn:hover{border-color:var(--dsw-alias-brand-primary);}' +
        '.tu-btn:disabled{opacity:.5;cursor:default;}' +
        '.tu-status{font-size:11.5px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:8px;min-height:16px;}' +
        '.tu-status-warn{color:var(--dsw-alias-state-warn-primary);}' +
        '.tu-hint{font-size:11.5px;color:var(--dsw-alias-state-warn-primary);width:100%;}' +
        '.tu-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:8px;}' +
        '.tu-card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;min-width:0;}' +
        '.tu-card-k{font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
        '.tu-card-v{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;}' +
        '.tu-panel{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;min-width:0;}' +
        '.tu-panel-hd{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;flex-wrap:wrap;}' +
        '.tu-panel-t{font-size:12.5px;font-weight:600;}' +
        '.tu-panel-note{font-size:10.5px;color:var(--dsw-alias-label-secondary);}' +
        '.tu-chart{position:relative;width:100%;}' +
        '.tu-chart svg{display:block;width:100%;height:auto;}' +
        '.tu-tip{position:absolute;top:6px;z-index:5;pointer-events:none;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 9px;font-size:11px;line-height:1.65;color:var(--dsw-alias-label-primary);box-shadow:0 4px 14px rgba(0,0,0,.25);white-space:nowrap;max-width:70%;}' +
        '.tu-tip-d{font-weight:700;margin-bottom:2px;}' +
        '.tu-tip-r{display:flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums;}' +
        '.tu-dot{width:8px;height:8px;border-radius:50%;flex:none;}' +
        '.tu-tip-k{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary);}' +
        '.tu-tip-v{font-weight:600;}' +
        '.tu-legend{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px;}' +
        '.tu-chip{display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:2px 9px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;}' +
        '.tu-chip:hover{border-color:var(--dsw-alias-brand-primary);}' +
        '.tu-chip-off{opacity:.42;}' +
        '.tu-bars{display:flex;flex-direction:column;}' +
        '.tu-state{padding:26px 0;text-align:center;font-size:12.5px;color:var(--dsw-alias-label-secondary);}' +
        '.tu-state-err{color:var(--dsw-alias-state-error-primary);}' +
        '.tu-modal-bg{position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px;}' +
        '.tu-modal{display:flex;flex-direction:column;gap:8px;width:min(700px,94vw);max-height:82vh;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 34px rgba(0,0,0,.38);}' +
        '.tu-modal-t{font-size:13px;font-weight:700;}' +
        '.tu-modal-note{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);word-break:break-all;}' +
        '.tu-modal-ft{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}' +
        '.tu-modal-ft .tu-spacer{flex:1;}' +
        '.tu-area{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;line-height:1.5;min-height:170px;max-height:44vh;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);white-space:pre;overflow:auto;resize:vertical;}' +
        '.tu-ok{font-size:11.5px;color:var(--dsw-alias-label-secondary);}' +
        '.tu-ok-warn{font-size:11.5px;color:var(--dsw-alias-state-warn-primary);}' +
        '.tu-over{color:var(--dsw-alias-state-error-primary);}' +
        '@keyframes tu-spin{to{transform:rotate(360deg);}}' +
        '.tu-spin{display:inline-block;width:11px;height:11px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:tu-spin .8s linear infinite;vertical-align:-2px;}'
    }

    // ── 小工具 ──
    async function rpc(action, args) {
      let res
      try {
        res = await fetch(RPC, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, args: args || {} }),
        })
      } catch (e) {
        throw new Error(String((e && e.message) || e))
      }
      if (!res.ok) {
        // v1.2.0：401/403 现在带 body（error/hint/seen），把原因原样带出来，排障不必靠猜
        let detail = ''
        try {
          const b = await res.json()
          if (b) {
            const seen = b.seen
              ? 'host=' + (b.seen.host || '-') + ' origin=' + (b.seen.origin || '-')
                + ' site=' + (b.seen.site || '-') + ' cookie=' + b.seen.cookie
              : ''
            detail = [b.error, b.hint, seen].filter(Boolean).join(' · ')
          }
        } catch { /* 空 body：保持旧行为 */ }
        throw new Error('HTTP ' + res.status + (detail ? ' — ' + detail : ''))
      }
      const body = await res.json()
      if (!body || body.ok !== true) throw new Error((body && body.error) || 'request failed')
      return body.data
    }

    function dkey(d) {
      const p = (n) => (n < 10 ? '0' : '') + n
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    }
    function todayKey() { return dkey(new Date()) }
    function shiftDays(key, n) {
      const parts = String(key).split('-')
      const d = new Date(+parts[0], +parts[1] - 1, +parts[2])
      d.setDate(d.getDate() + n)
      return dkey(d)
    }

    /** 闭区间天数（含首尾）；非法输入返回 null。 */
    function daysBetween(fromDay, toDay) {
      const a = String(fromDay || '').split('-')
      const b = String(toDay || '').split('-')
      if (a.length !== 3 || b.length !== 3) return null
      const da = new Date(+a[0], +a[1] - 1, +a[2])
      const db = new Date(+b[0], +b[1] - 1, +b[2])
      if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return null
      return Math.round((db - da) / 86400000) + 1
    }

    function presetRange(id) {
      if (id === 'all') return { fromDay: undefined, toDay: undefined }
      const preset = PRESETS.find((p) => p.id === id)
      if (!preset || !preset.days) return { fromDay: undefined, toDay: undefined }
      const today = todayKey()
      return { fromDay: shiftDays(today, -(preset.days - 1)), toDay: today }
    }

    function modelColor(key) {
      let hash = 0
      for (let i = 0; i < key.length; i++) hash = ((hash * 31) + key.charCodeAt(i)) >>> 0
      return PALETTE[hash % PALETTE.length]
    }

    function makeFormatters(localeId) {
      const locale = localeId === 'zh' ? 'zh-CN' : 'en-US'
      let compact, plain, money2, money4
      try {
        compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })
        plain = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })
        money2 = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        money4 = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
      } catch {
        const str = { format: (n) => String(n) }
        compact = str; plain = str; money2 = str; money4 = str
      }
      return {
        compact: (n) => compact.format(n),
        plain: (n) => plain.format(n),
        pct: (share) => (share * 100).toFixed(1) + '%',
        money: (n) => {
          if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
          return (Math.abs(n) >= 1 ? money2 : money4).format(n)
        },
      }
    }

    /** 触发浏览器下载；壳里若被拦，调用方还有"复制"兜底。 */
    function downloadText(name, text, mime) {
      try {
        const blob = new Blob([text], { type: mime + ';charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = name
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => { try { URL.revokeObjectURL(url) } catch { /* ignore */ } }, 5000)
        return true
      } catch {
        return false
      }
    }

    /** 当前区间 → CSV：先「桶 × 模型」明细，再模型小计与总计；金额按各桶占比摊到行上。 */
    function csvOf(data) {
      const esc = (v) => {
        const s = v === null || v === undefined ? '' : String(v)
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
      }
      const row = (cells) => cells.map(esc).join(',')
      const cur = data.cost ? data.cost.currency : ''
      const lines = []
      lines.push(row(['# range', data.range.fromDay, data.range.toDay, 'granularity', data.granularity]))
      lines.push(row(['bucket', 'model', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total', 'calls', 'cost']))
      const byKey = new Map(data.models.map((m) => [m.key, m]))
      for (const b of data.buckets) {
        const byModel = b.byModel || {}
        for (const key of Object.keys(byModel).sort()) {
          const c = byModel[key]
          const m = byKey.get(key)
          const share = m && m.total > 0 ? c.total / m.total : 0
          const cost = m && typeof m.cost === 'number' ? (m.cost * share).toFixed(6) : ''
          lines.push(row([b.key, key, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, c.total, c.calls, cost]))
        }
      }
      lines.push('')
      lines.push(row(['# model totals', cur ? 'currency=' + cur : 'cost: not configured']))
      lines.push(row(['model', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total', 'calls', 'cost']))
      for (const m of data.models) {
        lines.push(row([m.key, m.input, m.output, m.cacheRead, m.cacheWrite, m.reasoning, m.total, m.calls,
          typeof m.cost === 'number' ? m.cost.toFixed(6) : '']))
      }
      lines.push('')
      const totals = data.totals
      lines.push(row(['# total', totals.input, totals.output, totals.cacheRead, totals.cacheWrite, totals.reasoning, totals.total, totals.calls,
        data.cost ? data.cost.total.toFixed(6) : '']))
      return lines.join('\r\n')
    }

    function niceStep(raw) {
      if (!(raw > 0)) return 1
      const exp = Math.floor(Math.log10(raw))
      const base = Math.pow(10, exp)
      const frac = raw / base
      const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10
      return nice * base
    }

    function bucketLabel(key, granularity, t) {
      if (granularity === 'month') return key
      if (granularity === 'week') return key.slice(5)
      return key.slice(5)
    }
    function bucketFull(key, granularity, t) {
      if (granularity === 'month') return key
      if (granularity === 'week') return t('date.weekOf').replace('{d}', key)
      return key
    }

    // ── 趋势折线图 ──
    function LineChart({ data, fmt, t, localeId }) {
      const granularity = data.granularity
      const buckets = data.buckets
      const modelKeys = useMemo(() => data.models.map((m) => m.key), [data.models])
      const [hidden, setHidden] = useState(() => new Set())
      const [hover, setHover] = useState(null)

      // 新数据到达：清悬浮；图例开关仅剔除不再存在的模型，保留用户选择。
      useEffect(() => {
        setHover(null)
        const keys = data.models.map((m) => m.key)
        setHidden((prev) => {
          if (!prev.size) return prev
          const next = new Set([...prev].filter((k) => keys.includes(k)))
          return next.size === prev.size ? prev : next
        })
      }, [data.generatedAt, data.granularity])

      const n = buckets.length
      const W = 640, H = 260, padL = 56, padR = 12, padT = 12, padB = 26
      const iw = W - padL - padR
      const ih = H - padT - padB

      const maxTotal = buckets.reduce((a, b) => Math.max(a, b.total || 0), 0)
      const step = niceStep((maxTotal || 1) / 4)
      const yMax = step * 4
      const yOf = (v) => padT + ih - (yMax > 0 ? (v / yMax) * ih : 0)
      const xOf = (i) => padL + (n <= 1 ? iw / 2 : (iw * i) / (n - 1))

      const ticks = [0, 1, 2, 3, 4].map((k) => k * step)
      const labelEvery = Math.max(1, Math.ceil(n / 7))

      const totalPoints = buckets.map((b, i) => xOf(i).toFixed(1) + ',' + yOf(b.total || 0).toFixed(1)).join(' ')
      const visibleModels = modelKeys.filter((k) => !hidden.has(k))

      function onMove(e) {
        if (!n) return
        const rect = e.currentTarget.getBoundingClientRect()
        if (!rect.width) return
        const rel = ((e.clientX - rect.left) / rect.width) * W
        const denom = n <= 1 ? 1 : iw / (n - 1)
        let i = Math.round((rel - padL) / denom)
        if (i < 0) i = 0
        if (i > n - 1) i = n - 1
        setHover(i)
      }

      const tipBucket = hover !== null && n ? buckets[hover] : null
      const tipRows = tipBucket
        ? visibleModels
            .map((k) => ({ key: k, value: (tipBucket.byModel && tipBucket.byModel[k] ? tipBucket.byModel[k].total : 0) }))
            .filter((r) => r.value > 0)
            .sort((a, b) => b.value - a.value)
        : []

      function toggle(key) {
        setHidden((prev) => {
          const next = new Set(prev)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }

      return h('div', null, [
        h('div', { key: 'c', className: 'tu-chart' }, [
          tipBucket ? h('div', {
            key: 'tip',
            className: 'tu-tip',
            style: {
              left: (xOf(hover) / W * 100) + '%',
              transform: hover > n * 0.55 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
            },
          }, [
            h('div', { key: 'd', className: 'tu-tip-d' }, bucketFull(tipBucket.key, granularity, t)),
            h('div', { key: 't', className: 'tu-tip-r' }, [
              h('span', { key: 'dot', className: 'tu-dot', style: { background: 'var(--dsw-alias-label-primary)' } }),
              h('span', { key: 'k', className: 'tu-tip-k' }, t('legend.total')),
              h('span', { key: 'v', className: 'tu-tip-v' }, fmt.plain(tipBucket.total || 0)),
            ]),
            ...tipRows.slice(0, 8).map((r) => h('div', { key: r.key, className: 'tu-tip-r' }, [
              h('span', { key: 'dot', className: 'tu-dot', style: { background: modelColor(r.key) } }),
              h('span', { key: 'k', className: 'tu-tip-k', title: r.key }, r.key),
              h('span', { key: 'v', className: 'tu-tip-v' }, fmt.plain(r.value)),
            ])),
            tipRows.length > 8 ? h('div', { key: 'more', className: 'tu-tip-r' }, t('others').replace('{n}', String(tipRows.length - 8))) : null,
          ]) : null,
          h('svg', {
            key: 's',
            viewBox: '0 0 ' + W + ' ' + H,
            onMouseMove: onMove,
            onMouseLeave: () => setHover(null),
            role: 'img',
            'aria-label': t('title'),
          }, [
            // 网格与 Y 轴刻度
            ...ticks.map((tk) => h('g', { key: 'y' + tk }, [
              h('line', {
                x1: padL, y1: yOf(tk), x2: W - padR, y2: yOf(tk),
                stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1,
              }),
              h('text', {
                x: padL - 6, y: yOf(tk) + 3.5, fontSize: 9.5, 'text-anchor': 'end',
                fill: 'var(--dsw-alias-label-secondary)',
              }, fmt.compact(tk)),
            ])),
            // X 轴标签
            ...buckets.map((b, i) => (i % labelEvery === 0 || i === n - 1)
              ? h('text', {
                key: 'x' + i, x: xOf(i), y: H - 8, fontSize: 9.5, 'text-anchor': 'middle',
                fill: 'var(--dsw-alias-label-secondary)',
              }, bucketLabel(b.key, granularity, t))
              : null),
            // 每模型细线（单桶区间折线退化为一个点、SVG 画不出来，改用圆点）
            ...visibleModels.map((k) => {
              const valueAt = (b) => (b.byModel && b.byModel[k] ? b.byModel[k].total : 0)
              if (n === 1) {
                return h('circle', {
                  key: k, cx: xOf(0), cy: yOf(valueAt(buckets[0])), r: 2.8,
                  fill: modelColor(k), opacity: 0.85,
                })
              }
              const pts = buckets.map((b, i) => {
                return xOf(i).toFixed(1) + ',' + yOf(valueAt(b)).toFixed(1)
              }).join(' ')
              return h('polyline', {
                key: k, points: pts, fill: 'none', stroke: modelColor(k),
                strokeWidth: 1.4, opacity: 0.85, strokeLinejoin: 'round',
              })
            }),
            // 合计粗线（同样：单桶时画圆点，否则「开始=结束」的区间只剩网格线）
            n > 1 ? h('polyline', {
              key: 'total', points: totalPoints, fill: 'none',
              stroke: 'var(--dsw-alias-label-primary)', strokeWidth: 2, strokeLinejoin: 'round',
            }) : (n === 1 ? h('circle', {
              key: 'total', cx: xOf(0), cy: yOf(buckets[0].total || 0), r: 3.5,
              fill: 'var(--dsw-alias-label-primary)',
            }) : null),
            // 悬浮十字线
            ...(() => {
              if (hover === null || !n) return []
              const cx = xOf(hover)
              return [
                h('line', {
                  key: 'cross', x1: cx, y1: padT, x2: cx, y2: padT + ih,
                  stroke: 'var(--dsw-alias-label-secondary)', strokeWidth: 1, strokeDasharray: '3 3', opacity: 0.8,
                }),
                h('circle', { key: 'ct', cx, cy: yOf(tipBucket.total || 0), r: 3, fill: 'var(--dsw-alias-label-primary)' }),
              ]
            })(),
          ]),
        ]),
        h('div', { key: 'lg', className: 'tu-legend', title: t('chart.toggle') }, [
          h('span', {
            key: 'tot', className: 'tu-chip',
            style: { cursor: 'default' },
          }, [
            h('span', { key: 'd', className: 'tu-dot', style: { background: 'var(--dsw-alias-label-primary)' } }),
            t('legend.total'),
          ]),
          ...modelKeys.map((k) => h('button', {
            key: k,
            type: 'button',
            className: 'tu-chip' + (hidden.has(k) ? ' tu-chip-off' : ''),
            onClick: () => toggle(k),
            title: k,
          }, [
            h('span', { key: 'd', className: 'tu-dot', style: { background: modelColor(k) } }),
            k,
          ])),
        ]),
      ])
    }

    // ── 模型排名柱状图（横向条）──
    function BarChart({ data, fmt, t }) {
      const models = data.models
      const MAX_ROWS = 12
      const top = models.slice(0, MAX_ROWS)
      const rest = models.slice(MAX_ROWS)
      const restTotal = rest.reduce((a, m) => a + m.total, 0)
      const restCost = rest.reduce((a, m) => a + (typeof m.cost === 'number' ? m.cost : 0), 0)
      const restPriced = rest.some((m) => typeof m.cost === 'number')
      const currency = data.cost ? data.cost.currency : ''
      const rows = top.map((m) => ({ key: m.key, total: m.total, share: m.share, cost: m.cost }))
      if (rest.length) {
        const grand = data.totals.total || 0
        rows.push({
          key: t('others').replace('{n}', String(rest.length)),
          total: restTotal,
          share: grand > 0 ? restTotal / grand : 0,
          cost: restPriced ? restCost : null,
          aggregate: true,
        })
      }
      const W = 640, labelW = 180, valueW = 178, padR = 8, rowH = 26, barH = 13, topPad = 4
      const H = topPad * 2 + rows.length * rowH
      const max = rows.reduce((a, r) => Math.max(a, r.total), 0) || 1
      const trackX = labelW
      const trackW = W - labelW - valueW - padR

      if (!rows.length) return h('div', { className: 'tu-state' }, t('empty'))

      return h('div', { className: 'tu-chart' }, [
        h('svg', { key: 's', viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': t('model') },
          rows.map((r, i) => {
            const y = topPad + i * rowH
            const bw = Math.max((r.total / max) * trackW, r.total > 0 ? 2 : 0)
            const displayKey = r.key.length > 26 ? r.key.slice(0, 25) + '…' : r.key
            const valueText = fmt.compact(r.total) + ' · ' + fmt.pct(r.share)
              + (typeof r.cost === 'number' ? ' · ' + currency + fmt.money(r.cost) : '')
            return h('g', { key: r.key + i }, [
              h('text', {
                x: labelW - 8, y: y + rowH / 2 + 3.5, fontSize: 10.5, 'text-anchor': 'end',
                fill: 'var(--dsw-alias-label-primary)',
              }, [h('title', { key: 't' }, r.key), displayKey]),
              h('rect', {
                x: trackX, y: y + (rowH - barH) / 2, width: trackW, height: barH, rx: 3,
                fill: 'var(--dsw-alias-bg-layer-2)',
              }),
              h('rect', {
                x: trackX, y: y + (rowH - barH) / 2, width: bw, height: barH, rx: 3,
                fill: r.aggregate ? 'var(--dsw-alias-label-secondary)' : modelColor(r.key),
              }),
              h('text', {
                x: W - padR, y: y + rowH / 2 + 3.5, fontSize: 10.5, 'text-anchor': 'end',
                fill: 'var(--dsw-alias-label-primary)', style: { 'font-variant-numeric': 'tabular-nums' },
              }, [h('title', { key: 't' }, valueText), valueText]),
            ])
          }),
        ),
      ])
    }

    // ── 维度折叠 / 排序（v1.3.0）──
    /** 把「按模型」的聚合结果折叠成「按厂商」；折线图与排行榜共用同一份。 */
    function aggregateByProvider(data) {
      const map = new Map()
      const add = (dst, src) => {
        for (const f of ['input', 'output', 'total', 'cacheRead', 'cacheWrite', 'reasoning', 'calls']) dst[f] = (dst[f] || 0) + (src[f] || 0)
        if (typeof src.cost === 'number') dst.cost = (typeof dst.cost === 'number' ? dst.cost : 0) + src.cost
        return dst
      }
      for (const m of data.models) {
        const key = m.provider || m.key
        if (!map.has(key)) map.set(key, { key, provider: key, model: '', input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0, cost: null, share: 0 })
        add(map.get(key), m)
      }
      const models = [...map.values()]
      const grand = data.totals.total || 0
      for (const m of models) m.share = grand > 0 ? m.total / grand : 0
      const prefix = (k) => (k.indexOf('/') > 0 ? k.slice(0, k.indexOf('/')) : k)
      const buckets = data.buckets.map((b) => {
        const byModel = {}
        for (const key of Object.keys(b.byModel || {})) {
          const pk = prefix(key)
          if (!byModel[pk]) byModel[pk] = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0 }
          add(byModel[pk], b.byModel[key])
        }
        return { ...b, byModel }
      })
      return { ...data, models, buckets, dimension: 'provider' }
    }

    /** 排序：用量优先，或（配了价目表时）金额优先；未定价的排后面。 */
    function sortModels(models, by) {
      const list = [...models]
      if (by === 'cost') list.sort((a, b) => ((b.cost || 0) - (a.cost || 0)) || (b.total - a.total))
      else list.sort((a, b) => (b.total - a.total) || ((b.cost || 0) - (a.cost || 0)))
      return list
    }

    // ── 汇总卡 ──
    function SummaryCards({ data, fmt, t, summary }) {
      const totals = data.totals
      const prompt = totals.input + totals.cacheRead + totals.cacheWrite
      const hit = prompt > 0 ? totals.cacheRead / prompt : null
      const cards = [
        { k: t('total'), v: fmt.compact(totals.total), title: t('total') },
        { k: t('input'), v: fmt.compact(totals.input), title: t('input') },
        { k: t('output'), v: fmt.compact(totals.output), title: t('output') },
        { k: t('cacheRead'), v: fmt.compact(totals.cacheRead), title: t('cacheRead') },
        { k: t('cacheWrite'), v: fmt.compact(totals.cacheWrite), title: t('cacheWrite') },
        { k: t('reasoning'), v: fmt.compact(totals.reasoning), title: t('reasoning') },
        {
          k: t('hitRate'),
          v: hit === null ? '—' : (hit * 100).toFixed(1) + '%',
          title: t('hitRate.note'),
        },
        { k: t('calls'), v: fmt.plain(totals.calls), title: t('calls') },
        { k: t('modelCount'), v: String(data.models.length), title: t('modelCount') },
        { k: t('buckets'), v: fmt.plain((data.buckets || []).length), title: t('buckets.note') },
      ]
      if (data.cost) {
        cards.splice(1, 0, {
          k: data.cost.currency + ' ' + t('cost'),
          v: fmt.money(data.cost.total),
          title: data.cost.unpricedModels > 0
            ? t('cost.partial').replace('{n}', String(data.cost.unpricedModels))
            : t('cost.note'),
        })
      }
      // v1.3.0：今日 / 本月（与当前区间无关的固定口径）+ 预算告警
      if (summary) {
        cards.push({ k: t('today'), v: fmt.compact(summary.today.totals.total), title: summary.day })
        cards.push({ k: t('month'), v: fmt.compact(summary.month.totals.total), title: summary.month.fromDay + ' → ' + summary.day })
        const cur = summary.budget.currency
        const pick = summary.budget.daily > 0
          ? { limit: summary.budget.daily, spent: summary.today.cost, period: t('today'), over: !!(summary.today.cost && summary.today.cost.total > summary.budget.daily) }
          : (summary.budget.monthly > 0
            ? { limit: summary.budget.monthly, spent: summary.month.cost, period: t('month'), over: !!(summary.month.cost && summary.month.cost.total > summary.budget.monthly) }
            : null)
        if (pick && cur && pick.spent) {
          cards.push({
            k: t('budget'),
            v: cur + fmt.money(pick.spent.total) + ' / ' + cur + fmt.money(pick.limit),
            title: t('budget.note').replace('{period}', pick.period)
              .replace('{spent}', cur + fmt.money(pick.spent.total)).replace('{limit}', cur + fmt.money(pick.limit))
              + (pick.over ? ' · ' + t('budget.over') : ''),
            over: pick.over,
          })
        }
      }
      return h('div', { className: 'tu-cards' },
        cards.map((c) => h('div', { key: c.k, className: 'tu-card', title: c.title || c.k }, [
          h('div', { key: 'k', className: 'tu-card-k' }, c.k),
          h('div', { key: 'v', className: 'tu-card-v' + (c.over ? ' tu-over' : '') }, c.v),
        ])),
      )
    }

    // ── 分区主体 ──
    function UsagePanel({ t, getLocale }) {
      const [granularity, setGranularity] = useState('day')
      const [preset, setPreset] = useState('30d')
      const [customFrom, setCustomFrom] = useState('')
      const [customTo, setCustomTo] = useState('')
      const [data, setData] = useState(null)
      const [status, setStatus] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(true)
      const [retryTick, setRetryTick] = useState(0)
      const [tick, setTick] = useState(0)
      const [sheet, setSheet] = useState(null)   // null | { kind:'export'|'prices'|'rebuild'|'config', ... }
      const [dimension, setDimension] = useState('model')   // 'model' | 'provider'
      const [sortBy, setSortBy] = useState('tokens')        // 'tokens' | 'cost'
      const [summary, setSummary] = useState(null)          // 今日/本月/预算（独立于当前区间）
      const seqRef = useRef(0)
      const pollRef = useRef(null)
      const activeRef = useRef(false)
      const mountedRef = useRef(true)
      const silentRef = useRef(false)            // 自动刷新：不闪 loading
      const autoRef = useRef(true)

      const customValid = preset !== 'custom' || (!!customFrom && !!customTo && customFrom <= customTo)
      const customDirty = preset === 'custom' && !customValid

      const { fromDay, toDay } = preset === 'custom'
        ? { fromDay: customFrom || undefined, toDay: customTo || undefined }
        : presetRange(preset)

      // 状态轮询：回填/重建期间 1.5s 一次；转 idle 时刷新一次统计。
      // mountedRef 守卫：分区卸载后既不 setState 也不再排下一轮。
      async function pollStatus() {
        if (!mountedRef.current) return
        try {
          const st = await rpc('status')
          if (!mountedRef.current) return
          setStatus(st)
          const active = !!(st.backfill || st.rebuilding)
          if (active) {
            activeRef.current = true
            pollRef.current = setTimeout(pollStatus, 1500)
          } else if (activeRef.current) {
            activeRef.current = false
            setRetryTick((v) => v + 1)
          }
        } catch (e) {
          if (mountedRef.current) pollRef.current = setTimeout(pollStatus, 4000)
        }
      }

      useEffect(() => {
        mountedRef.current = true
        pollStatus()
        return () => {
          mountedRef.current = false
          if (pollRef.current) clearTimeout(pollRef.current)
        }
      }, [])

      // 自动刷新：页面可见时按配置间隔静默重取（回填/重建期间交给 pollStatus 的 1.5s 轮询）；
      // 切回前台也立刻刷新一次。隐藏时完全不发请求。间隔来自 status.config.refreshSeconds。
      const refreshMs = Math.max(15, Math.min(3600, (status && status.config && status.config.refreshSeconds) || 60)) * 1000
      useEffect(() => {
        const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
        const bump = () => {
          if (!mountedRef.current || !visible() || !autoRef.current) return
          silentRef.current = true
          setTick((v) => v + 1)
          // pollRef 非空 = 已有一条轮询链在跑（回填/重建/失败重试），别叠第二条
          if (!pollRef.current) pollStatus()
        }
        const id = setInterval(bump, refreshMs)
        const onVisibility = () => { if (visible()) bump() }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
        return () => {
          clearInterval(id)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [refreshMs])

      // 今日/本月/预算：与当前区间无关，跟着刷新节奏走（失败静默，不影响主面板）
      useEffect(() => {
        let alive = true
        rpc('summary').then(
          (s) => { if (alive && mountedRef.current) setSummary(s) },
          () => { /* 静默：摘要失败不该让面板报错 */ },
        )
        return () => { alive = false }
      }, [retryTick, tick])

      // 统计加载（含 300ms 防抖与竞态防护；自动刷新走 silent，不闪 loading）
      useEffect(() => {
        if (!customValid) return undefined
        const seq = ++seqRef.current
        const silent = silentRef.current
        silentRef.current = false
        const timer = setTimeout(async () => {
          if (!silent) setLoading(true)
          try {
            const result = await rpc('stats', { granularity, fromDay, toDay })
            if (seqRef.current === seq) { setData(result); setError(null) }
          } catch (e) {
            if (seqRef.current === seq) setError(String((e && e.message) || e))
          } finally {
            if (seqRef.current === seq && !silent) setLoading(false)
          }
        }, 300)
        return () => clearTimeout(timer)
      }, [granularity, fromDay, toDay, customValid, retryTick, tick])

      function onGranularity(g) {
        if (g === granularity) return
        // v1.1.1：只换分组方式，**不再自动改区间**——原来"近30天↔近12周↔近12月"会自动跳，
        // 坐标系整体平移，反而让人以为"点了没反应"。
        setGranularity(g)
      }

      async function onRebuild(confirm) {
        let result
        try {
          result = await rpc('rebuild', confirm ? { confirm: true } : {})
        } catch (e) {
          setError(String((e && e.message) || e))
          return
        }
        // 存储里有「日志已不存在」的历史 → 先弹二次确认，用户点了才真重建
        if (result && result.needsConfirm) {
          setSheet({ kind: 'rebuild', orphanSessions: result.orphanSessions || 0 })
          return
        }
        setSheet(null)
        if (result && result.started === false) return   // 已在重建中，别再排轮询
        activeRef.current = true
        if (pollRef.current) clearTimeout(pollRef.current)
        pollStatus()
      }

      // ── 导出 / 价目表 / 设置 弹层 ──
      // 视图：按厂商折叠 + 排序（纯客户端，导出也跟着用户看到的走）
      const view = useMemo(() => {
        if (!data) return null
        const agg = dimension === 'provider' ? aggregateByProvider(data) : data
        return { ...agg, models: sortModels(agg.models, sortBy) }
      }, [data, dimension, sortBy])

      const configTemplate = () => JSON.stringify({ refreshSeconds: 60, budget: { daily: 0, monthly: 0 }, retentionDays: 0 }, null, 2)

      function priceTemplate() {
        const keys = data && data.models ? data.models.map((m) => m.key) : []
        const models = {}
        for (const key of (keys.length ? keys : ['provider/model'])) {
          models[key] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        }
        return JSON.stringify({ currency: '¥', models }, null, 2)
      }

      function openExport(format) {
        if (!view) return
        setSheet({
          kind: 'export',
          format,
          text: format === 'csv' ? csvOf(view) : JSON.stringify(view, null, 2),
          note: '',
        })
      }

      async function openConfig() {
        setSheet({ kind: 'config', text: '', loading: true, note: '', meta: (status && status.config) || null })
        try {
          const info = await rpc('config')
          setSheet((prev) => (prev && prev.kind === 'config' ? { ...prev, loading: false, text: info.text || '', meta: info } : prev))
        } catch (e) {
          setSheet((prev) => (prev && prev.kind === 'config'
            ? { ...prev, loading: false, note: t('config.bad').replace('{msg}', String((e && e.message) || e)) }
            : prev))
        }
      }

      async function saveConfig() {
        const text = (sheet && sheet.text) || ''
        setSheet((prev) => (prev ? { ...prev, busy: true, note: '' } : prev))
        try {
          const info = await rpc('config.save', { text })
          setSheet((prev) => (prev && prev.kind === 'config'
            ? { ...prev, busy: false, meta: info, text: info.text || '', note: t('config.saved') + (info.prunedDays ? ' · pruned ' + info.prunedDays : '') }
            : prev))
          setRetryTick((v) => v + 1)
        } catch (e) {
          setSheet((prev) => (prev && prev.kind === 'config'
            ? { ...prev, busy: false, note: t('config.failed').replace('{msg}', String((e && e.message) || e)) }
            : prev))
        }
      }

      async function openPrices() {
        setSheet({ kind: 'prices', text: '', loading: true, note: '', meta: (status && status.prices) || null })
        try {
          const info = await rpc('prices')
          setSheet((prev) => (prev && prev.kind === 'prices'
            ? { ...prev, loading: false, text: info.text || '', meta: info }
            : prev))
        } catch (e) {
          setSheet((prev) => (prev && prev.kind === 'prices'
            ? { ...prev, loading: false, note: t('prices.bad').replace('{msg}', String((e && e.message) || e)) }
            : prev))
        }
      }

      async function savePrices() {
        const text = (sheet && sheet.text) || ''
        setSheet((prev) => (prev ? { ...prev, busy: true, note: '' } : prev))
        try {
          const info = await rpc('prices.save', { text })
          setSheet((prev) => (prev && prev.kind === 'prices'
            ? { ...prev, busy: false, meta: info, text: info.text || '', note: t('prices.saved') }
            : prev))
          setRetryTick((v) => v + 1)   // 立刻按新价目表重算
        } catch (e) {
          setSheet((prev) => (prev && prev.kind === 'prices'
            ? { ...prev, busy: false, note: t('prices.failed').replace('{msg}', String((e && e.message) || e)) }
            : prev))
        }
      }

      function copySheet() {
        const text = (sheet && sheet.text) || ''
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text)
            setSheet((prev) => (prev ? { ...prev, note: t('copied') } : prev))
            return
          }
        } catch { /* 落到"下载"或手动选择 */ }
        setSheet((prev) => (prev ? { ...prev, note: t('copy') + ' ✗' } : prev))
      }

      const fmt = makeFormatters(getLocale())
      const busy = !!(status && (status.backfill || status.rebuilding))
      const minDay = data && data.dataSpan ? data.dataSpan.minDay : undefined

      const statusRow = error
        ? h('span', { key: 'e', className: 'tu-status tu-status-warn' }, t('error.head').replace('{msg}', error))
        : busy
          ? h('span', { key: 'b', className: 'tu-status' }, [
            h('span', { key: 'sp', className: 'tu-spin' }),
            status.rebuilding ? t('rebuilding') : t('backfill')
              .replace('{done}', String(status.backfill ? status.backfill.done : 0))
              .replace('{total}', String(status.backfill ? status.backfill.total : 0)),
          ])
          : h('span', { key: 'i', className: 'tu-status' }, t('idle') + ' · ' + t('status.auto'))

      return h('div', { className: 'tu-wrap' }, [
        h('div', { key: 'top', className: 'tu-top' }, [
          h('span', { key: 'title', className: 'tu-title' }, t('title')),
          h('div', { key: 'gran', className: 'tu-seg', role: 'group', 'aria-label': t('granularity'), title: t('g.note') },
            GRANULARITIES.map((g) => h('button', {
              key: g, type: 'button',
              className: g === granularity ? 'tu-on' : undefined,
              onClick: () => onGranularity(g),
            }, t('g.' + g))),
          ),
          h('select', {
            key: 'preset', className: 'tu-select', 'aria-label': t('range'),
            value: preset,
            onChange: (e) => setPreset(e.target.value),
          }, PRESETS.map((p) => h('option', { key: p.id, value: p.id }, t('r.' + p.id)))),
          preset === 'custom'
            ? h('span', { key: 'dates', className: 'tu-dates' }, [
              h('label', { key: 'lf' }, t('from')),
              h('input', {
                key: 'f', type: 'date', className: 'tu-date',
                value: customFrom, min: minDay, max: todayKey(),
                onChange: (e) => setCustomFrom(e.target.value),
              }),
              h('label', { key: 'lt' }, t('to')),
              h('input', {
                key: 't', type: 'date', className: 'tu-date',
                value: customTo, min: minDay, max: todayKey(),
                onChange: (e) => setCustomTo(e.target.value),
              }),
            ])
            : null,
          h('span', { key: 'sp', className: 'tu-spacer' }),
          data ? h('button', { key: 'ex', type: 'button', className: 'tu-btn', onClick: () => openExport('csv') }, t('exportBtn')) : null,
          h('button', { key: 'pr', type: 'button', className: 'tu-btn', onClick: openPrices }, t('pricesBtn')),
          h('button', { key: 'cf', type: 'button', className: 'tu-btn', onClick: openConfig }, t('setBtn')),
          h('button', {
            key: 'rb', type: 'button', className: 'tu-btn', disabled: busy,
            onClick: () => onRebuild(false),
          }, busy ? t('rebuilding') : t('rebuild')),
          statusRow,
          customDirty ? h('div', { key: 'hint', className: 'tu-hint' }, t('dateHint')) : null,
          status && status.orphanSessions > 0
            ? h('div', { key: 'orph', className: 'tu-hint' }, t('status.orphan').replace('{n}', String(status.orphanSessions)))
            : null,
          data && data.cost && data.cost.unpricedModels > 0
            ? h('div', { key: 'cp', className: 'tu-hint' }, t('cost.partial').replace('{n}', String(data.cost.unpricedModels)))
            : null,          status && status.storageOk === false ? h('div', { key: 'ns', className: 'tu-hint' }, t('noStorage')) : null,
        ]),
        error && !data ? h('div', { key: 'err', className: 'tu-state tu-state-err' }, [
          h('div', { key: 'm' }, t('error.head').replace('{msg}', error)),
          h('button', { key: 'r', className: 'tu-btn', style: { marginTop: '10px' }, onClick: () => setRetryTick((v) => v + 1) }, t('retry')),
        ]) : null,
        !data && !error ? h('div', { key: 'ld', className: 'tu-state' }, [h('span', { key: 's', className: 'tu-spin' }), ' ' + t('loading')]) : null,
        data && view && view.empty && !error ? h('div', { key: 'em', className: 'tu-state' }, t('empty')) : null,
        data && view && !view.empty ? h(React.Fragment, { key: 'body' }, [
          h(SummaryCards, { key: 'cards', data: view, fmt, t, summary }),
          h('div', { key: 'line', className: 'tu-panel' }, [
            h('div', { key: 'hd', className: 'tu-panel-hd' }, [
              h('span', { key: 't', className: 'tu-panel-t' },
                t('title') + ' · ' + t('g.' + granularity) + ' · ' + t('buckets.count').replace('{n}', String((view.buckets || []).length))),
              h('span', { key: 'n', className: 'tu-panel-note' },
                view.range.fromDay + ' → ' + view.range.toDay
                + (daysBetween(view.range.fromDay, view.range.toDay) !== null
                  ? '（' + t('span.days').replace('{n}', String(daysBetween(view.range.fromDay, view.range.toDay))) + '）'
                  : '')
                + ' · ' + t('chart.hover')),
            ]),
            h(LineChart, { key: 'c', data: view, fmt, t, localeId: getLocale() }),
          ]),
          h('div', { key: 'bar', className: 'tu-panel' }, [
            h('div', { key: 'hd', className: 'tu-panel-hd' }, [
              h('span', { key: 't', className: 'tu-panel-t' }, t('rank.title')),
              h('div', { key: 'dim', className: 'tu-seg', role: 'group' }, [
                h('button', {
                  key: 'm', type: 'button', className: dimension === 'model' ? 'tu-on' : undefined,
                  onClick: () => setDimension('model'),
                }, t('dim.model')),
                h('button', {
                  key: 'p', type: 'button', className: dimension === 'provider' ? 'tu-on' : undefined,
                  onClick: () => setDimension('provider'),
                }, t('dim.provider')),
                view.cost ? h('button', {
                  key: 's', type: 'button',
                  onClick: () => setSortBy((v) => (v === 'cost' ? 'tokens' : 'cost')),
                }, sortBy === 'cost' ? t('sort.cost') + ' ▾' : t('sort.tokens') + ' ▾') : null,
              ]),
              h('span', { key: 'n', className: 'tu-panel-note' }, view.range.fromDay + ' → ' + view.range.toDay),
            ]),
            h(BarChart, { key: 'c', data: view, fmt, t }),
          ]),
        ]) : null,
        loading && data ? h('div', { key: 'mini', className: 'tu-status' }, [h('span', { key: 's', className: 'tu-spin' })]) : null,
        // ── 弹层：导出 / 价目表 ──
        sheet ? h('div', {
          key: 'sheet',
          className: 'tu-modal-bg',
          onClick: (e) => { if (e.target === e.currentTarget) setSheet(null) },
        }, [
          h('div', { key: 'm', className: 'tu-modal' }, sheet.kind === 'export' ? [
            h('div', { key: 't', className: 'tu-modal-t' },
              t('export.title') + ' · ' + (sheet.format === 'csv' ? t('export.csv') : t('export.json'))),
            h('div', { key: 'n', className: 'tu-modal-note' }, t('export.note')),
            h('textarea', { key: 'a', className: 'tu-area', readOnly: true, value: sheet.text || '' }),
            h('div', { key: 'ft', className: 'tu-modal-ft' }, [
              h('button', { key: 'csv', type: 'button', className: 'tu-btn', onClick: () => openExport('csv') }, t('export.csv')),
              h('button', { key: 'json', type: 'button', className: 'tu-btn', onClick: () => openExport('json') }, t('export.json')),
              h('span', { key: 'r', className: 'tu-ok' }, sheet.note || ''),
              h('span', { key: 'sp', className: 'tu-spacer' }),
              h('button', { key: 'cp', type: 'button', className: 'tu-btn', onClick: copySheet }, t('copy')),
              h('button', {
                key: 'dl', type: 'button', className: 'tu-btn',
                onClick: () => {
                  if (!view) return
                  downloadText('token-usage-' + view.range.fromDay + '_' + view.range.toDay + '.' + sheet.format,
                    sheet.text || '', sheet.format === 'csv' ? 'text/csv' : 'application/json')
                  setSheet((prev) => (prev ? { ...prev, note: t('download') } : prev))
                },
              }, t('download')),
              h('button', { key: 'cl', type: 'button', className: 'tu-btn', onClick: () => setSheet(null) }, t('close')),
            ]),
          ] : sheet.kind === 'rebuild' ? [
            h('div', { key: 't', className: 'tu-modal-t' }, t('rebuild.warn.title')),
            h('div', { key: 'n', className: 'tu-modal-note' }, t('rebuild.warn.body').replace('{n}', String(sheet.orphanSessions || 0))),
            h('div', { key: 'ft', className: 'tu-modal-ft' }, [
              h('span', { key: 'sp', className: 'tu-spacer' }),
              h('button', { key: 'ok', type: 'button', className: 'tu-btn', onClick: () => onRebuild(true) }, t('rebuild.warn.ok')),
              h('button', { key: 'no', type: 'button', className: 'tu-btn', onClick: () => setSheet(null) }, t('rebuild.warn.cancel')),
            ]),
          ] : sheet.kind === 'config' ? [
            h('div', { key: 't', className: 'tu-modal-t' }, t('config.title')),
            h('div', { key: 'n', className: 'tu-modal-note' },
              t('config.note').replace('{path}', (sheet.meta && sheet.meta.path) || '~/.dsh/token-usage-config.json')),
            sheet.meta && sheet.meta.error
              ? h('div', { key: 'e', className: 'tu-ok-warn' }, t('config.bad').replace('{msg}', sheet.meta.error))
              : null,
            h('textarea', {
              key: 'a', className: 'tu-area', spellCheck: false,
              value: sheet.loading ? '' : (sheet.text || ''),
              placeholder: '{\n  "refreshSeconds": 60,\n  "budget": { "daily": 0, "monthly": 0 },\n  "retentionDays": 0\n}',
              onChange: (e) => setSheet((prev) => (prev ? { ...prev, text: e.target.value } : prev)),
            }),
            h('div', { key: 'ft', className: 'tu-modal-ft' }, [
              h('span', { key: 'r', className: 'tu-ok' }, sheet.loading ? t('loading') : (sheet.note || '')),
              h('span', { key: 'sp', className: 'tu-spacer' }),
              h('button', {
                key: 'tp', type: 'button', className: 'tu-btn',
                onClick: () => setSheet((prev) => (prev ? { ...prev, text: configTemplate(), note: '' } : prev)),
              }, t('config.template')),
              h('button', {
                key: 'sv', type: 'button', className: 'tu-btn', disabled: !!sheet.busy, onClick: saveConfig,
              }, sheet.busy ? t('loading') : t('config.save')),
              h('button', { key: 'cl', type: 'button', className: 'tu-btn', onClick: () => setSheet(null) }, t('close')),
            ]),
          ] : [
            h('div', { key: 't', className: 'tu-modal-t' }, t('prices.title')),
            h('div', { key: 'n', className: 'tu-modal-note' },
              t('prices.note').replace('{path}', (sheet.meta && sheet.meta.path) || '~/.dsh/token-usage-prices.json')),
            sheet.meta && sheet.meta.error
              ? h('div', { key: 'e', className: 'tu-ok-warn' }, t('prices.bad').replace('{msg}', sheet.meta.error))
              : null,
            h('textarea', {
              key: 'a', className: 'tu-area', spellCheck: false,
              value: sheet.loading ? '' : (sheet.text || ''),
              placeholder: '{\n  "currency": "¥",\n  "models": {\n    "provider/model": { "input": 1, "output": 2, "cacheRead": 0.1 }\n  }\n}',
              onChange: (e) => setSheet((prev) => (prev ? { ...prev, text: e.target.value } : prev)),
            }),
            h('div', { key: 'ft', className: 'tu-modal-ft' }, [
              h('span', { key: 'r', className: 'tu-ok' },
                sheet.loading ? t('loading') : (sheet.note || '')),
              h('span', { key: 'sp', className: 'tu-spacer' }),
              h('button', {
                key: 'tp', type: 'button', className: 'tu-btn',
                onClick: () => setSheet((prev) => (prev ? { ...prev, text: priceTemplate(), note: '' } : prev)),
              }, t('prices.template')),
              h('button', {
                key: 'sv', type: 'button', className: 'tu-btn', disabled: !!sheet.busy, onClick: savePrices,
              }, sheet.busy ? t('loading') : t('prices.save')),
              h('button', { key: 'cl', type: 'button', className: 'tu-btn', onClick: () => setSheet(null) }, t('close')),
            ]),
          ]),
        ]) : null,
      ])
    }

    // ── 插件生命周期 ──
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        let styleTag = null
        if (typeof document !== 'undefined' && document.head) {
          styleTag = document.createElement('style')
          styleTag.setAttribute('data-plugin', '@local/token-usage')
          styleTag.textContent = styleText()
          document.head.appendChild(styleTag)
        }

        const disposeLocale = ctx.locale.register(NS, { zh, en })
        const t = ctx.locale.bind(NS)
        const getLocale = () => {
          try { return ctx.locale.getSnapshot().active } catch { return 'en' }
        }

        const disposeSlot = ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'token-usage', order: 50, label: () => t('nav'), locale: NS },
          function Section(props) {
            const translate = props && typeof props.t === 'function' ? props.t : t
            return h(UsagePanel, { t: translate, getLocale })
          },
        ))

        return () => {
          disposeSlot()
          disposeLocale()
          if (styleTag && styleTag.parentNode) styleTag.parentNode.removeChild(styleTag)
        }
      },
    }
  },
})
