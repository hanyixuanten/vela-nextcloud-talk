# 从手机配置 Nextcloud 凭据

AstroBox 插件只负责把用户输入的凭据通过蓝牙发给手表上的 Talk。手表用自己的网络调用 `GET /ocs/v2.php/cloud/user` 校验；只有认证通过且本地保存成功才确认。已有账号不受失败的验证影响。插入的应用密码只应授予此设备并通过 HTTPS 使用；插件不把密码写盘。

## 使用和真机验收

1. 安装与手表屏幕相符的 RPK，包名必须是 `com.hanyixuanten.nctalk`；同时在手机 AstroBox 安装同一次构建的 ABP，并连接目标手表。
2. 打开表上的 Talk，停留在「从手机配置」。也可以直接点插件里的「打开手表上的 Talk」——它会用 `thirdpartyapp::launch-qa` 把快应用启动到 `pages/setup`（旧固件拒绝非入口页时回退到 `pages/index`，再手动进设置）。**只有这一页在前台时手表才在监听 interconnect，应用不在这一页，发送必然被丢弃。**
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
- 设备状态是**实时**的：宿主在连接变化时推 `device-action`，插件收到后重新枚举并重绘；界面另有「检测设备」/「重新检测设备」按钮，点击时同样重测。二者都不依赖 `pending` 状态，因此上一次发送卡住也不会把面板锁死在旧结论上。
- **设备枚举只由点击触发，不在 `on_ui_render` 里发起。** 两个已上架、能正常找到设备的插件（BandTOTP、otp-helper）都是从点击回调调 `get_connected_device_list()`；渲染期请求 `device` 授权是唯一会拿到「未授权 → 空列表」的时机，而空列表与「真的没设备」在宿主侧无法区分。打开面板只绘制，第一步是让用户点「检测设备」。
- **检测链只包含枚举。** 宿主 `get_thirdparty_app_list` 自带 12 秒上限（`QUICK_APP_LIST_TIMEOUT`），早期版本把它和 `register_interconnect_recv` 串在枚举之后，state 又在链条末尾才提交，于是手表明明 50 ms 就被找到，4 秒看门狗却先把面板标成「设备枚举超时」。现在枚举一返回就提交结论并绘制「目标：<手表名 或 地址>」，应用列表与 ack 订阅在后台补，结果带 `probe_seq` 守卫，过期即丢弃。
- **`device-action` 自带地址。** 宿主派发的载荷是 `{"action":"connected"|"disconnected","addr":"…","name":"…"}`（见宿主 `interconnect_link.rs`），插件直接把它当目标，**不需要 `device` 权限**；而 `launch_qa` / `send_qaic_message` 只要 `thirdpartyapp` / `interconnect` / `register_interconnect_recv`。所以「设备枚举被拒」不再等于「无法配置」：打开面板后在 AstroBox 里断开再连一次手表，状态行出现「目标：<手表名>」即可继续。
- 宿主的 `device` 接口没有错误通道：未授权或内部失败时只是返回空列表。因此插件用 8 秒看门狗把「没有设备」和「调用没返回」区分开，并在无设备时把宿主报告的「已连接 / 已配对」数量显示出来。
- [Vela 官方 Android 三方 App 互联](https://iot.mi.com/vela/quickapp/zh/features/network/interconnect.html)要求 Android 应用和快应用包名、签名一致。这里使用 AstroBox 的插件宿主及其设备通道，不改变 Android 签名或包名；是否能收发仍应以对应设备、固件和 AstroBox 版本的真机验证为准。工作流只能验证构建及协议，不跑蓝牙真机测试。

## 排错

| 现象 | 先检查 |
| --- | --- |
| 面板停在「正在检测设备…」 | 宿主的设备枚举没有返回。先点「重新检测」；仍不动就重开面板或重启 AstroBox。超过 8 秒会自动转成「设备枚举超时」。 |
| 面板显示「设备枚举超时」 | 同上：宿主没有回答 `get-connected-device-list`。检查 AstroBox 版本与插件的「设备」权限。 |
| 面板显示「已连接 0 / 已配对 0」 | 说明 `device` 权限没有拿到（前端授权被拒时宿主只返回空列表，不报错）。三条出路：① 在插件权限里把「设备」打开，恢复自动枚举；② 保持面板打开，在 AstroBox 里断手表再连一次，插件会从 `device-action` 直接拿到地址并显示「目标：<手表名>」；③ 把 AstroBox 设备详情里的地址填进「设备地址（高级）」，填了就不再枚举——启动与发送只需要 `thirdpartyapp` / `interconnect` 权限。 |
| 面板一直显示「没有已连接的设备」 | 先点「重新检测设备」。插件会枚举 AstroBox 当前**已连接**的设备，只配对未连接不算；仍然为空时在 AstroBox 里断开重连手表。设备单独连上/断开时宿主会推 `device-action`，面板会自动重测，不必关掉重开。 |
| 面板显示「已配对但当前未连接」 | 宿主管道暂时没建立，发送时会再尝试一次；失败请先在 AstroBox 里连接手表。 |
| 发送按钮长时间停在「正在发送…」 | 超过 20 秒（15 秒 ACK 超时 + 5 秒宽限）会自动清除挂起的请求并提示重发；也可立刻点「重新检测设备」重置。 |
| 手机提示没找到手表或 Talk | 蓝牙连接、AstroBox 授权、是否选对设备、是否装了指定包名的 RPK。 |
| 手机超时，手表一直等待 | 手表是否停留在配置页前台，以及手机端是否与目标设备保持连接。 |
| 手表提示保存成功但手机收不到确认 | 更新两端到同一次构建，检查手机与手表蓝牙连接。在手表打开会话列表确认配置是否已保存，避免误以为密码失效。 |
| 手表验证失败 | 检查手表自身能否访问 Nextcloud、证书是否可信、是否使用有效的应用密码。 |
| 装不上或不能覆盖旧版 | 核对旧、新 RPK 的包名和签名。必须卸载时先准备好重新配置，卸载可能清除手表端数据。 |
