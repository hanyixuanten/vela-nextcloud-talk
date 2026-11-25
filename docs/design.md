# 设计说明

## 1. 屏幕与安全区

圆屏（Xiaomi Watch S3/S4/S4 Sport）和矩形屏（REDMI Watch 5）分别构建，共用 480 的设计宽度。下文的裁切推导针对圆屏；矩形屏不受圆形弦宽约束，使用更宽的内容区及矩形键盘。打包方式见 [CI 说明](ci.md)。

圆形表盘（480×480，半径 240）上，某一 y 高度处的可用宽度：

```
half_width(y) = sqrt(240² - (y - 240)²)
```

取几个关键值：

| y | 可用宽度 | 用途 |
| --- | --- | --- |
| 30 | ≈ 230 | 贴顶区域，几乎放不下东西 |
| 70 | ≈ 340 | 聊天页标题栏起点（栏宽 70% = 336） |
| 110 | ≈ 387 | 会话卡片第一行起点（卡片 82% = 394，边缘仅轻微入弧） |
| 240 | 480 | 屏中，最宽 |
| 380 | ≈ 402 | 输入条 / 底部按钮的可用起点 |
| 436 | ≈ 277 | 底部按钮实际所在高度（≤ 56% 宽才完整可见） |

界面按百分比布局（`common/styles/theme.css` 只给令牌，宽度由各页决定），所以每个贴边元素都必须先算弦宽再定宽度：

1. **顶部不放导航。** 聊天页标题栏 `margin-top: 70px`、宽 70%；会话页头部留出 112px 才让卡片进入 82% 宽度。
2. **底部要窄。** 会话页底部两个胶囊合计 52%，聊天输入条 50%，配置页按钮 56%——它们都在 y≈436 的 277px 弦内。
3. **中部可以宽。** 消息气泡与卡片 82% 位于 y ∈ [110, 380]，弦宽 ≥ 387，完整可见。

滚动列表允许在极上/极下被裁掉一点：那是可滚动内容的自然结果，不属于固定元素。

## 2. 输入法占用与双状态

输入法组件在 `screentype: "circle"` 下固定占 `480×321`：

```
+--------------------------------+  y=0
|  可用 159px                    |
+--------------------------------+  y=159
|  InputMethod 480×321           |
|                                |
+--------------------------------+  y=480
```

159px 塞不下「标题栏 + 消息列表 + 输入框」，所以聊天页做成两个互斥状态，靠 `editing` 切换：

```
        tap 输入条                    tap 取消 / 发送成功
  ┌──────────────┐  ────────────────>  ┌──────────────┐
  │ 消息列表态    │                     │ 输入态        │
  │ title + list │  <────────────────  │ 草稿 + 按钮   │
  └──────────────┘      tap 输入条      └──────────────┘
```

输入态高度预算（150px，贴近键盘顶部对齐）：

| 元素 | 高度 |
| --- | --- |
| 会话名 / 引用摘要 | 约 22 / 36 |
| 草稿预览（最多显示末尾 60 字） | ≤ 2 行 ≈ 56 |
| 取消 / 发送按钮 | 46 |
| 间距 | 12 + 6 |

### 键盘是绝对定位的

`@components/InputMethod` 的根节点是 `position: absolute; left: 0; bottom: 0`，**完全不参与布局**。因此任何要贴在键盘上方的页面都必须自己留出键盘高度：

- 登录页（`pages/login`）把两个状态分别包进 `if` 容器（`layout` / `edit-panel`），`edit-panel` 末尾放一个与键盘等高的 `.keyboard-gap` 占位（圆屏 321；矩形 283 = 255 键盘 + 28 候选行），「下一个 / 完成」就落在占位上方。
- 状态切换必须用 `if` 而不是 `show`：`show` 只是不可见，节点仍占布局高度。两个状态同时占位时，按钮会被推到键盘下面，整页也因此变成可滚动。
- `.app-page` 统一 `overflow: hidden`：整页不允许滚动，列表一律用自己的 `<scroll>`。
- 两个状态容器都是 `height: 100%` 的列布局，其中 `flex: 1` 的子块吸收剩余高度，所以两者之和恒等于 1 屏，不会溢出。

聊天页犯过同一条错误，而且症状更彻底：`main`（消息列表态）和 `editor`（输入态）都用 `show`，连同两条 `show` 切换的输入条（一条可见、一条隐藏）一起参与布局——

