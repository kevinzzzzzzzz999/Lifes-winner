# iPad / iPhone 源码构建

这是 InkSpace（人生赢家）的开发版主应用源码，支持 iOS / iPadOS 18.0 及以上。需要 macOS、Xcode 和 Python 3；本次构建使用 Xcode 27.1。仓库不包含开发者签名证书、描述文件或已签名安装包。

## 在模拟器构建

```sh
cd ios
python3 generate_project.py
python3 generate_project.py --check
xcodebuild -project InkSpace.xcodeproj -scheme InkSpace \
  -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/inkspace-build \
  ARCHS=arm64 CODE_SIGNING_ALLOWED=NO build
```

上面使用 Apple Silicon 的 arm64；Intel Mac 可删去 `ARCHS=arm64`。也可以直接打开 `ios/InkSpace.xcodeproj`，选择 InkSpace 和模拟器后运行。

项目生成器只使用 Python 标准库，根据 `InkSpace/` 中的 Swift 文件生成工程、共享 Scheme 和 Info.plist。新增 Swift 文件后重新生成；`--check` 检查结果是否一致。已保留 iPad 多窗口设置。

## 在自己的 iPad 或 iPhone 安装

1. 先运行项目生成器，再用 Xcode 打开工程。
2. 选择 InkSpace target 的 Signing & Capabilities，选择你自己的 Team，并设置自己的唯一 Bundle Identifier。
3. 连接设备，在 Xcode 选择设备并运行。开发签名和设备信任按 Xcode 的提示完成。

默认 Bundle Identifier 是 `org.inkspace.app`，Team 留空。重新生成工程会覆盖工程签名设置，请先生成、再选择 Team。后台刷新任务标识固定为 `org.inkspace.app.board-refresh`，在 Info.plist 和 `BoardBackgroundRefreshController.swift` 中配对；如果调整此标识，要同时更新两处及生成器。

AI 与翻译服务需要使用者自己的账号或 API 密钥，源码没有附带凭据。使用第三方服务时，其费用和使用条件由服务提供方决定。

## 当前范围与已知问题

- 本目录来自 2026-10-24 的主应用源码快照；它是开发版本，不代表全部设备流程已验收。
- iPad 约两万笔的大范围套索、移动、缩放及后续保存曾出现系统手写分析内存异常，稳定性修复仍在进行。请先用独立测试资料评估，保留资料备份。
- 本目录的 Xcode 工程仅构建主应用。较早快照的分享扩展源码位于 `ios/OptionalShareExtension/`，附手动集成说明；尚未合入主工程或验证为当前私有安装包中的同一扩展，不能用既有已签名扩展二进制补齐开源构建。
- 编译通过只能证明工程可构建；不代表真实 Apple Pencil、大范围撤销、iCloud 传播或所有多窗口流程均已验证。
- KaTeX、Marked 与 SheetJS 的代码及字体保持原有第三方许可；相应许可文件保留在 `InkSpace/Resources/`。

## 本次验证

项目生成、`--check`、plist 检查和 Xcode 27.1 的无签名 arm64 模拟器编译均已通过。本次没有安装或操作真实设备。工程目前使用 Swift 5 模式，仍有已有的弃用和并发检查警告；编译结果不代表 Swift 6 模式兼容性。
