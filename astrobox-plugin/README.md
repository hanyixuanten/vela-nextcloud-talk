# Talk 凭据配置 · AstroBox 插件

在 AstroBox（手机 / 桌面端）里填好服务器、用户名和应用密码，一键推送到手表上的 Talk 应用，省掉在 480px 圆屏上用九宫格敲一长串应用密码。

```
AstroBox (插件 UI)  ──interconnect──>  手表 Talk (pages/setup)
        ↑                                      │
        └────────── ack(ok/message) ───────────┘
```

## 形态

插件使用 **API Level 3 / WASI Preview 2**，将 Rust 编译为 `wasm32-wasip2` WebAssembly Component，通过 WIT 接口与宿主交互。[AstroBox v4 文档](https://abox.run/docs/plugin-development/v4/whats-new)确认 Level 2/3 继续由旧运行时支持；[Level 4 互联接口](https://github.com/AstralSightStudios/AstroBox-NG-Module-PluginSystem/blob/7e718be5294722af49b9e166cc76b9b49150a392/src/v4/host/interconnect.rs)与 Level 3 共用 QAIC 发送实现，因此修复通信不需要迁移到 WASI Preview 3。

- 入口是 `src/lib.rs`，实现 `lifecycle::Guest` 与 `event_v3::Guest`；
- UI 不是 HTML，是宿主渲染的**声明式元素树**（`ui-v3` 的链式 Builder）；
- 异步跨边界用 `future<T>`，Rust 侧拿到的就是 `FutureReader<T>`。

## 目录

```
astrobox-plugin/
├── Cargo.toml              # cdylib，target 见 .cargo/config.toml
├── .cargo/config.toml      # build.target = wasm32-wasip2
├── manifest.json           # 插件清单（版本 0.1.11、entry / wasi_version / api_level / permissions）
├── icon.png
├── src/
│   ├── lib.rs              # 生命周期、事件入口、发送流程
│   ├── ui.rs               # 凭据表单（ui-v3 元素树）
│   ├── protocol.rs         # 与手表应用的 JSON 协议
│   ├── state.rs            # 单一 Mutex 状态 + 快照
│   └── logger.rs           # 只往 stdout 打日志（见下）
├── tests/protocol.rs       # 协议单测（这个能跑）
└── scripts/
    ├── build_dist.py       # 构建 + 打包 .abp
    └── check_artifact.py   # 离线校验产物能否安装（不需要 AstroBox）
```

## 构建

需要 Rust（含 `wasm32-wasip2` 目标）与 Python 3。**工具链版本不能随便换**，见下面「为什么固定 Rust 1.92」：

```bash
rustup target add wasm32-wasip2   # 具体版本由 rust-toolchain.toml 决定

python3 scripts/build_dist.py                    # 调试构建到 dist/
python3 scripts/build_dist.py --release --package  # 发布构建并打 .abp
```

产物：

```
dist/nctalk_credential.wasm     # wasm component
dist/manifest.json  dist/icon.png
dist/nctalk-credential-0.1.11.abp  # 直接拖进 AstroBox 安装（ASCII 文件名）
```

⚠️ 如果系统里同时装了发行版 rustc（没有 wasm std），`build_dist.py` 调用的 `cargo` 可能是错的那个，会报 `can't find crate for core`。用 rustup 的 cargo：

```bash
PATH="$HOME/.cargo/bin:$PATH" python3 scripts/build_dist.py --release --package
```

### 为什么没有迁到 Level 4

宿主 `src/v4/host/device.rs` 与 v3 完全一致：

```rust
if !check_permission_declared(&app_handle, permissions, "device", ...).await {
    return Ok(Vec::new());
}
```

Level 4 换的是 wasmtime 48 / WASI p3、`async fn` 导出和 `astrobox:psys-host-v4` 这组包，**权限流程没有任何变化**：仍是「manifest 声明 + 前端授权」，前端拒绝就静默返回空列表。因此 Level 4 重写解决不了「设备枚举被拒」，而且 `astrobox-ng-wit` 在 crates.io 上只有 0.3.1（没有 v4 世界），得改成 git 依赖 master 的 0.4.0。

真正绕开它的办法是**不枚举**：地址可以从 `device-action` 事件（`{action, addr, name}`，不校验权限）里拿，或者在「设备地址（高级）」里手填。

### 为什么固定 Rust 1.92

组件里声明的 WASI 版本由**编译它的 Rust std** 决定，而 AstroBox 的 level 2/3 运行时是 wasmtime 38，只实现 **WASI 0.2.6**：

| Rust | 组件里的 wasi 版本 |
| --- | --- |
| 1.90 | 0.2.3 |
| 1.91 / 1.92 / 1.93 | 0.2.6 ← 正好是宿主上限 |
| 1.100（当前 stable） | 0.2.12 |

用 stable 编出来的包**编译一切正常**，装进 AstroBox 却加载失败——组件要求 `wasi:io/poll@0.2.12`，宿主只有 0.2.6，链接阶段就挂了。这就是最早「插件装不上」的真正原因，而不是 manifest 写错。

`rust-toolchain.toml` 把工具链钉在 1.92.0，`check_artifact.py` 会把超过 0.2.6 的包判成错误。

### 产物自检

装不上时先跑这个，不用连手机：

```bash
python3 scripts/check_artifact.py                    # 默认找 dist/*.abp
python3 scripts/check_artifact.py path/to/x.abp
```

它检查真会坏事的那几项：zip 布局是否扁平、manifest 必填字段类型、`entry` 指向的文件是否真在包里且是 **component** 而非 core module、文件名是否 ASCII、权限名是否在已知集合内。

### 测试

协议层是纯 serde，可以脱离 wasm 跑：

```bash
cargo test --locked --target x86_64-unknown-linux-gnu --test protocol
```

`tests/protocol.rs` 用 `#[path = "../src/protocol.rs"]` 把源文件编进测试 crate，所以**没有第二份协议实现**。插件本体依赖 wit-bindgen，只能编到 wasm，无法给 host 跑单测——这是刻意的取舍，不是偷懒。

## 安装

`.abp` 拖进 AstroBox 即可；或把 `dist/` 整个丢进插件目录后重启 AstroBox：

```
Windows  %APPDATA%\moe.astralsight.astrobox\plugins\<插件名>\
macOS    ~/Library/Application Support/moe.astralsight.astrobox/plugins/
Linux    ~/.local/share/moe.astralsight.astrobox/plugins/
```

## 用起来

1. 手表上安装 Talk（rpk），打开它 → 设置 → **从手机配置**，页面停在「等待手机发送…」；或直接点插件里的「打开手表上的 Talk」，由 `thirdpartyapp::launch-qa` 启动到 `pages/setup`。
2. AstroBox 里打开「Talk 凭据配置」，填服务器地址、用户名、应用密码。
3. 先点「检测设备」找手表，再点「发送到手表」。两者都会按「唯一候选」规则定位：恰好一台已连接设备，或恰好一台已配对设备（发送时会尝试建立连接）。多台即拒绝猜测。设备连上/断开时宿主的 `device-action` 事件也会自动触发重测。
   **设备枚举只由点击触发，不在渲染时发起**：已上架且能正常读到设备的两个插件（BandTOTP、otp-helper）都是从点击回调里调 `get_connected_device_list()`，渲染期请求 `device` 权限是唯一会拿到「未授权 → 空列表」的时机。同理，`get_thirdparty_app_list`（宿主上限 12 秒）不在检测链上：枚举一回来就出结论并绘制「目标：<手表名>」，应用列表与 ack 订阅随后在后台补，失败或过时都不影响结论。
   若设备列表始终为空（`device` 权限被前端拒绝时宿主只返回空列表），把 AstroBox 设备详情里的地址填进「设备地址（高级）」——填了就不再枚举，启动与发送只依赖 `thirdpartyapp` / `interconnect` 权限。
4. 手表请求 `/ocs/v2.php/cloud/user` 校验，保存后回复 ACK。宿主发送成功不等于已保存；只有匹配的成功 ACK 才会清空密码和显示「已保存」。

### 线上路由和协议

- **手机 → 手表：** `interconnect.send-qaic-message(addr, pkg-name, data)` 将 `data` 的 UTF-8 字节通过小米设备的 QAIC 传给快应用。宿主在目标设备的已安装列表中按包名查找应用及其签名指纹；不要用通用 `transport.send` 或手机端原生应用配对来替代这条路由。`data` 是 v1 JSON（`kind: "credentials"`、`base_url`、`user`、`app_password`），新版插件额外发送字符串 `request_id`。
- **手表 → 手机：** 手表使用 `connect.send({data: ackObject})`，ACK JSON 为 `ok`、可选 `message` 和 `display_name`，且须回显本次字符串 `request_id`。当前 AstroBox 的 `InterconnectMessage` 事件包装为 `{addr, pkgName, payloadHex, payloadText}`，其中 `payloadText` 是 ACK 的 JSON 文本；插件要求来源设备、包名和请求 ID 全部匹配，不接受无 request_id 的旧 ACK。
- **异步驱动：** 所有宿主调用都在回调里用 `block_on` 同步跑完，不用 `spawn`。wit-bindgen 的 `spawn` 只在「发起它的 async 计算」内部被 poll，导出回调里的 spawned task 可能一次都不执行——那会让插件看起来**从未请求过任何权限**（没有弹窗、没有枚举、永远「没有设备」）。两个能用的第三方插件（BandTOTP、otp-helper）都是 `block_on`。
- **超时：** 点发送后立即独立启动 15 秒计时器，不依赖设备/互联宿主调用返回；`Timer` 事件包装为 `{timerId, kind: "timeout", payload}`，`payload` 含本次请求 ID，不会让上一次定时器中断新请求。若宿主调用自身永不返回（例如枚举设备挂起），计时器仍会结束等待；此外超过 15 秒 + 5 秒宽限的挂起请求会在下次重绘、输入或点「重新检测」时被自动清除，UI 不会永久停在「正在发送…」。

## 权限

`manifest.json` 里声明：

| 权限 | 用途 |
| --- | --- |
| `device` | 枚举已连接设备，拿 `addr` |
| `interconnect` | 向手表的快应用发消息 |
| `thirdpartyapp` | 检查 Talk 是否已安装（没装就提前提示） |
| `register_interconnect_recv` | 订阅快应用回传的 ack（漏了就永远收不到回复） |

**渲染 UI 不需要权限。** 早期版本这里写的是 `ui`，是错的：已上架的第三方插件用 `ui_v3` 渲染整个界面，却只声明了 `device`/`interconnect`/`network`/`thirdpartyapp`/`register_interconnect_recv`。权限是**按 host 函数**授予的细粒度白名单，写一个不存在的名字反而可能让整份 manifest 反序列化失败——表现就是「装不上」。

按最小权限原则，没有声明 `network`：**插件自己不联网**，凭据校验交给手表那边做（手表本来就要连 Nextcloud）。好处是密码只经过一条链路（蓝牙 → 手表），插件端不产生任何对外请求。

## 设计取舍

**应用密码输入框是普通文本，不是密码框。** Nextcloud 的应用密码是 `xxxxx-xxxxx-xxxxx-xxxxx-xxxxx` 这种长串，掩码只会让人看不出自己漏了几位；而这个表单本来就跑在用户自己的设备上，掩码换不来安全感，只换来重输。真正的保护在别处：不落盘、发完即清、只经蓝牙一跳。

**密码不在插件里持久化（是选择，不是限制）。** Host API 里没有文件系统函数（`os` 只给 arch/hostname/locale），但运行时确实提供 WASI std fs，只是限定在插件自己的目录内——所以 `std::fs` 是可用的，真要落盘做得到。这一版没做：每次打开重新输入，真正的保存在手表的 `@system.storage`，收到匹配的成功 ACK 后插件清空表单里的密码。少一处明文落盘就少一处泄露面。

**只连接一台设备时才发送。** 如果 `device.get_connected_device_list()` 返回多台，断开其他设备再重试，避免把凭据发给错误的手表。

计时器在发送前同步建立（见上面的「线上路由和协议」）。由于宿主调用改为 `block_on` 同步等待，枚举/订阅/发送若永不返回，这一次点击会一直挂着——这正是 BandTOTP 的行为，也比「假装没设备」更诚实；面板侧仍用 15 秒 + 5 秒宽限清理挂起的发送。

**无文件日志。** 官方模板的 `logger.rs` 用 `tracing-appender` 写滚动文件，而它内部调用 `symlink::symlink_file`，在 wasm 目标上被编译掉，直接编译失败。这里改成只写 stdout（AstroBox 会捕获）。如果你从模板起步，第一件事就是把这段换掉。

## 已知限制

- **真机互联尚未验证。** 需使用支持小米 QAIC 的设备、已安装的 Talk 快应用，并将其停在「从手机配置」页。分别检查成功保存、错误密码返回失败、关闭手表页面导致超时后重试，以及打开表单后才连接设备。应用端的 `@system.interconnect` 支持情况随设备和固件而异。
- **`api_level: 3` 有版本门槛。** 需要 AstroBox ≥ 2.1.0；低于此版本会拒绝加载插件。
- **WASI 版本是硬约束。** 更换工具链后需重新运行 `check_artifact.py`。
