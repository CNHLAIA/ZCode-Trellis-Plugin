# ZCode Trellis Plugin

ZCode 从 3.6.x 到 3.7.x 中的某个版本开始，就以安全策略为理由，禁用了项目级 Hooks，此举导致 Trellis 工作流失效，很容易出现行为偏移。

本插件用于恢复 ZCode 中使用 Trellis 的正常流程。

## 安装

![添加插件市场](https://minio-s3.hlaia.top/image-bed/md/2026/08/17/1786973274381-f60ddd51713a117b.png)

在 ZCode设置 ---- 插件 ---- 右上角创建 ---- 添加插件市场，填本仓库的 github 链接

```text
https://github.com/CNHLAIA/ZCode-Trellis-Plugin.git
```

随后在 “个人” 里安装插件

![安装 trellis-bridge](https://minio-s3.hlaia.top/image-bed/md/2026/08/18/1786983769960-dd32b92b20713243.png)

非 Trellis 项目不会触发本插件



## 附

如有问题，欢迎提交 issue，或联系 hlaia@hlaia.com。

本插件采用 [MIT License](./LICENSE)

