<div align="center">

# 📊 Token Usage for DSH

**Bolt a fuel gauge onto your [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Settings panel —**
**see exactly how many tokens every model burns, every day / week / month.**

[![License: MIT](https://img.shields.io/badge/License-MIT-ffd93d?style=flat-square&labelColor=2b2b2b)](LICENSE)
[![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-4f8ef7?style=flat-square&labelColor=2b2b2b)](#-install)
[![Version](https://img.shields.io/badge/version-1.0.0-22b07d?style=flat-square&labelColor=2b2b2b)](CHANGELOG.md)
[![Zero Deps](https://img.shields.io/badge/zero--deps-🟩_pure_SVG-e0566b?style=flat-square&labelColor=2b2b2b)](#-how-it-works)
[![Local Only](https://img.shields.io/badge/local--first-🔒_nothing_leaves_your_machine-9b6bff?style=flat-square&labelColor=2b2b2b)](#-privacy)

[English](README.md) · [简体中文](README.zh.md)

</div>

---

## ✨ Why you need this

DSH works hard for you — but **do you know what it costs you?** The account page shows a
balance, and raw logs are a pile of JSONL...

Now just open **Settings → 📊 Token Usage** and the answer draws itself:

```text
┌───────────────────────────────────────────────────────────────┐
│ 📊 Token Usage          ( Day | Week | Month )  [Last 30d ▾]  │
├───────────────────────────────────────────────────────────────┤
│ ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐       │
│ │  Total 🧮 │ │  Input ⬇️  │ │ Output ⬆️  │ │  Calls 📞 │       │
│ │   986.2M  │ │   610.0M  │ │    8.4M   │ │    947    │       │
│ └───────────┘ └───────────┘ └───────────┘ └───────────┘       │
│                                                               │
│ 📈 Trend (line chart)     ✦ hover any day → per-model details │
│     80M ┤            ╭─╮                                      │
│     40M ┤   ╭──╮  ╭──╯ ╰──╮       ─── total                  │
│         ┼───┴──┴──┴───────┴───      ─── alpha-chat            │
│          06-02    06-06    06-10     ─── beta-reason           │
│                                                               │
│ 🏆 Model ranking (bar chart)                                  │
│     alpha-chat       ████████████████░░░░  62.4%              │
│     beta-reason      █████░░░░░░░░░░░░░░░  31.8%              │
│     gamma-mini       ▍                      5.8%              │
└───────────────────────────────────────────────────────────────┘
```

> 🖼️ Schematic of the UI. The real thing follows DSH's theme tokens and looks great in
> **both light and dark mode**.

## 🎯 Features

| Area | What you get |
|---|---|
| 📅 **Granularity** | Flip between **Day / Week / Month** — Monday-start weeks, calendar months; only day buckets are stored, so switching is **instant and free** |
| 🗓️ **Custom range** | Presets (last 7 / 30 days, 12 weeks, 12 months, all time) + **pick your own start & end dates** — chart any window you like |
| 📈 **Line chart** | Bold total line + thin per-model lines, **crosshair hover** breaks down every day, click legend chips to toggle models |
| 🏆 **Bar chart** | Horizontal model ranking with share % — spot your biggest token sink at a glance 💸 |
| 🔁 **Rebuild** | One-click full re-scan — idempotent, watermarks guard against double-counting and gaps |
| 🛡 **Accounting** | Dirty counters fail closed, **retried attempts are billed too**, fork inheritance never double-counts, compaction is included |

## 🚀 Install

**Option one · straight from GitHub (recommended, DSH's standard channel)**

```powershell
dsh plugin --profile web add github:GIN0076/dsh-token-usage
```

**Option two · clone & install locally (works offline; the channel this repo was built on)**

```powershell
git clone https://github.com/GIN0076/dsh-token-usage.git
```

Then run `plugin_manager install_bundle` in DSH with the clone directory as target, or use
**Plugins page → Install Bundle** in the GUI.
(Got `ambiguous-install`? `remove_bundle` first, then install — a known leftover-link quirk.)

**Hard-refresh the page** (`Ctrl+Shift+R`) → open **Settings → 📊 Token Usage** 🎉

**Uninstall**: `plugin_manager remove_bundle` → `@local/token-usage` — zero host residue;
the data folder is yours to keep or delete.

## 🤔 How it works

```text
 ~/.dsh/sessions session logs (the single source of truth, read-only)
      │  ① live fold of session/event      ② startup backfill (watermark-idempotent,
      ▼                                     skips sessions whose bytes never changed)
 Host half ──▶ day × provider/model × six buckets ──▶ storage-domain (persistent)
      │                                              (corrupt? backup-and-skip + rebuild)
      ▼
 /token-usage-rpc  🔒 connection auth + loopback Host + same-origin Origin
      ▼ same-origin fetch (data never leaves your machine)
 Client half ──▶ Settings section + pure-SVG charts (no chart lib, no build, zero deps)
```

**Accounting details** (`stats.js` pure functions, guarded by 46 fixtures):

- ✅ Counted: `assistant/message` (including stream usage), **`assistant/attempt` — retries
  cost money too!**, `compaction/summary`
- 🏷️ Attribution: messages carry their own provider/model; attempts & compaction fall back to
  the latest request header
- 🚫 Skipped: unsafe integers, negatives, reasoning > output, totals that contradict buckets
- 🕐 Buckets use the **host's local timezone**; fork-inherited prefixes are cut by
  `inheritedEventCount` — your ancestors' tokens are never counted twice

## 🔒 Privacy

- **Local-first**: statistics come only from `~/.dsh/sessions` on this machine —
  **no network calls, no uploads, ever**
- Triple RPC fence: connection auth (cookie) + loopback Host + same-origin Origin
- MIT licensed. No telemetry, no accounts, no backdoors.

## 🧩 Architecture (for the tinkerer)

```text
 ~/.dsh/sessions session logs (the single source of truth, read-only)
      │  ① live: ctx.on('session/event') folds post-commit events
      │  ② backfill: sessionQuery.listSessions + readSession (watermark-idempotent;
      │              skip sessions whose file bytes are unchanged)
      ▼
 Host half host.js
   · storage-domain `token_usage` (per-record + backup-and-skip; path-safe base64url keys)
       - daily: day × provider/model × six counters
       - watermark: per-session { seq, route, bytes }
   · /token-usage-rpc exact route (connection auth + loopback Host + same-origin Origin)
       - stats {granularity, fromDay, toDay} → aggregation (stats.js pure functions)
       - status → { backfill, rebuilding, storageOk, dataSpan }
       - rebuild → full re-scan (pauses live folding + buffered replay to avoid races)
      ▼ same-origin POST fetch
 Client half client.js (static bundle, __ModuleLoader__)
   · settings.section entry (id: token-usage, order: 50)
   · Day/Week/Month segmented control + presets (7d/30d/12w/12m/all/custom dates) + rebuild
   · summary cards → trend line chart (bold total + per-model lines + crosshair + legend)
     → model ranking bar chart
```

| File | Responsibility |
|---|---|
| `stats.js` | Pure aggregation; `node stats.fixtures.mjs` runs **46 fixtures** (accounting / dedup / week-month buckets / custom ranges / rollup consistency) |
| `host.js` | Host half: folding, backfill, rebuild, storage, RPC |
| `client.js` | Client half: section, controls, two SVG charts |
| `cordis.patch.yml` | Bundle patch row (relative specifier `./host.js`) |
| `locale/{zh,en}.json` | Plugin Manager display metadata; section copy lives inline in client.js |

## 🛠️ Developer cheat sheet

| Want to… | Do this |
|---|---|
| Change the **Client half** (UI / charts) | Edit `client.js` → **hard-refresh the page** (client-hmr swaps the rev) |
| Change the **Host half** (stats / RPC) | Edit `host.js` → **restart DSH**; hot-editing a running host is limited by Node's per-URL ESM cache, so swap the filename to force a new generation (see below) |
| Run tests | `node stats.fixtures.mjs` (46 fixtures) |
| Syntax check | `node --check host.js && node --check client.js && node --check stats.js` |

**Host hot-reload recipe** (running, no restart): edit `host.js` → `Copy-Item host.js host2.js`
→ point the `cordis.patch.yml` row name at `'./host2.js'` → `remove_bundle` + `install_bundle`.
Why: Node caches ESM per URL in-process; a new filename = a fresh URL = freshly loaded code.
**Fresh installs and restarts are not affected by this at all.**

### ⚠️ Pitfalls we hit (all fixed; kept here as a field manual)

| Pitfall | Symptom | Root cause & fix |
|---|---|---|
| `connection` not injected | Every RPC returns an empty 400 | Cordis Context is a strict proxy: touching a non-injected service throws, and the webserver's catch-all turns it into 400. Fix: add `'connection'` to `inject` (same as open-in-app) |
| Broken disposer | Domain stuck `already-open` after every remove | `ctx.inject()` returns a **fiber, not a function** — calling it threw a TypeError and aborted `dom.close()`, leaking the reservation. Fix: try/catch per step, close first, let the parent ctx cascade child fibers |
| Inconsistent error check | Retry gave up after one attempt | `DomainError.code='already-open'` (hyphen) vs `message="… is already open"` (**space**) — check both |
| One-shot storage failure | `storageOk:false` forever | Added lazy recovery: retry `attachStorage` on later requests; when memory already holds data, skip hydrate (double-count guard) and overwrite disk instead |
| Ghost domain | A dead generation holds the reservation | `storageDomain.get(name)` returns the leaked handle — close it directly (the facility is a singleton, so the holder must be a dead fiber); now built into the retry path |

## 📦 Restoring after a DSH update

**Yes — one command.** The plugin source lives in **your workspace**, not in `~/.dsh`, so an
update never touches it; only the profile registration is cleared. Re-run the install command
(`remove` first if you hit `ambiguous-install`). No peer constraints: the bundle declares no
`@deepseek-ai/dsh-*` peers, so compatibility gates never block it, and every API it uses
(`settings.section` / `sessionQuery` / `storageDomain` / `webServer` / `connection` /
`session/event`) is stable upstream surface. After an update, run the four-step check:

1. `list_plugins` → `include:token-usage` should be `fiberPhase: active`
2. RPC returns **401** unauthenticated / **200** authenticated
3. Hard-refresh → both charts render in Settings
4. If you edited the Host half, confirm the filename in `cordis.patch.yml` still exists

**Data**: statistics are derived. Even if `~/.dsh` is wiped, restoring the session logs makes
the startup backfill **rebuild everything** — or hit "Rebuild" for a full re-scan. The source
of truth can't be lost, so the aggregates can always grow back.

## 📜 License

[MIT](LICENSE) © 2026 GIN0076 — issues and PRs welcome.

*Inspired by the usage panel in [ZCode Usage Stats](https://zcode.z.ai/en/docs/usage-stats)
and the accounting design of local-first trackers like ccusage / tokscale / token-history.*
