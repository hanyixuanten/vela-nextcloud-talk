# 手机侧配置凭据（interconnect）

在手表上输入 `https://cloud.example.com` 加一串应用密码实在太痛苦。这条链路让用户在 AstroBox（手机/桌面）里打字，凭据经蓝牙送到手表，由手表自己校验并落盘。

```
┌──────────────┐   interconnect.send-qaic-message    ┌───────────────────┐
│ AstroBox 插件 │ ──────────────────────────────────> │ 手表 Talk          │
│ (Rust/wasm)   │   {"v":1,"kind":"credentials",…}    │ pages/setup        │
│              │ <────────────────────────────────── │                    │
└──────────────┘        ack {"ok":true,…}            └───────────────────┘
                                                              │
                                                    GET /ocs/v2.php/cloud/user
                                                              │
                                                       @system.storage
```

## 为什么校验放在手表

插件端可以做网络请求（WASI p2 有 http，清单里也能声明 `network`），但故意不做：

- 密码只经过一条链路（插件 → 蓝牙 → 手表），AstroBox 侧不产生任何对外请求；
- 校验逻辑与运行时共用同一份 `api.js`，错误文案、超时行为完全一致，不会出现「插件说成功、手表连不上」的分歧；
- 手表本来就要连 Nextcloud，多一个 HTTP 客户端只是多一份要维护的东西。

## 协议

请求（插件 → 手表），JSON 字符串：

```json
{
  "v": 1,
  "kind": "credentials",
  "base_url": "https://cloud.example.com",
  "user": "alice",
  "app_password": "xxxxx-xxxxx-xxxxx-xxxxx-xxxxx"
}
```

应答（手表 → 插件），JSON 字符串：

```json
{ "ok": true, "message": "已保存", "display_name": "Alice" }
```

字段约定：

| 字段 | 说明 |
| --- | --- |
| `v` | 协议版本，当前 `1`。版本不匹配时手表**明确报错**而不是半解析 |
| `kind` | 固定 `credentials`，用于在共享通道上区分别的消息 |
| `base_url` | 两端都会 trim 并去掉尾部 `/` |
| `ok` | 手表是否配置成功 |
| `message` | 展示给人看的一句话，失败时就是失败原因 |
| `display_name` | 校验成功时 Nextcloud 返回的显示名 |

`kind` 不匹配或 JSON 解析失败时，手表**静默忽略**（`silent: true`）：interconnect 是共享通道，别的应用的消息不该弹到用户脸上。

两侧实现：

- 手表：`src/common/scripts/protocol.js`（`parseCredentialMessage` / `buildAck`）
- 插件：`astrobox-plugin/src/protocol.rs`（`build_credential_message` / `parse_ack`）

改协议时两边一起改，并把 `PROTOCOL_VERSION` 加一。

## 时序

```
插件 on_load        枚举设备 → register_interconnect_recv(addr, pkg) → 探测快应用是否安装
手表 设置页         点「从手机配置」→ interconnect.instance() → onmessage 挂好
用户               填三个字段 → 点「发送到手表」
插件               校验格式 → send_qaic_message(addr, pkg, json) → set_timeout(15s)
手表 onmessage      解析 → 校验必填与 scheme → api.getCurrentUser()
      成功          store.save → 回 ack{ok:true} → 1.6s 后跳回会话列表
      失败          （不清空原有配置）→ 回 ack{ok:false, message}
插件 on_event       interconnect-message → 解析 ack → 更新状态；成功则清空内存密码
插件 timer          15s 内没收到 ack → 提示「确认 Talk 已打开并停在配置页」
```

## 前置条件（重要）

1. **手表上必须先打开 Talk 并停在「从手机配置」**。Vela 快应用退到后台会被挂起，收不到 interconnect 消息。
2. **快应用与手机端签名一致**。官方 Vela 文档写得很明确：`interconnect` 要求快应用 `package` 与手机端 App 包名一致、且 rpk 用同一张证书签名。AstroBox 的 `interconnect` host API 按 `pkg-name` 投递，是否绕开这条限制**未在真机验证**——这也是本项目目前最大的未知项。
3. 插件需要在 AstroBox 里被授予 `device` / `interconnect` / `thirdpartyapp` / `ui` 权限。

## 手表侧实现

`src/pages/setup/setup.ux`：

```js
import interconnect from '@system.interconnect'

const connect = interconnect.instance()
connect.onmessage = (evt) => {
  const parsed = protocol.parseCredentialMessage(evt.data)
  if (!parsed.ok) { /* silent 就直接 return */ }
  // 校验 -> 保存 -> connect.send({ data: protocol.buildAck({...}) })
}
```

`manifest.json` 需要 `{ "name": "system.interconnect" }`。入口在设置页的「从手机配置」一行。

## 排错

| 现象 | 先看 |
| --- | --- |
| 插件点发送后一直「正在发送…」，15s 后超时 | 手表没停在配置页；或 interconnect 被签名限制挡住 |
| 手表停在「等待手机发送…」不动 | 插件 send 返回了 `Err`，看 AstroBox 日志里插件的 stdout |
| 手表报「账号或应用密码错误」 | 应用密码填错，或用了账号密码。去 Nextcloud → 安全 → 应用密码 重新生成 |
| 手表报「会话参数缺失」之类无关错误 | 协议版本不匹配，确认插件与 rpk 是同一版本 |
| 插件根本看不到表单 | 插件 manifest 的 `permissions` 有 Host 不认的名字，逐个删掉排查 |