| 块 | 圆屏高度 |
| --- | --- |
| 标题栏（70 上边距 + 72 高 + 6 下边距） | 148 |
| 两条输入条（8 + 58 + 40，各一条） | 212 |
| 输入态（隐藏但仍占位） | 150 |
| 合计 | 510 > 480 |

`flex: 1` 的消息列表因此解析成 0 高，整块只剩一条横缝。改成 `if` 后列表拿到 480 − 148 − 106 = 226px。聊天页模板里已经没有 `show`，登录页的键盘占位与两态互斥同样由 `if` 保证，两者都由 `tests/layout.test.mjs` 守护。

草稿只显示末尾 60 字（`DRAFT_VIEW_LIMIT`），前面加省略号。这是为了避免长消息挤占输入区域。长按服务端标为可回复的消息后，页面仅保存目标 ID 和 48 个 UTF-16 代码单元以内的单行摘要（另加省略号），不额外获取原消息。发送失败保留草稿和引用；成功后清除。

## 3. 消息顺序与游标

列表按 **ID 倒序**展示，每次拉取 12 条、最多保留 24 个用于渲染的消息对象。正文截到 512 个 UTF-16 代码单元以内（另加省略号），作者名截到 48；不常驻原始 OCS 对象、附件数据或图片。这是常驻显示数据的限制，不是完整 JSON 响应和原生渲染的峰值内存保证。

- 列表底部点「加载更早消息」，使用历史方向的 `X-Chat-Last-Given`（缺失时取最小 ID）。短页不代表结束，`304` 或游标不再前进才隐藏入口。
- 浏览历史时暂停向前轮询，窗口满后移出较新的行，仍可继续翻页。点「返回最新消息」重新获取最近一页并恢复轮询。历史载入不写已读。
- 新消息轮询有独立游标，发送成功只在界面插入新行，不移动轮询游标，以免跳过尚未拉到的消息。合并时按 ID 去重。

## 4. 状态机

```
app.ux onCreate
   └─ store.load() → api.configure()

pages/splash（路由入口）onShow
   └─ store.load() → network.checkNetwork(settings)
        ├─ 离线 → replace('/offline')  ──重试──> 回到 pages/splash（重新探测）
        └─ 在线 → ├─ 无账号 → replace('/setup')
                   └─ 有账号 → replace('/')   （pages/index 会话列表）

pages/index onShow
   └─ 无账号 → replace('/setup')；有账号 → refresh()
        （**没有**「是否通过网络门」的检查：跨 bundle 读不到那个值，一读就弹回 splash）

pages/login  ──submit──> api.getCurrentUser()
                          ├─ ok   → store.save → replace('/')
                          └─ fail → 留在本页，显示错误

pages/index  ──tap 会话──> state.activeRoom + shared.pendingRoom → nav.navigate(pages/chat, {token, name})
                          nav.navigate = 30ms replace(params) → 1300ms replace → 2400ms push
                                         → 3600ms 仍未离开才 toast + 头部留下路由器快照
                          （「到没到」比对 router.getState() 快照，不只看页面自己的 onHide）

pages/chat   onInit  → 取 token：router params → shared.pendingRoom → state.activeRoom
             onShow  → 首次拉最近一页；之后恢复轮询（历史模式除外）
             onHide / onDestroy → 停止定时器
             tap 加载更早 → 向后翻页、暂停轮询
             tap 返回最新 → 重取最近一页、恢复轮询
             send ok → 清草稿、插入消息并尽快轮询
```

轮询用 `setTimeout` 递归而不是 `setInterval`：`setInterval` 在网络慢的时候会堆积请求，递归可以保证上一次请求回来后再排下一次。

## 5. 存储结构

`@system.storage` 只能存字符串，所以全部 JSON 序列化。聊天页不落盘消息或翻页游标；保留的旧版 `nctalk.markers` 存储辅助函数当前不在聊天流程中使用。

```jsonc
// nctalk.settings
{
  "baseUrl": "https://cloud.example.com",
  "user": "alice",
  "appPassword": "xxxxx-xxxxx-xxxxx-xxxxx-xxxxx",
  "displayName": "Alice",
  "keyboardType": "QWERTY",   // QWERTY | T9
  "screenType": "circle",     // circle | rect
  "pollInterval": 15000,
  "fontScale": "normal"       // small | normal | large
}

// nctalk.markers
{ "a1b2c3d4": 12345 }         // token -> 最后已读消息 id
```

`normalize()` 在读取和写入时都会 trim 并去掉 `baseUrl` 的尾斜杠，避免出现 `https://host//ocs/v2.php`。

`parseJson()` 对损坏数据回退到默认值而不是抛异常：storage 是用户数据，宁可重置也不能白屏。

