# Life's Winner / 人生赢家 — 桌面 build142

此目录提供当前发布安装包对应的完整 Electron、React/TypeScript、Swift 助手和 Notebook kernel 源码。详见 [维护交接](../docs/BUILD142-MAINTENANCE.md) 与 [可搬迁打包脚本](scripts/release/README.md)。

推荐：`npm ci` → `npm run typecheck` → `npm test` → `npm run build` → `npm run dev:safe`。最后一步在项目自己的独立配置与空资料夹中运行，避免连接已安装版和原笔记。

维护开发代码请使用此目录，不要从旧压缩源码或安装包内夹带的旧TS文件继续修改。发布包身份及逐文件验证在 `release-baseline/`。
