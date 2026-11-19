# 从手机配置 Nextcloud 凭据

AstroBox 插件只负责把用户输入的凭据通过蓝牙发给手表上的 Talk。手表用自己的网络调用 `GET /ocs/v2.php/cloud/user` 校验；只有认证通过且本地保存成功才确认。已有账号不受失败的验证影响。插入的应用密码只应授予此设备并通过 HTTPS 使用；插件不把密码写盘。

## 使用和真机验收

1. 安装与手表屏幕相符的 RPK，包名必须是 `com.hanyixuanten.nctalk`；同时在手机 AstroBox 安装同一次构建的 ABP，并连接目标手表。
2. 打开表上的 Talk，停留在「从手机配置」。首次启动默认进该页，有账号时可从设置进入。
3. 打开手机的「Talk 凭据配置」，确保 AstroBox 只连接需要配置的那一块表，输入 HTTPS 地址、用户名和应用密码后发送。确认手表先显示校验、随后保存并进入会话列表；同时确认手机收到成功回执。重开 Talk，确保配置仍存在。
4. 再用错误的应用密码测试：两边都应显示失败，手表原有账号仍可用。最后退出手表配置页再发送，确认手机报告超时而不是一直显示发送中，且可重试。
5. 两种屏幕分别检查主页、设置、配置页，以及登录和聊天的键盘、返回键、发送键是否可见且可点。

## 协议（v1）

手机发送 UTF-8 JSON 字符串；手表的 `onmessage` 也兼容已解码的对象：

```json
{"v":1,"kind":"credentials","request_id":"cfg-1","base_url":"https://cloud.example.com","user":"alice","app_password":"example"}
```

手表将对象交给 Vela `connect.send({ data: … })` 序列化：

```json
{"ok":true,"message":"已保存","display_name":"Alice","request_id":"cfg-1"}
```

`request_id` 是可选字符串：手表在回执原样带回，用于区分重试后到达的旧回执。旧版请求无此字段时仍能处理。非凭据消息或无法解析的消息忽略；`kind: credentials` 但版本或参数不正确时返回失败回执。协议实现见 [手表端](../src/common/scripts/protocol.js) 与 [插件端](../astrobox-plugin/src/protocol.rs)。

## 宿主事件与限制

- 插件使用 AstroBox API Level 3（WASI Preview 2），属于官方 [V2 系列接口](https://abox.run/docs/plugin-development/v2/host-api/interconnect)；Level 4 与之共存，本次不要求升级运行时。
- AstroBox 通过已连接设备地址和已安装快应用的包名定位目标。`send_qaic_message` 返回成功不等于手表已经处理。当前宿主的 `interconnect-message` 用 `{addr,pkgName,payloadText,payloadHex}` 包装回执；插件须解包后读取 `ok`。定时器事件也有宿主包装，应用应识别它并结束等待。
- [Vela 官方 Android 三方 App 互联](https://iot.mi.com/vela/quickapp/zh/features/network/interconnect.html)要求 Android 应用和快应用包名、签名一致。这里使用 AstroBox 的插件宿主及其设备通道，不改变 Android 签名或包名；是否能收发仍应以对应设备、固件和 AstroBox 版本的真机验证为准。工作流只能验证构建及协议，不跑蓝牙真机测试。

## 排错

| 现象 | 先检查 |
| --- | --- |
| 手机提示没找到手表或 Talk | 蓝牙连接、AstroBox 授权、是否选对设备、是否装了指定包名的 RPK。 |
| 手机超时，手表一直等待 | 手表是否停留在配置页前台，以及手机端是否与目标设备保持连接。 |
| 手表提示保存成功但手机收不到确认 | 更新两端到同一次构建，检查手机与手表蓝牙连接。在手表打开会话列表确认配置是否已保存，避免误以为密码失效。 |
| 手表验证失败 | 检查手表自身能否访问 Nextcloud、证书是否可信、是否使用有效的应用密码。 |
| 装不上或不能覆盖旧版 | 核对旧、新 RPK 的包名和签名。必须卸载时先准备好重新配置，卸载可能清除手表端数据。 |
