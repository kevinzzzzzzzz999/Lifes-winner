# 从 build142 源码继续开发与打包

这些脚本以当前 checkout 为根，不依赖原作者目录或临时开发目录。除了标准前端构建生成的文件，打包输出位于 `desktop/.release-work/`、`desktop/release/`；显式使用 `--development` 时还会准备未跟踪的 `desktop/runtime/` 和 `desktop/build/WorkMailHelper.app`。不会安装应用、启动录音、访问资料库、上传 GitHub，或改动 `/Applications` 中的应用。

## 日常源码开发

安装 Node.js 24.15 或更新版，在 `desktop` 目录执行：

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run dev:safe
```

`npm ci` 严格使用提交的锁文件；`build` 会先准备 PDF.js 的字体/CMap/WASM/许可证。`npm run dev:safe` 使用项目提供的隔离启动入口，不需要安装已发布应用。第一次验收请选空白资料夹。普通 `npm start` 仍使用常规配置，可能与已安装版本共享应用资料；不要用它对正式笔记做开发验收。准备运行组件不会自行隔离配置。

只有源码与 npm 依赖时，可以开发共享界面和普通文件功能；Python、TeX、Notebook及苹果原生助手需要额外准备。Apple Silicon Mac 的完整开发资源：

```sh
npm run prepare:runtime -- mac --development
npm run dev:safe
```

该命令下载并校验已发布的 Mac142 ZIP，提取运行环境及原生助手。开发 runtime 链接指向本 checkout 的 `.release-work/development-resources`；已存在的其他 runtime 不会被覆盖。修改 `runtime-src/notebook/kernel.py` 后重新运行此准备命令，即可让开发环境使用新 kernel。

## Mac：保留完整运行环境，重建应用代码

在 Apple Silicon Mac 上运行，需要 macOS 命令行开发工具；重编 Swift 助手还需要满足其 SDK 要求的完整 Xcode。完整功能的系统要求取决于助手：主应用/手写/录音从 macOS13 起，Notebook/邮件从 macOS14 起，苹果本地听写从 macOS26 起；不因此承诺每项均在这些系统实机通过。

```sh
npm run pack:mac
npm run verify:artifacts -- mac
```

流程会构建当前 renderer，将当前主进程/preload/vendor/native源和 npm 生产依赖组成新的 `app.asar`，复制校验过的已发布 Mac 包作为候选，替换 ASAR，并更新 Electron 的 ASAR 完整性字段。已有 frameworks、Python、Notebook依赖、TeX缓存和助手默认沿用基线。作者自有 `runtime-src/notebook/kernel.py`、`requirements*.lock`、`PROVENANCE.json`、`FILES.json` 会覆盖对应候选资源。

最后仅重签候选最外层应用，严格验证嵌套签名并生成 `release/Lifes-Winner-0.8.5-mac-arm64-rebuilt.zip`。默认为 ad hoc 签名，不公证；设置 `INKSPACE_MAC_SIGN_IDENTITY` 可以选择已配置的签名身份，但这不自动完成 Developer ID、hardened runtime 或公证。源版本号保持由 `package.json`/项目元数据管理，脚本不自行提升版本。

### 重编全部作者自有 Swift 助手

```sh
npm run build:native
npm run pack:mac
npm run verify:artifacts -- mac
```

可用 `npm run build:native -- --only ocr,pdf-info` 只重编指定助手。可选名称为 `ink,ocr,pdf-info,dictation,recorder,mail`。编译器统一由 `xcrun --sdk macosx swiftc` 选择，模块缓存和输出都位于 `.release-work`；无需执行源码中保留的历史构建脚本。

| 名称 | 当前源码 | 输出位置（候选 Resources 下） |
|---|---|---|
| ink | `src/native/NativeInkCore.swift`、`InkSpaceInkHelper.swift` | `runtime/native-ink/darwin-arm64/InkSpaceInkHelper.app` |
| ocr | `src/native/ocr/LocalOCR.swift`、`LocalOCRCLI.swift` | `runtime/nativeOCR/darwin-arm64/InkSpaceOCR` |
| pdf-info | `src/native/RelinkPDFInfo.swift` | `runtime/relink-pdf-info/inkspace-relink-pdf-info` |
| dictation | `src/native/dictation/DictationTranscript.swift`、`InkSpaceDictation.swift` | `runtime/dictation/darwin-arm64/InkSpaceDictation.app` |
| recorder | `src/native/recording/RecognitionRecorder.swift` | `runtime/recognition-recorder/darwin-arm64/RecognitionRecorder.app` |
| mail | `scripts/work-mail-helper/` 三份 Swift | `helpers/WorkMailHelper.app` |

`.app` 助手使用已校验基线作为资源/Info.plist模板，重新编译当前 Swift，保留必要录音权限并重签。这个步骤不请求麦克风权限、不启动助手。下次 Mac 打包自动覆盖已重编助手；如果相关源码在编译后变化，会拒绝使用过期输出，要求重新编译。删除 `.release-work/native-overrides` 可明确恢复使用基线助手。

这形成三个可重建层次：共享应用代码完整重建；六组作者自有 Swift 代码可重建；第三方 Python/IPython/NumPy/Pandas/TeX 依赖及签名资源默认复用固定发行基线。它不是从第三方引擎源代码重编所有二进制的工具链，也不声称产生与旧包字节相同的 ZIP。

## Windows x64：独立安装程序

可在 Windows x64 或 Mac 上交叉打包：

```sh
npm run pack:win
npm run verify:artifacts -- win
```

脚本固定并校验 Electron44.3.0、Python3.14.7、Tectonic0.17.0 和 electron-builder 官方 NSIS3.12 工具。源码与界面从当前 checkout 重建；许可证及经过逐文件检查的基础 TeX 缓存取自固定 Mac 发行包，不包含 Mac 可执行助手。结果为 `release/Lifes-Winner-0.8.5-Windows-x64-Setup.exe`。

Windows 包保持兼容预览状态：原生笔迹/Apple Vision OCR、Notebook科学计算、苹果听写/录音助手、原生邮件助手、旧 `.doc` 转换和 macOS 应用选择器不可用；FFmpeg 导出需 Windows 适配。没有 Windows 真机执行就不能把结构检查称为功能验收。安装程序显示 `WINDOWS-NOTES.txt` 的限制，且卸载时保留应用数据。默认不做 Windows 代码签名。

开发时可以先用 `npm run prepare:runtime -- win --development` 准备基础 Python/TeX，然后 `npm run dev:safe`。这不会解除源码中的 Mac 平台限制。

## 离线复用与可检验证据

`common.mjs` 固定公开基线 URL、文件长度和 SHA-256。已发布基线为 `v0.8.5-build142-desktop-preview/Lifes-Winner-0.8.5-build142-mac-arm64.zip`，摘要 `8e5f5e6ee03da72556e8fc78dfb6364b16e530b35acf3973ee3f36e93f7d620d`。第三方下载匹配官方 HTTPS 发行摘要；脚本不声称独立验证了 detached signature 信任链。

所有准备/打包命令可增加：

```sh
--baseline-file /path/to/Lifes-Winner-0.8.5-build142-mac-arm64.zip
--downloads-dir /path/to/pinned-archives
--offline
```

Windows下载目录需要上述固定名称的 Electron/Python/Tectonic ZIP、`nsis-bundle-3.12.tar.gz`，以及当前构建主机对应的 `7zip-darwin-arm64.tar.gz`、`7zip-darwin-x86_64.tar.gz` 或 `7zip-win-x64.tar.gz`。没有缓存会明确报错，不会在 `--offline` 下联网。`--skip-build` 仅供已刚完成生产构建的验收使用；正常打包应保留默认构建步骤。

`npm run licenses` 收集锁定且已安装 npm 包的许可证，连同已有 runtime/vendor 许可证一起进入候选。`verify:artifacts` 对照输入清单逐文件比对 ASAR，检查 Mac 签名/ASAR元数据，或检查 Windows x64 可执行文件、安装容器和286份TeX缓存。输出摘要、`verification-mac.json`/`verification-win.json` 明确把结构验证与运行/功能验收分开。

每次修改代码、helper或依赖后，重新构建和打包；在空白资料库验收保存、重启与跨设备同步，再让新包访问正式笔记。GitHub发布和用户设备安装不属于这些本地构建脚本。
