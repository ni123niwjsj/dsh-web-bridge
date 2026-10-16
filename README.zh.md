---
description: "在第二个 loopback 源上提供 DSH Web 界面，让任意 IDE 的内嵌浏览器（VS Code Simple Browser、JetBrains、VS Code 分支）都能使用；可选支持点击文件在编辑器里打开。"
kind: "package-reference"
---

# @ni123niwjsj/dsh-web-bridge

[English](README.md) | 中文

## 概述

在第二个 loopback 源上提供这套 DSH Web 界面。IDE 的内嵌浏览器直接嵌 `127.0.0.1:3080` 会被 DSH 的同源栅栏拒绝，本插件把界面放在自己的源上、以受信客户端的身份替你说话，于是**任何能显示网页的 IDE 都能当 DSH 的前端**；开启点击脚本后，UI 里的文件路径点击即在编辑器打开，Alt/⌘+点击开原生 diff。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

### 安装

DSH bundle 的标准安装命令（`<profile>` 换成你的 profile 名，Web 界面通常是 `web`）：

```bash
# 1) 从 GitHub 直接装（本仓库尚未发 npm 时用这个；装的是仓库当前状态）
dsh plugin --profile web add github:ni123niwjsj/dsh-web-bridge

# 2) 从 npm 装（发布之后）
dsh plugin --profile web add @ni123niwjsj/dsh-web-bridge

# 3) 本地开发：克隆下来指向目录
git clone https://github.com/ni123niwjsj/dsh-web-bridge && cd dsh-web-bridge
dsh plugin --profile web add link:$PWD
```

卸载是 `dsh plugin --profile web remove @ni123niwjsj/dsh-web-bridge`。

> ⚠️ **三种方式选一种，别混用** —— 它们装的是同一个包名，先后安装会并存冲突；要换方式先 `remove`。
> 本文档描述的行为在 **DSH 0.2.0-rc.2** 上实测过（还用到 `@deepseek-ai/schemastery` 与 `dsh-settings` 的运行时行为）。

装完按提示重启 DSH。插件随 DSH 启动而启动、随其退出而停止。唯一的落盘是**每次实例一个的临时根目录**（`mkdtemp` 出来的随机名，装 HEAD 快照与自检仓库），关闭桥接时整体删除。

### 使用

1. 设置 → **DSH Web Bridge**：确认状态是「运行中」，复制那里的地址（默认 `http://127.0.0.1:39977/`）。
2. IDE 里打开该地址：
   - VS Code：`Ctrl+Shift+P` → **Simple Browser: Show** → 粘贴地址
   - JetBrains 或其他 IDE：内置 Web 预览 / 外部浏览器
3. 想固定布局（面板在右、代码永远开中间）：把标签拖到右侧分栏 → 点一下那个组 → 命令面板 → **锁定组**。

### 配置

在本插件的**行配置页**里修改（设置 → 插件 → 找到本 bundle → 该行的「配置」）。这一页由插件自己渲染，`form`（实时值 + 写操作）由宿主交给它，所以带字段校验、`默认/已覆盖` 标记、逐字段「恢复默认」，以及保存后的反馈；写入走宿主的 settings 通道，落在 profile patch 里，不需要手改文件。保存涉及 `port`/`upstream`/`roots`/`injectClickScript`/`openCommand`/`launchMode` 时会按新配置重启桥接；`decorate`/`hijackChip` **不用重启**，刷新页面即可生效。

> **相对路径是怎么找到文件的（点击跳转的核心）：** 界面里显示的是**会话写入时的原样路径**（`dsh-web-bridge/lib/bridge.js`），而桥接自己的工作目录是**项目的上一级**（DSH 进程的 cwd），所以光靠它一个都解析不出来。宿主半边因此给桥接传的是一个**函数**（不是列表）：每次点击现取 `ctx.get('sessions').list()` 里每个活动会话的 `header.cwd`（子 agent 各有自己的会话，自动覆盖），加上用户在 `roots` 里配的目录、进程工作目录和 `$HOME`。会话是会来来去去的，**现取**才能让"桥接起来之后才新建的会话"也能点，不需要重启、也不需要你手工登记每个项目。`sessions` 不是硬依赖：没有它照样解析绝对路径和 `roots` 覆盖到的路径。解析失败时返回里带 `searched` 数组，页面快照里也有 `searchRoots`，就是为了让"它到底找了哪些目录"一眼可见。

