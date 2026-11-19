# 手表端不提供缩略图或图片预览

图片附件与其他文件附件一样，只显示消息文字和文件名。手表端不请求原图或缩略图，不预取、缓存或解码图片；要看附件请使用手机或网页端。

小文件不等于低内存占用。下表按 `宽 × 高 × 每像素字节` 估算单个解码缓冲区；这不是实测值，也未计入压缩响应、解码工作区或渲染所需的额外缓冲。

| 实际输入像素 | RGB565（2 B/像素） | RGBA8888（4 B/像素） |
| --- | ---: | ---: |
| 160 × 160 | 50 KiB | 100 KiB |
| 240 × 240 | 112.5 KiB | 225 KiB |
| 4032 × 3024 | 23.26 MiB | 46.51 MiB |

[Vela 的 `<image>` 文档](https://iot.mi.com/vela/quickapp/en/components/basic/image.html)没有承诺按显示尺寸解码；把图片显示得更小，不等于限制了上述解码开销。[Vela 的网络请求文档](https://iot.mi.com/vela/quickapp/en/features/network/fetch.html#responsetype-and-data-relationship-in-success)支持返回临时文件 URI，但未说明能设置传输字节硬上限。保留纯文本附件显示可避免引入这些资源开销；真机验收专注于[文本聊天基线](watch-memory-baseline.md)。
