# 手表端图片预览：暂缓自动加载

**决定：当前版本只显示附件文件名及原有消息文字，不自动下载或解码图片。** 不在会话列表、聊天列表、轮询或滚动时预取。以后可考虑一个默认关闭、由用户点按触发的单图缩略图原型；即使原型通过，也不等于批准自动预览。

## 已核实的接口与限制

| 接口 | 官方资料与项目判断 |
| --- | --- |
| Vela [`<image>`](https://iot.mi.com/vela/quickapp/en/components/basic/image.html) | `src` 接受本地和远程 URI，文档明确列出 PNG/JPG，提供 `complete(width, height)` 和 `error` 事件。没有给 `src` 加认证头的文档接口；不应直接绑定私有附件 URL。`object-fit` 是布局设置，不保证解码时降采样；`complete` 也晚于解码，不能作为尺寸安全门。 |
| Vela [`@system.fetch`](https://iot.mi.com/vela/quickapp/en/features/network/fetch.html#responsetype-and-data-relationship-in-success) | 支持自定义请求头，返回 HTTP 状态和响应头；`responseType: 'file'` 的 `data` 是临时文件 URI，文档明确说明临时图片可交给 `image`。这是候选路径，不是真机验证结果。文档没有承诺响应体流式读取、下载字节上限、取消或禁止自动重定向的选项。 |
| Vela [`@system.request`](https://iot.mi.com/vela/quickapp/en/features/network/request.html) / [`@system.file`](https://iot.mi.com/vela/quickapp/en/features/data/file.html) | `request.download` 返回 token，`onDownloadComplete` 返回默认落在应用缓存中的 URI；它不是现有清单声明的能力，也未提供验收所需的响应状态、头或传输上限保证，不作为自动回退。对 `internal://tmp/`，`file.get` / `file.delete` 文档明确不支持；[文件分区说明](https://iot.mi.com/vela/quickapp/en/guide/framework/project-structure.html#uri) 说明 tmp 只读，应用重启后 URI 不可访问，这不代表退出页面就会回收磁盘文件或解码内存。 |
| Nextcloud [Talk 消息](https://nextcloud-talk.readthedocs.io/en/stable/chat/#receive-chat-messages-of-a-conversation)与[富对象定义](https://github.com/nextcloud/server/blob/stable32/lib/public/RichObjectStrings/Definitions.php) | 从 `messageParameters` 识别真正的 `type: 'file'` 对象，不靠 `{file}` 键名、文件扩展名或正文链接。文件对象的 `id` 是实例内文件 ID，不是消息 ID；`mimetype`、`preview-available` 和原图尺寸均为可选字段。现有 [renderMessage](../src/common/scripts/format.js#L56-L75) 只做文字替换，预览失败不改变这条回退链。 |
| Nextcloud [Core 预览控制器（stable32）](https://github.com/nextcloud/server/blob/stable32/core/Controller/PreviewController.php) | 按 ID 的候选请求为 `GET <baseUrl>/index.php/core/preview?fileId=<id>&x=160&y=160&a=true&forceIcon=false&mimeFallback=false`（保留实例安装子路径，按目标版本和反向代理验证规范 URL）。源码中 `/core/preview.png` 是按路径的路由，不把它与按 ID 的路由混用。Core 在当前用户的目录下查找文件并检查可读权限；Talk 能显示文件名并不代表该账号能获取缩略图。这个端点返回图片而非 OCS JSON，也不保证所有版本、共享类型和预览配置都可用。 |

Xiaomi 的 fetch/download 支持表分别列出 Watch S3、Watch S4、REDMI Watch 5；未单列 S4 Sport。支持下载不等于已验证 Basic Auth、临时 URI、图片解码或文件回收在该固件上的组合行为。仓库的 [manifest](../src/manifest.json#L9-L17) 已声明 `system.fetch` 和 `system.file`；现有 [OCS 请求封装](../src/common/scripts/api.js#L100-L139) 则只解析文本 JSON，不应把二进制响应塞进该链路。

## 解码内存估算

按 `宽 × 高 × 每像素字节` 估算**一张解码像素缓冲区**，按 2 B/像素（RGB565）和 4 B/像素（RGBA8888）对比，并不假设 Vela 实际采用哪一种。以下不是整页峰值或手表内存预算；还可能同时持有压缩响应、解码工作区、缩放/合成缓冲和缓存副本。文件的压缩字节数、物理分辨率或 CSS 尺寸都不能给原图解码峰值设限。

| 实际输入像素 | RGB565 | RGBA8888 |
| --- | ---: | ---: |
| 160 × 160（原型上限） | 50 KiB | 100 KiB |
| 240 × 240 | 112.5 KiB | 225 KiB |
| 480 × 480 | 450 KiB | 900 KiB |
| 1920 × 1080 | 3.96 MiB | 7.91 MiB |
| 4032 × 3024（约 12 MP） | 23.26 MiB | 46.51 MiB |

即使每张只有 160 × 160，首屏批次若把 40 张都解码并保留，单按 RGBA 缓冲也约 3.91 MiB，尚未计入其他开销。限制并发下载也不等于限制已解码图片数量。

## 未来原型：必须满足的门槛

1. **只处理用户点按的单张缩略图。** 独立预览区，一次最多一个请求和一张已挂载图片；无后台队列、重试、持久缓存或原图回退。只接受当前本地会话中可识别的 PNG/JPEG 文件对象和合法正整数文件 ID；元数据缺失或含糊、明确不可预览、限制下载、访客/联邦等未验证情形保留文字。不创建公开分享，也不改变既有权限。
2. **凭证只用于已配置的同源 HTTPS 实例。** 使用应用密码的 Basic 请求头，URL 只由配置的实例基址、固定预览端点和经校验的 ID 构造；不跟随消息提供的链接，不把凭证写进 URL、UI、错误信息或日志。禁止重定向优先；若平台无法禁用，须证明不会跟随到其他源，也不会把凭证转发到非预期端点；只接受预期端点的 200 图片响应。无法证实时不启用。
3. **独立限制压缩字节和解码像素。** 原型建议实际响应体 ≤64 KiB、PNG/JPEG 两边各 ≤160 像素、总像素 ≤25,600。请求 `x/y` 和响应的 `Content-Length` 都不构成硬上限；只认经验证的传输上限（读取/落盘前可强制限制，或由受控响应端强制限制并验证），不假设 `fetch` 能靠 `success` 回调止住下载。交给 `<image>` 前验证 HTTP 状态、MIME、文件签名和真实尺寸，拒绝动画、损坏文件、过大图、类型不符和无法验证的响应；不通过 Base64 或无界 ArrayBuffer 绕过限制。若临时 URI 无法安全地做有界预检，且没有经验证的受控响应路径，则不启用。
4. **关闭时不保留图片。** 返回、切房、切换账号、进入输入态、退后台或超时都卸载图片并使迟到回调无效。UI 超时不是底层取消；底层请求未结束时不要开启下一张。应用自有缓存文件须可清理，系统 tmp 使用须通过真机验证不会随反复开关持续堆积。权限、网络或解码失败只显示文件名及简短失败提示，不阻塞聊天、已读或输入。

## 真机验收（待执行）

- **矩阵：** Xiaomi Watch S3、S4、S4 Sport（圆屏包）和 REDMI Watch 5（矩形包）逐个验证。记录型号、固件/Vela 版本、RPK 和 Nextcloud/Talk 版本、网络方式、安装路径及预览配置。模拟器可用于预检，不计入真机通过；未测型号不启用。
- **成功路径：** 先验证同一张内置 PNG/JPEG，再用测试账号走真实的 app-password → Core 预览 → Vela 临时 URI → `image` 链路。验证 160 × 160 边界、长宽比例、两种屏幕布局及无文件预取；记录从点按到首图/错误的时延、传输字节、`complete/error` 和 HTTP 状态，不记凭证、私人路径或原图内容。
- **失败路径：** 以隔离测试服务和无价值测试凭证覆盖 401/403/404、权限撤销、服务器关闭预览、跨源 3xx、登录页或错误 MIME、断网和超时。用无长度/错误长度、超字节上限、压缩很小却像素超限、损坏及动画等样本确认在解码前拒绝；同时确认无跨源认证、无原图请求，且单图失败不影响文字消息。
- **回归与压力：** 对比同固件、同房间的[纯文字基线](watch-memory-baseline.md)；至少连续打开/关闭 50 次，并在下载中返回、切房、锁屏休眠、快速重复点按或断网。用含 40 条附件的房间执行滚动、轮询、收发和键盘操作。记录请求并发、文件数及缓存字节、可用的内存峰值和关闭后的回落，以及滚动/键入时延；同时观察卡顿、崩溃、系统杀进程、旧图串到新页面或缓存持续增长。若工具看不到原生解码内存，标为未测，不以 JS 堆或「没崩」替代。
- **放行：** 各目标型号均须证明硬上限、认证边界、单请求/单图及释放行为；无崩溃、失控增长或可见的聊天/输入退化，并有实测峰值相对文字基线的安全余量。缺任何一项继续保留文件名；通过也只评审点按原型，不开启自动预览。