> **维护者须知（一个很容易踩空的门）：** 表单能不能出现，取决于每个字段有没有标 `.volatile()`。宿主 `settings.describe()` 会用私有的 `volatileForm()` 过滤每个条目，**一个 volatile 字段都没有的条目会被整个丢掉**——该行连命名空间都不存在，`configForms.get()` 只会回 `unavailable`；此时 `configure({ auto: false }, ctx.fiber)` 写得再对也没有用，那只是"这行自带你自己的页面、别自动生成表单"的策略。标上之后，字段解析出来不再是普通值，而是 Loader 就地改写的冻结引用 `{ get() }`，所以每次读取都要现走 `.get()`（`readRowSettings()`）；改动以 `loader/volatile-update` 事件到达、**不会重挂插件**，由 `adopt()` 据此重启桥接。另外，改动端口时先绑新端口再释放旧端口，端口被占用也不会把正在用的桥接弄没。

| 字段 | 默认 | 含义 |
|---|---|---|
| `port` | `39977` | 第二个 loopback 源的端口 |
| `upstream` | `127.0.0.1:3080` | 要代理的、正在运行的 DSH Web 服务 |
| `roots` | `[]` | 相对路径**额外**允许的根目录。通常用不着：桥接会自动把**每个活动会话的工作目录**（`Session.header.cwd`，含子 agent）一起算进去，再加上进程工作目录与 `$HOME` |
| `injectClickScript` | `true` | 注入点击跳转脚本；关闭即纯代理 |
| `decorate` | `true` | 给它认出来的行内路径加虚线下划线 + 手型光标，让人看得出能点 |
| `hijackChip` | `off` | 是否接管官方胶囊的点击：`off` 官方预览照常打开（默认）；`auto` 只在 IDE 壳里接管；`on` 总是接管，只开编辑器 |
| `autoStart` | `true` | 插件激活时自动启动 |
| `openCommand` | `code` | 打开文件的编辑器命令（`code`、`codium` 或绝对路径） |
| `launchMode` | `auto` | `auto` 先 CLI 再桌面 portal；`editor` 只用 CLI；`portal` 走 `vscode://` + xdg-desktop-portal（Linux） |

### 点击跳转是怎么工作的

注入脚本（`lib/click-script.js`，由桥接按请求现读磁盘发出）做两件事，**都不依赖 DSH、也不依赖写消息的模型用什么格式**：

1. **认**：从被点的元素往上走最多 8 层，看属性（`title` / `aria-label` / `href` / `data-path` / `data-file` / `data-review-file`）里有没有路径，再看这个元素的**整段文字**是不是一个路径（可带 `:123` / `:123-145` / `#L123` / `#锚点`）。路径段允许非 ASCII 与空格，所以中文文件名、带空格的工作目录都能点。官方胶囊那种"路径在 `title`、行号在可见文字里"的形态会把两边合起来用，所以行号不会丢。
2. **标外观**：凡是它认出来的**行内**元素，加上虚线下划线 + 手型光标 + hover 时的小图标（鼠标悬停还有提示气泡）。这一步的意义是：**路径看起来就能点**，不需要谁事先知道有这功能。`Alt`/`⌘` + 点击走**真正的 diff**（`code -r --diff <HEAD 快照> <文件>`；非 git 仓库、没有 HEAD 版本、或编辑器拒绝时，按设计降级为普通打开）。
3. **找文件**：绝对路径直接用；相对路径按**搜索目录**逐个拼（配置的 `roots` + **每个活动会话的工作目录** + 进程工作目录 + `$HOME`）。**全都没命中时再往下扫一层** —— 对每个搜索目录试它的**直接子目录**（`docs/TODO.md` → `<root>/*/docs/TODO.md`），因为人和模型写路径时，基准常常是"我正在干活的那个子目录"，而不是会话根。这一层**只在唯一命中时才用**：多处命中会**列出候选并拒绝猜** —— 静默打开一个似是而非的文件，比开不了更糟。
4. **回显**：打开前桥接读一下目标行（有界，最多 512KB），把结果写进左下角提示：成功时显示那一行的内容（`:250 「token: deriveToken(secret),」`）；行号**越过文件末尾**时直接警告「文件只有 165 行」；走了子目录回退时注明"在 `xxx/` 下找到"。**这一层是让"跳错行"当场可见的关键** —— 行号是写消息那一刻的快照，文件一改就过期，而"那一行是什么"骗不了人。

