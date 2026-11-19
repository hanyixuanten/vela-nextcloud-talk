# 签名文件

`aiot build` / `aiot release` 生成的 `.rpk` 需要签名才能在真机安装。证书放在这里：

```
sign/
├── debug/                 # 可选，仅调试包用（优先级最高）
│   ├── certificate.pem
│   └── private.pem
├── release/               # 可选，仅发布包用（优先级最高）
│   ├── certificate.pem
│   └── private.pem
├── certificate.pem        # 通用，调试包和发布包都会用
└── private.pem
```

## 查找顺序

toolkit 按 `signRoot`（默认 `./sign`）依次找，**第一个存在的就用**：

| 打包命令 | 顺序 |
| --- | --- |
| `aiot build`（调试） | `sign/debug/` → `sign/` → toolkit 自带的默认调试证书 |
| `aiot release`（发布） | `sign/release/` → `sign/` |

只放 `sign/*.pem` 即可让调试包和发布包共用一张证书。若没有配置证书，只有调试构建会退回 Toolkit 默认证书；发布构建不会产出 RPK。用不同证书构建的包不能覆盖安装。

`.gitignore` 已排除所有 `*.pem`，不要提交私钥。

## 生成自签名证书

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout sign/private.pem -out sign/certificate.pem \
  -days 3650 -subj "/CN=vela-nextcloud-talk"
```

## 注意

- 同一个应用每次发版必须使用**同一张**证书，否则升级安装会失败。
- 调试包和发布包建议使用同一张证书，方便在真机上反复覆盖安装。
- 通过「小米运动健康」安装第三方 rpk 时，包名与签名必须与设备上已安装的一致。
