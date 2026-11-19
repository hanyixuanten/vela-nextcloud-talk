# 设计说明

## 1. 屏幕与安全区

圆屏（Xiaomi Watch S3/S4/S4 Sport）和矩形屏（REDMI Watch 5）分别构建，共用 480 的设计宽度。下文的裁切推导针对圆屏；矩形屏不受圆形弦宽约束，使用更宽的内容区及矩形键盘。打包方式见 [CI 说明](ci.md)。

圆形表盘（480×480，半径 240）上，某一 y 高度处的可用宽度：

```
half_width(y) = sqrt(240² - (y - 240)²)
```

取几个关键值：

| y | 可用宽度 | 说明 |
| --- | --- | --- |
| 30 | ≈ 230 | 贴顶区域，几乎放不下东西 |
| 60 | ≈ 300 | 标题栏起点 |
| 90 | ≈ 358 | 标题栏主体，返回键圆心距中心 211px < 240，完整可见 |
| 240 | 480 | 屏中，最宽 |
| 440 | ≈ 266 | 输入条位置 |

由此得到两条硬约束：

1. **顶部不放导航。** 聊天页标题栏 `margin-top: 60px`，而不是贴顶。
2. **内容列宽 360px、左偏移 60px。** 即 `x ∈ [60, 420]`，在 y ∈ [60, 420] 区间内都能完整显示，只有滚动到极上/极下时列表边缘会被裁掉一点，这是可接受的。

聊天页底部输入条宽 248px 而不是撑满 360px，因为 y=440 处只剩 266px 可用宽度。

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
| 会话名 | 17px 字号 ≈ 22 |
| 草稿预览（最多显示末尾 60 字） | ≤ 2 行 ≈ 56 |
| 取消 / 发送按钮 | 46 |
| 间距 | 12 + 6 |

草稿只显示末尾 60 字（`DRAFT_VIEW_LIMIT`），前面加省略号。这是为了避免长消息把预览顶出屏幕上沿——`text` 组件无法设置最大行数，只能在数据侧截断。

## 3. 消息顺序与游标

列表按 **id 倒序**（最新在最上）。好处：

- 新消息 `concat` 到头部即可，不需要 `scrollTo`，绕开不同机型 `scroll` 滚动 API 的差异；
- 用户打开会话第一眼就是最新消息，符合手表「只看一眼」的使用方式。

游标 `newestId` 始终等于 `messages[0].id`，既用于轮询的 `lastKnownMessageId`，也用于已读标记。

## 4. 状态机

```
app.ux onCreate
   └─ store.load() → api.configure()
                     └─ hasAccount?
                         ├─ 否 → pages/index onShow → replace('/login')
                         └─ 是 → pages/index refresh()

pages/login  ──submit──> api.getCurrentUser()
                          ├─ ok   → store.save → replace('/')
                          └─ fail → 留在本页，显示错误

pages/index  ──tap 会话──> state.activeRoom = room → push('/chat', {token, name})

pages/chat   onInit  → loadInitial()（40 条）
             onShow  → 重新读 settings + startPolling()
             onHide / onDestroy → stopPolling()
             tap 输入条 → editing = true
             send ok  → 清草稿 + 头部插入新消息 + 重启轮询
```

轮询用 `setTimeout` 递归而不是 `setInterval`：`setInterval` 在网络慢的时候会堆积请求，递归可以保证上一次请求回来后再排下一次。

## 5. 存储结构

`@system.storage` 只能存字符串，所以全部 JSON 序列化。两个键：

```jsonc
// nctalk.settings
{
  "baseUrl": "https://cloud.example.com",
  "user": "alice",
  "appPassword": "xxxxx-xxxxx-xxxxx-xxxxx-xxxxx",
  "displayName": "Alice",
  "keyboardType": "QWERTY",   // QWERTY | T9
  "screenType": "circle",     // circle | rect | pill
  "pollInterval": 15000,
  "fontScale": "normal"       // small | normal | large
}

// nctalk.markers
{ "a1b2c3d4": 12345 }         // token -> 最后已读消息 id
```

`normalize()` 在读取和写入时都会 trim 并去掉 `baseUrl` 的尾斜杠，避免出现 `https://host//ocs/v2.php`。

`parseJson()` 对损坏数据回退到默认值而不是抛异常：storage 是用户数据，宁可重置也不能白屏。

## 6. 安全模型

| 项 | 现状 | 说明 |
| --- | --- | --- |
| 凭证类型 | 应用密码 | 不用账号密码；丢失设备只需吊销单条应用密码 |
| 传输 | HTTPS（建议强制） | 请求里不做证书 pinning，明文 HTTP 时代理即可读到密码 |
| 本地存储 | 明文 | **Vela 没有 keystore API**，`@system.storage` 是应用沙箱内的普通存储，root 或提权后可见 |
| 密码回显 | 掩码为 `•` | 输入态也只显示掩码 |
| 日志 | 不打印凭证 | `api.js` 只在失败时打错误文案，不打 header |

明文存储是平台限制，不是实现选择。缓解手段只有：用应用密码而不是账号密码、定期轮换、丢失设备时立即吊销。

## 7. 为什么不用长轮询 / WebSocket

Talk 支持 `lookIntoFuture=1`（服务端挂住连接，最多 60s）和 `timeout`。没采用的原因：

- Vela 的 `fetch` 在应用转入后台后行为不确定，长连接可能被静默掐断且不触发 `fail`；
- 60s 挂起期间若用户发消息，需要额外取消逻辑；
- 长轮询对表的功耗不一定比 15s 短轮询更好（每次都要重建 TLS 连接）。

短轮询的代价是延迟（最多 15s）和连接开销。`pollOnce()` 已经把参数抽出来了，想切长轮询只需传 `lookIntoFuture: 1, timeout: 25`，并处理 304。

## 8. 待决策

- **翻页方式**：`X-Chat-Last-Given` 已经拿到了，但「上滑加载更早消息」和「倒序列表」组合起来需要判断滚到列表底部（视觉上的底部 = 数组尾部）。Vela 的 `scroll` 没有 `scrollend` 事件，可能要退化成「底部固定一个『加载更早』按钮」。
- **图片消息**：`@system.fetch` 拿到的临时文件 uri 是否能在 `image` 组件里直接显示，需要在真机验证，模拟器和真机行为不一致。
- **多实例**：目前只支持一个 Nextcloud 账号。多账号需要把 `nctalk.settings` 改成账号数组 + 当前索引，`markers` 也要按账号分区。
