# Obsidian 伴侣安装与验证

伴侣版本为 **0.6.0**，最低 Obsidian **1.8.7**。它是独立的只读白板查看器；白板创建、笔迹编辑与导出由原生应用完成。它不是 Obsidian 主程序，也尚未在 Obsidian 社区插件目录发布。

## 手动安装

1. 在你的 Obsidian 仓库配置目录创建 `plugins/inkspace-companion/`。默认完整位置为 `.obsidian/plugins/inkspace-companion/`；自定义配置目录以 Obsidian 设置为准。
2. 从本仓库的 `obsidian/inkspace-companion/` 复制 **main.js、manifest.json、styles.css**，放入上一步目录。
3. 在 Obsidian「设置 → 第三方插件」中启用「人生赢家」。首次安装可能需要重新加载 Obsidian。更新时同时替换三个文件，再重新启用插件。
4. 使用命令「选择白板」打开自己仓库里的 `.inkspace.json`，或打开原生应用生成的 Markdown 白板入口。

插件查看本机已授权仓库内的文件，不提供样例私人笔记。iPad 上的「新建白板」及「书写」入口需要另行安装原生应用，并授权相同实际仓库；仅安装插件不会安装原生应用。桌面和 Android 不执行 iPad 新建操作。

## 源码

`main.js` 是现存的、可直接编辑的 CommonJS JavaScript 实现，`require("obsidian")` 由 Obsidian 主程序提供。没有另附 TypeScript 源码，没有打包步骤，不需要在插件目录运行 `npm install`。`styles.css` 和 `manifest.json` 同属安装输入。源码与安装输入保持一致。

本次公开选择了保存完整双语实现及回归套件的 0.6.0 副本；另一份 0.4.0 副本更旧，仅有中文界面。没有合并不同版本文件或伪造原始 TypeScript。

## 验证

在仓库根目录使用 Node.js 24 或更新版本运行：

```sh
node --check obsidian/inkspace-companion/main.js
node --test obsidian/tests/companion.test.cjs
```

35 项已有回归使用模拟 Obsidian 公开 API 和现场构造的数据，覆盖安全路径、JSON 校验、网页笔迹、PDF 缓存与并发、刷新竞争、清理、英文/简体中文及特殊字符路径。套件不访问私人仓库、设备或外部账户。通过这些检查不代表实际 Obsidian 界面、真实 iCloud 同步、复杂课程文件性能或当前原生版本的全部格式已获验收。

## 许可与边界

伴侣项目代码使用仓库根目录的 [MIT LICENSE](../LICENSE)，版权归属为 InkSpace contributors。未打包 Obsidian、其运行时或第三方 PDF.js/MathJax；插件调用宿主提供的 API。插件跟随 Obsidian 配置语言，简体中文之外回退英文；切换语言后重新加载。详细格式、容量及同步限制见 [插件 README](../obsidian/inkspace-companion/README.md)。
