# 可选 Safari 分享扩展源码

这个目录保存来自较早开发快照的分享扩展源码，供后续集成。它尚未加入主应用的 Xcode 工程，不属于已经编译通过的主应用 target，也未确认与当前私有安装包中已签名扩展逐字节一致。

扩展由 Safari 分享菜单触发，只提取网页标题、来源 URL 和用户选中文字，导出 `Web Clip.inkclip.json`。用户在系统文件选择器中保存，再到主应用的内置浏览器中选择「导入 Safari 剪藏文件」。它不需要 App Group 或共享容器。

## 文件

- `ShareClipViewController.swift`：分享界面、输入校验和文件导出。
- `ClipPreprocessor.js`：Safari 网页预处理，仅返回标题、URL 和选中文字。
- `Info.plist`：Share Extension 激活规则与入口类。

这些文件不含签名、描述文件或设备数据。当前主应用源码仍识别 `format: inkspace.webclip`、`version: 1`，与这个扩展输出的格式相同；这是代码层面的格式对应，不能代替实际 Safari 分享验收。

## 手动加入 Xcode 工程

1. 先生成主应用工程，在 Xcode 添加一个 iOS Share Extension target，并使用自己的 Team 和 Bundle Identifier，例如 `org.inkspace.app.shareclipper`。
2. 删除模板的控制器和 storyboard，把这里的 Swift 文件加入扩展 target，把 `ClipPreprocessor.js` 加入扩展的 Copy Bundle Resources。
3. 使用这里的 Info.plist，关闭扩展 target 的自动生成 Info.plist，确认 Principal Class 为 `$(PRODUCT_MODULE_NAME).ShareClipViewController`。
4. 把扩展嵌入主应用的 Embed App Extensions 阶段。为主应用和扩展使用匹配的版本号，部署目标设为 iOS 18.0 或以上。
5. 用独立测试内容检查 Safari 分享、保存、取消，以及主应用导入和重新打开。

当前 `generate_project.py` 只维护主应用工程，重新运行会移除手动加入的扩展 target。需要长期维护扩展时，应先把扩展 target 加入生成器，再保存工程变更。

## 验证范围

已检查 plist 格式、公开源码隐私和与主应用导入格式的静态对应。尚未构建这个独立扩展 target，未做 Safari 真机分享验收，也没有复制现成的 `.appex` 来补齐这些检查。
