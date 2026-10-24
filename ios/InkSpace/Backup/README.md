# 本机备份组件（0.5.0）

`BoardBackupController` 在主线程管理当前白板状态与请求顺序，`LocalBoardBackupStore` 在独立 actor 处理文件。保留目录是应用的 `Application Support/InkSpace/LocalBackups`，明确排除系统 iCloud 设备备份；它不在用户的 iCloud 仓库里。删除应用会删除这些本机历史，导出的 ZIP 可以另存。

## 保存集成

1. 先从画布冻结完整 `BoardDocument`（必须包含最新 `PKDrawing` 数据）。
2. `let generation = await controller.captureEditableCheckpoint(document: snapshot, vaultURL: root)`：先保存轻量可编辑状态，不读取或下载大附件。这类版本准确标为资料未核对。
3. 正常保存白板及原 PDF，不因备份错误改变正常保存结果。
4. `await controller.capture(document: savedSnapshot, vaultURL: root, reason: .checkpoint, generation: generation)`：补齐关联资料。同一冻结保存必须沿用第 2 步的序号，旧完整任务不能覆盖较新检查点。
5. 使用结束或主动备份：分别使用 `.session`、`.manual`，不传 generation。会话版本只有内容或资料摘要变化时才新增。
6. 新建／切换白板后调用 `await controller.activate(document:vaultURL:)`。视图异步更新会再次检查当前白板，旧任务不能切回旧状态。

默认每白板开启。开关保存在本机，关闭不删除历史。默认保留最近 10 个有变化的会话／手动版本，另外保护最新检查点和最近完整版本；容量默认共 2 GiB，设置可调到 1–16 GiB。单附件不超过 256 MiB，白板 JSON 不超过 256 MiB，附件不超过 10,000 个。达到预算会拒绝本次提交，保留已有完整版本。由于 ZIP 使用无压缩 STORE，大附件的导出包需要相应临时空间。

普通检查点可复用已核对、元数据未变的不可变 SHA-256 blob；会话结束／手动备份重新协调读取并计算摘要。读取前后检查文件标识、大小和修改时间；取消能中止正在等待的文件协调，并在流式复制块之间检查。导出、导入和恢复再次验证摘要。

关联资料包括 `sourcePath`、`originalSourcePath`、历史所属 PDF 路径，以及 Markdown 的本地行内、引用式和 wiki 图片。Markdown 与阅读器采用相同的库内路径规则，不访问远程图片、不跟随符号链接。引用到尚未下载或丢失的文件会列为未齐，而不是称为完整备份。普通笔记链接指向的整篇笔记不递归打包。

## 导出、导入与恢复

`BackupArchive.write(entries:to:maximumBytes:)` 是可复用的无依赖标准 ZIP 写入器，逐块复制、计算 CRC，支持取消。对应导入器只接受本应用导出的 UTF-8、STORE、无加密／ZIP64 ZIP，核验中央与本地记录、CRC、路径、文件数量和总大小。临时展开目录只有全部核验通过后才发布。

`BoardBackupSettingsView(controller:document:vaultURL:onRestore:)` 提供历史、开关、容量设置、立即备份、导出 ZIP、导入 ZIP、选择课程文件夹恢复。完整备份可在原仓库不可用时恢复。可编辑状态但缺资料的版本需要显式选择“仅恢复笔迹”，恢复副本暂停 PDF 写回。

每次恢复均新建 `所选目录/人生赢家恢复-UUID/`，源资料置于 `Sources/`，白板与 Obsidian Markdown 入口放在该目录。原白板 ID 换为新 ID，原生可编辑笔迹、节点、连线、定位点、打印框和视口保留。源文件链接映射到恢复目录，Markdown 库根 wiki／绝对图片链接同步改为副本路径。

复制 PDF 时用现有严格增量写入器移除旧白板所属的注释，保留其他注释与原对象字节；不会经 PDFKit 重存整个文件。含旧所属笔迹但结构无法安全处理时，整个恢复拒绝发布，原件和备份不变。副本以新白板 ID 写回自己的 PDF，不与原白板争写。没有所属笔迹的 PDF 按原字节复制。

## 验证

运行 `scripts/check-local-backups.sh`。这是实际 Mac Catalyst 生产组件回归，所有文件由测试在临时目录现场合成，不使用真实仓库或设备。覆盖 20 项：离线 ZIP 恢复、可编辑笔迹、PDF 所属批注剥除与外来批注保留、源字节不变、缺资料、开关、变更与去重、会话保留、世代顺序、真实复制中取消、限额失败回滚、符号链接、CRC／SHA 损坏与伪造完整包拒绝。设置页和系统文件选择／分享交互还需要整应用构建及 iPad 验收；组件通过不等于这些 UI 已验收。
