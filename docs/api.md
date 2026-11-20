# Nextcloud Talk 接口清单

所有请求由 `src/common/scripts/api.js` 发出，统一走 OCS JSON API。

## 公共请求头

| 头 | 值 | 为什么必须 |
| --- | --- | --- |
| `Authorization` | `Basic base64(user:appPassword)` | 应用密码认证，不用账号密码 |
| `OCS-APIRequest` | `true` | 缺了会返回登录页 HTML，解析报错难以定位 |
| `Accept` | `application/json` | Talk 的 `reactions` 结构会让 XML 响应非法 |

POST 额外带 `Content-Type: application/json`，body 为 JSON 字符串。

## 响应信封

OCS 把真实数据包在 `ocs` 里：

```json
{
  "ocs": {
    "meta": { "status": "ok", "statuscode": 200, "message": "OK" },
    "data": [ ... ]
  }
}
```

`api.js` 判定成功的条件是：HTTP 2xx **且**（`meta.statuscode` 为 `100`、`200` 或与 HTTP 状态码一致，或没有 `meta` 但 body 可解析）。OCS v2 可能在 `meta.statuscode` 里返回 HTTP 状态码，例如发送成功时的 `201`。

## 端点

### 校验账号

```
GET /ocs/v2.php/cloud/user
```

`data` 里取 `id`、`displayname`。登录页点「连接」时调用，但**不决定凭据是否落盘**：调用前已经写过一次 storage，这里只负责取 `displayname` 与判断成功与否。

### 会话列表

```
GET /ocs/v2.php/apps/spreed/api/v4/room?includeStatus=0
```

返回数组，客户端按 `lastActivity` 降序排。用到的字段：

| 字段 | 用途 |
| --- | --- |
| `token` | 后续所有请求的路径参数，也是本地头像取色的种子 |
| `displayName` / `name` | 标题 |
| `lastActivity` | 排序 + 右侧时间 |
| `lastMessage` | 消息预览（Rich Object String） |
| `unreadMessages` | 未读角标 |

同一个端点也被后台的 keeper 微服务调用（`src/services/keeper.js`），间隔为 `max(pollInterval, 30s)`，只取上述字段写入本地摘要 `nctalk.keeper`；它不拉消息正文，也不改已读标记。设计见 [design.md 第 12 节](design.md)。

### 拉取消息

```
GET /ocs/v2.php/apps/spreed/api/v1/chat/{token}?lookIntoFuture=0&limit=12&setReadMarker=0&markNotificationsAsRead=0[&lastKnownMessageId=N]
GET /ocs/v2.php/apps/spreed/api/v1/chat/{token}?lookIntoFuture=1&timeout=0&limit=12&setReadMarker=0&markNotificationsAsRead=0[&lastKnownMessageId=N]
```

- 历史方向（`0`）：无游标取最近一页；带游标只取更早的消息。
- 向前方向（`1`）：查询游标后的消息，客户端短轮询不设置 `timeout`，避免请求长期挂起。
- `X-Chat-Last-Given` 是当前方向的下一页游标，可能指向被过滤、未出现在响应列表中的记录；无此头时用消息 ID 的最小值（历史）或最大值（向前）。客户端按 ID 倒序展示，不依赖服务器排序。
- `304` 表示没有该方向的更多消息，不是请求错误。拉取不自动写已读；支持 `chat-keep-notifications` 时也禁止 GET 自动清除提醒。
- 回应变化可能随向前轮询返回为 `messageType: "system"`、`systemMessage: "reaction"` / `"reaction_revoked"` / `"reaction_deleted"` 的记录。这些记录本身不作为普通消息展示；若带有原消息的 `parent` 快照，可据其 `id` 更新已加载消息的回应字段。推进游标仍以 `X-Chat-Last-Given` 为准，无需开启 `includeLastKnown`。

### 发送消息

```
POST /ocs/v2.php/apps/spreed/api/v1/chat/{token}
{ "message": "你好" }
```

回复使用同一个端点，例如 `{ "message": "收到", "replyTo": 12345 }`。`replyTo` 是同一会话中可回复的消息 ID（JSON 整数），不是引用文本，也不是线程 ID。目标无效（如不存在、属于其他会话，或是不可回复的系统／命令消息）时，服务器返回 `400`。调用 `sendMessage(token, text, replyTo)` 时，省略第三个参数或传 `undefined` 会保持普通发送，JSON 不带 `replyTo`。

成功返回 `201`，`ocs.data` 是新建消息对象（含 `id`、`timestamp`），可以直接上屏，不必重新拉列表。回复的发送结果和后续拉取都可以带 `parent`：正常情况下是被回复的完整消息对象，但不再嵌套 `parent`；拉取时如果原消息已删除，可以收到 `{ "id": 12345, "deleted": true }`。普通消息没有 `parent`。

