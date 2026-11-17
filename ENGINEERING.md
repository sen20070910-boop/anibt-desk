# 工程维护与构建

## 单一版本源

只修改 `package.json` 的版本与最低 Node 要求，再运行 `node scripts/sync-version.mjs`。界面、命令行、更新信息共用生成的 `src/version.js`；锁文件和说明的当前版本随之同步。打包前执行一致性检查。

## 干净构建（Windows x64）

需要 Windows PowerShell、系统 .NET Framework 4.x 编译器，以及运行界面所需的 WebView2 Runtime。源码的 `toolchain.lock.json` 固定 Node 24.22.1、WebView2 SDK 1.0.4314.35 的下载地址、压缩包及关键文件 SHA-256。

1. `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap-toolchain.ps1`
2. 使用 `.tools/node/24.22.1/node-v24.22.1-win-x64/node.exe` 执行同目录下 `node_modules/npm/bin/npm-cli.js ci --ignore-scripts --no-audit --no-fund`。
3. 用上述 Node 执行 `scripts/sync-version.mjs --check`、`--test test/*.test.js`、`scripts/build.mjs`。
4. `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-native.ps1 -SkipRegistration`
5. 用上述 Node 执行 `scripts/package-release.mjs`，然后 `scripts/verify-release.mjs`。

独立验证入口：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/clean-build-check.ps1`。它只复制公开源码清单，在全新目录执行 npm ci、测试、原生与 JS 构建、打包和解压运行；不复制私人配置、数据、node_modules、旧 dist 或研究文件。`-UseVerifiedCache` 可复用已下载的工具压缩包，仍会校验哈希。结果目录保留用于检查。

打包器不再复制执行脚本的任意 Node。它校验固定运行时的版本、平台、架构及哈希，并附带对应 LICENSE。解压校验使用包内 Node 启动 CLI 和未配置 GUI，核对版本、静态文件与后台关闭状态，不连接真实 RSS 或 qB。浏览器交互验证另行执行，不能由文件校验替代。

## 当前服务边界

`src/gui/` 按下载、订阅、进度、备份、设置拆分路由；`gui-server.js` 暂保留应用生命周期、鉴权、共享缓存和跨域协调。路由通过明确的上下文接口访问少量共享状态，模块依赖直接导入。前端 `settings.js`、`status.js` 负责设置与状态渲染，`app.js` 保留页面状态和事件编排。先保留行为，再逐步抽出领域服务；没有一次性重写全部业务。

已移除未被产品加载的 components/theme-system 及对应孤立测试。实际加载顺序由 HTML 定义；新资产必须同时加入服务静态白名单与打包清单。

## 持久化协议

`state-store.js` 集中保护关键下载账本写入，手动添加、单集未看下载及备份恢复的多文件修改先写入并同步落盘 redo 日志，再发布各文件。全部完成才移除日志。异常时保留日志并阻止新的领域写入；GUI 定期或手动恢复，后台在取得原有下载锁后恢复。下载成功后的提交检查点必须保留，不能为了减少写盘而随意延迟。

不可逆的 qB 文件删除继续使用独立的 `watched-operations.js` 协议：先记录确认范围，再请求删除，最后提交观看状态。恢复仅核对原 hash，不重复发送删除。普通 redo 不是 qB 和文件系统之间的原子事务，也不能撤销已发生的下载或删除。

辅助日志、心跳、缓存仍使用各自的限额与容错机制，本轮没有把所有元数据强行放进一个事务。

## 状态增长与备份范围

当前小规模 JSON 状态无需数据库。诊断提供状态大小、记录数和未完成事务数；到 10,000 条记录时提示评估历史归档。本轮不自动缩减主去重状态。

后续归档必须先持久化完整历史，再保留 ID/hash/可信 bgmId/集数/修订版本等紧凑索引；来源不明的旧键保守保留。进度、重新处理、完成通知和备份均须兼容归档查询后，才能移走活跃账本中的记录。每月清理仅重置显示与计数，绝不可删除防重依据。

可迁移 JSON 备份：偏好、观看资料及所选账本，不包含待执行队列和凭据。每日自动备份主要保护观看资料、评价、草稿和偏好。

本机加密快照：配置、完整 state（含 pending、基线、去重）、手动账本、观看资料、草稿、外观网络偏好和本地退订控制。仅当前 Windows 账户和安装目录可恢复，最多接受 16 MiB 原始状态。不包含浏览器登录资料、视频、qB 数据和未完成的不可逆操作日志。恢复暂停后台与 pending，需核对后重新启用。它不是可跨机的整盘备份。

## 发布保留策略

`cleanup-workspace.ps1` 默认预览，保留最新 3 个版本包、当前展开目录，以及用户指定的 v2.21 回退包。保留包须通过 ZIP 哈希和内部清单逐文件验证，才能删除其他版本。`-Execute` 才执行；只处理 release 内明确命名的历史产物，拒绝链接，不清 data、登录资料、源码、工具链或视频。可通过 KeepVersions 与 PinnedVersions 调整。