写入失败的错误信息必须自带原因。Vela 文档写 `fail(data, code)`，但实际固件并不统一：有的传单个 `{ data, code }` 对象，有的只传一个字符串，有的什么都不传。早期实现只读第二个参数，于是所有非标准形状都会变成 `storage write failed, code=undefined`——既没有错误码也没有原因，等于没有信息。`storageFailure()` 现在兼容四种形状，缺失错误码时写 `code=unknown`（绝不输出 `undefined`），并把平台文案放进 message、附上 `key=` 和待写入字符数（配额/单键长度限制是最常见的失败原因）。`storageCode` / `storageDetail` 单独挂在 Error 上，调用方不必解析字符串。

## 6. 安全模型

| 项 | 现状 | 说明 |
| --- | --- | --- |
| 凭证类型 | 应用密码 | 不用账号密码；丢失设备只需吊销单条应用密码 |
| 传输 | 强制 HTTPS | 客户端拒绝 HTTP；请求里不做证书 pinning，仍依赖系统 TLS 校验 |
| 本地存储 | 明文 | **Vela 没有 keystore API**，`@system.storage` 是应用沙箱内的普通存储，root 或提权后可见；清除本地账号后应在 Nextcloud 吊销应用密码 |
| 密码回显 | 掩码为 `•` | 输入态也只显示掩码 |
| 日志 | 不打印凭证 | `api.js` 只在失败时打错误文案，不打 header |

明文存储是平台限制，不是实现选择。缓解手段只有：用应用密码而不是账号密码、定期轮换、丢失设备时立即吊销。

## 7. 为什么不用长轮询 / WebSocket

向前查询使用 `lookIntoFuture=1&timeout=0`，不让服务端等待下一条消息。Vela 在退后台后对长连接的处理未验证；短轮询也更容易与历史翻页串行。代价是连接开销和默认约 15 秒的更新间隔（另加请求耗时）。

## 8. 其他设计决策

- **表情反应**：普通消息仅显示 👍、❤️、😂 的计数（超过 99 显示 `99+`，`•` 表示自己点过），每行只存三位状态和短文本。反应事件复用向前轮询，只更新窗口中的原消息，不插入事件行；发送反应时暂停轮询，服务端确认后才更新。历史浏览暂停轮询，返回最新后重新拉取。无需图片、字体包、反应人列表缓存或额外轮询。
- **图片消息**：不提供缩略图或图片预览。Vela 的 `<image>` 不承诺按显示尺寸解码，`fetch` 也没有传输字节上限，纯文本附件显示是唯一不引入这些开销的选择。
- **多实例**：目前只支持一个 Nextcloud 账号。多账号需要把 `nctalk.settings` 改成账号数组 + 当前索引，`markers` 也要按账号分区。

## 9. 启动网络门

网络不通时应用不进入主界面（会话列表 / 设置 / 聊天），停在 `pages/offline`，只提供「重试」。