5. **锚点定位（`Alt` 之外更聪明的那一招）**：行号是**写消息那一刻的快照**，文件一改就过期，而且过期不报错 —— 你会被安静地送到一行无关的代码上。所以路径后面还可以跟**锚点**：`path#锚点文本`，由宿主在**点击那一刻**读文件、按字面量搜这段文本、算出当前行号。

   | 写法 | 含义 |
   |---|---|
   | `path:24`、`path:24-30` | 行号 / 行范围（取起始行） |
   | `path#L24`、`path#L24-L30` | 同上，`#` 形式（DSH 自带的文件引用提示词就教模型这么写链接） |
   | `path#deriveToken` | **锚点**：在文件里搜这段文本，大小写敏感、取第一次出现 |

   优先级 **锚点 → 行号 → 只打开文件**：锚点命中就用它；命中多处取第一处但**如实报"N 处"**；锚点没找到就退回行号（并说明"没找到"）；两者都没有就只打开文件。**任何情况下都不会因为锚点而开不了文件。**

6. **接管官方胶囊(可选,默认关)**:点官方那个小胶囊时,DSH 自己也会开一个查看标签页 —— 加上我们的编辑器跳转就是"两个动作"。`hijackChip` 可以把它接管掉:在**捕获阶段** `stopPropagation()`,而 React 的 `onClick` 挂在根容器(`document` 的后代)上,于是它收不到事件,官方标签页不再出现。只在**我们确实识别出目标**时才拦。

   | 设置 | 点胶囊发生什么 |
   |---|---|
   | `off`(**默认**) | 编辑器跳转 **+** DSH 查看标签页(= 不做任何改变) |
   | `auto` | **在 IDE 壳里**只开编辑器;在真浏览器里保持官方行为 |
   | `on` | 总是只开编辑器 |
   | (`injectClickScript: false`) | 只有 DSH 查看标签页,没有编辑器跳转 |

   `auto` 判断"是不是 IDE 壳"**靠实测出来的事实,不是猜**:VS Code 的 Simple Browser **不是 iframe**(实测 `window.top === window`),真正有区分度的是 UA —— VS Code 是 `Code/1.141.0 … Electron/43.7.7`,真浏览器是干净的 `Chrome/154`。所以规则是 **UA 里出现 `Electron` / `Code/` / `vscode` / `JCEF`,或者页面自报嵌在框架里**。判定结果会随每次页面加载上报到 `/__bridge/log`(`kind: "hello"`,`shell` + `hijack` 字段),以后"为什么没接管"看日志即可。

   **失败会交还**:拦截是同步决定、打开是异步结果,所以万一编辑器那边失败,脚本会带一次性跳过标记**重新派发点击**,让官方查看标签页照常打开 —— 最坏情况是"和没接管一样",绝不会"什么都没发生"。

装饰有两个**不需要重启**的关闭方式：注入配置里给 `decorate: false`，或者在浏览器控制台执行
`localStorage.setItem("dsh-web-bridge:decorate", "off")`。

两个已知的边界，都是刻意的：

