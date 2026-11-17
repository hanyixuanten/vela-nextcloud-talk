# Nextcloud Talk 接口清单

所有请求由 `src/common/scripts/api.js` 发出，统一走 OCS JSON API。

## 公共请求头

| 头 | 值 | 为什么必须 |
| --- | --- | --- |
| `Authorization` | `Basic base64(user:appPassword)` | 应用密码认证，不用账号密码 |
| `OCS-APIRequest` | `true` | 缺了会返回登录页 HTML，解析报错难以定位 |
| `Accept` | `application/json` | Talk 的 `reactions` 结构会让 XML 响应非法 |

POST/PUT 额外带 `Content-Type: application/json`，body 为 JSON 字符串。

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

`api.js` 判定成功的条件是：HTTP 2xx **且**（`meta.statuscode` 为 100/200，或没有 `meta` 但 body 可解析）。OCS v1 用 100，v2 用 200，两者都要认。

## 端点

### 校验账号

```
GET /ocs/v2.php/cloud/user
```

`data` 里取 `id`、`displayname`。登录页点「连接」时调用，成功才写 storage。

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

### 拉取消息

```
GET /ocs/v2.php/apps/spreed/api/v1/chat/{token}?lookIntoFuture=0&limit=40&setReadMarker=1[&lastKnownMessageId=N]
```

- 不带 `lastKnownMessageId`：取最近 `limit` 条，服务端按**时间正序**返回。
- 带 `lastKnownMessageId`：只取该 id 之后的新消息。
- 响应头 `X-Chat-Last-Given` 是下一页的游标（本骨架暂未用于翻页）。
- 可能返回 `304`，表示没有新消息，此时不应报错。

### 发送消息

```
POST /ocs/v2.php/apps/spreed/api/v1/chat/{token}
{ "message": "你好" }
```

成功返回 `201`，body 是新建消息对象（含 `id`、`timestamp`），可以直接上屏，不必重新拉列表。

### 已读标记

```
PUT /ocs/v2.php/apps/spreed/api/v1/chat/{token}/read
{ "lastReadMessage": 12345 }
```

失败静默忽略：已读标记失败不影响用户读消息。

## 错误映射

`describeStatus()` 把 HTTP 状态翻译成人话，直接显示在界面上：

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

Rich Object String 的展开在 `format.js` 的 `renderMessage()`：把 `{file}` 这类占位符替换成 `messageParameters.file.name`，未知占位符原样保留，避免信息丢失。
