# Changelog

按 [Keep a Changelog](https://keepachangelog.com/) 组织，版本号遵循 [SemVer](https://semver.org/)。
0.x 期间：破坏既有用法的改动动**中间**那位，修 bug 与新增动最后一位。

## [Unreleased]

## [0.2.0] — 2026-10-17

三轮独立审查（一份本地报告 + 两轮子代理）的发现，分五批落地。

### 安全

- **代理路径上改状态的请求必须带本桥接自己的 `Origin`。** 此前代理会把操作员的会话 cookie
  注入它转发的每个请求，而本机任意进程只要 `Host` 头正确就能免认证驱动完整 GUI API。
- `Sec-Fetch-Site: cross-site` 的子资源一律 403（跨站**文档导航**仍放行，不会把 IDE 页面
  锁在自己的桥接外面）。
- 独立版自检页的反射型 XSS（URL 参数被原样插进 HTML 与内联脚本）已转义。
- 桥接不再把自己的 token 转发上游；`absolute-form` 请求目标被拒绝（400）。

### 行为变化

- 代理路径的非 GET 请求需要 `Origin`；独立版 `--listen` 的非 loopback 地址会被拒绝，
  要暴露须显式 `--allow-remote`。两者都只影响非浏览器客户端，IDE 内嵌页面不受影响。
- 点击上报只保留匹配用得上的属性（`title` / `aria-label` / `data-path|file|filepath|review-file`），
  环形日志不再携带 `value` / `href` / 任意 `data-*`。

### 修复

- 不再把"多段文字拼接"的元素当成路径（DSH 查看器标签条那种 DOM 会在外层再套一层包装，
  旧规则只看直接子节点所以放行），也不会再把**路径被拆成相邻文本节点**时判成拼接。
- 逗号 / 空格并列的两个路径不再被当成一条。
- `href` 不再劫持站内链接（只认 `file:`、相对路径、或落在已配置 root 下的绝对路径）。
- 带 `aria-haspopup` / `aria-expanded` 的控件（文件选择器）不再被胶囊接管吞掉。
- 点文件（`.gitignore`）现在能识别。
- 同一个文件连续两次 Alt/Ctrl+点击，第二次 diff 不再因快照重名而降级为普通打开。
- 配置页在"宿主没有向本客户端公开配置"时如实说明，不再一直显示"正在读取配置…"。
- 卸载时走同一条串行队列并加 `disposed` 守卫，排队中的改动不会再让桥接"复活"。
- 快照剪枝只清理 60 秒以上的旧文件，避免删掉并发请求正在读的那份。

### 新增

- 配置项「**diff 修饰键**」：`alt`（默认）/ `ctrl` / `shift` / `always`。Linux 上很多窗口
  管理器会把 Alt+点击截走，此前 diff 在这类机器上够不到。
- 配置项「**给模型一段锚点提示词**」（`anchorPrompt`，默认开）：可关，**活切换**。
- 注入配置里的 `clientRev`，页面每次 `hello` 上报它 —— 日志能看出"页面跑的是哪一版脚本"。
- CI（`.github/workflows/checks.yml`）：语法检查 + 三个不需要活 DSH 的套件。
- `peerDependencies`（optional）声明。

## [0.1.0] — 2026-10-16

首个公开版本：把官方 DSH Web GUI 放在第二个 loopback 源上，让任何 IDE 内嵌浏览器都能
当 DSH 的前端；点击界面里的文件路径即在编辑器打开，Alt/⌘+点击开原生 diff（含锚点定位、
行号回显、一层目录回退、胶囊接管开关、9 个配置字段与外置的独立版代理）。

[Unreleased]: https://github.com/ni123niwjsj/dsh-web-bridge/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ni123niwjsj/dsh-web-bridge/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ni123niwjsj/dsh-web-bridge/releases/tag/v0.1.0
