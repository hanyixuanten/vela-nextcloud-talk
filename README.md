# Vela Nextcloud Talk

小米 Vela（Xiaomi Watch / 手环）上的 Nextcloud Talk 客户端，纯 Vela JS 快应用实现。

骨架仓库：登录、会话列表、收发消息、设置四条主链路都已跑通，UI 按 480 设计宽度的圆形表盘排布，输入法接入 [NEORUAA/Vela_input_method](https://github.com/NEORUAA/Vela_input_method)（已内置到 `src/components/InputMethod/`，支持中文拼音 / 英文 / 日语罗马字）。

```
手表 ──HTTPS Basic Auth（应用密码）──> Nextcloud Talk OCS API
```

没有手机端中转，也没有后端服务：手表直连你的 Nextcloud 实例。

---

## 快速开始

### 1. 环境

两种方式任选：

- **AIoT-IDE**（官方，推荐）：安装后在「打开项目」里选择本仓库根目录即可，内置模拟器与打包按钮。
- **命令行**：需要 Node ≥ 18（本项目在 v22.22.2 + aiot-toolkit 2.0.5 上验证过），然后

  ```bash
  npm install          # 装 aiot-toolkit
  npm start            # 启动模拟器并运行
  npm run build        # 产出 dist/*.debug.rpk
  ```

  仓库自带的 `.npmrc` 指向 npmmirror，若在国外可自行删掉。

### 2. 安装到手表

已构建好的包在 `dist/`：

```
dist/com.hanyixuanten.nctalk.debug.0.2.0.rpk   411 KB
package : com.hanyixuanten.nctalk
version : 0.2.0 (versionCode 2)
sign    : sign/certificate.pem (CN=vela-nextcloud-talk)
```

安装步骤：

1. 手机装「小米运动健康」并与手表配对。
2. 手机端进入 `我的 → 关于 → 连点「关于」进入 Debug → 第三方应用`，包名填 `com.hanyixuanten.nctalk`，选择上面的 rpk 安装。
3. 或者用社区工具（[minstall](https://github.com/HyperionD/minstall) 等）走蓝牙安装。
4. 手表上打开 Talk，填服务器地址、用户名、**应用密码**。嫌在表上打字麻烦，用下面的插件从手机填。

自己重新打包：

```bash
npm run build        # → dist/com.hanyixuanten.nctalk.debug.0.2.0.rpk
```

签名证书的查找顺序是 `sign/debug/` → `sign/` → toolkit 内置的默认调试证书。本仓库的 rpk 用的是 `sign/*.pem`（自签名）。`sign/*.pem` 已在 `.gitignore` 里，所以**克隆后不生成证书也能打包**，只是会退回 toolkit 的默认证书——那样每次换机器重打包签名就变了，覆盖安装可能失败。要固定签名，按 [`sign/README.md`](sign/README.md) 生成一次即可。

### 3. 从手机配置凭据（可选，但要装插件）

在 480px 圆屏上敲服务器地址加一长串应用密码实在难受，所以有一个 AstroBox 插件：在手机上填表，凭据经蓝牙推到手表，由手表自己校验并保存。

```
手表：Talk → 设置 → 从手机配置   （停在这一页等）
手机：AstroBox → 打开「Talk 凭据配置」→ 填三项 → 发送到手表
```

插件源码在 [`astrobox-plugin/`](astrobox-plugin/)（Rust → `wasm32-wasip2`），构建产物 `astrobox-plugin/dist/nctalk-credential-<版本>.abp` 直接拖进 AstroBox 安装（需要 AstroBox ≥ 2.1.0，因为用了 api_level 3）。装不上先跑 `python3 astrobox-plugin/scripts/check_artifact.py`。协议与时序见 [`docs/interconnect.md`](docs/interconnect.md)。

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

46 条 JS 断言：`base64` / `format` / `protocol` 的单元测试，加上针对 `tests/mock-server.mjs` 这个假 Nextcloud 的 14 条接口集成测试（认证头、OCS 信封、游标、错误映射、网络失败）。测试里 `api.js` 是**原样执行**的，只把 `@system.fetch` 换成 `tests/fetch-double.mjs` 这个替身。

插件侧的协议单测要另跑（它只能编到 host，不能编到 wasm）：

```bash
cd astrobox-plugin && cargo test --target x86_64-unknown-linux-gnu --test protocol
```

### 6. CI

`.gitea/workflows/ci.yml` 四个 job：`test`（JS 46 条断言）、`test-plugin`（Rust 7 条协议断言）、`build-rpk`、`build-plugin`，后两个用 `needs:` 卡在前两个通过之后，产物走 artifact。签名证书从 `SIGN_PRIVATE_PEM` / `SIGN_CERT_PEM` 两个 secret 注入，不配也能出包（退回 toolkit 调试证书）。

细节、runner 标签要求和本地复现命令见 [`docs/ci.md`](docs/ci.md)。

---

## 功能

| 功能 | 状态 | 说明 |
| --- | --- | --- |
| 账号登录 / 校验 | ✅ | 走 `/ocs/v2.php/cloud/user` 验证，成功才落盘 |
| 会话列表 | ✅ | 按最近活跃排序、未读数、最后一条消息预览 |
| 历史消息 | ✅ | 最近 40 条，倒序展示（最新在最上方，无需滚动到底） |
| 发送消息 | ✅ | POST `/chat/{token}`，发送后本地立即上屏 |
| 已读标记 | ✅ | 打开会话后 PUT `/chat/{token}/read` |
| 轮询新消息 | ✅ | 默认 15s，可在设置里改成 30s / 60s |
| 中文 / 英文 / 日语输入 | ✅ | 内置三⽅输入法组件，QWERTY 与 T9 两种布局 |
| 设置 | ✅ | 键盘布局、屏幕形状、轮询间隔、字号、清除数据 |
| 从手机配置凭据 | ✅ | AstroBox 插件经 interconnect 推送，手表校验后保存 |
| 图片 / 文件消息 | ❌ | 只渲染文本，附件显示为占位文字 |
| 长轮询 / WebSocket | ❌ | 见「已知限制」 |
| 通知推送 | ❌ | Vela 暂无第三方 app 的推送通道 |
| 通话、回复、表情回应 | ❌ | 超出骨架范围 |

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
├── .gitea/workflows/ci.yml       # Gitea Actions：测试 + 打包 rpk/abp
├── docs/
│   ├── api.md                    # 接口清单与错误映射
│   ├── design.md                 # 圆屏布局计算与状态机
│   ├── interconnect.md           # 与插件的协议、时序、排错
│   └── ci.md                     # CI 的 job 划分、secrets、runner 配置
├── tests/
│   ├── run.sh                    # 一键跑全部测试（需要 Node ≥ 18）
│   ├── mock-server.mjs           # 假 Nextcloud Talk OCS 服务
│   ├── fetch-double.mjs          # @system.fetch 的 Node 替身
│   ├── api.test.mjs              # api.js 集成测试
│   ├── protocol.test.mjs         # 凭据协议单元测试
│   └── units.test.mjs            # base64 / format 单元测试
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
- `editing = true`：会话名 + 草稿预览（只显示末尾 60 字）+ 取消 / 发送

这样既不用滚动页面，也不会出现键盘遮挡。

### 消息顺序

消息按 **id 倒序**渲染，最新一条在最上方。这样新消息到达时直接 `concat` 到数组头部即可，完全不需要 `scrollTo`（Vela 的 `scroll` 滚动控制在不同机型上行为不一致，能绕开就绕开）。

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
  screentype="{{screenType}}"      <!-- circle | rect | pill -->
  maxlength="5"
  vibratemode="short"
  @complete="onKeyComplete"    <!-- evt.detail.content -->
  @delete="onKeyDelete"
></input-method>
```

`@delete` 只给事件不给内容，删字符要自己做，并且要处理代理对（emoji 占两个 code unit）。

### 屏幕形状

`manifest.json` 的 `config.designWidth` 默认 480，对应圆形表盘（Watch S1 Pro / S3 / S4 / S5）。换设备时：

| 设备 | 分辨率 | designWidth | screentype |
| --- | --- | --- | --- |
| Watch S1 Pro / S5 | 480×480 | 480 | `circle` |
| Watch S3 / S4 / H1 | 466×466 | 480（会被缩放） | `circle` |
| Band 8 Pro / 9 Pro | 336×480 | 336 | `pill` |
| Band 9 / 10 | 192×490 等 | 192 | `pill` |

`designWidth` 需要改 `manifest.json` 后重新打包；`screentype` 只是传给输入法组件的布局参数，可以在设置页里实时切换。

---

## 已知限制

- **轮询而非长轮询**：`lookIntoFuture=1` 需要服务端挂住连接最多 60s，Vela 的 `fetch` 生命周期在后台不稳，所以用 15s 短轮询。代价是耗电和延迟。想试长轮询，改 `chat.ux` 的 `pollOnce` 传 `lookIntoFuture: 1` 即可。
- **明文 HTTP**：`manifest.json` 没有声明网络安全例外，实际请务必用 HTTPS，否则应用密码在链路上是裸的。
- **密码存储**：Vela 没有 keystore API，应用密码以明文存在 app 沙箱内的 `@system.storage` 里。这是平台限制，不是实现选择，详见 [`docs/design.md`](docs/design.md)。
- **无附件渲染**：文件/图片消息会显示成 Rich Object String 展开后的文件名文本。
- **消息上限**：一次只取 40 条，没有上滑加载更早消息。
- **未读数**：会话列表的未读数直接取服务端 `unreadMessages`，本地不会自增。
- **interconnect 的签名前提**：官方 Vela 文档要求快应用与手机端 App 包名/签名一致才能互联，而 AstroBox 的 `interconnect` host API 是按 `pkg-name` 投递的。这条限制是否被绕开**未在真机验证**，如果手表收不到推送，先看插件的 stdout 日志里 send 是否返回 `Err`。细节见 [`docs/interconnect.md`](docs/interconnect.md)。
- **插件不持久化密码**：AstroBox 的 Host API 里确实没有文件系统函数（`os` 只给 arch/hostname/locale），运行时虽然提供 WASI std fs（限定在插件自己的目录内），但这一版**故意没有**写盘——密码每次都要重填，真正的保存只发生在手表的 `@system.storage`，发送成功后插件立刻清空内存里的密码。

## 下一步

按优先级：

1. 上滑加载更早消息（`lastKnownMessageId` 翻页）
2. 图片消息缩略图（`@system.fetch` 拿临时文件 uri → `image` 组件）
3. 长按消息回复 / 表情
4. 手势返回（`onBackPress` 已由系统接管，但可以加滑动手势）
5. 离线草稿队列

---

## 参考

- [Vela JS 应用开发文档](https://iot.mi.com/vela/quickapp/zh/guide/)
- [AstroBox 插件文档](https://plugindoc.astrobox.online/)
- [项目配置 manifest.json](https://iot.mi.com/vela/quickapp/zh/guide/framework/manifest.html)
- [数据请求 fetch](https://iot.mi.com/vela/quickapp/zh/features/network/fetch.html)
- [Nextcloud Talk Conversation API](https://nextcloud-talk.readthedocs.io/en/latest/conversation/)
- [Nextcloud Talk Chat API](https://nextcloud-talk.readthedocs.io/en/latest/chat/)
- [NEORUAA/Vela_input_method](https://github.com/NEORUAA/Vela_input_method)
- [AstroBox NG 插件模板（Rust）](https://github.com/AstralSightStudios/AstroBox-NG-Plugin-Template-Rust)

## 许可

本仓库代码 MIT。`src/components/InputMethod/` 沿用上游许可，见该目录下的 `LICENSE`。`astrobox-plugin/` 依赖的 `astrobox-ng-wit` 为 MIT。