- **一段话中间夹着的路径不认**（要求整段文字就是路径）。规则是被真实误报逼紧的：状态行的 `168 tok/s69.3M tok` 差点被当成文件。
- **空格与非 ASCII 都认了**：路径段允许**非 ASCII 字母**（`测试清单.md`）和**单个空格**（`dsh workspace`）；属性通道里空格只允许出现在**第二个及以后的段**，否则前面的散文会被吸进路径（`Read src/api/server.ts` 会从 `Read` 开始匹配）。守门的是另一条更硬的规则：**点号后第一个字符必须是字母** —— 这就是 `168 tok/s69.3M tok` 仍然被拒的原因。
- **子目录回退只扫一层**：`<root>/*/path` 能命中，`<root>/*/*/path` 不能。两层会让误判面积变大，等真遇到再加。

另外，**DSH 自己的胶囊是另一条路**：它的解析是逐字的（token 必须完全等于本轮产出过的路径，或等于其中某个文件唯一的 basename），带 `:399` 这种后缀就不会变成胶囊；而且它点开的是 DSH 自己的预览标签页，那个接口只接路径、**不接行号**。所以"能不能跳到第几行"这件事，可靠的那条路始终是注入脚本这一条。

### 给模型的约定

插件会往系统提示词里注册**一段补充说明**（`systemPrompt.section`，名字 `dsh-web-bridge:file-anchors`，序号紧跟在 DSH 自带的文件引用段之后），只讲 DSH 自己那条提示词**讲不了**的部分：行号是快照、锚点才是耐久的，以及「**不确定行号就别写**」。DSH 原本那段已经规定了「用相对工作目录的路径」和 `#L24` 写法，所以这里不重复。注册失败只记一条警告，绝不影响桥接。

### 接口

桥接源上另有一组接口，需要派生出来的 token（放请求头，见文末「运行时不变量」），供排障与脚本调用；`/__bridge/client.js` 例外 —— 它由页面按需取用，本身不是秘密：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/__bridge/ping` | 状态：上游、roots、事件数 |
| GET | `/__bridge/log?limit=N` | 最近的 open/diff/click 事件（含点击到的真实 DOM） |
| POST | `/__bridge/open` | `{file, line?}` → 编辑器打开并定位 |
| POST | `/__bridge/diff` | `{file}` → 原生 diff（`--diff <HEAD 快照> <当前文件>`，失败降级为普通打开） |
| POST | `/__bridge/report` | 注入脚本上报点击 |
| GET | `/__bridge/selftest` | 在临时 git 仓库里验证快照、打开链路与目标行；**默认 dry-run**（只验证命令，不开编辑器），加 `?live=1` 才真的打开 |
| GET | `/__bridge/client.js` | 注入脚本本体 |

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

DSH 的 `/api` 入口要求 `Host` 是 loopback 或受信 authority、拒绝 `Sec-Fetch-Site: cross-site`、带 `Origin` 时必须与 `Host` 同源；索引页还需要那个 `HttpOnly; SameSite=Strict`、绑定 authority 的签名 cookie。嵌入 IDE webview 的页面两者都不满足，因此本插件：

- 用 `ctx.credentials` 里 `client-connection/browser-session` 的持久签名密钥现场铸 cookie；
- 上游请求剥掉 `Origin` / `Sec-Fetch-Site` / `Referer`（`Origin` 缺失即被 DSH 视为受信客户端）；
- 回程剥掉 `Set-Cookie`，嵌入方全程不持有凭据；
- HTTP 与 WebSocket 都转发，并在 `text/html` 响应里注入 `window.__DSH_BRIDGE__` 与点击脚本；
- 点击脚本只做启发式识别（官方 UI 的文件行没有 `href`）：整段文本必须**就是**一个路径、扩展名必须以字母开头、属性里匹配到哪段就只取哪段，识别不到时把真实 DOM 写进 `/__bridge/log`。

打开文件优先用编辑器 CLI（`code -r -g`），失败时回退到桌面 portal（`vscode://file/...` + `xdg-desktop-portal`）——后者是桥接自身跑在沙箱里时的唯一可用路径。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- 不装插件的最小版：仓库外同级目录 `dsh-bridge/`（单文件反代 + `run.sh`）。
- 相关 skill：`cordis-plugin-development`（本包的 Host/Client 结构与 Config 约定）、`cordis-composition-reference`（patch 方言）。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- **只绑 127.0.0.1**：桥接握着会话 cookie，不要改绑到非 loopback 地址。
- **单向**：只解决 DSH → 编辑器；反向（编辑器选区注入对话、hunk 级应用）需要 VS Code 扩展。
- **点击识别是启发式**：官方 UI 没有可供拦截的链接；误识别会把真实 DOM 记进日志，据此收紧规则。
- **`launchMode: portal` 仅 Linux**；macOS / Windows 用 `editor` 并在会话环境里运行 DSH。
- **版本耦合**：cookie 格式属 DSH 内部约定，DSH 更改后需同步；失败原因会写进设置页状态。
- 新文件 / 非 git 仓库没有 HEAD 版本 → diff 降级为「打开文件」。

