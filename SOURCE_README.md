# 人生赢家 / Life's winner

希望每一个使用我开源功能的人，都是各自的 Life's winner。

I hope everyone who uses my open-source tools can be their own Life's winner.

面向 Mac、iPad、iPhone 与 Obsidian 的本地笔记、手写白板和文档工作空间。

An open-source workspace for local notes, handwriting, whiteboards and documents on Mac, iPad, iPhone and Obsidian.

## 下载与开始 / Download and start

| 部分 / Part | 内容 / Contents | 运行与安装 / Setup |
| --- | --- | --- |
| [Mac](desktop/) | Electron、React、白板、文档与 Notebook / Boards, documents and notebooks | [构建说明 / Build guide](docs/desktop-build.md) |
| [iPad / iPhone](ios/) | SwiftUI、PencilKit、PDF 与文件夹 / PDF and folder workspaces | [Xcode 与签名 / Xcode and signing](docs/ios-build.md) |
| [Obsidian](obsidian/inkspace-companion/) | 查看与连接白板 / View and connect boards | [安装 / Installation](docs/obsidian-build.md) |
| 独立工具与组件 / Standalone tools and components | 同一账号的 `Lifes-winner-modules` 仓库 / The companion `Lifes-winner-modules` repository | 按需下载应用或单个功能 / Download an app or individual feature |

这是完整软件的开发源码。下载源码 ZIP 或克隆后，按平台说明运行；Mac 需 Node.js 24.15+，可选 OCR、原生书写及完整 Python 环境有额外要求。iOS 真机安装需自己的 Apple 开发签名；不提供个人签名 IPA。

This is the integrated application's development source. Download its source ZIP or clone it, then follow the platform guide. Mac requires Node.js 24.15+; optional OCR, native handwriting and the full Python runtime need extra setup. Installing native iOS builds requires your own Apple signing setup; no personally signed IPA is supplied.

不想安装开发工具时，可在 `Lifes-winner-modules` 首页选择独立 Mac 应用，或三个 iPhone/iPad 主屏幕工具：书写画板、偏好方案和文档工作台。主屏幕工具使用 Safari → 分享 → 添加到主屏幕；首次联网，等待“可离线使用”。各工具可切换中文 / English。正式入口与验收以模块仓库首页及 `MOBILE-APPS.md`、`DESKTOP-APPS.md` 为准。

For tools without developer setup, use the standalone Mac apps or the Writing, Preferences and Documents home-screen tools listed in `Lifes-winner-modules`. On iPhone/iPad, use Safari → Share → Add to Home Screen, open online once and wait for Ready for offline use. Tools offer 中文 / English. Published links and verified availability are listed on that repository's home page and in `MOBILE-APPS.md` / `DESKTOP-APPS.md`.

## 状态与边界 / Status and limits

首次公开源码整理于 2026-10-24，基于 Mac 第 105 轮、原生第 106.3 轮基础与 Obsidian 伴侣 0.6.0。iPad 约两万笔的大范围套索仍有已知崩溃；跨设备、云同步和全部压力流程尚未完成验收。Mac 测试不能代表 iPad/iPhone 的稳定性。先用独立测试文件，并备份重要笔记。

The first public source snapshot was prepared on 2026-10-24 from Mac round 105, native round 106.3 foundations and Obsidian companion 0.6.0. Large iPad lasso operations involving about 20,000 strokes still have a known crash. Cross-device behavior, cloud sync and complete stress workflows remain under development; Mac results do not establish iPad/iPhone stability. Start with test files and back up important notes.

[实际验证 / Actual validation](docs/validation.md)

## 独立复用 / Reusable modules

`Lifes-winner-modules` 提供 20 个 Node 包、18 个 Swift 产品、React 组件、独立 Obsidian 伴侣和 Safari 扩展源，记录 63 个功能组的来源、用法和平台依赖。可只下载所需功能，或接入自己的软件；每个包按自己的 README 准备依赖。

`Lifes-winner-modules` provides 20 Node packages, 18 Swift products, React components, an Obsidian companion and Safari extension source, recording 63 feature groups with provenance, usage and platform dependencies. Download only what you need or integrate it into your own software; follow each package's README.

## 隐私与每月同步 / Privacy and monthly updates

发布只含经过检查的软件源码、通用资源、测试与文档，不附带个人笔记、课件、账号、凭据、设备记录、私人路径、个人签名和开发日志。每月检查已完成变更，经过隐私、许可与相关验证后更新完整软件及模块；临时实验不会自动公开。主屏幕草稿不跨设备自动同步，重要内容请导出。

Public releases include reviewed source, generic assets, tests and documentation, excluding personal notes, course materials, accounts, credentials, device records, private paths, personal signing materials and development logs. Completed changes are reviewed monthly and synchronized to the integrated source and modules after privacy, license and relevant validation checks. Experiments are not published automatically. Home-screen drafts do not sync between devices; export important work.

[发布规则 / Publication rules](docs/publishing.md)

## 许可与兼容 / License and compatibility

项目自有代码采用 [MIT License](LICENSE)，可使用、修改、分发及商用，保留版权与许可声明。第三方组件保持[原许可](THIRD_PARTY_NOTICES.md)。英文显示名为 **Life's winner**；技术包名、API、文档格式、协议与存储键保持兼容，历史发行不改写。

Original code is MIT-licensed: use, modify, redistribute or use commercially while keeping copyright/license notices. Third-party components retain their licenses. The display name is **Life's winner**; technical package names, APIs, formats, protocols and storage keys remain compatible. Historical releases are retained.
