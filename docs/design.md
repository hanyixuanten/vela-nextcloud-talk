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

`flex: 1` 的消息列表因此解析成 0 高，整块只剩一条横缝（真机报告：「会话界面被压成长横条」）。改成 `if` 后列表拿到 480 − 148 − 106 = 226px。聊天页模板里已经没有 `show`，由 `tests/chat-layout.test.mjs` 守护：两种状态用 `if`、模板不出现 `show`、固定块之后列表在圆屏/矩形屏都 ≥ 180px。

回归检查见 `tests/login-layout.test.mjs`（状态用 `if`、占位在按钮之后、占位高度不低于键盘实际高度、`.app-page` 不可滚动）。

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
                          nav.navigate = push → 300ms 后仍在页面上 → replace 同一目标 → 仍失败才 toast

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
- **图片消息**：不提供缩略图或图片预览；详见[解码成本评估](image-preview.md)。
- **多实例**：目前只支持一个 Nextcloud 账号。多账号需要把 `nctalk.settings` 改成账号数组 + 当前索引，`markers` 也要按账号分区。

## 9. 启动网络门

网络不通时应用不进入主界面（会话列表 / 设置 / 聊天），停在 `pages/offline`，只提供「重试」。

做法照 [HyperBilibili](https://github.com/Searchstars/Hyperbilibili) 的 `pages/app/entry/splash`：**把网络检查放在路由入口页**。`src/manifest.json` 的 `router.entry` 是 `pages/splash`，点图标先落到这一页（图标 + 名称 + 「正在检查网络…」），页面 `onShow` 探测完再 `replace` 到会话列表或 `pages/setup`；失败则 `replace('/offline')`。主界面不是「先渲染再隐藏」，而是**根本没被创建**，所以不存在检查期间点到「设置」的窗口，也没有列表闪一下再跳走的情况。

判定只看一件事（`common/scripts/network.js`）：`@system.network.getType` 的结果。**只有明确的 `none` 才算离线**——空字符串、`fail` 回调、或者干脆不回调，都记为「未知」并放行。

这一条比 HyperBilibili 的 `NetworkCheck` 更宽松（它把空值也当离线），原因是真机上吃过一次教训：把判定简化成只看类型之后，有固件上 `getType` **既不 success 也不 fail**，页面就永久停在「正在检查网络…」，比之前停在离线页更没用。所以：

- `TYPE_TIMEOUT_MS`（4 s）是 `getType` 的硬上限：不回调就记 `unknown` 继续走；
- 「未知」不等于「没网」，放行进应用，由第一条请求给出带 `code` 的真实错误；
- 启动页始终显示当前阶段（`stage`：「读取设置…」/「检查网络…」/「进入 /…」/「跳转重试…」），手表上没有日志控制台，卡住时必须能从表盘上读出来；
- `router.replace` 推迟一个 tick 再发（与 `onShow` 同 tick 的跳转可能被路由丢掉，表现也像卡死），1.2 s 后若页面仍可见则重试一次并改文案。

### 两个探针是证据，不是判决

放行只看接口类型。路由决定之后（`router.replace` 已在执行），`pages/splash` 再跑两个探针，结果只进 `state` 和日志，**不参与放行、也不阻塞启动页**：

| 探针 | 目标 | 回答的问题 |
| --- | --- | --- |
| 对照（control） | `https://www.bilibili.com/` | 这块表本身能不能上外网？（与参考实现同一类公共站点，证书链是主流 CA） |
| 目标（server） | `<baseUrl>/status.php` | 能不能到达你自己的 Nextcloud？ |

两者组合就是诊断：**对照通、目标不通 → 是域名解析 / 证书链 / 端口这一段的问题，不是手表没网**；两个都不通 → 接口在但没有可用出口。结果分别写进 `state.controlProbe` / `state.serverProbe`（`{ ok, status, code, detail, timedOut, ms, url }`），无账号时 `serverProbe` 为 `null`。

这是修过一次的回归。0.2.4 起探针被当成第二道门：`status.php` 在 8 秒内没有响应就判离线。于是 DNS 慢、TLS 握手慢、应用刚启动 Wi-Fi 还没完全关联、或者目标服务器的证书链/端口在手表上不被接受时，用户看到的是一个**永远停在「没有网络」的死页**——而同一块表上 HyperBilibili 能正常联网，因为参考实现从不因为「服务器探不通」拦人。更糟的是离线页不显示任何 `code`，原因被彻底藏起来。

现在的取舍：

- **设备没接口** → 离线性命，这是唯一阻挡入口的情况，因为界面上每条请求都必然失败；
- **接口在、服务器探不通** → 仍然放行。用户会进到会话列表，由第一条真实请求给出带平台错误码的文案（`api.js` 的 `fail` 现在把 `code` 也拼进可见消息，例如「网络请求失败：code=1001」）；如果对照探针是通的，会话页会在这句前面再加「网络正常，但服务器不可达」（`index.serverUnreachable`），把「Wi-Fi 没网」和「这台服务器连不上」分开。这比一个没有信息的死页有用：它区分了 DNS / TLS / 连接，而且是用户能截屏反馈的东西。

`tests/network.test.mjs` 钉住三件事：`none` / `''` / `getType` 失败都判离线且不发任何请求；判定本身零往返（`checkSignal()` 不发请求）；对照通了而目标不通时**仍然是 online**，同时 `server.ok === false` 且带 `code`，探针超时则 `timedOut: true`。测试用 `probeTargets(settings, { controlUrl })` 把对照探针指向本地服务器，不去真的访问 bilibili。

路由决策抽成纯函数 `common/scripts/launch.js` 的 `routeAfterGate(online, hasAccount)`：离线一律 `/offline`（账号状态不参与），在线且无账号才 `/setup`，其余进会话列表。`tests/launch-gate.test.mjs` 直接跑这个函数，并静态断言入口页是 `pages/splash`、会话列表**不会**再跳回 `/splash`、离线页的重试回到 `/splash`、网络门的判定不由 `probe` 决定，且 `this.probe()` 出现在 `router.replace` **之后**。

网络门**不发布「通过/未通过」的判定**。曾经有过 `state.launchAllowed` 加 `pages/index` 的守卫，那正是死循环的来源（见下一节）；现在门只负责「跳到哪一页」然后把结论忘掉，主界面不再回头质疑它。

### 跨页状态：`common/scripts/*.js` 里的模块级对象是「每页一份」

0.2.10 真机上出现过 `检查网络… → 进入 / → 检查网络…` 的死循环。根因不在判定，而在状态共享：`aiot-toolkit` 把每个页面打成独立的 webpack entry，`src/common/scripts/state.js` 会被**内联进每个页面的 bundle**（用构建出的 RPK 验证过：`app.js`、`pages/splash/splash.js`、`pages/index/index.js`、`pages/chat/chat.js` 里都各有一份 `networkChecked` / `activeRoom` 的拷贝）。所以 splash 写 `state.launchAllowed = true`，`pages/index` 读到的仍是它自己的 `false` → 立刻 `replace('/splash')` → 又跑一遍门，无限循环。

官方文档给的跨页通道是 app 实例：`app.ux` 导出的对象可以在任何页面通过 `this.$app.$def` 访问。因此：

- `app.ux` 导出一个 `shared` 对象（`gateChecked` / `gateOnline` / `networkType` / `controlProbe` / `serverProbe` / `backgroundSummary`）；
- `common/scripts/shared.js` 的 `sharedOf(vm, fallback)` 负责取 `this.$app.$def.shared`，取不到时退回页面本地 `state`（测试与不支持 `$def` 的固件仍能跑，不至于硬崩）；
- 0.2.11 先把判定放上 `shared` 并保留守卫，真机仍然循环——说明 `$app.$def` 上的写入在页面之间也不保证可见（或守卫本身读到的仍是旧值）。0.2.12 的结论：**不要再试着跨页读判定**，把守卫删掉。门只在「`type === "none"`」时把用户送去 `/offline`，其余情况一律放行；插件直接拉起 `pages/index` 也照常工作，请求失败由页面自己报错。

`shared` 现在只承载两件锦上添花的数据：`backgroundSummary`（keeper 预渲染）与 `controlProbe` / `serverProbe`（会话页「服务器不可达」提示）。它们读不到时最多退化成「没有预渲染 / 没有提示」，不影响能不能进应用。`tests/launch-gate.test.mjs` 静态断言：`app.ux` 必须导出 `shared`、`shared` 上不得有 `gateOnline`、任何页面都不得出现 `launchAllowed` / `gateOnline` / `gateChecked`。

离线页只在 `type === "none"` 时出现，文案仍是「连上 Wi-Fi 再试」。

离线页不再自己探测，重试只做 `replace('/splash')`：判一次只需要一个结论，两次探测意味着死网络下要等两个超时。

AstroBox 插件用 `thirdpartyapp::launch-qa` 拉起 `pages/index`（旧固件不接受非入口页时的回退）时**不再**被弹回网络门：那条守卫是死循环的根源，而门现在只挡 `none`，直接进列表只会看到每条请求自己的错误，比来回跳屏有用。

插件启动到 `pages/setup`（手机推凭据）不经过网络门，这是有意的：那是配置页而不是主界面，它自己的校验和 20 秒超时会给出准确结论。

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

0.2.5 的主题移植在真机（圆表）上翻过一次车，两条都是尺寸解析问题，记在这里避免重犯：

| 位置 | 错误写法 | 真机表现 | 正确写法 |
| --- | --- | --- | --- |
| `.app-page` | `position: relative` | 页面根不再把确定宽度传给子节点 | 静态定位（沿用移植前的 `.page`） |
| `.app-bg` | `width/height: 100%` | 回退到位图的固有尺寸，粉色辉光只占左上角 256×256，其余纯黑 | `480px` × `480px`（矩形屏在 RECT 块里加高） |
| `<scroll>` 内容根 `.list` | `width: 100%` | 滚动内容没有确定宽度，百分比解析不到基准，气泡／行全部塌成零宽（「消息界面被压扁」「会话列表被压成长横条」） | `480px`（设计宽度），子卡片用 394 / 413 / 374 这类设计像素 |
| 状态容器（`main` / `editor` / 输入条） | `show="{{editing}}"` | 隐藏节点仍占高度：148 + 212 + 150 = 510 > 480，列表 `flex: 1` 解析成 0，只剩一条横缝（「被压成长横条」） | `if="{{...}}"`，模板内不出现 `show` |
| 会话列表的占位块与 `.badge` | `show="{{!loading && error}}"` | 三个占位块（各约 100px）躲在列表末尾一起占高度，能滚动进空白；未读为 0 时徽标仍占 30px，把时间顶出行 | `if="{{...}}"`；`tests/index-layout.test.mjs` 断言这一页模板不出现 `show` |

界面尺寸与显隐不变式由四个测试守护：`tests/layout-sizing.test.mjs` 断言页面根没有相对定位、`.app-bg` 用像素值且 `object-fit` 合法、三个滚动页的 `.list` 与卡片在每种屏幕下都是像素宽度；`tests/chat-layout.test.mjs` 断言聊天页两态用 `if`、模板不出现 `show`，并算出固定块之上留给消息列表的高度（圆屏 226、矩形 466）；`tests/index-layout.test.mjs` 对会话列表做同样的检查（不出现 `show`、`.list` 480px、卡片 394 / 413，圆屏 268 / 矩形 478 可用高度）。百分比只在父节点有确定宽度时才用（例如 `.app-page` 的直接子节点）。

### 跳转不能只靠 `router.push`

1.0.0 的真机报告：点会话卡片、点「设置」**都没有任何反应**（不是报错、不是闪一下，就是停在原地），而同一行里的「刷新」正常。这三个处理器里只有「刷新」不跳转——两条死掉的路正是全应用仅有的两处 `router.push`；所有确实能落地的跳转（splash → index / setup / offline）用的都是 `router.replace`。结论：**这块固件上 `push` 可能静默不生效**，而手表没有控制台，静默失败和界面卡死从外面看是一样的。

`src/common/scripts/nav.js` 因此把 push 当成「可能不落地」：

| 步骤 | 做法 | 为什么 |
| --- | --- | --- |
| 1 | 页面在 `onHide` / `onDestroy` 里置 `leftPage = true` | 用来判断「到底离没离开」，`$visible` 只在固件实现时才可用，两者都看 |
| 2 | `push(target)` | 能落地时行为与以前完全一致（返回栈保留） |
| 3 | 300ms 后仍在页面上 → `replace(target)` | 与启动门同一种写法，已验证能落地；代价是返回栈退化为「回列表」 |
| 4 | 再 400ms 仍在页面上 → `prompt.showToast('打不开，请重试')` | 让下一次反馈可判定：有 toast = 导航跑了但两种形式都被丢弃；没 toast = 点击根本没进处理器 |

配套的两处：

- 房间信息走两条通道：router params（`pages/chat` 的 `protected`）+ `$app.$def.shared.pendingRoom`（跨页对象，见 §9）。`pages/chat.onInit` 读完立刻清空，避免上一间房串到下一间。
- 被 replace 打开的页面在栈底，`router.back()` 无处可去，所以 chat / settings / setup 的返回统一走 `nav.leave(ROUTE.home)`：`router.getState().index > 0` 才 `back()`，否则 replace 回 `pages/index`。

`tests/navigation.test.mjs` 守护这条链：页面里不得再出现裸 `router.push`、`nav.js` 必须先 push 再 replace、`leftPage` 必须在 onHide 与 onDestroy 都置位（否则 replace 成功后会误报 toast）、以及 chat 必须读 `pendingRoom` 并清空。

### 0.2.5 的两个包不是同一个东西

0.2.5 发版后才修了上面三条尺寸问题，期间 `versionName` 没动，于是「0.2.5」既可以指修复前的包，也可以指修复后的包——真机上「会话列表还是被压扁」的报告就来自修复前那个。**只要改了用户看得见的布局，就必须同时抬版本号**，否则没法从版本号判断表上装的是哪一版。0.2.6 起这条作为发布纪律。

## 12. 后台留存（微服务）

目标：离开应用（回表盘 / 息屏 / 上划关闭）后仍能按间隔拉会话列表，把未读数留住，有新消息时振一下。这不是「消息推送」——Vela 没有给第三方 app 的推送通道，能做的上限就是「后台自己轮询 + 本地留存」。

### 12.1 为什么不用 `config.background`

官方[后台运行](https://iot.mi.com/vela/quickapp/zh/guide/framework/other/background-running.html)的两个条件是硬条件：

1. `manifest.json` 的 `config.background.features` 声明了后台接口——**只有** `system.audio`、`system.request`、`system.geolocation` 三个可选；
2. 切换后台时**至少有一个已声明的后台接口正在运行**，否则应用被停止。

聊天轮询走 `@system.fetch`，不在名单里；本项目也没有音频、定位或真实的下载任务。为了保活去跑一个假的静音音频或空下载，既过不了「后台运行需求是否合理」的审核，也是纯粹的电量浪费，因此**不声明 `config.background`**。

### 12.2 用微服务承载后台轮询

[微服务](https://iot.mi.com/vela/quickapp/zh/features/other/serviceclient.html)是官方给出的「脱离应用生命周期」的能力：

```json
"services": [{ "name": "keeper", "path": "services/keeper", "autoStart": true, "permissions": [] }]
```

- 服务文件 `src/services/keeper.js`，与页面共包、随应用安装；`autoStart: true` 让框架启动时就拉起它，不必等用户打开应用。
- 客户端 `serviceclient.connect({ name: 'keeper', policy: 'always' })`：`always` 表示**应用关闭后服务不关闭**；`byNeeds` 会在最后一个客户端断开时关掉服务，不适合本场景。
- 服务端只有 `serviceManager` 全局（`postMessage` / `getClientsInfo` / `disconnectClient` / `terminate`），不能用 `@system.router` / `prompt` / `brightness` 这些页面侧接口。服务侧 feature 能力表里 `fetch`、`storage`、`vibrator`、`file`、`interconnect` 都是 `all`，所以轮询 + 写盘 + 振动都在允许范围内。

### 12.3 轮询归属：同一时刻只有一个轮询者

服务和应用如果都轮询，同一份会话列表会被请求两遍。约定：

| 状态 | 谁轮询 | 说明 |
| --- | --- | --- |
| 应用在前台 | 页面 | 会话列表 `onShow` 拉一次；聊天页按 `pollInterval` 拉消息 |
| 应用在后台 / 已关闭 | keeper 服务 | `app.ux` 的 `onHide` 发 `{type:'background'}` 让服务开始，`onShow` 发 `{type:'foreground'}` 让它停下 |

`shouldPoll()`（`src/common/scripts/keeper.js`）就是这条规则的唯一实现，单测直接钉它。`app.ux` 把服务端的 `{type:'rooms'}` 推送写进 `state.backgroundSummary`，会话页在 `onShow` 先用它渲染一遍，再发真实请求。

### 12.4 留存的数据

`@system.storage` 的 `nctalk.keeper` 只存一份摘要，不存消息正文：

```json
{ "at": 1732100000000, "total": 3, "account": "alice@https://cloud.example.com",
  "rooms": [{ "token": "abc", "name": "项目群", "preview": "Alice: 在吗", "unread": 3, "at": 1732099999 }] }
```

- `account` 是 `user@baseUrl`。换账号后旧摘要不能出现在新账号的列表里，会话页比对不上就丢弃。
- 读取侧（`parseSummary`）把摘要当不可信输入：损坏 JSON、旧结构、`total` 与 `rooms` 不一致时一律重算或退回空摘要。
- 清除本地数据走 `storage.clear()`，会一并清掉这份摘要。

### 12.5 振动语义

- **首次成功轮询只建立基线，不振动**：服务启动时已经存在的未读不是「新消息」。
- 只在未读总数上升且应用不在前台时振 `mode: 'short'`；`BUZZ_COOLDOWN_MS`（60 秒）内不重复振，否则群聊每个轮询周期都会振一次。
- 未读下降（用户在别处读完）不振动，只更新摘要。

### 12.6 间隔与失败

- 后台轮询间隔 = `max(pollInterval, 30000)`。界面上的 15 秒是给人看的刷新节奏，后台没有屏幕要更新，15 秒一次 OCS 请求纯烧电。
- 单次失败（断网、超时、401）只写日志，**保留上一份摘要并继续排下一次**：手表离线时还能显示上次的未读数，是有意义的行为，不是降级。
- 设置里「后台留存」关闭时：服务不再发请求、不再排定时器；重新打开会先 `start()` 再 `refresh()` 立刻同步一次。关闭后服务进程可能仍驻留到重启，但没有任何网络与定时行为。

### 12.7 未在文档中确认的部分（真机必查）

| 项 | 现状 | 处理 |
| --- | --- | --- |
| 微服务的机型支持 | 官方只给了 `@system.request`、`vibrator` 等的支持明细，**微服务没有支持明细表** | 真机确认 S3 / S4 / REDMI Watch 5 上 `connect` 返回 1000/1001 与否；连不上时客户端只打日志，应用照旧当前台客户端用 |
| 服务内 `setTimeout` | 文档未写；打包产物里确实注入了 `setTimeout` / `setInterval` | 真机看日志里是否按 30 秒间隔出现 `keeper: poll failed` / 摘要更新 |
| `serviceManager.postMessage` 签名 | 文档表格写 `postMessage(clientId, Object)`，唯一示例写 `postMessage({ clientId, params })` | 先按示例调用，抛异常再退回两参数形式（`src/services/keeper.js`） |
| 后台网络是否被系统挂起 | 未验证 | 观察息屏 10 分钟后摘要时间戳是否还在推进 |

构建侧已验证：`npm run build:circle` 会把 `src/services/keeper.js` 打进 RPK（rspack 单独打包，依赖一并内联），`manifest-watch.json` 保留 `services` 字段，不需要改打包脚本。守护这些接线的测试是 `tests/keeper.test.mjs`（服务决策逻辑）和 `tests/keeper-service.test.mjs`（manifest / app.ux / 设置页 / i18n 的一致性）。
