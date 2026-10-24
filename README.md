# 人生赢家 / Life's winner

希望每一个使用我开源功能的人，都是各自的 Life's winner。

I hope everyone who uses my open-source tools can be their own Life's winner.

面向 Mac、iPad、iPhone 的本地笔记、手写白板与文档工作空间；另有可独立使用的工具、模块与 Obsidian 伴侣。

A local-first workspace for notes, handwriting, whiteboards and documents on Mac, iPad and iPhone, with standalone tools, reusable modules and an Obsidian companion.

[Mac 源码 / Source](desktop/) · [iPad/iPhone 源码 / Source](ios/) · [独立功能 / Standalone modules](https://github.com/kevinzzzzzzzz999/Lifes-winner-modules) · [功能边界 / Feature limits](https://github.com/kevinzzzzzzzz999/Lifes-winner-modules/blob/main/FEATURES.md)

## 直接使用 / Ready-to-use tools

| 设备 / Device | 入口与安装 / Open and install |
| --- | --- |
| iPhone / iPad | [三个主屏幕工具 / Three home-screen tools](https://kevinzzzzzzzz999.github.io/Lifes-winner-modules/)：书写、偏好、文档分别打开；Safari → 分享 → 添加到主屏幕。<br>Open Writing, Preferences or Documents separately; Safari → Share → Add to Home Screen. |
| Mac | [已验证应用下载 / Verified app downloads](https://github.com/kevinzzzzzzzz999/Lifes-winner-modules/blob/main/DESKTOP-APPS.md)：下载 ZIP、解压、将 `.app` 拖入“应用程序”。<br>Download a ZIP, extract it and move the `.app` to Applications. |
| 只取一项功能 / Reuse one feature | [独立模块库 / Module catalog](https://github.com/kevinzzzzzzzz999/Lifes-winner-modules)：20 个 Node 包、18 个 Swift 产品、React 与集成源码。<br>20 Node packages, 18 Swift products, React and integration source. |

普通工具无需 Xcode、Node.js 或完整版。主屏幕工具首次联网，等“可离线使用”，各自支持中文 / English。Mac 需要 macOS 13+，当前 ad-hoc 签名、未经过 Apple 公证，首次打开可能需要系统确认。准确入口、用途与公开验收见[移动说明](https://github.com/kevinzzzzzzzz999/Lifes-winner-modules/blob/main/MOBILE-APPS.md)和[Mac 说明](https://github.com/kevinzzzzzzzz999/Lifes-winner-modules/blob/main/DESKTOP-APPS.md)。

These tools need no Xcode, Node.js or full application. Open home-screen tools online once and wait for Ready for offline use; each offers 中文 / English. Mac requires macOS 13+; apps use ad-hoc signing and are not Apple-notarized, so first opening may need system approval. See the mobile and Mac guides for exact availability and scope.

## 完整软件源码 / Integrated application source

[**下载源码 ZIP / Download source ZIP**](Lifes-winner-source-2026-10-24-r3.zip?raw=1) · [SHA256 与文件清单 / Hashes and manifest](source-manifest.json)

源码已按目录展开，可以直接浏览、克隆和比较改动；包含工程、测试、通用资源与许可。

Source is also expanded into repository directories for browsing, cloning and comparing changes, including projects, tests, generic resources and licenses.

| 平台 / Platform | 构建与安装 / Build and install |
| --- | --- |
| Mac | Node.js 24.15+；[桌面构建 / Desktop build](desktop-build.md)，可选 OCR、原生书写和 Python 另有要求。<br>Follow the desktop guide; optional OCR, native handwriting and Python have extra requirements. |
| iPad / iPhone | macOS、Xcode 与自己的 Apple 签名；[iOS 指南 / iOS guide](ios-build.md)。<br>Requires macOS, Xcode and your own Apple signing setup. |
| Obsidian | [伴侣安装 / Companion installation](obsidian-build.md) |

完整软件仍是开发源码发行，不提供个人签名 IPA；源码 ZIP 不是可直接安装的手机应用。

The integrated application remains a development source release, without a personally signed IPA. A source ZIP is not an installable iPhone/iPad application.

## 功能 / Features

| 场景 / Area | 功能 / Capabilities |
| --- | --- |
| 阅读与批注 / Reading | PDF、Office、图片、Markdown、旁注与摘录 / PDF, Office, images, Markdown, margin notes and excerpts |
| 手写整理 / Handwriting | 白板、PencilKit、卡片、连接、子白板与历史 / Boards, PencilKit, cards, links, child boards and history |
| 代码计算 / Code | 本地 Python、Notebook、表格交换与数学 / Local Python, notebooks, tabular exchange and mathematics |
| 学习计划 / Study | 搜索、复习卡片、任务、日历与 ICS / Search, review cards, tasks, calendars and ICS |
| 网页媒体 / Web and media | 剪藏、AI 适配、字幕与媒体工程 / Clips, AI adapters, subtitles and media projects |

## 状态与边界 / Status and limits

首次源码基于 Mac 第 105 轮、原生第 106.3 轮基础与 Obsidian 0.6.0。iPad 约两万笔的大范围套索仍有已知稳定性问题；iCloud、真实 Apple Pencil 和全部设备流程不能由构建或组件测试代替。先用测试文件并备份重要资料。完整实际检查见 [validation.md](validation.md)；独立模块的[最新验收](https://github.com/kevinzzzzzzzz999/Lifes-winner-modules/blob/main/VALIDATION.md)另行记录。

The initial source is based on Mac round 105, native round 106.3 foundations and Obsidian 0.6.0. Large iPad lasso selections of about 20,000 strokes still have a known stability issue. Builds and component tests do not establish iCloud, physical Apple Pencil or every device workflow. Start with test files and back up important work. Integrated and standalone checks are documented separately.

## 隐私、每月更新与参与 / Privacy, monthly updates and contribution

发布排除个人笔记、课件、账号、密钥、设备记录、私人路径、个人签名和开发日志。每月检查已完成变更，经过隐私、许可与相关验证后同步完整源码、功能包和已验证应用。个人草稿不会因发布自动跨设备同步。网页托管方仍收到普通页面请求。

Releases exclude personal notes, course materials, accounts, secrets, device records, private paths, personal signing materials and development logs. Completed changes are reviewed monthly and synchronized across the integrated source, modules and verified apps after privacy, license and relevant validation checks. Publishing never synchronizes personal drafts between devices. Static hosts still receive ordinary page requests.

欢迎提交可复现问题与文档建议，附平台、版本、步骤和合成样例；不要在 Issue 上传私人笔记、账号或密钥。

Issues and documentation suggestions are welcome. Include the platform, version, steps and a synthetic example; do not upload private notes, accounts or secrets.

## 许可与名称 / License and naming

项目自有代码采用 [MIT License](LICENSE)，允许使用、修改、分发及商用，保留版权和许可；[第三方组件](THIRD_PARTY_NOTICES.md)保留原许可。显示名称为 **人生赢家 / Life's winner**，技术 API、格式、协议、存储键和兼容文件名保留，历史发行不改写。

Original code is MIT-licensed: use, modify, redistribute or use commercially while retaining copyright/license notices. Third-party components retain their licenses. The display name is **人生赢家 / Life's winner**; technical APIs, formats, protocols, storage keys and compatible filenames remain unchanged. Historical releases are retained.
