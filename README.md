# life'winner · 人生赢家

希望每一个使用我开源功能的人，都是各自的 life'winner。

**Local-first notes, handwriting, whiteboards, PDF and notebooks for macOS, iPad and iPhone.**

面向 Mac、iPad 和 iPhone 的开源本地笔记、手写白板与文档工作空间。把资料、批注、思维结构和学习工具放在自己的文件夹中；Obsidian伴侣可查看已有白板。

[浏览Mac源码](desktop/) · [浏览iPad/iPhone源码](ios/) · [独立模块与组件](https://github.com/kevinzzzzzzzz999/inkspace-modules) · [功能覆盖与边界](https://github.com/kevinzzzzzzzz999/inkspace-modules/blob/main/FEATURES.md)

## 能用它做什么 / What you can do

| 场景 | 功能 |
| --- | --- |
| 阅读与批注 | PDF、Office、图片和Markdown阅读，旁注、原文关联、摘录与导出 |
| 手写与整理 | 白板、PencilKit手写、文字/公式卡片、节点连接、子白板、合并和历史 |
| 代码与计算 | 代码编辑、本地Python、Jupyter Notebook、表格数据交换与数学工作台 |
| 学习与计划 | 搜索与笔记关联、学习卡片、间隔复习、任务清单、日历与ICS |
| 网页与媒体 | 网页剪藏、AI接口、字幕、播放与非破坏式媒体编辑；外部服务/引擎按需配置 |
| 开发者复用 | 20个Node库、18个Swift产品、React组件和独立集成，可只下载需要的功能 |

## iPhone / iPad 主屏幕工具

书写画板、偏好方案和文档工作台另有分别添加到主屏幕的轻量网页适配。正式入口、安装说明和公开验收状态以[移动工具说明](https://github.com/kevinzzzzzzzz999/inkspace-modules/blob/main/MOBILE-APPS.md)为准；正式链接验证前，源码不能视为已经可安装的成品。

## 下载与开始 / Get started

[**下载完整软件源码（ZIP）**](life-winner-source-2026-10-24-r2.zip?raw=1)

源码也已按目录提供，可直接阅读、克隆和比较改动。下载包内含可编辑源文件、工程、测试、通用资源及许可；清单与SHA256见[source-manifest.json](source-manifest.json)。

| 平台 | 要求与步骤 |
| --- | --- |
| Mac | Node.js 24.15+；按[桌面构建说明](desktop-build.md)准备依赖、构建并运行Electron |
| iPad / iPhone | macOS与Xcode；按[iOS说明](ios-build.md)构建，真机安装使用自己的Apple签名 |
| Obsidian | 按[伴侣说明](obsidian-build.md)安装插件 |
| 只用某项功能 | 到[模块库](https://github.com/kevinzzzzzzzz999/inkspace-modules)选择带示例、依赖和测试的独立源码包 |

这是开发中的源码发行。完整公众安装包、公证和全部可选运行组件仍有各自准备要求。

## 状态与已知边界

完整软件首次快照为2026-10-24：Mac第105轮、原生第106.3轮基础、Obsidian 0.6.0。模块库已单独复查并修正下载/类型/遗漏问题，最新结果见其[独立使用验证](https://github.com/kevinzzzzzzzz999/inkspace-modules/blob/main/VALIDATION.md)。

iPad约两万笔的大范围套索仍有已知稳定性问题。iCloud、真实Apple Pencil及全部设备流程不能由编译或组件测试替代；完整源快照的实际检查见[validation.md](validation.md)。可选AI、OCR、Python、TeX和媒体引擎需满足各自条件。

## 参与改进 / Contribute

欢迎用Issue反馈可复现问题、文档建议或明确的模块需求。请附平台、源码/下载版本、操作步骤和合成样例，避免提交私人笔记、课件、账号或密钥。模块提取的逐项范围公开在功能审计中，便于选择能直接复用的部分。

## 隐私与许可证

发布内容只含审查过的软件源码与通用资源，不附带个人笔记、课件、账号、凭据、设备记录或签名。后续完成版本会经隐私与相关构建检查后更新源码与模块。

项目原创代码使用[MIT License](LICENSE)，允许使用、修改、分发及商业使用，保留许可和版权声明即可；第三方组件保持[原有许可](THIRD_PARTY_NOTICES.md)。

## 对外名称与兼容

英文产品名称现统一为 **life'winner**。旧仓库地址、工程与库的技术名称、文档格式、协议和存储标记保留兼容；不会因为改名迁移或读取任何用户资料。历史源码包保留，不改写旧发行。