**这一版修掉了什么（外部代码审查之后）**

- **桥接现在有自己的栅栏**：`Host` 必须是 `127.0.0.1:<端口>` / `localhost:<端口>`，带**外部 `Origin`** 的请求一律 403 —— **HTTP 与 WebSocket 升级都查**(浏览器在 WS 握手上一定会带 `Origin`,而 WS 没有 CORS 保护)。没有 `Origin` 的请求是导航/子资源,放行:它读不到任何响应内容,而 DNS rebinding 由上面那条 `Host` 规则挡住。此前升级那条路不做任何检查就把 `Origin`/`Sec-Fetch-Site` 抹掉转发上游，而 DSH 的栅栏认为"没有 Origin 就可信"，于是**任意网页都能以你的身份连上 `/api/remote.mux`**；畸形 `Host` 也能在请求监听器里同步抛异常，被 DSH 的 fail-loud 变成 `process.exit(1)`。现在监听器整体有 try/catch，处理链有 `.catch`，非法 `openCommand` 返回失败而不是抛，请求体有上限且容忍中断 —— **任何失败都只降级成告警/500，不会带走会话**。
- **token 回归它本来的角色**（CSRF）：只认请求头，不再接受查询串（那会进历史、日志和 `Referer`）；启动时校验 token 非空（此前两边都是 `undefined` 时会被判为通过）。
- **diff 是真的了**：此前从未传 `--diff`，而且 Alt+点击会把同一条命令**开两次**（独立版一直是对的）。现在是一条 `code -r --diff <HEAD 快照> <文件>`，失败才降级为普通打开。
- **不再泄漏监听器**：`start()`/`adopt()` 走同一条串行队列（此前 `start()` 只在 `handle` 上设防，而它两个 await 之后才赋值，连存两次端口会留下多个仍在监听的服务器）。
- **关得干净**：`close()` 会销毁升级后的隧道；HEAD 快照与自检仓库都放在**每次实例一个的临时根目录**里（随机名、`wx` 写入），关闭时整体删除。
- **不再阻塞事件循环**：`git` 调用改为异步（此前最坏能在会话里冻 15 秒），文件判定从两次 syscall 减到一次。
- **注入的 JSON 做了 `<` 转义**（会话工作目录里出现 `</script>` 时不会提前结束脚本元素）。

**仍然保留的有意选择**

- **绝对路径与 `..` 仍然允许**：界面里本来就会显示工作区外的路径，这是功能不是漏洞 —— 现在的边界是"谁能问"（栅栏 + token），而不是"能问什么"。
- **识别仍然严格**：句中夹着的路径、带空格的路径不认（误报的历史包袱：`168 tok/s69.3M tok`）。要放宽就得同时设计压误报的办法。
- **`?limit` 之外的诊断接口不做鉴权分级**：能在桥接源上说话的，本来就是持有 token 的那个页面。

**已知但未做**

- 目录扫描（一层回退）仍是同步 I/O，只是把 syscall 数和上限压低了；要彻底搬去 `fs/promises` 是另一批改动。
- 自检仓库与 HEAD 快照只在整个桥接关闭时清理，不是用完即删（要留到编辑器读完）。