兼容性：上游从 Talk 8.0 开始提供 [`chat-replies`](https://nextcloud-talk.readthedocs.io/en/stable/capabilities/#80) capability，消息上的 `isReplyable` 标明是否可回复。本应用已使用 Talk 12.0 引入的 `conversation-v4`，无需更换聊天端点；普通发送不依赖回复能力。参见上游[发送消息](https://nextcloud-talk.readthedocs.io/en/stable/chat/#sending-a-new-chat-message)和[父消息结构](https://nextcloud-talk.readthedocs.io/en/stable/chat/#parent-data)。

### 添加 / 撤销消息回应

```
POST /ocs/v2.php/apps/spreed/api/v1/reaction/{token}/{messageId}
{ "reaction": "👍" }

DELETE /ocs/v2.php/apps/spreed/api/v1/reaction/{token}/{messageId}?reaction=%F0%9F%91%8D
```

`setReaction(token, messageId, reaction, active)` 在 `active` 为 `true` 时发送 POST，`false` 时发送 DELETE。与 Talk 网页客户端一致：添加用 JSON body，撤销用 URL 编码的查询参数，不发送 body。新添加返回 `201`，已添加同一表情返回 `200`，撤销成功返回 `200`；找不到消息或要撤销的回应时可能返回 `404`。

成功时，`ocs.data` 是该消息完整的「表情 → 回应者列表」（没有回应时为 `{}`，Nextcloud 24 可能为 `[]`），不等于聊天消息中的计数。客户端将列表长度转换为「表情 → 总数」，如果响应没有可用映射则返回 `null`，与有效的空映射 `{}` 区分。当前用户已点选的表情由聊天消息的 `reactionsSelf` 提供；本次操作成功后可按 `active` 更新当前表情的选中状态。

上游从 Talk 14 / Nextcloud 24 开始提供 `reactions` capability。消息中缺少回应字段不代表服务器不支持回应。服务器只允许对符合条件的消息操作，并检查会话只读状态和参与者权限。参见上游[回应管理](https://nextcloud-talk.readthedocs.io/en/stable/reaction/)和[消息字段](https://nextcloud-talk.readthedocs.io/en/stable/chat/#receive-chat-messages-of-a-conversation)。

### 已读标记

```
POST /ocs/v2.php/apps/spreed/api/v1/chat/{token}/read
{ "lastReadMessage": 12345 }
```

首次加载最新消息或轮询收到新消息时，使用该批实际显示的最大 ID；历史分页不调用。失败不影响读消息。

## 错误映射

`describeStatus()` 把 HTTP 状态翻译成人话，直接显示在界面上。请求另有 20 秒客户端超时，避免网络调用永久悬挂。

| HTTP | 界面文案 | 常见原因 |
| --- | --- | --- |
| 400 | 请求被拒绝（参数错误） | 消息为空、`replyTo` 非法 |
| 401 | 账号或应用密码错误 | 用了账号密码，或应用密码已被吊销 |
| 403 | 没有权限执行该操作 | 会议只读 |
| 404 | 会话不存在或已被删除 | token 过期、被移出会话 |
| 412 | 会话尚未开放（等待室） | 等待室开启且非主持人 |
| 413 | 消息过长 | 超过 `chat.max-length`（默认 32000） |
| 429 | 操作过于频繁，请稍后再试 | 访客提及频率限制 |
| 5xx | 服务器错误（状态码） | 反向代理 / PHP 超时 |
| — | 网络请求失败：… | `fetch` 的 `fail` 回调，DNS、证书、代理 |

服务端 `meta.message` 比默认文案更具体时会优先显示服务端文案。

## 消息对象用到的字段

| 字段 | 说明 |
| --- | --- |
| `id` | 消息 id，同时用作本地排序游标 |
| `actorId` / `actorDisplayName` | 判断「是不是我发的」、显示作者 |
| `message` | Rich Object String，含 `{占位符}` |
| `messageParameters` | 占位符到 `{name, id, type}` 的映射 |
| `timestamp` | 秒级 unix 时间 |
| `systemMessage` | 非空表示系统消息（加入/退出/改名） |
| `messageType` | `comment` / `comment_deleted` / `system` / `command` |
| `isReplyable` | 服务器标记此消息是否可回复 |
| `parent` | 可选的被回复消息对象，或已删除标记 `{ id, deleted: true }` |
| `reactions` | 可选的「表情 → 总回应数」映射 |
| `reactionsSelf` | 可选的当前用户已回应的表情数组；未回应时可能不返回 |

Rich Object String 的展开在 `format.js` 的 `renderMessage()`：把 `{file}` 这类占位符替换成 `messageParameters.file.name`，未知占位符原样保留，避免信息丢失。
