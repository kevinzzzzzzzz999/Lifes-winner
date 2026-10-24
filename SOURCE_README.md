# InkSpace · 人生赢家

An open-source workspace for local notes, handwriting, whiteboards and documents.

面向 Mac、iPad、iPhone 和 Obsidian 的本地笔记、手写白板与文档工作空间。

## 使用与开发 / Getting started

| 部分 | 内容 | 运行与安装 |
| --- | --- | --- |
| [Mac 桌面端](desktop/) | Electron、React、白板、文档与 Notebook | [构建说明](docs/desktop-build.md) |
| [iPad / iPhone](ios/) | SwiftUI、PencilKit、PDF 与文件夹工作空间 | [Xcode 构建与签名](docs/ios-build.md) |
| [Obsidian 伴侣](obsidian/inkspace-companion/) | 在 Obsidian 中连接 InkSpace 文件与白板 | [安装说明](docs/obsidian-build.md) |

下载源码后请按对应平台的说明运行。iPad / iPhone 版需要使用自己的 Apple 开发签名；此仓库不提供个人签名的安装包。Mac 的可选 OCR、原生书写和完整 Python 运行环境有额外构建要求，见桌面端说明。

Download the source and follow the platform-specific guide. iOS device installation requires your own Apple signing setup. Optional desktop native helpers and the full Python runtime have additional build requirements.

## 当前状态 / Status

这是开发中的开源源码版本。首次公开整理于 2026-10-24，基于桌面端 0.8.5 的第 105 轮源码、原生端第 106.3 轮基础以及 Obsidian 伴侣 0.6.0。

- iPad 在包含约两万笔的大范围套索操作中仍有已知崩溃问题，移动、缩放、撤销与保存的完整压力流程尚未全部通过。
- 各平台独立验证；Mac 的测试结果不代表 iPad、iPhone 或云同步已经通过验收。
- 请先用独立测试文件体验开发版本，并保留重要笔记的备份。

This is a development source release. Large iPad lasso operations involving around 20,000 strokes still have a known crash. Device stability, cross-device behavior and complete stress workflows remain under development. See [validation](docs/validation.md) for the checks actually performed on this public source snapshot.

## 独立模块 / Reusable modules

同一 GitHub 账号下的 `inkspace-modules` 仓库提供散装功能库：JavaScript / Node.js 包、Swift 产品、独立 Obsidian 伴侣和分享扩展源。它记录 61 个功能组的来源、独立使用方式和剩余平台依赖，适合只取一项功能或组合到自己的软件中。

## 隐私与同步 / Privacy and updates

公开仓库只包含经检查的软件源码、通用应用资源、测试和必要文档。笔记、课程材料、个人账号、凭据、设备记录、签名和本地开发日志不属于发布内容。

后续发布必须先筛选源码、检查私人信息与第三方许可，并运行相关验证。未经验证的临时实验不会自动成为公开发布版本。同步过程及要求见 [发布规则](docs/publishing.md)。

The public repository contains reviewed application source, generic assets, tests and documentation. Personal content, credentials, device records and signing materials are excluded. Updates pass publication checks before being pushed.

## 许可证 / License

项目自有代码使用 [MIT 许可证](LICENSE)。任何人都可以使用、修改和分发，也可以用于商业用途；分发时保留版权与许可声明。第三方组件保持各自原有许可，见 [第三方说明](THIRD_PARTY_NOTICES.md)。

Original project code is available under the MIT License. Third-party components retain their own licenses.
