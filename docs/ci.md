# CI（GitHub Actions）

[工作流](../.github/workflows/ci.yml)在推送到 `main`、推送 `v*` tag、PR 和手动 `workflow_dispatch` 时运行。同一分支的新 push 会取消上一次未完成的运行。`ubuntu-latest` runner 负责打包，本机不需要编译工具链。

| 任务 | 内容 | Artifact |
| --- | --- | --- |
| `test` | `npm test`（纯 Node，不需要安装打包工具） | — |
| `test-plugin` | Rust 插件协议回归测试 | — |
| `build-rpk` | JS 测试通过后，按 `circle` / `rect` 矩阵分别编译并验证 RPK | `rpk-xiaomi-watch-s3-s4-s4-sport`、`rpk-redmi-watch-5` |
| `build-plugin` | 协议测试通过后打包 `wasm32-wasip2` 插件并验证 ABP | `abp` |

## 签名

在仓库 `Settings → Secrets and variables → Actions → Secrets` 配置 `SIGN_PRIVATE_PEM` 和 `SIGN_CERT_PEM` 时，工作流把它们写到 `sign/release/` 并运行 `release:<shape>`。两个 secret 都缺失时（含 fork PR），运行 `build:<shape>` 并使用 Toolkit 调试证书；只配置其中一个会报错。签名不同可能无法覆盖旧包；如需卸载重装，请准备好重新配置手表。

需要代理的 runner 可设置仓库变量 `HTTP_PROXY`。插件 Rust 版本由 [rust-toolchain.toml](../astrobox-plugin/rust-toolchain.toml) 固定，勿随意升级，否则新组件可能要求宿主还不支持的 WASI 版本。

## 获取产物

把改动推到有权限的 GitHub 仓库，等待 **Actions → CI → Artifacts** 出现结果。解开 Artifact 的外层 ZIP 后选 `.rpk` 或 `.abp`，无需解开安装包本身。打 tag 会运行构建，不会自动创建 GitHub Release。

```sh
# 本地可选：分别打两款调试包
npm ci
npm run build:circle
npm run build:rect
# 轻量回归测试：
npm test
```

CI 包结构检查不能代替屏幕渲染与蓝牙真机测试，参见[真机验收步骤](interconnect.md#使用和真机验收)。
