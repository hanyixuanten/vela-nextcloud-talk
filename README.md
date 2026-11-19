# Vela Nextcloud Talk

小米 Vela（Xiaomi Watch / 手环）上的 Nextcloud Talk 客户端，纯 Vela JS 快应用实现。

骨架仓库：登录、会话列表、收发消息、设置四条主链路都已跑通，UI 以 480 为设计宽度，并针对圆屏和矩形屏分别打包，输入法接入 [NEORUAA/Vela_input_method](https://github.com/NEORUAA/Vela_input_method)（已内置到 `src/components/InputMethod/`，支持中文拼音 / 英文 / 日语罗马字）。

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

  仓库自带的 `.npmrc` 指向 npmmirror，若在国外可自行删掉。

### 2. 安装到手表

本机不必编译。把代码推送到有权限的 GitHub 仓库后，从 **Actions → CI → 对应运行 → Artifacts** 下载并解压：

| Artifact | 适用设备 |
| --- | --- |
| `rpk-xiaomi-watch-s3-s4-s4-sport` | Xiaomi Watch S3 / S4 / S4 Sport（466 × 466 圆屏） |
| `rpk-redmi-watch-5` | REDMI Watch 5（432 × 514 矩形屏） |
| `abp` | 手机 AstroBox 插件，用于从手机配置凭据 |

两个 RPK 包名均为 `com.hanyixuanten.nctalk`，同一块表只安装对应的一个。

安装步骤：

1. 手机装「小米运动健康」并与手表配对。
2. 手机端进入 `我的 → 关于 → 连点「关于」进入 Debug → 第三方应用`，包名填 `com.hanyixuanten.nctalk`，选择上面的 rpk 安装。
3. 或者用社区工具（[minstall](https://github.com/HyperionD/minstall) 等）走蓝牙安装。
4. 手表上打开 Talk。**首次启动直接进「从手机配置」页**（它才是监听 interconnect 的那一页），要么等手机推，要么点「手动输入」自己填三项。

本地调试构建用 `build:circle` 或 `build:rect`；正式签名分别用 `npm run release:circle`、`npm run release:rect`，需按 [`sign/README.md`](sign/README.md) 配置证书。没有 CI 签名密钥时会产出调试包，不一定能覆盖旧签名的安装。

### 3. 从手机配置凭据（可选，但要装插件）

在手表上敲服务器地址加一长串应用密码实在难受，所以有一个 AstroBox 插件：在手机上填表，凭据经蓝牙推到手表，由手表自己校验并保存。

```
手表：首次启动就在「从手机配置」页；已有账号时走 设置 → 从手机配置
手机：AstroBox → 打开「Talk 凭据配置」→ 填三项 → 发送到手表
```

只有这一页在监听 interconnect。登录页底部也留了「从手机配置」入口，避免选了手动输入之后回不去。

插件源码在 [`astrobox-plugin/`](astrobox-plugin/)（Rust → `wasm32-wasip2`），构建产物 `astrobox-plugin/dist/nctalk-credential-<版本>.abp` 直接拖进 AstroBox 安装（需要 AstroBox ≥ 2.1.0，用 api_level 3；插件工具链固定 Rust 1.92，否则组件要求的 WASI 版本超过宿主上限）。装不上先跑 `python3 astrobox-plugin/scripts/check_artifact.py`。协议与时序见 [`docs/interconnect.md`](docs/interconnect.md)。

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

JS 回归测试包括基础工具、凭据协议、配置页接收与确认流程、聊天分页和轮询，以及针对模拟 Nextcloud 的接口集成测试。

插件侧的协议单测要另跑（它只能编到 host，不能编到 wasm）：

```bash
cd astrobox-plugin && cargo test --target x86_64-unknown-linux-gnu --test protocol
```

### 6. CI

[GitHub Actions 工作流](.github/workflows/ci.yml)运行 JS 与 Rust 测试，之后用矩阵分别打包圆屏、矩形屏 RPK，并构建 ABP。配置 `SIGN_PRIVATE_PEM` 和 `SIGN_CERT_PEM` 两个 Secret 会生成正式签名 RPK；都不配置时生成调试 RPK。

细节、runner 标签要求和本地复现命令见 [`docs/ci.md`](docs/ci.md)。

---

## 功能

| 功能 | 状态 | 说明 |
| --- | --- | --- |
| 账号登录 / 校验 | ✅ | 走 `/ocs/v2.php/cloud/user` 验证，成功才落盘 |
| 会话列表 | ✅ | 按最近活跃排序、未读数、最后一条消息预览 |
| 历史消息 | ✅ | 每次拉 12 条；列表底部点「加载更早消息」，最多保留 24 条 |
| 发送消息 | ✅ | POST `/chat/{token}`，发送后本地立即上屏 |
| 已读标记 | ✅ | 打开会话或收到新消息后 POST `/chat/{token}/read` |
| 轮询新消息 | ✅ | 默认 15s，可在设置里改成 30s / 60s |
| 中文 / 英文 / 日语输入 | ✅ | 内置三⽅输入法组件，QWERTY 与 T9 两种布局 |
| 设置 | ✅ | 键盘布局、轮询间隔、字号、清除数据 |
| 从手机配置凭据 | ✅ | AstroBox 插件经 interconnect 推送，手表校验后保存 |
| 图片 / 文件消息 | ❌ | 只显示文件名及文字，不下载图片 |
| 长轮询 / WebSocket | ❌ | 见「已知限制」 |
| 通知推送 | ❌ | Vela 暂无第三方 app 的推送通道 |
| 引用回复 | ✅ | 长按可回复的消息 →「回复」；点 × 可取消引用 |
| 表情反应 | ✅ | 长按普通消息 →「表情」，可添加或撤销 👍、❤️、😂（Talk 14+） |
| 通话 | ❌ | 尚未实现 |

---

## 目录结构

```
vela-nextcloud-talk/
├── package.json                  # aiot-toolkit 构建脚本
├── .npmrc                        # npmmirror registry
├── src/
│   ├── manifest.json             # 包名、路由、features、designWidth
│   ├── app.ux                    # 启动时读取设置并配置 API client
│   ├── i18n/
│   │   ├── defaults.json         # 中文（兜底）
│   │   └── en.json
│   ├── common/
│   │   ├── images/icon.png       # 192×192，由 scripts/gen-icon.py 生成
│   │   └── scripts/
│   │       ├── api.js            # Nextcloud Talk OCS 客户端
│   │       ├── base64.js         # Basic Auth 用的 base64（无 btoa 依赖）
│   │       ├── store.js          # @system.storage 封装 + 设置默认值
│   │       ├── state.js          # 跨页面共享的运行时缓存
│   │       ├── format.js         # 时间、Rich Object String、头像取色
│   │       └── protocol.js       # 手机推凭据的协议（与插件对称）
│   ├── components/
│   │   └── InputMethod/          # 三方输入法（vendored，勿手改）
│   └── pages/
│       ├── index/index.ux        # 会话列表
│       ├── chat/chat.ux          # 聊天（含输入态）
│       ├── login/login.ux        # 账号录入
│       ├── setup/setup.ux        # 等手机推送凭据（interconnect）
│       └── settings/settings.ux  # 设置
├── scripts/
│   ├── gen-icon.py               # 零依赖 PNG 生成
│   └── sync-input-method.sh      # 重新拉取并覆盖 InputMethod
├── astrobox-plugin/              # 手机侧配置凭据的 AstroBox 插件（Rust → wasm）
│   ├── Cargo.toml
│   ├── manifest.json             # entry / api_level / permissions
│   ├── src/                      # lib / ui / protocol / state / logger
│   ├── tests/protocol.rs         # 协议单测（能跑，不依赖 wasm）
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
│   ├── chat.test.mjs             # 聊天交互测试
│   └── seed-watch-chat.test.mjs  # seed/watch 聊天测试
├── scripts/seed-watch-chat.mjs   # 向真机写入测试消息
└── docs/
    ├── image-preview.md          # 附件显示调查
    └── watch-memory-baseline.md  # 手表基线内存
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

所以 `y = 30` 时只有约 230px 宽，`y = 60` 时约 300px。这直接决定了头部不能贴顶：聊天页的标题栏从 `y = 60` 开始，返回键圆心到屏幕中心距离 211px（< 240）才保证完整可见。具体取值见 [`docs/design.md`](docs/design.md)。

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

- **短轮询**：使用 `lookIntoFuture=1` 拉取新消息，每次请求结束后再开始计时；按设置每 15s（可改 30s / 60s）轮询。浏览历史或离开页面时暂停轮询。
- **HTTPS-only**：手动登录、候选账号校验与手机凭据协议均拒绝明文 HTTP；客户端依赖系统 TLS 校验，不做证书 pinning。
- **密码存储**：Vela 没有 keystore API，应用密码以明文存在 app 沙箱内的 `@system.storage` 里。这是平台限制，不是实现选择，详见 [`docs/design.md`](docs/design.md)。清除本地账号后也应在 Nextcloud 吊销对应应用密码。
- **无附件预览**：图片和文件只显示 Rich Object String 展开后的文件名及文字。不提供缩略图，也不下载或解码图片，原因见[图片预览评估](docs/image-preview.md)。
- **消息窗口**：每次拉取 12 条，界面最多保留 24 条；支持加载更早消息，单条正文保留前 512 个 UTF-16 代码单元以内并加省略号。
- **未读数**：会话列表的未读数直接取服务端 `unreadMessages`，本地不会自增。
- **互联真机验证**：AstroBox 按已连接设备地址与已安装快应用包名投递；仍须在目标固件与 AstroBox 版本上验证收发。Android 官方互联签名要求与排错见[凭据互联说明](docs/interconnect.md)。
- **插件不持久化密码**：AstroBox 的 Host API 里确实没有文件系统函数（`os` 只给 arch/hostname/locale），运行时虽然提供 WASI std fs（限定在插件自己的目录内），但这一版**故意没有**写盘——密码每次都要重填，真正的保存只发生在手表的 `@system.storage`，发送成功后插件立刻清空内存里的密码。

## 下一步

按优先级：

1. 按[文本聊天真机内存基线](docs/watch-memory-baseline.md)验收历史分页、返回最新、后台切换及内存峰值。
2. 手势返回（`onBackPress` 已由系统接管，但可以加滑动手势）。
3. 离线草稿队列。

手表端不做缩略图或图片预览；更多撤回、复制等操作暂未实现。

---

## 参考

- [Vela JS 应用开发文档](https://iot.mi.com/vela/quickapp/zh/guide/)
- [AstroBox 插件文档](https://abox.run/docs/plugin-development/v2/host-api/interconnect)
- [项目配置 manifest.json](https://iot.mi.com/vela/quickapp/zh/guide/framework/manifest.html)
- [数据请求 fetch](https://iot.mi.com/vela/quickapp/zh/features/network/fetch.html)
- [Nextcloud Talk Conversation API](https://nextcloud-talk.readthedocs.io/en/latest/conversation/)
- [Nextcloud Talk Chat API](https://nextcloud-talk.readthedocs.io/en/latest/chat/)
- [NEORUAA/Vela_input_method](https://github.com/NEORUAA/Vela_input_method)
- [AstroBox NG 插件模板（Rust）](https://github.com/AstralSightStudios/AstroBox-NG-Plugin-Template-Rust)

## 许可

本仓库代码 MIT。`src/components/InputMethod/` 沿用上游许可，见该目录下的 `LICENSE`。`astrobox-plugin/` 依赖的 `astrobox-ng-wit` 为 MIT。
