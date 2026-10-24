# Public source validation — 2026-10-24

These checks apply to the exported source tree, not to every end-user workflow.

| Component | Result |
| --- | --- |
| Desktop TypeScript check | Passed |
| Desktop production build | Passed; PDF.js resources generated from the pinned dependency |
| Existing desktop regression suite | 405 tests: 404 passed, 1 native helper test skipped, 0 failed |
| iOS project generation and consistency check | Passed |
| iOS arm64 simulator build | Passed with Xcode 27.1, code signing disabled |
| Obsidian JavaScript syntax and manifest checks | Passed |
| Existing Obsidian companion regression suite | 35 passed, 0 failed |

Desktop validation reused the existing locked dependency installation. A fresh dependency download on a new computer, full public installer generation, notarization, Windows and Intel Mac operation were not verified in this preparation.

No real iPad, iPhone or Obsidian vault was modified for this export. The known iPad large-lasso crash and unfinished cross-device acceptance remain open. Compilation and component tests do not establish device stability.

The publication tree excludes local notes, account state, device logs and personal signing materials. Publication checks and a separate source review are required again for future updates.


## 2026-10-24 · life'winner 显示名称修订

本修订只更新公开源码中的产品展示名、英文介绍、窗口标题及未来导出的纯显示信息。19项现有解析/几何回归、两份Obsidian各35项回归、相关脚本/TSX/JSON/plist语法与761文件隐私检查通过。保留数据归属、文档格式、ID、路径、协议与现有接口；不代表此前真机稳定性边界已经消失。