- **锚点定位**：`path:行号` 里的行号是消息写出那一刻的**快照**，文件一改就过期 —— 而且过期**不报错**，只是安静地送到一行无关的代码上。改成 `path` + 一段唯一文本（函数名、一行代码），由宿主在**点击那一刻**读文件定位；三级降级：锚点唯一命中 → 锚点算出的行；否则 → 消息里的行号；都没有 → 只打开文件。这样任何情况下都不会跳错。
- **回显目标行**：打开前顺手读一下那一行，写进 toast（`:250 · 「token: deriveToken(secret),」`）。跳错立刻可见，成本极低。
- **给模型一段提示词**：宿主有 `systemPrompt.section({ name, order, text })`，插件可以在自己的作用域里注册（也可以做成技能）。措辞方向：引用文件写 `path:行号`；**不确定就别写行号**（写错比不写更糟）；引用代码给唯一片段。注意这是**建议不是保证**，也修不了过期。
- **接管官方胶囊**（可选）：在捕获阶段 `stopPropagation()` 掐掉 DSH 自己的 `onClick`，点胶囊就不再多开一个 DSH 预览标签页。取舍是只能乐观拦截（编辑器失败时只剩 toast），所以应该做成开关。
- **把 `decorate` 做成 Config 字段**：外观开关目前只有 `localStorage["dsh-web-bridge:decorate"] = "off"` 这个逃生口；加字段需要一次 DSH 重启。
- **识别放宽**（取舍项）：句中夹着的路径、带空格的路径现在都不认。放宽要同时设计压误报的办法（历史上状态行 `168 tok/s69.3M tok` 差点被当成文件打开）。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

```bash
for f in lib/*.js; do node --check "$f"; done   # 注意要一个一个查
node verify-click-match.mjs    # 识别（锚点、中文、空格）+ token 自愈 + 外观 + toast + 接管三态与交还（89 项）
node verify-host-apply.mjs     # 宿主半边：volatile 标记、settings 门、就地读值、会话 root、token 派生、提示词段（35 项）
node verify-resolve.mjs        # 解析、回显、锚点、页面配置注入、真 diff 只启动一次、临时目录关闭即删（49 项）
node verify-live-config.mjs    # 真实桥接：改端口/开关、相对路径、token 跨重挂、连存不泄漏监听器（24 项）
node verify-config-page.mjs    # 客户端两个座位、写操作、控件配色（33 项）
node verify-plugin.mjs 39989   # 桥接本体：自己的栅栏、致命路径、自检（22 项，需要活着的 DSH）
node verify-support.mjs        # 自检：能否找到宿主自带的 schemastery / dsh-settings
# 合计 252 项
```

验证脚本（含 `verify-support.mjs`）不在 `files` 里，不会随包发布。`lib/bridge.js` 与 `dsh-bridge/dsh-bridge-proxy.mjs` 是同一份逻辑的两个形态（插件内 / 独立进程），改动需同步；**唯一的刻意差异**是前者接受一个 `roots` 提供函数（好拿到活动会话的工作目录），后者没有会话存储可问，只能靠 `--root`。

</details>

**运行时不变量：** 插件只监听 loopback，并且**只认自己的源**（`Host` 必须是自己，外部 `Origin`/cross-site 一律 403，HTTP 与 WebSocket 一视同仁）；卸载即随 `ctx.effect` 关闭；不新增任何持久状态；唯一写盘的是下面那个临时根目录。

**关于 token（一个曾经的真实故障）：** 桥接接口用的 token 由那把持久的 signing secret **派生**（`deriveToken`），不是每次激活随机生成 —— 因为页面会比桥接活得久：重启 DSH 会重挂插件，而已加载的文档只能靠**重新加载**才能拿到新 token，其余一切（走代理的 UI）都不受影响，于是症状就是"界面好好的、每次点击都静默 403"。派生之后，同一个 harness home 永远算出同一把 token，跨重启、跨重挂、跨插件升级都稳定。代价是它不能单独轮换（要轮就轮 DSH 的浏览器会话 secret）。注入脚本另外带一层自愈：遇到 403 先就地重读本文档的 HTML 换新 token 重试一次，换不到才刷新页面一次（20 秒冷却，避免死循环）。

## 许可

MIT —— 见 [LICENSE](./LICENSE)。

<p align="right"><a href="#ni123niwjsjdsh-web-bridge">回到顶部</a></p>
