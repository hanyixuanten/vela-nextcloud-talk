# CI（GitHub Actions）

[工作流](../.github/workflows/ci.yml)在推送到 `main`、推送 `v*` tag、PR 和手动 `workflow_dispatch` 时运行。同一分支的新 push 会取消上一次未完成的运行。`ubuntu-latest` runner 负责打包，本机不需要编译工具链。

| 任务 | 内容 | Artifact |
| --- | --- | --- |
| `test` | `npm test`（纯 Node，不需要安装打包工具） | — |
| `test-plugin` | Rust 插件协议回归测试 | — |
| `build-rpk` | JS 测试通过后，按 `circle` / `rect` 矩阵分别编译并验证 RPK | `rpk-debug-*` 或 `rpk-release-*`（前缀由签名模式决定，后缀为 `xiaomi-watch-s3-s4-s4-sport` / `redmi-watch-5`） |
| `build-plugin` | 协议测试通过后打包 `wasm32-wasip2` 插件并验证 ABP | `abp` |

## 签名

在仓库 `Settings → Secrets and variables → Actions → Secrets` 配置 `SIGN_PRIVATE_PEM` 和 `SIGN_CERT_PEM` 时，工作流把它们写到 `sign/release/` 并运行 `release:<shape>`。两个 secret 都缺失时（含 fork PR），运行 `build:<shape>` 并使用 Toolkit 调试证书；只配置其中一个会报错。签名不同可能无法覆盖旧包；如需卸载重装，请准备好重新配置手表。

需要代理的 runner 可设置仓库变量 `HTTP_PROXY`。插件 Rust 版本由 [rust-toolchain.toml](../astrobox-plugin/rust-toolchain.toml) 固定，勿随意升级，否则新组件可能要求宿主还不支持的 WASI 版本。

## 获取产物

把改动推到有权限的 GitHub 仓库，等待 **Actions → CI → Artifacts** 出现结果。解开 Artifact 的外层 ZIP 后选 `.rpk` 或 `.abp`，无需解开安装包本身。`ci.yml` 打 tag 只运行构建、不创建 Release；正式发布见下面的「发布 Release」。

```sh
# 本地可选：分别打两款调试包
npm ci
npm run build:circle
npm run build:rect
# 轻量回归测试：
npm test
```

CI 包结构检查不能代替屏幕渲染与蓝牙真机测试，参见[真机验收步骤](interconnect.md#使用和真机验收)。

## 发布 Release

[release.yml](../.github/workflows/release.yml) 只在手动 `workflow_dispatch` 时运行，必须从 `main` 触发，输入 `x.x.x`（前导 `v` 会被去掉）。

| 任务 | 内容 |
| --- | --- |
| `prepare` | 校验版本号格式、拒绝已存在的 tag / Release；用 `npm version` 改 `package.json` + `package-lock.json`，再用 [`scripts/bump-manifest-version.cjs`](../scripts/bump-manifest-version.cjs) 改 `src/manifest.json` 的 `versionName` 并把 `versionCode` 加 1；提交 `chore(release): x.y.z (watch)` 推到 `main` |
| `test` / `test-plugin` | 同上，作用在那个版本提交上 |
| `build-rpk` | 两个形状各打一个正式签名 RPK，校验文件名必须是 `com.hanyixuanten.nctalk.release.<版本>-<形状>.rpk` |
| `build-plugin` | 构建 ABP 并跑 `check_artifact.py` |
| `publish` | 汇总附件、断言清单（2 个 RPK + 1 个 ABP、无 `debug` 字样、两个形状都不缺、zip 完整），写安装说明，`gh release create` 建 tag 并发布 |

和 `ci.yml` 的关键差异：**没有调试回退**。缺 `SIGN_PRIVATE_PEM` / `SIGN_CERT_PEM` 时 `build-rpk` 直接失败，因为 Toolkit 会把调试包也命名成可安装的包，看起来很像正式版。`publish` 再兜一层，附件名里出现 `debug` 或不是 `release.<版本>` 就中止。

版本号只在这里改，本地不要手改版本再推 tag：`versionCode` 必须严格递增，重复发布同一个版本号会被 `prepare` 拒绝。插件版本（`astrobox-plugin/manifest.json` 和 `Cargo.toml`）独立于应用版本，不随应用发版变动。

