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
dist/nctalk-credential-0.1.2.abp  # 直接拖进 AstroBox 安装（ASCII 文件名）
```

⚠️ 如果系统里同时装了发行版 rustc（没有 wasm std），`build_dist.py` 调用的 `cargo` 可能是错的那个，会报 `can't find crate for core`。用 rustup 的 cargo：

```bash
PATH="$HOME/.cargo/bin:$PATH" python3 scripts/build_dist.py --release --package
```

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
| `register_interconnect_recv` | 订阅快应用回传的 ack（漏了就永远收不到回复） |

**渲染 UI 不需要权限。** 早期版本这里写的是 `ui`，是错的：已上架的第三方插件用 `ui_v3` 渲染整个界面，却只声明了 `device`/`interconnect`/`network`/`thirdpartyapp`/`register_interconnect_recv`。权限是**按 host 函数**授予的细粒度白名单，写一个不存在的名字反而可能让整份 manifest 反序列化失败——表现就是「装不上」。

按最小权限原则，没有声明 `network`：**插件自己不联网**，凭据校验交给手表那边做（手表本来就要连 Nextcloud）。好处是密码只经过一条链路（蓝牙 → 手表），插件端不产生任何对外请求。

## 设计取舍

**密码不在插件里持久化（是选择，不是限制）。** Host API 里没有文件系统函数（`os` 只给 arch/hostname/locale），但运行时确实提供 WASI std fs，只是限定在插件自己的目录内——所以 `std::fs` 是可用的，真要落盘做得到。这一版没做：每次打开重新输入，真正的保存在手表的 `@system.storage`，发送成功后插件立刻清空内存里的密码。少一处明文落盘就少一处泄露面。

**只发给第一台已连接设备。** `device.get_connected_device_list()` 返回多台时取第一台。多设备同时连接是罕见场景，为它加选择器会让 UI 复杂一档，先不做。

**15s 超时兜底。** 发完以后用 `timer.set_timeout` 起一个 15 秒计时；手表没回 ack 就提示「确认 Talk 已打开并停在『从手机配置』页面」。否则按钮会永远卡在「正在发送…」。

**无文件日志。** 官方模板的 `logger.rs` 用 `tracing-appender` 写滚动文件，而它内部调用 `symlink::symlink_file`，在 wasm 目标上被编译掉，直接编译失败。这里改成只写 stdout（AstroBox 会捕获）。如果你从模板起步，第一件事就是把这段换掉。

## 已知限制

- **未在真机验证。** 这份代码在这里只验证到「编译通过 + 协议单测通过 + 产物是合法 wasm component」。
- **interconnect 的签名前提。** 官方 Vela 文档要求快应用与手机端 App 的**包名和签名一致**才能互联。AstroBox 的 `interconnect` host API 是按 `pkg-name` 投递的，是否能绕过这条限制需要实测；若收不到消息，先看插件的 stdout 日志里 send 有没有返回 `Err`。
- **`ui-v3` 的输入回传格式未知。** `on_ui_event_v3` 的 `event_payload` 可能是裸字符串，也可能是 `{"value":".."}`。`parse_input_value()` 两种都认，但没有文档可对照。
- **权限名单仍以实测为准。** 现在的取值来自一个已上架插件的清单（`device` / `interconnect` / `thirdpartyapp` / `register_interconnect_recv`），官方文档通篇没有列过 v2 的合法权限枚举。
- **`api_level: 3` 有版本门槛。** 官方对照表：api_level 2 → AstroBox ≥ 2.0.0，api_level 3 → ≥ 2.1.0。低于 2.1.0 会**直接拒绝加载**，症状和「装不上」几乎一样。
- **WASI 版本是硬约束。** 见上文；换工具链前先跑 `check_artifact.py`。
- **仍未在真机验证。** 现在「结构、清单、WASI 版本、权限」四项都能离线校验，但 interconnect 是否真能通到手表应用只能在设备上确认。
