# 从手机配置 Nextcloud 凭据

AstroBox 插件只负责把用户输入的凭据通过蓝牙发给手表上的 Talk。手表**先把凭据落到 storage，再用自己的网络调用 `GET /ocs/v2.php/cloud/user` 校验**：校验只决定要不要补上显示名和回执的成功/失败，不决定凭据是否保存——密码是在手机上敲的，一次超时或一次输错都不该让它丢掉。所以回执 `ok:false` 的含义是「校验没通过」，文字里同时会说明凭据已保存。插入的应用密码只应授予此设备并通过 HTTPS 使用；插件不把密码写盘。

## 使用和真机验收

1. 安装与手表屏幕相符的 RPK，包名必须是 `com.hanyixuanten.nctalk`；同时在手机 AstroBox 安装同一次构建的 ABP，并连接目标手表。
2. 打开表上的 Talk，停在入口页的网络门之后（先确认手表有可用网络接口：`pages/splash` 只在 `@system.network` 类型为空或 `none` 时才停在离线页；服务器探针只记录、不拦人）。也可以直接点插件里的「打开手表上的 Talk」——它会用 `thirdpartyapp::launch-qa` 把快应用启动到 `pages/setup`（旧固件拒绝非入口页时回退到 `pages/index`，直接进会话列表；网络门只挡「没有任何网络接口」，不会把它弹回启动页，然后手动走 设置 → 从手机配置）。**只有 `pages/setup` 在前台时手表才在监听 interconnect，应用不在这一页，发送必然被丢弃。**
3. 打开手机的「Talk 凭据配置」，确保 AstroBox 只连接需要配置的那一块表，输入 HTTPS 地址、用户名和应用密码后发送。确认手表先写 storage、随后显示校验并在通过后进入会话列表；同时确认手机收到成功回执。重开 Talk，确保配置仍存在。
4. 再用错误的应用密码测试：两边都应显示失败，但手表上保存的已经是这次发来的凭据（回执文字带「已保存；」前缀），在手表「设置 → 账号」里改正即可。最后退出手表配置页再发送，确认手机报告超时而不是一直显示发送中，且可重试。
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

