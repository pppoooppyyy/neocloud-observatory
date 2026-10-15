# Neocloud 每日公开采集

GitHub Actions 每天 UTC 02:00（台北 10:00）运行，也可在 Actions 页手动运行；GitHub 定时任务可能延迟启动。主分支修改 `collector/**`、`scripts/**` 或本工作流会触发一次检查。单次最多 10 分钟，统一并发组排队，避免两次采集同时写入。

## 配置

1. Portal 部署 `GET /api/neocloud/public-snapshot` 和专用 `POST /api/neocloud/collector-update` 接口。
2. 在仓库 Settings → Secrets and variables → Actions 添加 `NEOCLOUD_SYNC_TOKEN`，值与 Portal 该接口的专用密钥一致。只授权此观察台增量写入，不放入通用 Cloudflare 凭据或 GitHub 写入令牌。
3. 配置密钥后再推送工作流，或在 Actions 中运行 **Neocloud daily collection**。成功或部分成功会在步骤摘要显示来源状态、日期和保存的 revision；完全失败则任务失败。

采集 job 的 `GITHUB_TOKEN` 仅 `contents: read`，checkout 不保存凭据。不需要安装 npm 包。手工运行需要 Node.js 22，并通过环境变量提供专用密钥：

```sh
node --experimental-strip-types --test collector/sync.test.mjs
node --experimental-strip-types scripts/collect-daily.mjs
```

密钥只发送至固定的 Portal `collector-update` 地址，不发送给公开来源，不写文件或日志。脚本不提交、推送或改动 GitHub Pages 文件。

## 数据与并发

脚本先读取两站共用的公开快照，再运行 GPU 指数、GPU/TPU 官方报价、财政部基准与信用公告、融资公开披露四组采集。库文件从 Portal `apps/pm-research-hub/lib/neocloud/` 复制，来源、单位、日期校验和失败保留规则一致；后续修改需同步这些已审核模块。

提交格式为 `{expectedRevision, patch, results, startedAt}`。HTTP 409 时重新读取当前公开快照，以 `concurrentPatch(原始基线, 当前快照, 原始增量)` 保留期间人工修订，最多重试三次，不重新采集或覆盖较新记录。只重试明确的 409；其他失败交由下一次运行检查，避免网络结果不明时重复提交。

当日成功的目录读取才新增该日 GPU/TPU 观察；同日 id 稳定，历史保留。指数、财政部记录和公告保留真实来源日期，缺失不填零或延续旧值。每日融资披露与固定周榜分列。逐券行情未接入授权来源；已导入的 FUNDA CDS 历史独立保存在共享快照中，本采集任务不修改 CDS 数据。旧版 2026-10-01 截图收在信用页的折叠参考区。

Portal 保存成功后，Portal 与 GitHub Pages 可见页面每 30 秒读取公开快照。无需为每日数据重建或推送静态网页。此工作流提供日常采集执行环境；Portal 仍负责权限、校验、合并及 R2 历史快照保存。

## 自动保活

独立 `maintain-schedule` job 每日检查，每 20 天通过 GitHub API 更新 `.github/schedule-heartbeat.json`，产生真实仓库活动，避免公开仓库连续 60 天无活动导致定时任务停用。该步骤不依赖采集成功，也不获取 Portal 密钥。仅保活 job 使用临时 `GITHUB_TOKEN` 的 `contents: write` 权限；脚本固定仓库、主分支与文件路径，并带当前文件 SHA 校验，不覆盖其他文件、不强制推送。此令牌的提交不触发新工作流。保活记录只表示维护时间，不代表采集成功；暂时失败由次日再次尝试。平台长期故障、账号限制或人工停用仍可能中断运行。

保活测试：`node --test collector/maintenance.test.mjs`。线上运行摘要显示本次是否更新、上次维护时间和下一次到期时间。
