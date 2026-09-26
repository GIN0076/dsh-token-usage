/**
 * @local/token-usage —— 包入口（re-export 真源 host.js）。
 *
 * cordis.patch.yml 的行 name 指向 './host.js'（相对文件符，anchored beside patch 文件）。
 * 全新安装 / 重启直接加载它，无额外讲究。
 *
 * ★ 运行中热改 Host 半时才有的坑：Node ESM 按 URL 进程内缓存，
 *   改 host.js 后 remove+install 不换模块代际（实测 2026-09-25）。换代流程：
 *     ① 改 host.js → node --check
 *     ② Copy-Item host.js host<N>.js（下一个未用编号）
 *     ③ cordis.patch.yml 行 name 改 './host<N>.js'
 *     ④ plugin_manager remove_bundle → install_bundle
 *   详见 README「Host 半热更流程 / Host hot-reload recipe」。
 */
export { name, inject, apply } from './host.js'