- 插件使用 AstroBox API Level 4（manifest `wasi_version: 3` / `api_level: 4`，见 [Level 4 文档](https://abox.run/docs/plugin-development/v4)），宿主接口全部是 `async func`；Level 2/3 的插件继续由旧运行时支持，但本插件不再兼容只支持 Level 2/3 的 AstroBox。
- AstroBox 通过已连接设备地址和已安装快应用的包名定位目标。`send_qaic_message` 返回成功不等于手表已经处理。当前宿主的 `interconnect-message` 用 `{addr,pkgName,payloadText,payloadHex}` 包装回执；插件须解包后读取 `ok`。定时器事件也有宿主包装，应用应识别它并结束等待。
- 设备状态是**实时**的：宿主在连接变化时推 `device-action`，插件收到后重新枚举并重绘；界面另有「检测设备」/「重新检测设备」按钮，点击时同样重测。二者都不依赖 `pending` 状态，因此上一次发送卡住也不会把面板锁死在旧结论上。
- **设备枚举只由点击触发，不在 `on_ui_render` 里发起。** 两个已上架、能正常找到设备的插件（BandTOTP、otp-helper）都是从点击回调调 `get_connected_device_list()`；渲染期请求 `device` 授权是唯一会拿到「未授权 → 空列表」的时机，而空列表与「真的没设备」在宿主侧无法区分。打开面板只绘制，第一步是让用户点「检测设备」。
- **Level 4 的宿主调用直接 `await`，`wit_future` 样板已删除。** 导出（`on_event` / `on_ui_event` / `on_ui_render` 等）都是 `async func`，由宿主驱动 guest task；宿主错误带 `string` 原因，发送和启动失败会记下具体原因。这样既不会出现 Level 2/3 里同步回调 `spawn` 的任务从不 poll（插件看起来**根本没发起过任何宿主调用**：没有 `device` 权限请求、没有弹窗、永远「没有设备」），也不会 `block_on` 写要返回宿主的 future 而触发 `deadlock detected`。因此探测不再有看门狗：枚举是在 async 回调里等待的，卡住会卡住这一次点击，但不会假装「没设备」。
- **检测链只包含枚举。** 宿主 `get_thirdparty_app_list` 自带 12 秒上限（`QUICK_APP_LIST_TIMEOUT`），早期版本把它和 `register_interconnect_recv` 串在枚举之后，手表明明 50 ms 就被找到，面板却要等完整条链才有结论。现在枚举一返回就提交并绘制「目标：<手表名 或 地址>」；应用列表**不在发送路径上**，只在发送已经失败或「打开 Talk」时查，用来把「没装 rpk」和「蓝牙/IPC 失败」区分开。
- **等待预算必须长于手表自己的判断。** 手表的 OCS 请求有 20 秒看门狗（`REQUEST_TIMEOUT_MS`），超时后还要写 storage、再回执，所以插件给 40 秒。预算比这短时会出现最误导人的现象：手表还在「正在校验账号…」，手机已经报「手表没有回应」判失败，用户在两端看到的结论相反。同理，`get_thirdparty_app_list` 那 12 秒也不能站在发送之前——它和旧版 15 秒的回执预算叠加时，凭据往往还没送到手表，手机就已经超时。Level 4 的 `timer::set_timeout` 是同步本地操作，到期仍以 `Timer` 事件回到 `on_event`；载荷里的 `request_id` 用来过滤旧定时器。
- **`device-action` 自带地址。** 宿主派发的载荷是 `{"action":"connected"|"disconnected","addr":"…","name":"…"}`（见宿主 `interconnect_link.rs`），插件直接把它当目标，**不需要 `device` 权限**；而 `launch_qa` / `send_qaic_message` 只要 `thirdpartyapp` / `interconnect` / `register_interconnect_recv`。所以「设备枚举被拒」不再等于「无法配置」：打开面板后在 AstroBox 里断开再连一次手表，状态行出现「目标：<手表名>」即可继续。
- 宿主的 `device` 接口没有错误通道：未授权或内部失败时只是返回空列表。因此面板在无设备时把宿主报告的「已连接 N / 已配对 M」数量显示出来，并区分「还没检测」与「检测过、确实没有」。
- [Vela 官方 Android 三方 App 互联](https://iot.mi.com/vela/quickapp/zh/features/network/interconnect.html)要求 Android 应用和快应用包名、签名一致。这里使用 AstroBox 的插件宿主及其设备通道，不改变 Android 签名或包名；是否能收发仍应以对应设备、固件和 AstroBox 版本的真机验证为准。工作流只能验证构建及协议，不跑蓝牙真机测试。

## 排错

| 现象 | 先检查 |
| --- | --- |
| 面板停在「正在检测设备…」 | 枚举是在 async 回调里等待的：宿主没返回就一直停在这句。看 AstroBox 日志里有没有 `permission request start 'device'`——有就是前端权限弹窗在等确认，没有就是插件没有发起调用（版本不对，重装当前版本 0.1.14）。 |
| 面板显示「已连接 0 / 已配对 0」 | 说明 `device` 权限没有拿到（前端授权被拒时宿主只返回空列表，不报错）。三条出路：① 在插件权限里把「设备」打开，恢复自动枚举；② 保持面板打开，在 AstroBox 里断手表再连一次，插件会从 `device-action` 直接拿到地址并显示「目标：<手表名>」；③ 把 AstroBox 设备详情里的地址填进「设备地址（高级）」，填了就不再枚举——启动与发送只需要 `thirdpartyapp` / `interconnect` 权限。 |
| 面板一直显示「没有已连接的设备」 | 先点「重新检测设备」。插件会枚举 AstroBox 当前**已连接**的设备，只配对未连接不算；仍然为空时在 AstroBox 里断开重连手表。设备单独连上/断开时宿主会推 `device-action`，面板会自动重测，不必关掉重开。 |
| 面板显示「已配对但当前未连接」 | 宿主管道暂时没建立，发送时会再尝试一次；失败请先在 AstroBox 里连接手表。 |
| 发送按钮长时间停在「正在发送…」 | 超过 45 秒（40 秒 ACK 超时 + 5 秒宽限）会自动清除挂起的请求并提示重发；也可立刻点「重新检测设备」重置。 |
| 手报表「正在校验账号…」很久，最后报「服务器没有响应」 | 手表没拿到任何 HTTP 响应，与凭据无关：确认手表已连 Wi-Fi、服务器地址从手表网络可解析（同一块表用「手动输入」登录同一地址可交叉验证）。日志里的 `request timeout: GET <url>` 会打印真实请求地址。 |
| 手机提示没找到手表或 Talk | 蓝牙连接、AstroBox 授权、是否选对设备、是否装了指定包名的 RPK。 |
| 手机超时，手表一直等待 | 手表是否停留在配置页前台，以及手机端是否与目标设备保持连接。 |
| 手表停在校验途中就熄屏 | 现在校验期间会 `setKeepScreenOn(true)` 并在成功/失败/离开页面时释放；若仍熄灭，说明该固件没有这个方法，日志里会有 `setKeepScreenOn failed`。 |
| 一打开就停在「没有网络」 | 启动网络门只判 `@system.network` 类型，停在离线页说明手表确实没有可用网络接口（Wi-Fi 未连/未关联）。连上后点「重试」即可，不需要重装。 |
| 能进会话列表，但请求报「网络请求失败：code=…」 | 网络接口正常、到服务器这一段不通。`code` 是平台传输错误（DNS / TLS / 连接），配合日志里的完整 URL 判断是域名解析、证书链还是端口被挡；这不是启动门在拦人。 |
| 手表提示保存成功但手机收不到确认 | 更新两端到同一次构建，检查手机与手表蓝牙连接。在手表打开会话列表确认配置是否已保存，避免误以为密码失效。 |
| 手表验证失败 | 凭据已按手机发来的内容保存；检查手表自身能否访问 Nextcloud、证书是否可信、是否使用有效的应用密码，改好后重新发送或手动登录。 |
| 装不上或不能覆盖旧版 | 核对旧、新 RPK 的包名和签名。必须卸载时先准备好重新配置，卸载可能清除手表端数据。 |
