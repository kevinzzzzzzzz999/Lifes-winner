# Mac 桌面版构建与运行

这是 0.8.5 的开发源码快照。Mac Apple Silicon 是目前主要开发平台；Windows 打包配置仍在代码中，但本次开源准备没有进行 Windows 安装验证。

## 本地运行

需要 Node.js 24.15 或更新版本及 npm。第一次安装依赖需要联网。

```sh
cd desktop
npm ci
npm run typecheck
npm test
npm run build
npm start
```

`npm run build` 会先从锁定的 `pdfjs-dist` 依赖复制 CMap、标准字体、WASM 和上游许可证，再生成本地界面。`npm start` 启动 Electron。开发时可在一个终端运行 `npm run dev`，在另一个终端运行 `INKSPACE_RENDERER_URL=http://127.0.0.1:5178 npm start`。

先选择一个新建的空资料文件夹体验。此应用读写用户主动授权的本地资料目录；项目不附带作者笔记、课程文档、账号配置或浏览器登录状态。

## 按需准备的运行组件

仓库包含这些功能的调用代码、构建来源和准备脚本；体积较大的运行组件不随源码提交。缺少组件时，应用应报告对应功能不可用。

- Python 基础运行环境：`node scripts/packaging/prepare-python.mjs`。脚本校验固定的公开发行归档摘要，不修改系统 Python。
- Mac Notebook 科学计算组件：用准备出的 `runtime/python/darwin-arm64/bin/python3 -I -B scripts/packaging/prepare-notebook.py` 安装锁定依赖，再运行 `runtime/python/darwin-arm64/bin/python3 -I -B scripts/packaging/collect-notebook-runtime.py`。锁文件包含 Excel 读取组件。
- Mac 原生笔迹：安装完整 Xcode 后执行 `python3 src/native/build-helper.py`。保留生成的完整 `.app` helper；详见 `src/native/README.md`。
- Mac OCR：源文件位于 `src/native/ocr/`，本次没有提供已签名的 OCR 可执行文件。
- LaTeX：保留 Tectonic 官方发行摘要及离线缓存清单，但仓库不附带 TeX 离线缓存或编译器二进制。现有 `prepare-latex.mjs` 要求先提供与清单一致的基础缓存；不应把它描述成干净检出即可一键准备。完整 LaTeX 安装包准备流程仍需补齐。
- 视频导出使用用户另行安装的 FFmpeg/ffprobe。该组件不随项目分发。

## 安装包状态

`electron-builder.cjs` 与 `scripts/packaging/` 保留了原有安装包制作代码。完整安装包仍要求各平台运行环境、许可证、TeX 缓存及所需原生 helper 全部准备完成。这次发布没有生成、签名或公证面向公众的安装包，也没有声称 Windows、Intel Mac 或全部原生扩展已通过运行验证。GitHub 上的源码可供下载、构建和改进。

## 本次准备验证

2026-10-24：桌面源码类型检查与生产构建通过；现有 Node 回归共 405 项，404 项通过、1 项因未构建原生 PencilKit helper 而跳过、0 项失败。检查复用了开发环境已有的锁定依赖，没有在全新电脑重新下载依赖；本次未进行完整安装包或真实设备功能验收。

构建工具报告配置加载方式和较大输出包的提示，未阻止生产构建。它们不等于运行崩溃。其他平台和运行组件的验收仍须单独完成。
