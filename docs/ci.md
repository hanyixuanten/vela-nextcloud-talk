# CI（Gitea Actions）

工作流在 [`.gitea/workflows/ci.yml`](../.gitea/workflows/ci.yml)，触发条件：push 到 `main`、打 `v*` tag、PR、以及手动 `workflow_dispatch`。

## 四个 job

| job | 依赖 | 干什么 | 产物 |
| --- | --- | --- | --- |
| `test` | — | `npm ci` + `npm test`（46 条 JS 断言：base64 / format / protocol 单测 + 对 mock Nextcloud 的 14 条接口集成测试） | — |
| `test-plugin` | — | `cargo test --target x86_64-unknown-linux-gnu --test protocol`（7 条协议单测，不需要 wasm 目标） | — |
| `build-rpk` | `test` | 恢复签名证书 → `npm run build` → 校验 `dist/*.rpk` 内容 | `rpk` |
| `build-plugin` | `test-plugin` | `rustup target add wasm32-wasip2` → `scripts/build_dist.py --release --package` | `abp` |

`build-*` 用 `needs:` 卡住：测试挂了就不浪费一次 `cargo build` 和一次 aiot 打包。

## 需要的配置

### 1. Runner 标签

`runs-on: ubuntu-latest` —— act_runner 注册时必须带这个标签（默认标签通常是 `ubuntu-latest` 或 `docker`，在 runner 配置里确认一下）：

```yaml
# act_runner 的 config.yaml
labels:
  - "ubuntu-latest:docker://catthehacker/ubuntu:act-latest"
```

### 2. 签名证书（可选，但强烈建议）

仓库 `Settings → Actions → Secrets` 加两个：

| Secret | 内容 |
| --- | --- |
| `SIGN_PRIVATE_PEM` | `sign/private.pem` 全文（含 `-----BEGIN ...-----`） |
| `SIGN_CERT_PEM` | `sign/certificate.pem` 全文 |

不配也能过：aiot-toolkit 会退回自带的调试证书（`sign/debug/` → `sign/` → 内置）。代价是**签名会变**，从 CI 产物覆盖安装旧包会失败。工作流里有一步会明确打印「没有签名密钥，将使用 toolkit 调试证书」，不会静默。

### 3. 代理（国内 runner 常需要）

工作流顶部有一个静态变量：

```yaml
env:
  HTTP_PROXY: ''
```

runner 访问 npm / crates.io 需要代理时，填成 `http://host:port` 即可。所有联网步骤都是这个模式：

```bash
if [ -n "$HTTP_PROXY" ]; then
  export http_proxy="$HTTP_PROXY" https_proxy="$HTTP_PROXY"
fi
```

空值不会被导出，所以不会出现空 `http_proxy` 把工具带偏的情况。

> 没用 `${{ vars.HTTP_PROXY }}`，是因为 `vars` 上下文在不同 Gitea 版本上支持程度不一致，一个表达式解析失败会让**所有 job** 挂掉。改一行 YAML 比排查这个便宜。

## 为什么只有两个外部 action

`actions/checkout@v4` 和 `actions/upload-artifact@v4`，剩下的全是 shell。

自建 act_runner 经常拉不到 github.com，`uses:` 越多越容易在第一步就挂。因此：

- 不用 `actions/setup-node`：镜像自带 Node ≥ 18，工作流里 `node -v` 打出来便于核对；
- 不用 `dtolnay/rust-toolchain`：改成 `if ! command -v cargo` 就装 rustup，装了就用现成的；
- 不用 `actions/cache`：Rust 依赖每次重编，插件 release 构建约 12s，不值得为它多一个 action 依赖。

`uses: actions/checkout@v4` 能解析，依赖实例的 `DEFAULT_ACTIONS_URL` 把短名映射到可访问的镜像（Gitea 默认指向 gitea.com 的 actions 镜像）。如果你的实例连 gitea.com 也不通，把这行改成内网镜像的完整地址，或干脆用 token 手动 clone：

```yaml
- name: Checkout (manual)
  run: |
    git clone --depth 1 \
      "https://${{ secrets.GITEA_TOKEN }}@git.vblg.top/hanyixuanten/vela-nextcloud-talk.git" .
```

## 本地复现

CI 里跑的都是能本地跑的命令，出问题先在本机对一遍：

```bash
# test
npm ci && npm test

# test-plugin
cd astrobox-plugin && cargo test --target x86_64-unknown-linux-gnu --test protocol

# build-rpk
npm run build && ls -l dist/

# build-plugin
cd astrobox-plugin && PATH="$HOME/.cargo/bin:$PATH" \
  python3 scripts/build_dist.py --release --package && ls -l dist/
```

这套命令在干净 clone 里验证过：`npm ci` 装 718 个包，JS 46 条断言全绿，Rust 7 条全绿，rpk 与 abp 都能产出。

## 实跑记录（首次上线踩的坑）

runner 镜像实际是 `gitea/runner-images:ubuntu-26.04`，**镜像里没有 cargo**，也没有 rustup。第一版工作流就这样挂了：

```
/var/run/act/workflow/1.sh: line 7: cargo: command not found
##[error]Process completed with exit code 127
```

原因很典型：`sh -s -- -y` 装完 rustup 后只写进了 shell profile，`echo $HOME/.cargo/bin >> $GITHUB_PATH` 只对**后续 step** 生效，当步里紧接着的 `cargo --version` 自然找不到。修法是当步再 `export PATH="$HOME/.cargo/bin:$PATH"` 一次。

同一轮里另外两个信号：

- `test (js)` 通过，Node **v24.22.3** / npm 11.19.1 —— 镜像自带的 Node 足够新，不需要 `actions/setup-node`；
- `build (rpk)` 通过，日志里明确打出 `no signing secrets; the toolkit debug certificate will be used`，artifact `rpk.zip` 395 KB 上传成功 —— 说明不配 secrets 也能出包，降级路径是通的。

`build (abp)` 因为 `test (plugin protocol)` 失败被 `needs:` 跳过，等修好后才第一次真正跑起来。

## 已知限制

- **没有缓存**，每次全量 `npm ci` + `cargo build`。想要就自己加 `actions/cache`，键用 `Cargo.lock` 和 `package-lock.json` 的哈希。
- **不做签名校验**（除非配了 secrets）。CI 里 `openssl x509 -noout -subject` 只打印，不比对是否符合预期。
- **不跑模拟器**。Vela 的 UI 只能靠 AIoT-IDE + AVD 验证，CI 里没有，所以 `build` 只证明「能编过、产物结构对」，不证明「跑起来对」。
- **abp 文件名是 ASCII**（`nctalk-credential-<版本>.abp`）。早先版本用的是 manifest 里的中文 `name`，在部分平台安装器上会出问题，现在 `build_dist.py` 改为从 wasm entry 派生，可用 `--archive-name` 覆盖。
