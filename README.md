# InkSpace · 人生赢家

开源的本地笔记、手写白板与文档工作空间，包含 **Mac、iPad 和 iPhone** 三个版本，以及 Obsidian 伴侣。

## 下载完整源码

[**下载 InkSpace 完整源码（ZIP）**](InkSpace-source-2026-10-24.zip)

ZIP 内保存完整、可编辑的源文件、工程、测试、资源与说明。解压后进入 `inkspace/`，按平台说明构建。源代码文件清单与摘要见 [source-manifest.json](source-manifest.json)。

| 平台 | 构建与安装说明 |
| --- | --- |
| Mac | [桌面版说明](desktop-build.md) |
| iPad / iPhone | [Xcode 构建与自己的设备签名](ios-build.md) |
| Obsidian | [伴侣安装说明](obsidian-build.md) |

这些下载提供源码。iPad / iPhone 安装需要使用者自己的 Apple 签名；完整公众安装包、公证和所有平台运行环境仍有独立准备要求。

## 按功能使用

同一账号下的 **inkspace-modules** 仓库提供独立功能下载：白板、PDF、文档、Notebook、搜索、学习、日历、媒体、数学与原生工具，以及 React 组件和 Obsidian 集成。每个下载包都有用途、使用方法、依赖和许可。

## 开发状态

首次源码整理日期为 2026-10-24。桌面源码来自第 105 轮，iPad/iPhone 主应用来自第 106.3 轮基础，Obsidian 伴侣为 0.6.0。iPad 约两万笔的大范围套索仍有已知稳定性问题；编译与组件检查不代表全部真机流程完成。实际检查见 [验证记录](validation.md)。

## 隐私与更新

发布内容仅限审查过的软件源码与通用资源，不附带个人笔记、课件、账号、凭据、设备记录或签名。后续完成的软件版本会经过隐私与相关构建检查，再更新这里的源码下载与独立功能库。

## 许可证

项目自有代码按 [MIT License](LICENSE) 开源，允许使用、修改、分发和商业使用，分发时保留许可与版权声明。第三方组件保持[原有许可](THIRD_PARTY_NOTICES.md)。
