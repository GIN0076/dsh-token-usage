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
    const DEFAULT_PRESET = { day: '30d', week: '12w', month: '12m' }
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
      if (!res.ok) throw new Error('HTTP ' + res.status)
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
      let compact, plain
      try {
        compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })
        plain = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })
      } catch {
        compact = { format: (n) => String(n) }
        plain = { format: (n) => String(n) }
      }
      return {
        compact: (n) => compact.format(n),
        plain: (n) => plain.format(n),
        pct: (share) => (share * 100).toFixed(1) + '%',
      }
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
            // 每模型细线
            ...visibleModels.map((k) => {
              const pts = buckets.map((b, i) => {
                const v = b.byModel && b.byModel[k] ? b.byModel[k].total : 0
                return xOf(i).toFixed(1) + ',' + yOf(v).toFixed(1)
              }).join(' ')
              return h('polyline', {
                key: k, points: pts, fill: 'none', stroke: modelColor(k),
                strokeWidth: 1.4, opacity: 0.85, strokeLinejoin: 'round',
              })
            }),
            // 合计粗线
            n > 1 ? h('polyline', {
              key: 'total', points: totalPoints, fill: 'none',
              stroke: 'var(--dsw-alias-label-primary)', strokeWidth: 2, strokeLinejoin: 'round',
            }) : null,
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
      const rows = top.map((m) => ({ key: m.key, total: m.total, share: m.share }))
      if (rest.length) {
        const grand = data.totals.total || 0
        rows.push({
          key: t('others').replace('{n}', String(rest.length)),
          total: restTotal,
          share: grand > 0 ? restTotal / grand : 0,
          aggregate: true,
        })
      }
      const W = 640, labelW = 180, valueW = 108, padR = 8, rowH = 26, barH = 13, topPad = 4
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
              }, fmt.compact(r.total) + ' · ' + fmt.pct(r.share)),
            ])
          }),
        ),
      ])
    }

    // ── 汇总卡 ──
    function SummaryCards({ data, fmt, t }) {
      const cards = [
        { k: t('total'), v: fmt.compact(data.totals.total) },
        { k: t('input'), v: fmt.compact(data.totals.input) },
        { k: t('output'), v: fmt.compact(data.totals.output) },
        { k: t('cacheRead'), v: fmt.compact(data.totals.cacheRead) },
        { k: t('calls'), v: fmt.plain(data.totals.calls) },
        { k: t('modelCount'), v: String(data.models.length) },
      ]
      return h('div', { className: 'tu-cards' },
        cards.map((c) => h('div', { key: c.k, className: 'tu-card', title: c.k }, [
          h('div', { key: 'k', className: 'tu-card-k' }, c.k),
          h('div', { key: 'v', className: 'tu-card-v' }, c.v),
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
      const seqRef = useRef(0)
      const pollRef = useRef(null)
      const activeRef = useRef(false)
      const mountedRef = useRef(true)

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

      // 统计加载（含 300ms 防抖与竞态防护）
      useEffect(() => {
        if (!customValid) return undefined
        const seq = ++seqRef.current
        const timer = setTimeout(async () => {
          setLoading(true)
          try {
            const result = await rpc('stats', { granularity, fromDay, toDay })
            if (seqRef.current === seq) { setData(result); setError(null) }
          } catch (e) {
            if (seqRef.current === seq) setError(String((e && e.message) || e))
          } finally {
            if (seqRef.current === seq) setLoading(false)
          }
        }, 300)
        return () => clearTimeout(timer)
      }, [granularity, fromDay, toDay, customValid, retryTick])

      function onGranularity(g) {
        if (g === granularity) return
        const prevDefault = DEFAULT_PRESET[granularity]
        setGranularity(g)
        // 预设区间跟随粒度（自定义/全部保持用户选择）
        if (preset === prevDefault) setPreset(DEFAULT_PRESET[g])
      }

      async function onRebuild() {
        try {
          await rpc('rebuild')
        } catch (e) {
          setError(String((e && e.message) || e))
          return
        }
        activeRef.current = true
        if (pollRef.current) clearTimeout(pollRef.current)
        pollStatus()
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
          : h('span', { key: 'i', className: 'tu-status' }, t('idle'))

      return h('div', { className: 'tu-wrap' }, [
        h('div', { key: 'top', className: 'tu-top' }, [
          h('span', { key: 'title', className: 'tu-title' }, t('title')),
          h('div', { key: 'gran', className: 'tu-seg', role: 'group', 'aria-label': t('granularity') },
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
          h('button', {
            key: 'rb', type: 'button', className: 'tu-btn', disabled: busy,
            onClick: onRebuild,
          }, busy ? t('rebuilding') : t('rebuild')),
          statusRow,
          customDirty ? h('div', { key: 'hint', className: 'tu-hint' }, t('dateHint')) : null,
          status && status.storageOk === false ? h('div', { key: 'ns', className: 'tu-hint' }, t('noStorage')) : null,
        ]),
        error && !data ? h('div', { key: 'err', className: 'tu-state tu-state-err' }, [
          h('div', { key: 'm' }, t('error.head').replace('{msg}', error)),
          h('button', { key: 'r', className: 'tu-btn', style: { marginTop: '10px' }, onClick: () => setRetryTick((v) => v + 1) }, t('retry')),
        ]) : null,
        !data && !error ? h('div', { key: 'ld', className: 'tu-state' }, [h('span', { key: 's', className: 'tu-spin' }), ' ' + t('loading')]) : null,
        data && data.empty && !error ? h('div', { key: 'em', className: 'tu-state' }, t('empty')) : null,
        data && !data.empty ? h(React.Fragment, { key: 'body' }, [
          h(SummaryCards, { key: 'cards', data, fmt, t }),
          h('div', { key: 'line', className: 'tu-panel' }, [
            h('div', { key: 'hd', className: 'tu-panel-hd' }, [
              h('span', { key: 't', className: 'tu-panel-t' }, t('title') + ' · ' + t('g.' + granularity)),
              h('span', { key: 'n', className: 'tu-panel-note' }, data.range.fromDay + ' → ' + data.range.toDay + ' · ' + t('chart.hover')),
            ]),
            h(LineChart, { key: 'c', data, fmt, t, localeId: getLocale() }),
          ]),
          h('div', { key: 'bar', className: 'tu-panel' }, [
            h('div', { key: 'hd', className: 'tu-panel-hd' }, [
              h('span', { key: 't', className: 'tu-panel-t' }, t('model') + ' · ' + t('share')),
              h('span', { key: 'n', className: 'tu-panel-note' }, data.range.fromDay + ' → ' + data.range.toDay),
            ]),
            h(BarChart, { key: 'c', data, fmt, t }),
          ]),
        ]) : null,
        loading && data ? h('div', { key: 'mini', className: 'tu-status' }, [h('span', { key: 's', className: 'tu-spin' })]) : null,
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
