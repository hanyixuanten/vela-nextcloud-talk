# CI（GitHub Actions）

工作流在 [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)，触发条件：push 到 `main`、打 `v*` tag、PR、以及手动 `workflow_dispatch`。同一分支的新推送会取消上一次还在跑的任务（`concurrency`）。

> 历史：这份工作流最早写在 `.gitea/workflows/` 下，用在自建 Gitea 的 act_runner 上跑通过一轮。现在源码主仓在 GitHub，`git.vblg.top` 上的那个仓库是它的**只读镜像**（`mirror: True`，8 小时同步），所以 CI 只保留 `.github/workflows/`。

## 四个 job

| job | 依赖 | 干什么 | 产物 |
| --- | --- | --- | --- |
| `test` | — | `npm ci` + `npm test`（46 条 JS 断言：base64 / format / protocol 单测 + 对 mock Nextcloud 的 14 条接口集成测试） | — |
| `test-plugin` | — | `cargo test --target x86_64-unknown-linux-gnu --test protocol`（7 条协议单测，不需要 wasm 目标） | — |
| `build-rpk` | `test` | 恢复签名证书 → `npm run build` → 检查 `dist/*.rpk` 内容 | `rpk` |
| `build-plugin` | `test-plugin` | `rustup target add wasm32-wasip2` → `build_dist.py --release --package` → `check_artifact.py` | `abp` |

`build-*` 用 `needs:` 卡住：测试挂了就不浪费一次 `cargo build` 和一次 aiot 打包。

`build-plugin` 里多了 `check_artifact.py` 一步——它把「manifest 权限写错 / entry 指错文件 / 打成 core module 而不是 component / 文件名非 ASCII」这类**装不上**的问题挡在 CI，而不是等装到手机上才发现。

## 需要的配置

### 1. Runner

`runs-on: ubuntu-latest` —— GitHub 托管 runner 开箱可用，不需要自建。实测镜像里 **Node 是 v24**，够新，所以没用 `actions/setup-node`。

### 2. 签名证书（可选，但强烈建议）

`Settings → Secrets and variables → Actions → Secrets` 新增两个：

| Secret | 内容 |
| --- | --- |
| `SIGN_PRIVATE_PEM` | `sign/private.pem` 全文（含 `-----BEGIN ...-----`） |
| `SIGN_CERT_PEM` | `sign/certificate.pem` 全文 |

不配也能过：aiot-toolkit 会退回自带的调试证书（`sign/debug/` → `sign/` → 内置）。代价是**签名会变**，拿 CI 产物覆盖安装旧包会失败。工作流会明确打印「没有签名密钥，将使用 toolkit 调试证书」，不会静默。

### 3. 代理（按需）

走仓库变量而不是硬编码：

```yaml
env:
  HTTP_PROXY: ${{ vars.HTTP_PROXY }}
```

在 `Settings → Secrets and variables → Actions → Variables` 建一个 `HTTP_PROXY`（如 `http://host:port`）即可。变量未定义时展开为空串，所有联网步骤都是：

```bash
if [ -n "${HTTP_PROXY:-}" ]; then
  export http_proxy="$HTTP_PROXY" https_proxy="$HTTP_PROXY"
fi
```

空值不会被导出，不会出现空 `http_proxy` 把工具带偏。国内 runner 拉 crates.io 慢时这一项很有用。

## 为什么只有两个外部 action

`actions/checkout@v4` 和 `actions/upload-artifact@v4`，剩下全是 shell。

- 不用 `actions/setup-node`：镜像自带 Node ≥ 18，工作流里 `node -v` 打出来便于核对；
- 不用 `dtolnay/rust-toolchain`：改成 `if ! command -v cargo`，有就用、没有才装 rustup；
- 不用 `actions/cache`：Rust 依赖每次重编，插件 release 构建约 12s，不值得为它多一个依赖。

少一个 action 就少一个会因为上游变更或网络问题挂掉的环节。

## 看产物

跑完在 run 页面底部 **Artifacts** 下载 `rpk` / `abp`。`abp` 解压出来就是 `dist/` 的内容（manifest + icon + wasm），直接拖进 AstroBox 安装。

要长期分发，建议给 `v*` tag 建 Release 把这两个文件挂上去，而不是塞进 git 历史。

## 本地复现

```bash
# test
npm ci && npm test

# test-plugin
cd astrobox-plugin && cargo test --target x86_64-unknown-linux-gnu --test protocol

# build-rpk
npm run build && ls -l dist/

# build-plugin
cd astrobox-plugin && PATH="$HOME/.cargo/bin:$PATH" \
  python3 scripts/build_dist.py --release --package
python3 scripts/check_artifact.py
```

这套命令在干净 clone 里验证过：`npm ci` 装 718 个包，JS 46 条断言全绿，Rust 7 条全绿，rpk 与 abp 都能产出并通过自检。

## 实跑记录（踩过的坑）

第一版在自建 act_runner 上跑时挂过一次：

```
/var/run/act/workflow/1.sh: line 7: cargo: command not found
##[error]Process completed with exit code 127
```

镜像里没有 cargo，rustup 装完只写进了 shell profile，`echo $HOME/.cargo/bin >> $GITHUB_PATH` 只对**后续 step** 生效，当步里紧接着的 `cargo --version` 自然找不到。修法是当步再 `export PATH` 一次——现在两个 rust job 都是这么写的。

同一轮还确认了两件事：`test (js)` 在 Node v24 上直接过，不需要 `setup-node`；`build (rpk)` 在没有签名 secrets 时也能出包并成功上传 artifact。

## 已知限制

- **没有缓存**，每次全量 `npm ci` + `cargo build`。想要就加 `actions/cache`，键用 `Cargo.lock` 与 `package-lock.json` 的哈希。
- **不跑模拟器**。Vela 的 UI 只能靠 AIoT-IDE + AVD 验证，CI 里没有，所以 `build-rpk` 只证明「能编过、产物结构对」，不证明「跑起来对」。
- **不校验签名一致性**。除非配了 secrets，否则只打印证书 subject，不比对是不是预期那张。
- **插件包只做静态校验**。`check_artifact.py` 能挡格式与清单问题，挡不住运行时问题（比如 interconnect 被签名限制挡住）。
