# Talk 凭据配置 · AstroBox 插件

在 AstroBox（手机 / 桌面端）里填好服务器、用户名和应用密码，一键推送到手表上的 Talk 应用，省掉在 480px 圆屏上用九宫格敲一长串应用密码。

```
AstroBox (插件 UI)  ──interconnect──>  手表 Talk (pages/setup)
        ↑                                      │
        └────────── ack(ok/message) ───────────┘
```

## 形态

AstroBox v2 插件是一个 **Rust 库编译成的 `wasm32-wasip2` WebAssembly Component**，通过 WIT 定义的接口与宿主交互（无共享内存、无 syscall）。所以：

- 入口是 `src/lib.rs`，实现 `lifecycle::Guest` 与 `event_v3::Guest`；
- UI 不是 HTML，是宿主渲染的**声明式元素树**（`ui-v3` 的链式 Builder）；
- 异步跨边界用 `future<T>`，Rust 侧拿到的就是 `FutureReader<T>`。

## 目录

```
astrobox-plugin/
├── Cargo.toml              # cdylib，target 见 .cargo/config.toml
├── .cargo/config.toml      # build.target = wasm32-wasip2
├── manifest.json           # 插件清单（entry / wasi_version / api_level / permissions）
├── icon.png
├── src/
│   ├── lib.rs              # 生命周期、事件入口、发送流程
│   ├── ui.rs               # 凭据表单（ui-v3 元素树）
│   ├── protocol.rs         # 与手表应用的 JSON 协议
│   ├── state.rs            # 单一 Mutex 状态 + 快照
│   └── logger.rs           # 只往 stdout 打日志（见下）
├── tests/protocol.rs       # 协议单测（这个能跑）
└── scripts/build_dist.py   # 构建 + 打包 .abp
```

## 构建

需要 Rust（含 `wasm32-wasip2` 目标）与 Python 3：

```bash
rustup target add wasm32-wasip2

python3 scripts/build_dist.py                    # 调试构建到 dist/
python3 scripts/build_dist.py --release --package  # 发布构建并打 .abp
```

产物：

```
dist/nctalk_credential.wasm     # wasm component
dist/manifest.json  dist/icon.png
dist/Talk 凭据配置.abp           # 直接拖进 AstroBox 安装
```

⚠️ 如果系统里同时装了发行版 rustc（没有 wasm std），`build_dist.py` 调用的 `cargo` 可能是错的那个，会报 `can't find crate for core`。用 rustup 的 cargo：

```bash
PATH="$HOME/.cargo/bin:$PATH" python3 scripts/build_dist.py --release --package
```

### 测试

协议层是纯 serde，可以脱离 wasm 跑：

```bash
cargo test --target x86_64-unknown-linux-gnu --test protocol
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

1. 手表上安装 Talk（rpk），打开它 → 设置 → **从手机配置**，页面停在「等待手机发送…」。
2. AstroBox 里打开「Talk 凭据配置」，填服务器地址、用户名、应用密码。
3. 点「发送到手表」。插件把凭据通过 interconnect 发给 `com.hanyixuanten.nctalk`。
4. 手表校验（真的去请求 `/ocs/v2.php/cloud/user`）→ 回一条 ack → 插件显示「已保存（显示名）」。

## 权限

`manifest.json` 里声明：

| 权限 | 用途 |
| --- | --- |
| `device` | 枚举已连接设备，拿 `addr` |
| `interconnect` | 向手表的快应用发消息 |
| `thirdpartyapp` | 检查 Talk 是否已安装（没装就提前提示） |
| `ui` | 渲染表单 |

按最小权限原则，没有声明 `network`：**插件自己不联网**，凭据校验交给手表那边做（手表本来就要连 Nextcloud）。好处是密码只经过一条链路（蓝牙 → 手表），插件端不产生任何对外请求。

## 设计取舍

**密码不在插件里持久化。** AstroBox v2 的 host API 没有文件系统接口（`os` 只给 arch/hostname/locale 等），插件无法自行落盘。所以每次打开都要重新输入；真正保存的是手表上的 `@system.storage`。发送成功后插件会立刻清空内存里的密码。

**只发给第一台已连接设备。** `device.get_connected_device_list()` 返回多台时取第一台。多设备同时连接是罕见场景，为它加选择器会让 UI 复杂一档，先不做。

**15s 超时兜底。** 发完以后用 `timer.set_timeout` 起一个 15 秒计时；手表没回 ack 就提示「确认 Talk 已打开并停在『从手机配置』页面」。否则按钮会永远卡在「正在发送…」。

**无文件日志。** 官方模板的 `logger.rs` 用 `tracing-appender` 写滚动文件，而它内部调用 `symlink::symlink_file`，在 wasm 目标上被编译掉，直接编译失败。这里改成只写 stdout（AstroBox 会捕获）。如果你从模板起步，第一件事就是把这段换掉。

## 已知限制

- **未在真机验证。** 这份代码在这里只验证到「编译通过 + 协议单测通过 + 产物是合法 wasm component」。
- **interconnect 的签名前提。** 官方 Vela 文档要求快应用与手机端 App 的**包名和签名一致**才能互联。AstroBox 的 `interconnect` host API 是按 `pkg-name` 投递的，是否能绕过这条限制需要实测；若收不到消息，先看插件的 stdout 日志里 send 有没有返回 `Err`。
- **`ui-v3` 的输入回传格式未知。** `on_ui_event_v3` 的 `event_payload` 可能是裸字符串，也可能是 `{"value":".."}`。`parse_input_value()` 两种都认，但没有文档可对照。
- **权限名单未公开。** 文档没列 v2 的合法 `permissions` 值，这里按 WIT 接口名写的（`device` / `interconnect` / `thirdpartyapp` / `ui`）。若某个名字不被接受，加载时会被拒绝，删掉对应项再试。
