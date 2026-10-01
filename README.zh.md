<div align="center">

# 📊 词元用量统计 · Token Usage for DSH

**给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的设置面板装一块「油耗表」——**
**每个模型每天 / 每周 / 每月烧掉多少 token，打开设置一眼看清。**

[![License: MIT](https://img.shields.io/badge/License-MIT-ffd93d?style=flat-square&labelColor=2b2b2b)](LICENSE)
[![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-4f8ef7?style=flat-square&labelColor=2b2b2b)](#-安装)
[![Version](https://img.shields.io/badge/version-1.3.0-22b07d?style=flat-square&labelColor=2b2b2b)](CHANGELOG.md)
[![Zero Deps](https://img.shields.io/badge/zero--deps-🟩_纯_SVG_零构建-e0566b?style=flat-square&labelColor=2b2b2b)](#-它怎么工作)
[![Local Only](https://img.shields.io/badge/本地优先-🔒_数据不出机-9b6bff?style=flat-square&labelColor=2b2b2b)](#-隐私)

English · [简体中文](README.zh.md)

</div>

---

## ✨ 为什么需要它

DSH 很能干活，但**它花了你多少 token**？账户页只给余额，原始日志是一坨 JSONL——

现在，打开 **设置 → 📊 词元用量**，答案直接画在你面前：

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ 📊 词元用量统计  ( 日 | 周 | 月 )  [近 30 天 ▾]   [导出] [价目表] [设置] [↻ 重新统计] │
├────────────────────────────────────────────────────────────────────────────┤
│ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐          │
│ │总词元🧮│ │ ¥成本  │ │ 输入⬇️ │ │ 输出⬆️ │ │缓存读🗃️│ │缓存命中│          │
│ │ 11.4亿 │ │ ¥3.42  │ │ 946.4万│ │ 145.8万│ │ 11.3亿 │ │ 99.2%  │          │
│ └────────┘ └────────┘ └────────┘ └────────┘ └────────┘ └────────┘          │
│ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐                     │
│ │ 今日   │ │ 本月   │ │ 预算   │ │ 请求数 │ │ 桶数   │   ← 预算超支会变红    │
│ │ 2.26亿 │ │ 11.4亿 │ │¥1.5/¥10│ │  3239  │ │   3    │                     │
│ └────────┘ └────────┘ └────────┘ └────────┘ └────────┘                     │
│                                                                            │
│ 📈 词元用量统计 · 日 · 共 3 个桶    2026-09-29 → 2026-10-01（3 天）· 悬浮查看明细 │
│     80M ┤            ╭─╮                                                   │
│     40M ┤   ╭──╮  ╭──╯ ╰──╮       ─── 合计                                 │
│         ┼───┴──┴──┴───────┴───      ─── alpha-chat                         │
│          06-02    06-06    06-10     ─── beta-reason                        │
│                                                                            │
│ 🏆 排行 · 占比            ( 按模型 | 按厂商 )  [按金额 ▾]                    │
│     alpha-chat       ████████████████░░░░  62.4% · ¥2.13                   │
│     beta-reason      █████░░░░░░░░░░░░░░░  31.8% · ¥1.09                   │
│     gamma-mini       ▍                      5.8% · ¥0.20                   │
└────────────────────────────────────────────────────────────────────────────┘
```

> 🖼️ 界面示意图（schematic）。金额 / 预算 / 今日 / 本月这几张卡**要先配价目表**（和可选的预算）才出现；
> 实际渲染跟随 DSH 主题 token，**明暗模式都好看**。

## 🎯 功能一览

| 分组 | 能力 |
|---|---|
| 📅 **粒度** | **日 / 周 / 月** 一键切换——周一起始、自然月；只存日桶，切粒度**零成本即时生效**。注意：汇总卡与排行榜是**整段区间的合计**（不随粒度变），随粒度变的是折线图分组与「**桶数**」卡 |
| 🗓️ **时间自定义** | 预设（近 7 天 / 30 天 / 12 周 / 12 个月 / 全部）+ **自定义起止日期**，任意范围出图 |
| 📈 **折线图** | 合计粗线 + 每模型细线，**悬浮十字线**逐日拆明细，图例点击开关单个模型 |
| 🏆 **柱状图** | 模型总量横向排名 + 占比% + 金额，一眼看出谁是吞金兽 💸 |
| 💰 **成本估算** | 自带价目表（`~/.dsh/token-usage-prices.json`，面板内可编辑），按**每百万 token 单价**估算金额；**插件不内置任何价格**，没配就不显示金额 |
| 💸 **预算与今日/本月** | 汇总卡带「今日 / 本月」固定口径；配了预算 + 价目表后出**预算卡**（`¥已花 / ¥预算`），**超支变红** |
| 🏷️ **多维度看数** | 排行榜与折线图可切「**按模型 / 按厂商**」；配了价目表后排行榜还能**按金额**排序 |
| ⚙️ **可配置** | 面板「设置」直接编辑 `~/.dsh/token-usage-config.json`：刷新间隔 / 预算 / 保留期 |
| 📊 **统计面** | 汇总卡：总词元 / 金额 / 输入 / 输出 / 缓存读 / 缓存写 / 推理 / **缓存命中率** / 请求数 / 模型数 |
| 📤 **导出** | 当前区间导出 **CSV**（桶 × 模型逐行 + 模型小计 + 总计）与 **JSON**，可复制或下载 |
| 🔄 **自动刷新** | 页面可见时每 60 秒静默重取，切回前台立即刷新，隐藏时完全不发请求 |
| 🔁 **重新统计** | 一键全量重扫重建——幂等，水位防双计、防漏计；**若存储里有「日志已不存在」的历史会先弹确认**（那部分无法重建，防手滑） |
| 🛡 **统计口径** | 脏数据 fail-closed 跳过、**摘要按事件自带 provider/model 归属**、fork 继承不双计、compaction 也入账 |

## 💰 成本怎么算（可选）

插件**不内置任何价格**——别人的价目表不等于你的账单。想看到金额，就在面板点「价目表」填一张：

```json
{
  "currency": "¥",
  "models": {
    "deepseek-account/deepseek-flash": { "input": 1, "output": 2, "cacheRead": 0.1, "cacheWrite": 1 }
  },
  "default": { "input": 1, "output": 2 }
}
```

- 单位 = **每百万 token 的价格**（币种取 `currency`，缺省 ¥）；模型键就是面板上显示的 `provider/model`
- `cacheRead`/`cacheWrite` 不填 → 按 `input` 价计；`default` 是兜底（没列出的模型按它算）
- 存到 `~/.dsh/token-usage-prices.json`（写入是「先写临时文件再原子替换」，不会写坏半个文件）
- 面板顶部「价目表 → 填入模板」会**把你当前数据里出现过的模型全列出来**，填数字即可
- 没定价的模型会被单独计数并在面板上明示「金额只算了有价的部分」——不会拿 0 糊弄你
- 清空内容再保存 = 关掉金额显示

> 价格是**估算**，不是账单：以 provider 官方计费为准。

## 🚀 安装

**方式一 · GitHub 一键（推荐，DSH 标准通道）**

```powershell
# 桌面版（本机默认运行的 profile 就是 desktop）
dsh plugin --profile desktop add github:GIN0076/dsh-token-usage
# 或不指定 profile，装进当前默认 profile
dsh plugin add github:GIN0076/dsh-token-usage
```

> ⚠️ 别照抄成 `--profile web`：那是网页版 profile，桌面 App 读的是 `desktop`，
> 装错 profile 会出现「命令成功、面板里啥也没有」。

**方式二 · 克隆后本地安装（离线可用，本仓开发期实测通道）**

```powershell
git clone https://github.com/GIN0076/dsh-token-usage.git
```

然后在 DSH 执行 `plugin_manager install_bundle`，target 选克隆目录；或用 GUI **插件页 → 安装 Bundle**。
（装完报 `ambiguous-install`？先 `remove_bundle` 再装即可——残留 link 的已知坑。）

装完 **硬刷新页面**（`Ctrl+Shift+R`）→ 打开 **设置 → 📊 词元用量** 🎉

**卸载**：`plugin_manager remove_bundle` → `@local/token-usage` —— 宿主零残留，数据目录可留可删。

## 🤔 它怎么工作

```text
 ~/.dsh/sessions 会话日志（唯一事实源，只读）
      │  ① 实时折叠 session/event      ② 启动回填（水位幂等，文件没变直接跳过）
      ▼
 Host 半 ──▶ 日 × provider/model × 六桶计数 ──▶ storage-domain 持久化
      │                                          （坏了也不慌：备份跳过 + 一键重建）
      ▼
 /token-usage-rpc  🔒 连接鉴权 + 回环 Host + 同源 Origin 三重栅栏
      ▼ 同源 fetch（数据不出本机）
 Client 半 ──▶ 设置面板分区 + 纯 SVG 双图（无图表库、无构建、零依赖）
```

**明细口径**（`stats.js` 纯函数，63 项夹具把关）：

- ✅ 计入：`assistant/message`（含流内 usage）、`compaction/summary`（**按事件自带的 provider/model 归属**）
- ⚠️ 支持但不承诺：`assistant/attempt` 也走同一条折叠逻辑，但 **0.2.0-rc.2 实测该事件不携带 usage**
  （18 个会话 / 17 条 attempt / 0 命中）——**重试与失败调用的花费上游不报，插件无源可算**，别指望这里能看出重试成本
- 🏷️ 路由归属：消息自带 provider/model；摘要优先自带、缺则回退最近一次请求头；尝试归最近请求头
- 🚫 跳过：非安全整数、负数、reasoning > output、total 与分桶矛盾的脏数据
- 🕐 时间桶落**宿主本地时区**；fork 继承前缀按 `inheritedEventCount` 截断——不算两遍祖先的账

## 🔒 隐私

- **只读本地**：统计完全来自本机 `~/.dsh/sessions`，**绝不联网、绝不上传**
- RPC 三重栅栏：连接鉴权（cookie）+ 回环 Host + 同源 Origin
- MIT 许可，无遥测、无账号、无后门

## 🧩 架构（给想改代码的你）

```text
 ~/.dsh/sessions 会话日志（唯一事实源，只读）
      │  ① 实时：ctx.on('session/event') 折叠 post-commit 事件
      │  ② 回填：sessionQuery.listSessions + readSession（水位幂等；字节未变快跳）
      ▼
 Host 半 host.js
   · storage-domain 域 token_usage（per-record + backup-and-skip；行键 path-safe base64url）
       - daily：日 × provider/model × 六桶计数
       - watermark：会话水位 { seq, route, bytes }
   · /token-usage-rpc 精确路由（连接鉴权 + 回环 Host + 同源 Origin 三重栅栏）
       - stats {granularity, fromDay, toDay} → 聚合（stats.js 纯函数，带价目表时附成本）
       - status → { backfill, rebuilding, storageOk, dataSpan, prices }
       - rebuild → 清空全量重扫（暂停折叠 + 缓冲补折防竞态；**存储含无源历史时先返回 needsConfirm**）
       - prices / prices.save → 读/写 ~/.dsh/token-usage-prices.json（写前校验 + 临时文件原子替换）
   · 鉴权/同源拒绝一律带 JSON 诊断体 {error, hint, seen{host,origin,site,cookie}}（不回显 cookie 值）
      ▼ 同源 POST fetch
 Client 半 client.js（静态 bundle，__ModuleLoader__）
   · settings.section 分区（id: token-usage, order: 50）
   · 日/周/月分段 + 预设区间（近7天/30天/12周/12个月/全部/自定义起止日期）+ 重新统计
   · 汇总卡 → 趋势折线图（合计粗线 + 每模型细线 + 悬浮十字线明细 + 图例开关）→ 模型排名柱状图
   · 价目表编辑器（模板/校验/保存）· 导出弹层（CSV/JSON，复制或下载）· 可见时 60s 自动刷新
```

| 文件 | 职责 |
|---|---|
| `stats.js` | 纯聚合函数；`node stats.fixtures.mjs` 跑 **63 项夹具**（口径/去重/路由归属/周月桶/自定义范围/滚算一致性/**价目表与成本**） |
| `host.js` | Host 半：折叠、回填、重建、存储、RPC |
| `client.js` | Client 半：分区、控件、两张 SVG 图表 |
| `cordis.patch.yml` | bundle patch 行（相对文件符 `./host.js`） |
| `locale/{zh,en}.json` | Plugin Manager 展示元数据；分区文案内联在 client.js |

## 🛠️ 开发者速查

| 想干什么 | 怎么做 |
|---|---|
| 改 **Client 半**（界面/图表） | 编辑 `client.js` → **硬刷新页面即生效**（client-hmr 换 rev） |
| 改 **Host 半**（统计/RPC） | 编辑 `host.js` → **重启 DSH**；运行中不重启热改受 Node ESM 按 URL 缓存所限，需换文件名强制换代（见下） |
| 跑测试 | `node stats.fixtures.mjs`（63）+ `node client.i18n.fixtures.mjs`（257）+ `node client.smoke.mjs`（51） |
| 语法检查 | `node --check host.js && node --check client.js && node --check stats.js` |

**Host 半热更流程**（运行中不重启时）：改 `host.js` → `Copy-Item host.js host2.js` →
`cordis.patch.yml` 行 name 改 `'./host2.js'` → `remove_bundle` + `install_bundle`。
原理：Node ESM 按 URL 进程内缓存，新文件名 = 新 URL = 强制加载新代码；
**全新安装 / 重启无此限制**。

### ⚠️ 踩过的坑（都已修复，写此备查）

| 坑 | 现象 | 根因与修法 |
|---|---|---|
| `connection` 未 inject | RPC 全 400 空 body | Cordis Context 是严格代理，访问未 inject 服务直接抛错，被 webserver 兜底成 400。修：`inject` 加 `'connection'`（open-in-app 同款） |
| disposer 中断 | 每次 remove 后域永久 `already-open` | `ctx.inject()` 返回 **fiber 不是函数**，`offRoute()` 抛 TypeError 掐断 `dom.close()` → reserved 泄漏。修：逐 step try/catch + close 优先，子 fiber 交给父 ctx 级联清理 |
| 错误判定不一致 | 重试一次就放弃 | `DomainError.code='already-open'`（连字符）vs `message="… is already open"`（**空格**）——code/message 必须双查 |
| 失败即永久内存态 | `storageOk:false` 不再恢复 | 加懒恢复：请求时重试 `attachStorage`；内存已有数据时跳过 hydrate（防双计）直接覆盖磁盘 |
| 幽灵域占坑 | 死代际占住 reserved | `storageDomain.get(name)` 取泄漏 handle 直接 `close()`（同 facility 单例 → 持有者必是死 fiber），已内建到重试路径 |

## 📦 本体更新后怎么装回来

**结论：能，一条命令。** 插件源码在**你的工作区**，不随 `~/.dsh` 卸装丢失；更新清掉的只是
profile 注册——重跑安装命令即可（报 `ambiguous-install` 就先 `remove` 再装）。
兼容性：零依赖 bundle 未声明 `@deepseek-ai/dsh-*` peer，不会被兼容门拦下；
用到的 API（`settings.section` / `sessionQuery` / `storageDomain` / `webServer` /
`connection` / `session/event`）都是上游稳定面，更新后跑一遍验收即可：

1. `list_plugins` 看 `include:token-usage` 是否 `fiberPhase: active`
2. RPC 未认证 **401** / 认证 **200**
3. 硬刷新页面 → 设置分区两张图正常
4. 若改过 Host 半，确认 `cordis.patch.yml` 指向的文件名存在

**数据面**：统计是派生数据。即使 `~/.dsh` 被清，会话日志还原后启动回填**自动重建**全部
用量历史；不放心就点「重新统计」全量重扫。事实源丢不掉，聚合表随时能长回来。

## 📜 许可

[MIT](LICENSE) © 2026 GIN0076 —— 欢迎 issue / PR。

*灵感来源：[ZCode Usage Stats](https://zcode.z.ai/en/docs/usage-stats) 的用量面板，以及
ccusage / tokscale / token-history 等本地优先统计工具的口径设计。*
