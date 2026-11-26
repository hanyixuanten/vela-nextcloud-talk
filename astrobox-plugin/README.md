# Talk 凭据配置 · AstroBox 插件

在 AstroBox（手机 / 桌面端）里填好凭据，一键推送到手表上的 Talk 应用，省掉在 480px 圆屏上用九宫格敲一长串密码。

两种模式，面板顶部一键切换：

| 模式 | 填什么 | 手表做什么 |
| --- | --- | --- |
| 账号 | 服务器、用户名、应用密码 | `GET /ocs/v2.php/cloud/user` 校验后保存 |
| 公开聊天室（无需账号） | 房间链接（或令牌）、房间密码（房间有就要）、显示名称 | 真的 join 一次房间，保存会话 cookie 与 `actorId` |

```
AstroBox (插件 UI)  ──interconnect──>  手表 Talk (pages/setup)
        ↑                                      │
        └────────── ack(ok/message) ───────────┘
```

## 形态

插件使用 **API Level 4**：manifest 声明 `wasi_version: 3` / `api_level: 4`，Rust 编译成 `wasm32-wasip2` WebAssembly Component，接入 `psys-world-v4` WIT 世界。Level 4 的宿主运行时是 wasmtime 48（WASI p2 + p3 同时提供），Level 2/3 继续跑在旧运行时上；详见 [Level 4 文档](https://abox.run/docs/plugin-development/v4) 和 [新特性](https://abox.run/docs/plugin-development/v4/whats-new)。

迁移到 Level 4 的收益不是“换了几个接口”：

- `lifecycle::on_load`、`event::on_event`、`on_ui_event`、`on_ui_render` 全部是 `async func`，插件里直接 `.await` 宿主接口，不再需要 `block_on` + `wit_future::new` + `spawn(writer.write)` 那套样板，也不会再有“spawn 出去的任务从来没被 poll”导致的权限弹窗不出现、设备列表永远为空。
- 宿主错误从裸 `result<_, ()>` 变成 `result<_, string>`，发送/启动失败能把宿主给的原因显示在面板上。
- 包名从 `astrobox:psys-host` / `astrobox:psys-plugin` 换成 `astrobox:psys-host-v4` / `astrobox:psys-plugin-v4`，由 `astrobox-ng-wit = "0.4"` 生成。

- 入口是 `src/lib.rs`，实现 `lifecycle::Guest` 与 `event::Guest`；
- UI 不是 HTML，是宿主渲染的**声明式元素树**（v4 的 `ui` Builder）；
- host 调用失败会带原因，界面直接展示。

## 目录

```
astrobox-plugin/
├── Cargo.toml              # cdylib，astrobox-ng-wit 0.4（v4 WIT 世界）
├── .cargo/config.toml      # build.target = wasm32-wasip2
├── rust-toolchain.toml     # 固定 Rust 1.93，见下
├── manifest.json           # api_level 4 / wasi_version 3 / 版本 0.1.15
├── icon.png
├── src/
│   ├── lib.rs              # 生命周期、异步事件入口、发送流程
│   ├── ui.rs               # 凭据表单（v4 ui 元素树）
│   ├── protocol.rs         # 与手表应用的 JSON 协议
│   ├── state.rs            # 单一 Mutex 状态 + 快照
│   └── logger.rs           # 只往 stdout 打日志（见下）
├── tests/
│   ├── protocol.rs         # 协议单测（原生 target 可跑）
│   └── v4.rs               # Level 4 manifest / async 导出契约测试
└── scripts/
    ├── build_dist.py       # 构建 + 打包 .abp
    └── check_artifact.py   # 离线校验产物能否安装（不需要 AstroBox）
```

## 构建

需要 Rust 1.93（含 `wasm32-wasip2` 目标）与 Python 3。工具链版本不能随便换，见下面「为什么固定 Rust 1.93」：

```bash
rustup target add wasm32-wasip2   # 具体版本由 rust-toolchain.toml 决定

python3 scripts/build_dist.py                    # 调试构建到 dist/
python3 scripts/build_dist.py --release --package  # 发布构建并打 .abp
```

产物：

```
dist/nctalk_credential.wasm     # wasm component（导入 astrobox:psys-host-v4/*）
dist/manifest.json  dist/icon.png
dist/nctalk-credential-0.1.15.abp  # 直接拖进 AstroBox 安装（ASCII 文件名）
```

⚠️ 如果系统里的 `cargo` 不是 rustup 的那个（本机 `/usr/bin/cargo` 用的是系统 1.100），`rust-toolchain.toml` 不会生效，可能编出错误的 WASI 版本。用 rustup 的 cargo：

```bash
PATH="$HOME/.cargo/bin:$PATH" python3 scripts/build_dist.py --release --package
```

### 为什么固定 Rust 1.93

Level 4 的运行时同时装了 WASI p2 和 p3，但 Rust 标准库仍通过 p2 target 链接，**组件里 p2 导入的版本由编译它的 Rust std 决定**：

| Rust | 组件里的 wasi 版本 |
| --- | --- |
| 1.90 | 0.2.3 |
| 1.91 / 1.92 / 1.93 | 0.2.6 ← 已验证的基线 |
| 1.100（当前 stable，提供 `wasm32-wasip3` 但未安装） | 0.2.12，需要重新验证 |

用新工具链编译一切正常，装进宿主却可能加载失败：组件要求更高版本的 `wasi:*`，宿主 p2 侧没有对应实现，链接阶段就挂了。`rust-toolchain.toml` 把工具链钉在 1.93，`scripts/check_artifact.py` 会把超过 0.2.6 的包判成错误，`tests/v4.rs` 会检查 manifest 与 v4 契约。

### 产物自检

装不上时先跑这个，不用连手机：

```bash
python3 scripts/check_artifact.py                    # 默认找 dist/*.abp
python3 scripts/check_artifact.py path/to/x.abp
```

它检查真会坏事的那几项：zip 布局是否扁平、manifest 必填字段类型、`api_level` 与 `wasi_version` 是否匹配（4↔3、2/3↔2）、`entry` 指向的文件是否真在包里且是 **component** 而非 core module、p2 导入是否越过已验证基线、文件名是否 ASCII、权限名是否在已知集合内。

### 测试

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo test --locked --target x86_64-unknown-linux-gnu
```

- `tests/protocol.rs` 用 `#[path = "../src/protocol.rs"]` 把源文件编进测试 crate，只有一份协议实现；
- `tests/v4.rs` 静态检查 manifest、`astrobox-ng-wit 0.4`、p2 target 以及全部 `async` 导出，防止某次改动悄悄退回 Level 2/3 的 `event_v3` / `wit_future` 写法。迁移前的代码跑这个测试 3 项全失败，迁移后全通过。

插件本体依赖 WIT 生成代码，只能编到 wasm，不给 host 跑单测——这是刻意的取舍。

## 安装

`.abp` 拖进 AstroBox 即可；或把 `dist/` 整个丢进插件目录后重启 AstroBox：

```
Windows  %APPDATA%\moe.astralsight.astrobox\plugins\<插件名>\
macOS    ~/Library/Application Support/moe.astralsight.astrobox/plugins/
Linux    ~/.local/share/moe.astralsight.astrobox/plugins/
```

## 用起来

1. 手表上安装 Talk（rpk），打开它 → 设置 → **从手机配置**，页面停在「等待手机发送…」；或直接点插件里的「打开手表上的 Talk」，由 `thirdpartyapp::launch_qa` 启动到 `pages/setup`。
2. AstroBox 里打开「Talk 凭据配置」，填服务器地址、用户名、应用密码；没有账号就点「切换到公开聊天室（无需账号）」，改填房间链接、房间密码（可留空）和显示名称。
3. 先点「检测设备」找手表，再点「发送到手表」。两者都会按「唯一候选」规则定位：恰好一台已连接设备，或恰好一台已配对设备（发送时会尝试建立连接）。多台即拒绝猜测。设备连上/断开时宿主的 `device-action` 事件也会自动触发重测。
   **设备枚举只由点击触发，不在渲染时发起**：渲染期弹 `device` 授权，前端拒绝后宿主只返回空列表，看起来就是「没有手表」。同理，`get_thirdparty_app_list`（宿主上限 12 秒）不在检测链上：枚举一回来就出结论并绘制「目标：<手表名>」，应用列表与 ack 订阅随后在后台补，失败或过时都不影响结论。
   若设备列表始终为空（`device` 权限被前端拒绝时宿主只返回空列表），把 AstroBox 设备详情里的地址填进「设备地址（高级）」——填了就不再枚举，启动与发送只依赖 `thirdpartyapp` / `interconnect` 权限。
4. 手表自己校验：账号模式请求 `/ocs/v2.php/cloud/user`，公开模式 `POST /room/{token}/participants/active`（房间有密码就带 `password`）再补一个访客显示名。保存后回复 ACK。宿主发送成功不等于已保存；只有匹配的成功 ACK 才会清空对应的密码字段并显示「已保存」。

### 线上路由和协议

- **手机 → 手表：** `interconnect.send_qaic_message(addr, pkg-name, data)` 将 `data` 的 UTF-8 字节通过小米设备的 QAIC 传给快应用。宿主在目标设备的已安装列表中按包名查找应用及其签名指纹；不要用通用 `transport.send` 或手机端原生应用配对来替代这条路由。`data` 是 v2 JSON：`kind: "credentials"`、`mode`（`account` / `public`）、账号三项（`base_url` / `user` / `app_password`）、公开三项（`room_link` / `room_password` / `display_name`），另一模式的字段留空字符串，另加字符串 `request_id`。房间链接原样传给手表解析——解析只有手表那一份实现（`src/common/scripts/roomlink.js`），插件只做「非空 + 看起来是 https」的就地检查。
- **手表 → 手机：** 手表使用 `connect.send({data: ackObject})`，ACK JSON 为 `ok`、可选 `message` 和 `display_name`，且须回显本次字符串 `request_id`。当前 AstroBox 的 `InterconnectMessage` 事件包装为 `{addr, pkgName, payloadHex, payloadText}`，其中 `payloadText` 是 ACK 的 JSON 文本；插件以回显的 `request_id` 作为唯一必需的匹配项，来源设备/包名只在**存在且不一致**时否决（旧宿主会直接透传 JSON，没有信封，按旧逻辑这种合法回执会被丢掉，面板于是在超时后报「手表没有回应」）。无 request_id 的旧 ACK 一律不接受，因为它分不清是哪一次发送。
- **异步驱动：** Level 4 的导出是 `async func`，宿主自己驱动这些 guest task。点击「发送到手表」时先建 40 秒超时，然后 `await` 枚举 / 订阅 / 发送；宿主调用都可能阻塞，但不再有 `block_on` 写 future 的死锁，也不再依赖 `spawn` 任务是否会被 poll。
- **超时：** 点发送后立即独立启动 40 秒计时器，不依赖设备/互联宿主调用返回；v4 的 `timer::set_timeout` 同步返回 timer id，到期后以 `Timer` 事件送到 `on_event`，`payload` 含本次请求 ID，不会让上一次定时器中断新请求。若宿主调用自身永不返回（例如枚举设备挂起），计时器仍会结束等待；此外超过 40 秒 + 5 秒宽限的挂起请求会在下次重绘、输入或点「重新检测」时被自动清除。40 秒不是随手取的：手表自己的 OCS 请求有 20 秒看门狗（`REQUEST_TIMEOUT_MS`），失败后还要写 storage、再回执；预算短于这条链时，手表还在「正在校验账号…」，手机已经判失败，两端结论相反。同理 `get_thirdparty_app_list`（宿主侧 12 秒上限）只在发送失败后才查，用来区分「没装 rpk」和「传输断开」，UI 不会永久停在「正在发送…」。

## 权限

`manifest.json` 里声明：

| 权限 | 用途 |
| --- | --- |
| `device` | 枚举已连接设备，拿 `addr` |
| `interconnect` | 向手表的快应用发消息 |
| `thirdpartyapp` | 检查 Talk 是否已安装、启动手表上的 Talk |
| `register_interconnect_recv` | 订阅快应用回传的 ack（漏了就永远收不到回复） |

**渲染 UI 不需要权限。** 权限是按 host 函数授予的细粒度白名单，写一个不存在的名字反而可能让整份 manifest 反序列化失败——表现就是「装不上」。

按最小权限原则，没有声明 `network`：**插件自己不联网**，凭据校验交给手表那边做（手表本来就要连 Nextcloud）。好处是密码只经过一条链路（蓝牙 → 手表），插件端不产生任何对外请求。Level 4 新增的 `http-server` / `notification` 等能力这里也没有用到，因此不需要额外授权。

## 设计取舍

**应用密码输入框是普通文本，不是密码框。** Nextcloud 的应用密码是 `xxxxx-xxxxx-xxxxx-xxxxx-xxxxx` 这种长串，掩码只会让人看不出自己漏了几位；而这个表单本来就跑在用户自己的设备上，掩码换不来安全感，只换来重输。真正的保护在别处：不落盘、发完即清、只经蓝牙一跳。

**密码不在插件里持久化（是选择，不是限制）。** Host API 里没有文件系统函数，但运行时确实提供 WASI std fs，只是限定在插件自己的目录内——所以 `std::fs` 是可用的，真要落盘做得到。这一版没做：每次打开重新输入，真正的保存在手表的 `@system.storage`，收到匹配的成功 ACK 后插件清空表单里的密码。少一处明文落盘就少一处泄露面。

**只连接一台设备时才发送。** 如果 `device.get_connected_device_list()` 返回多台，断开其他设备再重试，避免把凭据发给错误的手表。

**无文件日志。** 官方模板的 `logger.rs` 用 `tracing-appender` 写滚动文件，而它内部调用 `symlink::symlink_file`，在 wasm 目标上被编译掉，直接编译失败。这里改成只写 stdout（AstroBox 会捕获）。

## 已知限制

- **真机互联尚未在 Level 4 运行时上验证。** 需使用支持小米 QAIC 的设备、已安装的 Talk 快应用，并将其停在「从手机配置」页。分别检查成功保存、错误密码返回失败、关闭手表页面导致超时后重试，以及打开表单后才连接设备。应用端的 `@system.interconnect` 支持情况随设备和固件而异。
- **`api_level: 4` 有版本门槛。** 需要带 Level 4 运行时的 AstroBox；旧版本只支持 Level 2/3，会拒绝加载本插件。Level 2/3 的插件继续受旧运行时支持，但本插件不再兼容它们。
- **WASI 版本是硬约束。** 更换工具链后需重新运行 `check_artifact.py` 与 `cargo test`。
