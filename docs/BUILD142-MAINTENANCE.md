# build142 源码与维护交接

此目录是已发布 Mac / Windows `0.8.5 build142` 的开发源码起点。
Mac 主进程、preload、原生桥接和共享文件与发布包逐字节核对；完整
TypeScript / React 源码重建后的原有72份生产界面资源也逐 SHA-256 一致。
安装包内部夹带的部分旧 TS 文件不是维护基准。

## 在另一台电脑开始

安装包含 npm 的 Node.js 24.15 或更新版本，下载此仓库当前源码，或克隆：

```sh
git clone https://github.com/kevinzzzzzzzz999/Lifes-winner.git
cd Lifes-winner/desktop
npm ci
npm run typecheck
npm test
npm run build
npm run dev:safe
```

`dev:safe` 把配置、浏览器会话、日志、备份和测试资料夹放在项目自己的
`.development/runs/`，每次启动独立实例；不自动接入已安装软件的配置或
iCloud 笔记。测试启动器也关闭了邮件助手与系统通知，以避免影响已安装版。
按“打开文件夹”会选择该测试实例的空白资料夹。先用测试文件重现问题。
`npm start` 仍是普通 Electron 启动入口，不应用它默认连接真实资料进行测试。

源码、测试和构建工具不要求把笔记库放入 Git。正常使用安装版时，仍在软件
中选择已完整下载的 iCloud 资料夹；iCloud 同步和程序源码维护是两个独立过程。

## 源码范围

- `desktop/src/main/`、`src/preload/`：Electron 后端、IPC、文件与工作区服务。
- `desktop/src/renderer/`、`src/shared/`、`public/`：完整 React / TS / 样式与通用资源。
- `desktop/src/native/`、`scripts/work-mail-helper/`：笔迹、OCR、录音、听写、
  PDF信息和邮件/通知的 Swift 源码。
- `desktop/runtime-src/notebook/`：应用自有 Notebook kernel 及锁定依赖、来源记录。
- `desktop/tests/`：回归测试、合成夹具和真实旧137索引模块的兼容性夹具。
- `desktop/scripts/release/`：可搬迁的运行组件准备、签名副本与平台打包流程。
- `desktop/release-baseline/`：发布包身份、源码摘要和生产界面重建校验依据。

旧源码归档仍保留为历史资料。请使用当前 `desktop/` 或 Releases 中明确命名的
`Lifes-Winner-0.8.5-build142-source.zip`；原二进制标签下 GitHub 自动生成的
`Source code (zip)` 仍对应当时旧提交，不能把它误认成此维护快照。
本次只同步桌面 build142，未把已有 `ios/` 目录冒充为后续本机 iPad/iPhone 版本。

## 构建与打包

`npm run build` 先从锁定 PDF.js 依赖准备 CMaps、字体、WASM 和许可证，再执行
Vite。原安装包遗漏了这些独立 PDF 静态资源，此处是构建准备补齐；原有72份
界面生产文件保持可验证的相同内容。打包工具、测试移植修复及上述资源补齐
不会被描述成原安装包二进制完全可重复。

```sh
npm run prepare:runtime -- mac
npm run pack:mac
# 或在 Windows / 支持的交叉构建环境中：
npm run pack:win
```

首次准备需要联网下载已发布基准包和官方运行组件，脚本核对锁定摘要。
Mac基准包包含完整运行组件，可在不接触任何已安装应用或资料库的情况下取用；
自有源码随当前仓库提供。Windows组件采用官方 Electron、Python 和 Tectonic。
具体参数与目标平台限制见 `desktop/scripts/release/README.md`。
Mac原生助手重编译需要完整 Xcode。Apple签名、公证、Windows签名证书均不包含
在源码中；没有证书时只制作本地签名或未签名预览包。

发布过的安装文件摘要记录在基准清单中。重新编译、重签或重新压缩后的文件
摘要会变化；正确验证方法是核对源码/资源清单，再验证新包自身的完整性。

## 修 bug 与同步更新

1. 记录软件版本、操作系统、复现步骤、预期与实际结果；先判断是本机权限/
   文件下载问题，还是软件逻辑问题。
2. 新建修复分支，用合成或经明确授权的最小副本复现；不要操作真实笔记原件。
3. 修改对应源文件，运行相关回归；发布前完成类型检查、测试与生产构建。
4. Windows专属问题需在Windows安装和运行验证。Mac包构建成功不等于Windows
   功能验收。把修复提交回同一仓库，避免两台电脑各留一份未同步的产品版本。
5. 从同一审核源码构建各平台新包，记录新版本和校验值，再更新GitHub Releases。
   各电脑保存并退出软件后安装新版，保留原笔记库与本机应用数据。

目前程序没有应用内自动更新。旧版遇到新数据格式时，不应直接降级写回。
浏览器登录、AI凭据、设备ID和本机工作空间也不应通过复制整个配置目录同步。

## 已验证与边界

基准核对确认 main153、preload3、原生桥接相关13、shared26 和 renderer72
份对应生产文件一致。回归测试中的少量潜在人名/课程提示词已在公开夹具中
泛化，旧137测试依赖已收为相对路径夹具；未改变安装包产品逻辑。
Swift-only测试在缺少Mac/Xcode时跳过，测试时区在子进程启动前固定以保持可移植。
具体检查结果见 `desktop/release-baseline/VALIDATION.md`。

Windows仍是未签名兼容预览：苹果原生笔迹、Vision OCR、听写/录音助手、Notebook
科学计算运行器和原生邮件助手不可用。视频导出需另配FFmpeg。包含末尾空格、
冒号等名称的既有资料树需要先在副本中评估；不要直接改名破坏附件引用。
