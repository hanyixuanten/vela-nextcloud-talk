# Vela Nextcloud Talk

小米 Vela（Xiaomi Watch / 手环）上的 Nextcloud Talk 客户端，纯 Vela JS 快应用实现。

骨架仓库：登录、会话列表、收发消息、设置四条主链路都已跑通，UI 以 480 为设计宽度、视觉与组件规范移植自 [HyperBilibili](https://github.com/Searchstars/Hyperbilibili) 的手表模板（黑底彩色辉光 + 圆角卡片 + 单主色胶囊按钮），并针对圆屏和矩形屏分别打包，输入法接入 [NEORUAA/Vela_input_method](https://github.com/NEORUAA/Vela_input_method)（已内置到 `src/components/InputMethod/`，支持中文拼音 / 英文 / 日语罗马字）。

```
手表 ──HTTPS Basic Auth（应用密码）──> Nextcloud Talk OCS API
```

没有手机端中转，也没有后端服务：手表直连你的 Nextcloud 实例。

---

## 快速开始

### 1. 环境

两种方式任选：

- **AIoT-IDE**（官方）：先用下面的构建命令或 GitHub Actions 生成对应屏幕的 RPK，再用 IDE 模拟器或真机调试。不要直接用 IDE 打包按钮构建原始源码，因为它不会执行本项目的屏幕条件预处理。
- **命令行**：需要 Node ≥ 18（本项目在 v22.22.2 + aiot-toolkit 2.0.5 上验证过），然后

  ```bash
  npm ci               # 安装 aiot-toolkit
  npm run build:circle # Xiaomi Watch S3 / S4 / S4 Sport
  npm run build:rect   # REDMI Watch 5
  ```

  仓库自带的 `.npmrc` 指向官方 npm registry；网络慢时可按需改回国镜像。

### 2. 安装到手表

本机不必编译。把代码推送到有权限的 GitHub 仓库后，从 **Actions → CI → 对应运行 → Artifacts** 下载并解压：

| Artifact | 适用设备 |
| --- | --- |
| `rpk-debug-xiaomi-watch-s3-s4-s4-sport` / `rpk-release-xiaomi-watch-s3-s4-s4-sport` | Xiaomi Watch S3 / S4 / S4 Sport（466 × 466 圆屏） |
| `rpk-debug-redmi-watch-5` / `rpk-release-redmi-watch-5` | REDMI Watch 5（432 × 514 矩形屏） |
| `abp` | 手机 AstroBox 插件，用于从手机配置凭据 |

没有配置签名密钥时只会出现 `rpk-debug-*`；配置了 secrets 的构建同时只产出 `rpk-release-*`。

两个 RPK 包名均为 `com.hanyixuanten.nctalk`，同一块表只安装对应的一个。

安装步骤：

1. 手机装「小米运动健康」并与手表配对。
2. 手机端进入 `我的 → 关于 → 连点「关于」进入 Debug → 第三方应用`，包名填 `com.hanyixuanten.nctalk`，选择上面的 rpk 安装。
3. 或者用社区工具（[minstall](https://github.com/HyperionD/minstall) 等）走蓝牙安装。
4. 手表上打开 Talk。启动先过网络门（手表没有可用网络接口时只会停在「重试」页，进不去会话和设置）：通过后**首次启动直接进「从手机配置」页**（它才是监听 interconnect 的那一页），要么等手机推，要么点「手动输入」自己填三项。

本地调试构建用 `build:circle` 或 `build:rect`；正式签名分别用 `npm run release:circle`、`npm run release:rect`，需按 [`sign/README.md`](sign/README.md) 配置证书。没有 CI 签名密钥时会产出调试包，不一定能覆盖旧签名的安装。

### 3. 从手机配置凭据（可选，但要装插件）

在手表上敲服务器地址加一长串应用密码实在难受，所以有一个 AstroBox 插件：在手机上填表，凭据经蓝牙推到手表，由手表自己校验并保存。

```
手表：首次启动就在「从手机配置」页；已有账号时走 设置 → 从手机配置
手机：AstroBox → 打开「Talk 凭据配置」→ 填三项 → 发送到手表
```

只有这一页在监听 interconnect。登录页底部也留了「从手机配置」入口，避免选了手动输入之后回不去。

插件源码在 [`astrobox-plugin/`](astrobox-plugin/)（Rust → `wasm32-wasip2`，API Level 4 / WASI Preview 3），构建产物 `astrobox-plugin/dist/nctalk-credential-<版本>.abp` 直接拖进 AstroBox 安装（需要带 Level 4 运行时的 AstroBox；旧版本只支持 Level 2/3，会拒绝加载。插件工具链固定 Rust 1.93，否则组件要求的 WASI 版本可能超过宿主上限）。装不上先跑 `python3 astrobox-plugin/scripts/check_artifact.py`。协议与时序见 [`docs/interconnect.md`](docs/interconnect.md)。

```bash
cd astrobox-plugin
rustup target add wasm32-wasip2
PATH="$HOME/.cargo/bin:$PATH" python3 scripts/build_dist.py --release --package
```

不装插件也完全可以，手表的登录页照样能手动输。

### 4. 准备应用密码

不要用账号密码登录。在 Nextcloud 网页端：

```
右上角头像 → 个人设置 → 安全 → 应用密码 → 输入设备名 → 生成
```

得到形如 `xxxxx-xxxxx-xxxxx-xxxxx-xxxxx` 的密码，填到手表的「应用密码」里。这样即使手表丢失，也只需要吊销这一条应用密码。

### 5. 跑测试（可选）

不需要模拟器，桌面 Node ≥ 18 即可：

```bash
npm test          # 或 sh tests/run.sh
```

JS 回归测试包括基础工具、凭据协议、配置页接收与确认流程、聊天分页/顺序/长消息与轮询，以及针对模拟 Nextcloud 的接口集成测试。启动网络门由 `tests/network.test.mjs`（接口类型判定、探针只作证据）和 `tests/launch-gate.test.mjs`（入口页路由决策）守住；`tests/layout.test.mjs` 是一组纯静态的布局断言，守住设计像素尺寸、`if` 显隐、键盘占位，以及**每个 `<scroll>` 必须是「屏幕高 − 固定 chrome」的像素高度（`flex: 1` 会让这块固件把内容压进视口、滚不动）**——这些只能靠真机才能发现的问题。`tests/navigation.test.mjs` 守住跳转链，`tests/page-vm.test.mjs` 守住页面 VM 的硬规则（有 `protected`/`public`/`private` 就不能再写 `data`），`tests/tap-recovery.test.mjs` 守住「用户点了就必须有反应」。

插件侧的协议单测与 v4 契约测试要另跑（插件本体只能编到 wasm，测试编到 host）：

```bash
cd astrobox-plugin
PATH="$HOME/.cargo/bin:$PATH" cargo test --locked --target x86_64-unknown-linux-gnu
```

真机或虚拟机联调前，可以先用本机凭据验一遍服务器：把 `.env.example` 复制成 `.env.local`（已进 `.gitignore`，权限 600），填 `NCTALK_BASE_URL` / `NCTALK_USER` / `NCTALK_APP_PASSWORD` 后跑

```bash
npm run check:live      # 或 node scripts/check-credentials.mjs [--file other.env]
```

它依次探 `status.php`、验 `/ocs/v2.php/cloud/user`、列 Talk 会话，只打印结论不打印密码；三项都 200 就说明手表登录页填的那套东西能用。注意它是**只读**检查，不会往任何会话里发消息。

### 6. CI

[GitHub Actions 工作流](.github/workflows/ci.yml)运行 JS 与 Rust 测试，之后用矩阵分别打包圆屏、矩形屏 RPK，并构建 ABP。配置 `SIGN_PRIVATE_PEM` 和 `SIGN_CERT_PEM` 两个 Secret 会生成正式签名 RPK；都不配置时生成调试 RPK。

细节、runner 标签要求和本地复现命令见 [`docs/ci.md`](docs/ci.md)。

### 7. 发布版本（维护者）

发版走手动触发的 [Release 工作流](.github/workflows/release.yml)：**Actions → Release → Run workflow**，输入 `x.x.x`（写成 `v0.3.0` 也认）。一次运行会做完这些事：

1. 校验版本号格式，并拒绝已存在的 tag / Release（发布过的版本不能覆盖）；
2. 把 `package.json`、`package-lock.json` 的 `version` 和 `src/manifest.json` 的 `versionName` 一起改成新版本，`versionCode` 自增 1，提交 `chore(release): x.y.z (watch)` 并推到 `main`；
3. 跑 JS 与插件协议测试，再用**正式签名**构建两个形状的 RPK 和 ABP；
4. 创建 tag `vX.Y.Z` 并发布 GitHub Release，附件是 `com.hanyixuanten.nctalk.release.<版本>-circle.rpk`、`-rect.rpk` 和 `nctalk_credential-<插件版本>.abp`。

两条硬约束是故意留的：没有配置签名 secrets 时工作流直接失败（不会退化成调试包），产物名里出现 `debug` 或者对不上 `release.<版本>` 时也直接失败，所以 Release 里不会出现调试包。`versionCode` 必须严格递增，installer 只认更大的值；插件版本（`astrobox-plugin/manifest.json`）独立维护，不跟随应用版本。

---

## 功能

| 功能 | 状态 | 说明 |
| --- | --- | --- |
| 账号登录 / 校验 | ✅ | 先落盘再走 `/ocs/v2.php/cloud/user` 校验；校验失败也保留输入 |
| 会话列表 | ✅ | 按最近活跃排序、未读数、最后一条消息预览 |
| 历史消息 | ✅ | 每次拉 12 条；列表顶部点「加载更早消息」，窗口最多保留 16 条 |
| 发送消息 | ✅ | POST `/chat/{token}`，发送后本地立即上屏 |
| 已读标记 | ✅ | 打开会话或收到新消息后 POST `/chat/{token}/read` |
| 轮询新消息 | ✅ | 默认 15s，可在设置里改成 30s / 60s |
| 后台留存 | ✅ | 两条官方机制并用：`config.background` + 下载轮询管「回表盘 / 息屏」，微服务管「应用被关闭」；留存未读、新消息振动，**始终开启，无开关** |
| 中文 / 英文 / 日语输入 | ✅ | 内置三⽅输入法组件，QWERTY 与 T9 两种布局 |
| 设置 | ✅ | 键盘布局、轮询间隔、字号、清除数据 |
| 从手机配置凭据 | ✅ | AstroBox 插件经 interconnect 推送，手表先保存再校验；校验期间不熄屏 |
| 启动网络检测 | ✅ | 只看 `@system.network` 类型，且仅 `none` 判离线（空/失败/4 s 无回调都算「未知」并放行）；bilibili（对照）与 `<baseUrl>/status.php`（目标）两个探针只记录、不拦人 |
| 图片 / 文件消息 | ❌ | 只显示文件名及文字，不下载图片 |
| 长轮询 / WebSocket | ❌ | 见「已知限制」 |
| 通知推送 | ❌ | Vela 没有第三方 app 的推送通道；后台留存只在本地轮询后振动，不能唤醒屏幕或弹通知 |
| 长消息 | ✅ | 气泡显示 4 行预览，点「展开全文」进详情页看整段文本 |
| 消息顺序 | ✅ | 最新的消息在最下面，紧挨输入条 |
| 引用回复 | ✅ | 长按可回复的消息 →「回复」；点 × 可取消引用 |
| 表情反应 | ✅ | 长按普通消息 →「表情」，可添加或撤销 👍、❤️、😂（Talk 14+） |
| 通话 | ❌ | 尚未实现 |

---

## 目录结构

```
vela-nextcloud-talk/
├── package.json                  # aiot-toolkit 构建脚本
├── .npmrc                        # 官方 npm registry（CI 可改用镜像）
├── .env.example                  # 联调凭据模板（真实 .env.local 不进库）
├── src/
│   ├── manifest.json             # 包名、路由、features、designWidth
│   ├── app.ux                    # 启动时读取设置并配置 API client
│   ├── i18n/
│   │   ├── defaults.json         # 中文（兜底）
│   │   └── en.json
│   ├── common/
│   │   ├── images/icon.png       # 192×192，由 scripts/gen-icon.py 生成
│   │   ├── images/bg/            # 页面辉光背景（pink/blue），由 scripts/gen-bg.py 生成
│   │   ├── styles/theme.css      # 设计令牌，各页 @import 后编译期内联
│   │   └── scripts/
│   │       ├── api.js            # Nextcloud Talk OCS 客户端
│   │       ├── base64.js         # Basic Auth 用的 base64（无 btoa 依赖）
│   │       ├── store.js          # @system.storage 封装 + 设置默认值
│   │       ├── state.js          # 跨页面共享的运行时缓存
│   │       ├── format.js         # 时间、Rich Object String、头像取色
│   │       ├── textlayout.js     # 气泡/详情页共用的折行与文本度量
│   │       ├── network.js        # 启动网络门（类型判定 + bilibili/服务器探针证据）
│   │       ├── launch.js         # 网络门的路由决策（纯函数，可单测）
│   │       └── protocol.js       # 手机推凭据的协议（与插件对称）
│   ├── components/
│   │   ├── ui/AppPill.ux         # 胶囊按钮（模板 DefaultButton 的等价物）
│   │   └── InputMethod/          # 三方输入法（vendored，勿手改）
│   └── pages/
│       ├── splash/splash.ux      # 路由入口：先探网络，通过才进主界面
│       ├── index/index.ux        # 会话列表
│       ├── chat/chat.ux          # 聊天（含输入态，最新消息在最下面）
│       ├── message/message.ux    # 单条消息的完整文本（气泡「展开全文」的目标页）
│       ├── login/login.ux        # 账号录入
│       ├── setup/setup.ux        # 等手机推送凭据（interconnect，校验期间保持亮屏）
│       ├── offline/offline.ux    # 网络不通时的唯一出口，只提供重试
│       └── settings/settings.ux  # 设置
├── scripts/
│   ├── build-watch.cjs           # 屏幕条件预处理 + aiot 打包
│   ├── check-credentials.mjs     # 本机真机联调凭据自检（只读）
│   ├── gen-icon.py               # 零依赖 PNG 生成
│   ├── gen-bg.py                 # 页面辉光背景 PNG（纯 Python 写 PNG）
│   └── sync-input-method.sh      # 重新拉取并覆盖 InputMethod
├── astrobox-plugin/              # 手机侧配置凭据的 AstroBox 插件（Rust → wasm）
│   ├── Cargo.toml
│   ├── rust-toolchain.toml       # 固定 Rust 1.93（p2 0.2.6 已验证基线）
│   ├── manifest.json             # entry / api_level 4 / wasi_version 3
│   ├── src/                      # lib / ui / protocol / state / logger
│   ├── tests/protocol.rs         # 协议单测（能跑，不依赖 wasm）
│   ├── tests/v4.rs               # Level 4 manifest / async 导出契约测试
│   └── scripts/build_dist.py     # 构建 + 打 .abp
├── .github/workflows/ci.yml      # GitHub Actions：测试 + 打包 rpk/abp
├── docs/
│   ├── api.md                    # 接口清单与错误映射
│   ├── design.md                 # 圆屏布局计算与状态机
│   ├── interconnect.md           # 与插件的协议、时序、排错
│   └── ci.md                     # CI 的 job 划分、secrets、产物与排错
├── tests/
│   ├── run.sh                    # 一键跑全部测试（需要 Node ≥ 18）
│   ├── mock-server.mjs           # 假 Nextcloud Talk OCS 服务
│   ├── fetch-double.mjs          # @system.fetch 的 Node 替身
│   ├── api.test.mjs              # api.js 集成测试
│   ├── protocol.test.mjs         # 凭据协议单元测试
│   ├── units.test.mjs            # base64 / format 单元测试
│   ├── network.test.mjs          # 网络门：类型判定 + 探针只作证据
│   ├── launch-gate.test.mjs      # 入口页路由决策与「先探网络再进主界面」
│   ├── layout.test.mjs           # 静态布局：设计像素、if 显隐、键盘占位、可用高度
│   ├── navigation.test.mjs       # 跳转：阶梯逐级只变一个变量、返回不落到空栈
│   ├── page-vm.test.mjs          # 页面 VM：有 protected 就不能再写 data（否则页面建不出来）
│   ├── tap-recovery.test.mjs     # 点击不被状态位吞掉：刷新可重发、卡住的读取会超时放行
│   ├── setup.test.mjs            # 配置页接收与确认流程
│   ├── chat.test.mjs             # 聊天交互测试（顺序、四行预览、展开全文、窗口上限）
│   ├── keepalive.test.mjs        # 表冠退出保活：纯声明形态、后台机制不复活、前台轮询健在
│   └── build-watch.test.cjs      # 屏幕条件编译测试
├── LICENSE                       # 根仓库 MIT 许可
├── SECURITY.md                   # 漏洞报告与安全边界
└── sign/                         # 证书放这里（.gitignore 已排除 pem）
```

`src/` 是固定目录名，不能改；`build/`、`dist/` 由 aiot-toolkit 生成。

---

## 关键实现说明

### 认证

所有请求带三个头：

```
Authorization: Basic base64(user:appPassword)
OCS-APIRequest: true
Accept: application/json
```

`OCS-APIRequest: true` 必须带，否则 Nextcloud 会返回登录页 HTML，`JSON.parse` 直接炸掉，报错信息完全看不出原因。`Accept: application/json` 必须带，因为 Talk 的 `lastMessage.reactions` 结构会让 XML 响应非法。

Vela 运行时不保证有 `btoa`，且 `btoa` 只接受 Latin-1，所以 `common/scripts/base64.js` 自己做了 UTF-8 编码后再 base64，可以处理中文用户名。

### 圆屏布局

圆形表盘上，屏幕四角在视觉上不可用。以 480 设计宽度、半径 240 计算，某个 y 处的可用宽度是：

```
可用宽度 = 2 * sqrt(240² - (y - 240)²)
```

所以 `y = 30` 时只有约 230px 宽，`y = 70` 时约 340px，到底部 `y = 436` 又只剩约 277px。这直接决定了头部不能贴顶、底部不能撑满：聊天页标题栏从 `y = 70` 开始且宽 70%，输入条只有 50% 宽；会话卡片 82% 宽则要等到 `y ≥ 110`。具体取值见 [`docs/design.md`](docs/design.md)。

### 界面与设计系统

配色、圆角、字重与组件形态移植自 [HyperBilibili](https://github.com/Searchstars/Hyperbilibili)：黑底 + 彩色辉光背景、`#262626` 圆角卡片、唯一主色 `#FF7DA8`、全圆胶囊按钮。

- `src/common/styles/theme.css` 只放令牌类，各页 `<style>` 里 `@import` 后由打包器内联（已验证规则出现在 `pages/*/*.js`），运行时不额外加载。
- 按钮统一走 `src/components/ui/AppPill.ux`；宽度用 prop 传入，因为 Vela 只应用组件自身的样式块，父级的 `class`/`style` 不会透传。
- 页面背景是 `scripts/gen-bg.py` 生成的 256×256 辉光 PNG（纯 Python 写 PNG，零依赖），放在 480×480 的盒子里用 `object-fit: cover` 铺满（Vela 不接受 CSS 的 `fill`）。

### 启动网络门与校验期亮屏

启动时不直接进主界面，而是照 [HyperBilibili](https://github.com/Searchstars/Hyperbilibili) 的 `splash` 做法：**路由入口页就是网络门**（`router.entry = pages/splash`）。点图标先看到图标 + 「正在检查网络…」，用 `@system.network.getType` 判类型（与 HyperBilibili 的 `NetworkCheck` 一致），只有空值或 `none` 才停在 `pages/offline`，只给「重试」，重试回到入口页重探；通过则 `replace` 到会话列表或 `pages/setup`。路由决定之后才跑两个探针：`https://www.bilibili.com/`（对照，证明这块表能上外网）和 `<baseUrl>/status.php`（目标，证明能到你自己的服务器）。结果**只作为证据**写进 `state.controlProbe` / `state.serverProbe` 与日志，**不参与放行、也不阻塞启动页**——早先把探针当第二道门时，DNS/TLS 慢或证书链不被手表接受都会表现为「永远停在没有网络」，且页面上看不到任何错误码。对照通而目标不通时，会话页的错误会写成「网络正常，但服务器不可达：…」，把「Wi-Fi 没网」和「这台服务器连不上」分开。主界面（会话 / 设置 / 聊天）在这种情况下根本不会被创建。会话页**不做**「是否通过门」的检查：那个跨页判定读不到（每个页面是独立 bundle），一读就会在 `检查网络…` 与 `进入 /` 之间死循环；门只挡 `none`，直接进列表最多看到请求自己的错误。

从手机推来的凭据在手表上要经历「写 storage → 最长 20 秒的校验 → 回执」，期间用 `@system.brightness.setKeepScreenOn(true)` 保持亮屏，成功、失败、离开页面都会释放。写盘排在校验之前，校验失败也保留输入（回执文字带「已保存；」前缀）；只有写盘本身失败才什么都不留。细节见 [`docs/design.md`](docs/design.md) 第 9、10 节。

### 挂后台：表盘悬浮入口（纯声明，1.0.21）

需求不是后台消息同步，而是 HyperBilibili 那种「按下表冠回表盘 → 表盘出现悬浮图标 → 点它回到原状态」。对照 HyperBilibili 仓库：commit `0ccb19b`（音频播放器出现之前）仅凭 manifest `config.background.features: ["system.request", "system.audio"]` 声明实现挂后台，表盘悬浮入口就是音频播放时系统挂出的**媒体卡片**。

Talk 与它完全一致：只在 `features` + `config.background.features` 声明 `system.audio`，**没有任何播放代码**。HyperBilibili 仓库考古证实它在音频播放器出现之前也从未播放过任何音频——纯声明即挂后台。1.0.20 曾加过静音 WAV 循环作为保险，真机验证前先按 HyperBilibili 的最简形态收敛；若悬浮图标不再出现，从 git 历史找回 `keepAliveAudio.js` + `keepalive.wav`（commit `3e48d2f`）即可。

**1.0.20 起没有后台轮询**：keeper 微服务（`services/`、`serviceclient`）与进程内 15 秒下载 ticker（`bgSync.js`）整体拆除，用户明确不需要后台消息同步。轮询只在前台发生——会话页 `onShow` 刷新列表，聊天页可见时按间隔拉消息。`tests/keepalive.test.mjs` 钉住：纯声明形态不被加回播放、被拆除的机制不复活、前台轮询健在。

### 输入态为什么要两个页面状态

输入法展开时固定占用 `480×321`，圆形表盘只剩 159px 可用高度，塞不下「标题 + 消息列表 + 输入框」。所以聊天页有两个互斥状态：

- `editing = false`：标题栏 + 消息列表 + 输入条
- `editing = true`：会话名或单行引用摘要 + 草稿预览（只显示末尾 60 字）+ 取消 / 发送

这样既不用滚动页面，也不会出现键盘遮挡。

### 键盘收起

输入法组件没有「收起」键，可以点键盘上方的草稿或字段区域关闭键盘：

- 聊天页：点会话名、引用摘要或草稿预览，或者点「取消」；
- 登录页：`.edit-top`（字段标签 + 当前值）同理。

收起聊天键盘不会丢弃草稿或引用；要改发普通消息，点引用旁的 ×。发送失败会保留草稿和引用，不自动重发。

### 消息顺序

消息按 **id 倒序**渲染，最新一条在最上方。新消息按 ID 合并去重；查看历史时暂停轮询，超过 24 条就移出较新的记录。点「返回最新消息」重新获取最近一页。

### 输入法集成

组件来自 [NEORUAA/Vela_input_method](https://github.com/NEORUAA/Vela_input_method)，当前固定在 commit `b6afb11`（记录在 `src/components/InputMethod/UPSTREAM_VERSION`）。要升级：

```bash
sh scripts/sync-input-method.sh            # 用内置的 pin
sh scripts/sync-input-method.sh <git-ref>  # 指定分支或 commit
```

注意三点：

1. 词库靠 `file.readText` 按**包内绝对路径**读取，默认 `/components/InputMethod/assets/dictionary/`。所以组件必须放在 `src/components/InputMethod`；换位置要传 `dictionarypath`。
2. `manifest.json` 里必须声明 `system.file`（读词库）和 `system.device`（组件内部用 `@system.device` 判断屏幕），少一个 `aiot build` 就会以 `missing feature` 失败。
3. 词库文件是 `.txt` 后缀（内容仍是 JSON），因为部分 Vela 运行时读包内 `.json` 会返回 `202: invalid file type`。

事件与用法：

```html
<input-method
  hide="{{!editing}}"          <!-- true 隐藏，false 弹出 -->
  keyboardtype="{{keyboardType}}"  <!-- QWERTY | T9 -->
  screentype="circle"             <!-- 圆屏构建；矩形屏构建使用 rect -->
  maxlength="5"
  vibratemode="short"
  @complete="onKeyComplete"    <!-- evt.detail.content -->
  @delete="onKeyDelete"
></input-method>
```

`@delete` 只给事件不给内容，删字符要自己做，并且要处理代理对（emoji 占两个 code unit）。

### 屏幕形状

两种目标共用 `config.designWidth: 480`；Vela 会按物理宽度缩放单位。构建时选择圆屏或矩形屏布局与对应键盘，圆屏避开裁切区域，矩形屏使用更宽的内容区；不用手动修改 manifest。

---

## 已知限制

- **跨页状态只能放 app 实例**：每个页面是独立 webpack entry，`common/scripts/state.js` 的模块级对象是「每页一份」，跨页判定/缓存必须经 `this.$app.$def.shared`（见 `src/common/scripts/shared.js` 与 design.md 第 9 节），否则会出现 splash ⇄ 会话页互相踢球的死循环。
- **跳转可能被静默丢弃**：这块固件上 `router.push` 可能不生效，跳转成功也不一定触发 `onHide`，两者从外面看都是「点了没反应」。`src/common/scripts/nav.js` 因此按「延后 → 逐级只变一个形式或参数 → 比对 `router.getState()` 快照」重试，全部落空才弹 toast；代价是返回栈退化为「回会话列表」（`nav.leave` 处理）。若目标页自己建不出来（见下一条），这个阶梯也只能报告而不能修复。见 design.md 第 11 节。
- **页面 VM 不能同时声明 `data` 与 `protected`**：同时声明 `data` 与 `protected` 时页面 VM 根本建不出来：路由发出跳转，目标页构造失败，表现就是「点会话没反应」。会话页的状态块因此叫 `private`，`protected` 只接路由参数，`tests/page-vm.test.mjs` 对所有页面做这条静态检查。
- **服务器不可达时仍可进入应用**：启动门只判网络接口类型（且仅 `none` 算离线），因此 `status.php` 探不通、`getType` 失败或超时都不会拦人；真正的失败会以「网络正常，但服务器不可达：网络请求失败：code=…」的文案出现在会话列表（对照探针通时），平台错误码同时打在日志里。启动页会显示当前阶段，卡住时能直接从表盘看出停在哪一步。
- **短轮询**：使用 `lookIntoFuture=1` 拉取新消息，每次请求结束后再开始计时；按设置每 15s（可改 30s / 60s）轮询。浏览历史或离开页面时暂停轮询。
- **后台留存不是推送**：靠微服务在后台按 `max(pollInterval, 30s)` 轮询会话列表，只能做本地未读留存和振动提醒，不能亮屏、弹通知或收实时消息。它是额外的请求与电量开销，但只保留一个开关会让「有账号就该跑」这件事变成一个用户要理解的取舍，所以固定开启。微服务的机型支持与后台定时器行为官方文档未给出，需真机确认（[design.md 第 12 节](docs/design.md)）。
- **HTTPS-only**：手动登录、候选账号校验与手机凭据协议均拒绝明文 HTTP；客户端依赖系统 TLS 校验，不做证书 pinning。
- **密码存储**：Vela 没有 keystore API，应用密码以明文存在 app 沙箱内的 `@system.storage` 里。这是平台限制，不是实现选择，详见 [`docs/design.md`](docs/design.md)。清除本地账号后也应在 Nextcloud 吊销对应应用密码。
- **无附件预览**：图片和文件只显示 Rich Object String 展开后的文件名及文字。不提供缩略图，也不下载或解码图片：`<image>` 不承诺按显示尺寸解码，`fetch` 也没有传输字节上限。
- **消息窗口**：每次拉取 12 条，界面最多保留 24 条；支持加载更早消息，单条正文保留前 512 个 UTF-16 代码单元以内并加省略号。
- **未读数**：会话列表的未读数直接取服务端 `unreadMessages`，本地不会自增。
- **互联真机验证**：AstroBox 按已连接设备地址与已安装快应用包名投递；仍须在目标固件与 AstroBox 版本上验证收发。Android 官方互联签名要求与排错见[凭据互联说明](docs/interconnect.md)。
- **插件不持久化密码**：AstroBox 的 Host API 里确实没有文件系统函数（`os` 只给 arch/hostname/locale），运行时虽然提供 WASI std fs（限定在插件自己的目录内），但这一版**故意没有**写盘——密码每次都要重填，真正的保存只发生在手表的 `@system.storage`，发送成功后插件立刻清空内存里的密码。

## 下一步

按优先级：

1. 真机验收历史分页、返回最新、后台切换与微服务留存（步骤见 [design.md 第 12 节](docs/design.md)）。
2. 手势返回（`onBackPress` 已由系统接管，但可以加滑动手势）。
3. 离线草稿队列。

手表端不做缩略图或图片预览；更多撤回、复制等操作暂未实现。

---

## 参考

- [Vela JS 应用开发文档](https://iot.mi.com/vela/quickapp/zh/guide/)
- [AstroBox 插件文档](https://abox.run/docs/plugin-development/v2/host-api/interconnect)
- [项目配置 manifest.json](https://iot.mi.com/vela/quickapp/zh/guide/framework/manifest.html)
- [数据请求 fetch](https://iot.mi.com/vela/quickapp/zh/features/network/fetch.html)
- [微服务（后台服务能力）](https://iot.mi.com/vela/quickapp/zh/features/other/serviceclient.html)
- [后台运行](https://iot.mi.com/vela/quickapp/zh/guide/framework/other/background-running.html)
- [Nextcloud Talk Conversation API](https://nextcloud-talk.readthedocs.io/en/latest/conversation/)
- [Nextcloud Talk Chat API](https://nextcloud-talk.readthedocs.io/en/latest/chat/)
- [NEORUAA/Vela_input_method](https://github.com/NEORUAA/Vela_input_method)
- [AstroBox NG 插件模板（Rust）](https://github.com/AstralSightStudios/AstroBox-NG-Plugin-Template-Rust)

## 许可

本仓库代码 MIT。`src/components/InputMethod/` 沿用上游许可，见该目录下的 `LICENSE`。`astrobox-plugin/` 依赖的 `astrobox-ng-wit` 为 MIT。