做法照 [HyperBilibili](https://github.com/Searchstars/Hyperbilibili) 的 `pages/app/entry/splash`：**把网络检查放在路由入口页**。`src/manifest.json` 的 `router.entry` 是 `pages/splash`，点图标先落到这一页（图标 + 名称 +「正在检查网络…」），页面 `onShow` 探测完再 `replace` 到会话列表或 `pages/setup`，失败则 `replace` 到 `pages/offline`。主界面不是「先渲染再隐藏」，而是**根本没被创建**，所以不存在检查期间点到「设置」的窗口。

判定只看一件事（`common/scripts/network.js`）：`@system.network.getType` 的结果。**只有明确的 `none` 才算离线**——空字符串、`fail` 回调、或者干脆不回调，都记为「未知」并放行。

- `TYPE_TIMEOUT_MS`（4 s）是 `getType` 的硬上限：不回调就记 `unknown` 继续走，否则页面会永久停在「正在检查网络…」；
- 「未知」不等于「没网」，放行进应用，由第一条请求给出带 `code` 的真实错误；
- 启动页始终显示当前阶段（`stage`：「读取设置…」/「检查网络…」/「进入 /…」/「跳转重试…」），手表上没有日志控制台，卡住时必须能从表盘上读出来；
- `router.replace` 推迟一个 tick 再发（与 `onShow` 同 tick 的跳转可能被路由丢掉），1.2 s 后若页面仍可见则重试一次并改文案。

### 探针是证据，不是判决

放行只看接口类型。路由决定之后（`router.replace` 已在执行），`pages/splash` 再跑两个探针，结果只进 `state` 和日志，**不参与放行、也不阻塞启动页**：

| 探针 | 目标 | 回答的问题 |
| --- | --- | --- |
| 对照（control） | `https://www.bilibili.com/` | 这块表本身能不能上外网？ |
| 目标（server） | `<baseUrl>/status.php` | 能不能到达你自己的 Nextcloud？ |

对照通而目标不通 → 问题在域名解析 / 证书链 / 端口这一段；两个都不通 → 接口在但没有可用出口。结果分别写进 `state.controlProbe` / `state.serverProbe`（`{ ok, status, code, detail, timedOut, ms, url }`），无账号时 `serverProbe` 为 `null`。

探针**不能**当第二道门：`status.php` 超时就判离线，会让慢 DNS、慢 TLS、Wi-Fi 尚未完全关联、或证书链在手表上不被接受的情况停在一个没有 `code` 的死页上。所以只有「设备没有网络接口」阻挡入口，其余情况一律放行，由会话列表的第一条真实请求给出带平台错误码的文案；对照探针通时，会话页会在前面加「网络正常，但服务器不可达」，把「Wi-Fi 没网」和「这台服务器连不上」分开。

路由决策抽成纯函数 `common/scripts/launch.js` 的 `routeAfterGate(online, hasAccount)`：离线一律 `pages/offline`（账号状态不参与），在线且无账号才 `pages/setup`，其余进会话列表。`tests/launch-gate.test.mjs` 跑这个函数，并静态断言入口页是 `pages/splash`、`ROUTE` 都是页面 key、`probe()` 出现在 `router.replace` 之后；`tests/network.test.mjs` 钉住三种离线判定、`checkSignal()` 零往返，以及 control 通 / server 不通时仍然 online。

### 跨页状态只能放 app 实例

`aiot-toolkit` 把每个页面打成独立的 webpack entry，`src/common/scripts/state.js` 会被**内联进每个页面的 bundle**，模块级对象因此是「每页一份」。跨页数据必须走 `this.$app.$def`：

- `app.ux` 导出 `shared`（`backgroundSummary`、`controlProbe`、`serverProbe`）；
- `common/scripts/shared.js` 的 `sharedOf(vm, fallback)` 取不到 `$def` 时退回页面本地 `state`，测试与不支持 `$def` 的固件仍能跑；
- **不要跨页读判定**：曾经把 `gateOnline` 放在 `shared` 上并让会话页据此回跳网络门，结果 splash ⇄ 列表互相踢球。门只负责「跳到哪一页」，然后把结论忘掉。

`tests/launch-gate.test.mjs` 静态断言 `app.ux` 导出 `shared`、`shared` 上没有 `gateOnline`、任何页面都不出现 `launchAllowed` / `gateOnline` / `gateChecked`。

离线页不自己探测，重试只做 `replace` 回 `pages/splash`：判一次只需要一个结论，两次探测意味着死网络下要等两个超时。AstroBox 插件用 `thirdpartyapp::launch-qa` 拉起 `pages/index`、或从手机推凭据启动 `pages/setup` 时都不经过网络门——前者只会看到每条请求自己的错误，后者是配置页，自带校验与超时。

## 10. 校验期间不熄屏

配置页收到凭据后要经历「写 storage → 最长 20 秒网络校验 → （成功时补写显示名）→ 发回执」，手表默认亮屏时间通常短于此，屏幕会在校验途中熄灭，用户看不到结果，也看不到失败原因。

因此 `onMessage` 解析成功后立即 `@system.brightness.setKeepScreenOn({ keepScreenOn: true })`，在校验成功、失败以及页面 `onHide` / `onDestroy`（`detachLink`）时一律置回 `false`。设置接口按「尽力而为」处理：部分固件没有该方法，抛错或 fail 只写日志，不能影响凭据流程。

### 先落盘，再校验

凭据的顺序是**先写 storage，再用 `/ocs/v2.php/cloud/user` 校验**，校验结论只影响两件事：`displayname` 要不要补写、回执报成功还是失败。

理由是两个入口的输入都很贵，而校验只提供附加信息：

- 手机上敲的应用密码只传一次，手表网络的 20 秒超时、DNS/TLS 失败、甚至页面在校验途中被系统回收，都不该让这次输入凭空消失；
- 手表小键盘上敲长串应用密码更难，登录页失败后还要靠 `onInit` 从 storage 回填才能「接着改」，不保存等于每次从头再来。

代价是明确接受的：手机推来错误密码时，磁盘上留下的就是这份错误凭据，原来的可用账号被覆盖。因此失败路径必须**在回执和状态文字里说清楚「已保存」**（`setup.savedUnverified` / `login.savedUnverified`，文案形如「已保存；<失败原因>」），否则用户会以为没保存而重复输入。写盘本身失败则相反：此时什么都没留下，直接报 storage 的错误，并且不再发起校验——没有可保存的账号，校验通过也没有意义。

同一原则也决定了两处细节：`state.settings` / `api.configure()` 在写盘成功后立刻更新（而不是等校验通过），因为它们只是 storage 的缓存；换账号时旧的 `displayName` 会被清空，避免失败后显示上一个账号的名字。

## 11. 界面系统

视觉与组件规范移植自 [HyperBilibili](https://github.com/Searchstars/Hyperbilibili) 的 watch 模板：

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| 页面底色 | `#000000` + 一张彩色辉光 PNG | 层次感不依赖模糊特效 |
| 卡片面 | `#262626`（次级 `#1F1F1F`） | 列表行、气泡、输入条 |
| 主色 | `#FF7DA8` | 唯一的「可点 / 强调」信号：主按钮、未读、设置项数值 |
| 次色 | `#0D7AFF` | 只出现在离线页背景与蓝色页面背景 |
| 圆角 | 卡片 26–30，胶囊 90 | 全圆胶囊按钮高 56 / 76 |
| 字重 | 标题 600，正文 500 | 手表字体没有真正的 bold |

实现约定：

- `src/common/styles/theme.css` 只放令牌类（`.app-page` `.app-bg` `.t-*` `.card` `.pill` `.badge` …），各页 `@import` 后在编译期内联（已用产物验证：规则出现在 `pages/*/*.js` 里），因此不增加运行时开销，也不会出现两份拷贝。
- `src/components/ui/AppPill.ux` 是唯一的按钮组件。宽度通过 prop 传入而不是父级 `class`/`style`——Vela 只应用组件自身的样式块，父级样式不会透传。
- 页面背景是 `scripts/gen-bg.py` 生成的 256×256 径向辉光 PNG（纯 Python 写 PNG，零依赖、无矢量），盒子和位图都是正方形，所以 `object-fit: cover` 正好等于全屏填充、不裁切也不变形（Vela 的 `object-fit` 只接受 `contain` / `cover` / `none` / `scale-down`，CSS 规范里的 `fill` 不是合法值）。
- 圆屏的所有贴边尺寸仍按第 1 节的弦宽公式取值。

### 尺寸必须落在设计像素上

Vela 对百分比与显隐的解析有几处与 CSS 规范不同，这些写法会直接塌掉布局：

| 位置 | 不要写 | 为什么 | 正确写法 |
| --- | --- | --- | --- |
| `.app-page` | `position: relative` | 页面根不再把确定宽度传给子节点 | 静态定位，`100%` 宽的列布局 |
| `.app-bg` | `width/height: 100%` | 回退到位图固有尺寸，辉光只占左上角 256×256 | `480px` × `480px`，矩形屏在 RECT 块里加高 |
| `<scroll>` 内容根 `.list` | `width: 100%` | 滚动内容没有确定宽度，百分比解析不到基准，子卡片全部塌成零宽 | `480px`（设计宽度），子卡片用 394 / 413 / 374 这类设计像素 |
| **`<scroll>` 本身** | `flex: 1` | **这就是「被压扁而不是可滚动」的根因**：flex 解析出高度后，这块固件把内容压进视口而不是让它溢出——列表永远不滚，子节点在主轴上被压缩，文字量出来就是 0 高（`chat: row0 343x0`） | 固定设计像素高度 = 屏幕高 − 固定 chrome：chat 226 / index 268 / settings 408（矩形屏 466 / 478 / 568）。参照 HyperBilibili `src/less/global.less` 的 `.scroll { width/height: 100% }`——滚动区永远有一个确定的盒子，内容才可能比它高 |
| 会话气泡内的文字（`.msg-meta` / `.msg-body` / `.msg-row` / `.reaction-summary`） | 不写 `width` | 没有确定宽度时 `text` 按内容固有宽度排，长消息**不换行** | `362px`（= 394 − 16 × 2），矩形屏 `381px`（= 413 − 32），见 `chat.ux` |
| 会话气泡内的正文 | 多行 `text`；`for` 逐行；行加 `height`；把字号拆到第二个 class | 这些写法在滚动区还是 `flex: 1` 的时期实测全是 0 高（`343x0`）；真因见上面那行——内容被压进视口。改完滚动区后它们没再逐一回测，所以仍按已验证的形态保留 | 正文在 `common/scripts/textlayout.js` 的 `splitRows()` 里按宽度预估切行，模板里**四个手写索引槽位**（两个 `for` 共用 `$idx` 键，内层不产出节点），每行是气泡的直接子节点、单个自包含 class：`width` + 侧边距 + `font-size` + `font-weight` + `color` + `lines: 1`，不加 `height`、不加 `line-height`。第 5 行起不再进气泡，改由 `pages/message`（展开全文）承载，见 §13 |
| 会话列表卡片里的文字（`.room-name` / `.room-preview`） | `width: 100%` | 与上一条同源：在 flex 卡片里没有自己的确定宽度 | `200px`（矩形屏 `219px` = 卡片宽 − 头像 56 − 各段边距），`lines: 1` 与字号写在同一个块里 |
| 状态容器（`main` / `editor` / 输入条） | `show="{{...}}"` | 隐藏节点仍占高度：148 + 212 + 150 = 510 > 480，`flex: 1` 的列表解析成 0 | `if="{{...}}"`，模板内不出现 `show` |
| 会话列表的占位块与 `.badge` | `show="{{...}}"` | 占位块躲在列表末尾一起占高度；未读为 0 时徽标仍占 30px，把时间顶出行 | `if="{{...}}"` |
| `pages/message` 的正文 | 逐行 `text` | 一条消息最长 2000 字，按行切会变成 60–100 个节点，滚动区一次全部实例化 | 整段一个多行 `text`（`.body-*`：像素宽 + 字号 + 无 `lines`），卡片高度随文本增长。这是全应用唯一的多行正文，形状抄自 HyperBilibili `pages/tools/textdetail` 的 `.text`（`width: 95%` + `padding`，不写 `lines`） |

`tests/layout.test.mjs` 守住这些不变式：页面根静态定位、`.app-bg` 用像素值且 `object-fit` 合法、三个滚动页的 `.list` 与卡片在每种屏幕下都是像素宽、两态用 `if`、固定块之上留给消息列表的高度（圆屏 / 矩形屏都 ≥ 180px）、气泡内每个 `text` 都等于「气泡宽 − 左右边距」且都是 `lines: 1` 带固定高度（旧样式读不到这个宽度，测试直接报错），以及登录页键盘占位不低于真实键盘高度。百分比只在父节点有确定宽度时才用（例如 `.app-page` 的直接子节点）。

这段排查留下一条方法论：**手表没有检查器，所以症状要用数字换成结论**。会话页当时临时加过一次 `measureFirstBubble()`，把气泡、行槽位、页头标题的 `getBoundingClientRect` 打进日志，连续几轮给出的都是「宽度对、高度 0」：

```
bubble 372x18 / text 343x0 / row0 343x0 / title 311x36
```

`title` 能排版、宽度全对、字号/行数/class 结构怎么改都还是 0 —— 这个组合最终指向的不是文字属性，而是父级把主轴压掉了（`<scroll>` 的 `flex: 1`）。探针在 1.0.13 验证通过后已全部删除，模板里那几个 `id` 一并去掉；下次需要现场数据时按同样方式临时加回，别留在发布包里。

两条同批发现也记在这里：这块固件不认 `align-self`（日志 `Unknown style - alignSelf`，所以自己发的气泡一直不是靠右的），以及页面被销毁时 VM 已经不再提供页面方法（`onDestroy` 里调 `this.onHide()` 直接抛 `TypeError: not a function`），销毁钩子只能读写状态、不能调方法。

### 跳转：先排除形式与时序，再怀疑目标页

这块固件上 `router.push` 可能静默不生效，而跳转成功也不一定触发 `onHide`——两者从外面看都是「点了没反应」。`common/scripts/nav.js` 因此按「延后 → 逐级只变一个变量 → 比对 `router.getState()` 快照」的顺序尝试，全部落空才弹 toast：

| 时间 | 做法 | 排除了什么 |
| --- | --- | --- |
| +30ms | `replace(uri, params)` | 同拍发送 |
| +1300ms | `replace(uri)` | 参数 |
| +2400ms | `push(uri, params)` | 形式 |
| +3600ms | 仍未离开 → toast，并把路由器前后快照写进列表页头部 | 下一次报告是事实而不是症状 |

「到没到」以 `router.getState()` 的 `index` / `path` / `name` 为准，页面自己的 `$visible` 只作补充。房间信息同时走 router params（`pages/chat` 的 `protected`）与 `$app.$def.shared.pendingRoom`，所以不带 params 的那一级仍能打开会话；`onInit` 读完立刻清空，避免串房。被 `replace` 打开的页面在栈底，`router.back()` 无处可去，所以返回统一走 `nav.leave(ROUTE.home)`。

`nav.leave` 同样不相信任何一次跳转：`getState().index > 0` 时先 `back()`，700ms 后拿路由快照验证，没离开才用延后 30ms 的 `replace(home)` 兜底，仍没离开就回调页面恢复自己暂停的东西。1.0.7 的朴素版本（`index > 0 → back()`，无验证）让会话页的「返回」变成静默空操作——栈深报的是真，`back()` 却被丢弃，没有下一级可兜底；`pages/chat` 的 `goBack()` 也因此不再先调 `onHide()`：把 `visible` 置 false 再跳失败，留下的是一屏亮着却拒绝一切读取的死页面。

会话列表头部保留一行状态（`正在加载…` / `已更新 N 个会话` / `✕ 失败原因` / 路由快照），因为滚动区末尾的失败文案常常看不到。

### 页面 VM 的硬规则

页面同时声明 `data` 与 `protected` / `public` / `private` 时，这块固件的页面 VM **根本建不出来**：路由发出跳转，目标页构造失败，调用页停在原地，表现就是「点会话没反应」。会话页因此把状态块叫 `private`，`protected` 只接路由参数。`tests/page-vm.test.mjs` 对每个页面做这条静态检查——规则只能静态断言，所以必须覆盖所有页面而不是点名 chat。

### 用户点了就必须有反应

不要用布尔状态位拦住后面的读取：一次既不回调也不报错的请求会让 `loading` / `receiving` 永远为真，按钮从此静默无响应。

1. **用户发起的读取永远优先**：`refresh()` 不因 `loading` 提前返回，而是用 `fetchToken` 让旧请求的答案失效（1.5s 内的重复点击才忽略）；
2. **超过请求超时的状态位视为失效**：`releaseStaleReceive()` 在 `receive` / `schedulePoll` / `onShow` 开头放掉 25s 以上的 `receiving`；
3. **回到页面时 `loading` 清零**：可见的页面不可能是「正在忙」；
4. **失败必须能点**：聊天页的错误占位块本身可点重试。

`tests/tap-recovery.test.mjs` 守护这四条。

### 改了看得见的布局就要抬版本号

`versionName` 不动时，同一个版本号既可能指修复前的包也可能指修复后的包，无法从版本号判断表上装的是哪一版。

## 12. 挂后台：表盘悬浮入口（1.0.20）

需求不是后台消息同步，而是 HyperBilibili 那种「按下表冠回表盘 → 表盘出现悬浮图标 → 点它回到原状态」。1.0.14–1.0.19 走过三条路（布尔量前台标记 → keeper 微服务 → 进程内 15 秒下载 ticker），全部以「后台留存不可用」告终；对 HyperBilibili 仓库考古（commit `0ccb19b`，音频播放器出现之前）给出了答案：它的「挂后台」就是 manifest 里 `config.background.features: ["system.request", "system.audio"]` 的声明，表盘悬浮入口是音频播放时系统挂出的**媒体卡片**。

### 12.1 实现

- manifest：`features` 与 `config.background.features` 都声明 `system.audio`。
- `app.ux` 的 `onHide` 用 `@system.audio` 循环播放打包的静音 WAV（`src/common/audio/keepalive.wav`，2 秒 8kHz 单声道，音量 0，标题 Talk）；`onShow` / `onDestroy` 停止。
- `@system.audio` 懒加载 + try/catch（沿用 `serviceclient` 的教训：feature 缺失的模块级 import 会在 app.ux 初始化时抛异常带崩一切）。固件没有音频时打日志退回普通行为。

### 12.2 轮询只在foreground

1.0.20 起**没有后台轮询**：keeper 微服务（`services/`、`@system.serviceclient`）与进程内 15 秒下载 ticker（`bgSync.js`、`createKeeper`）整体拆除——用户明确不需要后台消息同步。轮询只在前台发生：

- 会话页 `onShow` 刷新列表（1.5 秒防双击下限不变）；
- 聊天页可见时按 `pollInterval` 短轮询消息。

`tests/keepalive.test.mjs` 钉住三件事：保活音频接线正确；被拆除的机制不复活（`services/` 目录、`keeperClient`、`bgKeeper` 等不得回到 `app.ux`，manifest 不得再有 `services` / `serviceclient`）；前台轮询健在。

### 12.3 真机待验证

| 项 | 现状 | 处理 |
| --- | --- | --- |
| 静音音频（volume 0）能否维持媒体卡片 | 未验证 | 进 app → 按表冠 → 看表盘是否出现悬浮图标；不出现则改音量 0.01 或换 m4a |
| 悬浮图标点回后状态 | 未验证 | 应原样回到离开前的页面；被杀则说明音频没撑住进程 |
| 息屏数小时后的存活 | 未验证 | 若夜间被回收属平台行为，可接受（回表盘当时可用即可） |


## 13. 消息顺序、长消息与内存

### 13.1 最新的消息在最下面

1.0.14 把消息按 id 降序排，最新一条在列表顶部，而输入条在底部——读一条新消息要先往上翻。1.0.15 起全链路改为升序：

| 位置 | 变化 |
| --- | --- |
| `receive()` | `views.sort((a, b) => a.id - b.id)`；`newest` 取数组末尾 |
| `mergeViews()` | 窗口保留 `slice(-WINDOW_SIZE)`（`keepOldest` 时保留 `slice(0, WINDOW_SIZE)`，即正在往回翻的旧页） |
| `olderCursor` | 最旧一行变成 `messages[0]`（原来是最末一行） |
| 模板 | 「加载更早消息」与所有占位块移到列表**顶部**，消息循环在其下 |
| 滚动 | `scrollToLatest()` 在首次加载、翻回最新、发送成功、以及轮询到新消息时滚到底；`loadOlder()` 之后滚到顶（历史被插到上方，偏移不变会让画面错位） |

滚动用 `scrollTo({ top: 100000 })`，由平台 clamp 到内容高度，不需要事先量；再在 `SCROLL_RETRY_MS = 200ms` 后重复一次，因为首帧的内容盒子可能还是旧高度（HyperBilibili 的 `dmpage.ScrollToEnd` 也是延后 500ms 才滚）。

### 13.2 长消息：四行预览 + 展开全文

HyperBilibili 的评论区就是「固定高度预览 → 点开是整段文本的独立页」（`src/components/Reply/Reply.ux` 的 `.replycontent` 200px 卡片 + `src/pages/tools/textdetail`）：手表屏幕放不下整段文本，但也不能让它消失。

本项目照同一分工实现：

- 气泡固定显示 `PREVIEW_ROWS = 4` 行（原为 6 行），末尾带 `…`；
- 超出的消息多一行 `.msg-more`（「展开全文 ›」），**它是气泡里唯一的点击目标**——气泡本身留给长按操作面板，两种手势不抢；
- 点它进入 `pages/message`：整段文本放在一张卡片里、页面可滚动，形状与 `textdetail` 一致（`.body-*` 像素宽 + 字号，无 `lines`）；
- 文本在 `toView()` 里最多保留 `MESSAGE_LIMIT = 2000` 字符，超出部分连详情页也不显示（见 13.3）。

路由参数走 `nav.navigate(ROUTE.message, { text, meta, scale })`，同时写一份 `shared.pendingDetail`，供 `nav.navigate` 梯子里那级「不带参数的 replace」兜底；页面 `onInit` 读完立刻清空。

### 13.3 内存：把上限写进代码

固件在销毁页面时记过一次 out-of-memory 警告，所以三条上限都落在常量里，而不是「应该不会太多」：

| 上限 | 值 | 为什么 |
| --- | --- | --- |
| `WINDOW_SIZE` | 16（原 24） | 圆屏两屏、方屏八屏；每个气泡 = 视图对象 + 4 个行字符串 + 5 个 `text` 节点 |
| `PREVIEW_ROWS` | 4（原 6） | 每个气泡少两个 `text` 节点；剩下的交给详情页 |
| `MESSAGE_LIMIT` | 2000 字符 | 一条 5 万字的粘贴不会变成上千个行字符串；详情页也只渲染这一段 |

另外三处：

1. **轮询不再重算已知消息**：`receive('forward')` 先用现有 id 建一张表，服务端回包里的老消息直接跳过 `toView()`（不重切行、不再分配字符串），只转换新 id；
2. **`onDestroy` 显式释放**：`messages = []`、`draft`、`replySummary` 一并清空，`scrollTimer` 清掉——页面 VM 在 destroy 之后仍会存活一段时间，那 16 个视图对象是它身上最大的一块；
3. **详情页 `onDestroy` 清掉正文**，它只服务一条消息。

`tests/chat.test.mjs` 钉住 13.1 与 13.2（顺序、窗口保留哪一端、四行预览、`more` 标志、`openDetail` 的参数），`tests/layout.test.mjs` 钉住详情页的像素预算。
