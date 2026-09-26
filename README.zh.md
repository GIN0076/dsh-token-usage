<div align="center">

# 📊 词元用量统计 · Token Usage for DSH

**给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的设置面板装一块「油耗表」——**
**每个模型每天 / 每周 / 每月烧掉多少 token，打开设置一眼看清。**

[![License: MIT](https://img.shields.io/badge/License-MIT-ffd93d?style=flat-square&labelColor=2b2b2b)](LICENSE)
[![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-4f8ef7?style=flat-square&labelColor=2b2b2b)](#-安装)
[![Version](https://img.shields.io/badge/version-1.0.0-22b07d?style=flat-square&labelColor=2b2b2b)](CHANGELOG.md)
[![Zero Deps](https://img.shields.io/badge/zero--deps-🟩_纯_SVG_零构建-e0566b?style=flat-square&labelColor=2b2b2b)](#-它怎么工作)
[![Local Only](https://img.shields.io/badge/本地优先-🔒_数据不出机-9b6bff?style=flat-square&labelColor=2b2b2b)](#-隐私)

English · [简体中文](README.zh.md)

</div>

---

## ✨ 为什么需要它

DSH 很能干活，但**它花了你多少 token**？账户页只给余额，原始日志是一坨 JSONL——

现在，打开 **设置 → 📊 词元用量**，答案直接画在你面前：

```text
┌───────────────────────────────────────────────────────────────┐
│ 📊 词元用量统计      ( 日 | 周 | 月 )  [近 30 天 ▾]  [↻ 重新统计] │
├───────────────────────────────────────────────────────────────┤
│ ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐       │
│ │ 总词元 🧮  │ │  输入 ⬇️   │ │  输出 ⬆️   │ │ 请求数 📞  │       │
│ │  1.5 亿   │ │  603 万   │ │  148 万   │ │   889     │       │
│ └───────────┘ └───────────┘ └───────────┘ └───────────┘       │
│                                                               │
│ 📈 趋势折线图            ✦ 悬浮任意一天 → 当天各模型逐个拆开        │
│     80M ┤            ╭─╮                                      │
│     40M ┤   ╭──╮  ╭──╯ ╰──╮       ─── 合计                    │
│         ┼───┴──┴──┴───────┴───      ─── mimo-flash            │
│          09-18    09-22    09-25     ─── deepseek-flash        │
│                                                               │
│ 🏆 模型排名柱状图                                               │
│     mimo-v2.6-flash  ████████████████░░░░  75.6%              │
│     mimo-v2.6-pro    █████░░░░░░░░░░░░░░░  22.4%              │
│     deepseek-flash   ▍                      2.0%              │
└───────────────────────────────────────────────────────────────┘
```

> 🖼️ 界面示意图（schematic）。实际渲染跟随 DSH 主题 token，**明暗模式都好看**。

## 🎯 功能一览

| 分组 | 能力 |
|---|---|
| 📅 **粒度** | **日 / 周 / 月** 一键切换——周一起始、自然月；只存日桶，切粒度**零成本即时生效** |
| 🗓️ **时间自定义** | 预设（近 7 天 / 30 天 / 12 周 / 12 个月 / 全部）+ **自定义起止日期**，任意范围出图 |
| 📈 **折线图** | 合计粗线 + 每模型细线，**悬浮十字线**逐日拆明细，图例点击开关单个模型 |
| 🏆 **柱状图** | 模型总量横向排名 + 占比%，一眼看出谁是吞金兽 💸 |
| 🔁 **重新统计** | 一键全量重扫重建——幂等，水位防双计、防漏计 |
| 🛡 **统计口径** | 脏数据 fail-closed 跳过、**重试的请求照样计费**、fork 继承不双计、compaction 也入账 |

## 🚀 安装

**方式一 · GitHub 一键（推荐，DSH 标准通道）**

```powershell
dsh plugin --profile web add github:GIN0076/dsh-token-usage
```

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

**明细口径**（`stats.js` 纯函数，46 项夹具把关）：

- ✅ 计入：`assistant/message`（含流内 usage）、**`assistant/attempt`——重试也花钱！**、`compaction/summary`
- 🏷️ 路由归属：消息自带 provider/model；尝试/压缩归最近一次请求头
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
       - stats {granularity, fromDay, toDay} → 聚合（stats.js 纯函数）
       - status → { backfill, rebuilding, storageOk, dataSpan }
       - rebuild → 清空全量重扫（暂停折叠 + 缓冲补折防竞态）
      ▼ 同源 POST fetch
 Client 半 client.js（静态 bundle，__ModuleLoader__）
   · settings.section 分区（id: token-usage, order: 50）
   · 日/周/月分段 + 预设区间（近7天/30天/12周/12个月/全部/自定义起止日期）+ 重新统计
   · 汇总卡 → 趋势折线图（合计粗线 + 每模型细线 + 悬浮十字线明细 + 图例开关）→ 模型排名柱状图
```

| 文件 | 职责 |
|---|---|
| `stats.js` | 纯聚合函数；`node stats.fixtures.mjs` 跑 **46 项夹具**（口径/去重/周月桶/自定义范围/滚算一致性） |
| `host.js` | Host 半：折叠、回填、重建、存储、RPC |
| `client.js` | Client 半：分区、控件、两张 SVG 图表 |
| `cordis.patch.yml` | bundle patch 行（相对文件符 `./host.js`） |
| `locale/{zh,en}.json` | Plugin Manager 展示元数据；分区文案内联在 client.js |

## 🛠️ 开发者速查

| 想干什么 | 怎么做 |
|---|---|
| 改 **Client 半**（界面/图表） | 编辑 `client.js` → **硬刷新页面即生效**（client-hmr 换 rev） |
| 改 **Host 半**（统计/RPC） | 编辑 `host.js` → **重启 DSH**；运行中不重启热改受 Node ESM 按 URL 缓存所限，需换文件名强制换代（见下） |
| 跑测试 | `node stats.fixtures.mjs`（46 项） |
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
