# Fork 计划：作品数据日汇总 + Excel 导出（floating-life/MatrixMedia）

> 2026-11-19 Claude 规划。路线 A：先在 fork 自用，稳定后再拆 PR 给上游 hanliang97（路线 B）。
> 使用端：用户 Windows 笔记本 clemon；VPS 只跑单测，真实采集在笔记本验收。

## 目标
各平台每个作品**每天**的数据（播放/点赞/评论/分享/收藏/涨粉）汇总到一张表；同一视频跨平台合一行；每日自动采集；导出 .xlsx 给 AI 分析。

## 现状（v0.14.9）
- 7 平台采集已有（src/main/services/dataStats/），works 每次覆盖为最新累计值，**无作品日历史**
- 账号级 daily.json 有日快照；无定时采集；统计数据无导出
- 依赖已有 `xlsx`(SheetJS 0.18.5)，不新增依赖

## 卡片（一卡一分支一 PR，Neon 实现 → Grok 审 → Claude 验收）
| 卡 | 分支 | 内容 |
|---|---|---|
| S1 | feat/stats-works-daily | 作品日快照存储 works-daily.json + 长表行构建（含日增量）+ 单测 |
| S2 | feat/stats-cross-link | 跨平台作品关联（发布记录优先，标题归一化兜底）+ 汇总行 + 单测 |
| S3 | feat/stats-daily-schedule | 软件开着时每日定点（默认 10:00）串行采集全部已登录账号，可配置/关闭，写采集日志 |
| S4 | feat/stats-xlsx-export | 导出 .xlsx（作品日明细/作品跨平台汇总/平台日汇总/账号日快照/字段说明），GUI 按钮 + `cli stats-export`，「作品汇总」tab |
| S6 | feat/stats-fuzzy-link | 跨平台作品模糊匹配自动合并（作品↔target + 无发布记录跨平台聚类）+ 手工矫正持久化（link-overrides.json）+ 界面矫正交互 + 导出新列 |

## S6：跨平台作品模糊匹配 + 手工矫正（`feat/stats-fuzzy-link`）
- **背景**：各平台发布标题常被截断、改写、插中间话题，或作品直接在平台发布而无 MatrixMedia 发布记录，仅靠直链/唯一标题会漏合。
- **自动匹配四步（`contentLink.js`）**：①直链 1:1 → ②唯一标题 1:1 → ③同组同平台模糊匹配（去话题/emoji/标点空白得 core，长度≥6 子串截断 0.95 否则二元组 Dice；时间窗 ≤2 天、缺时间门槛 +0.1；sim≥0.6、最佳比次佳高 ≥0.1、互为最佳，`matchedBy="fuzzy"` 附两位小数 `score`）→ ④无发布记录作品同组跨平台聚类（同规则互为最佳成边 + Kruskal 合并，每平台每簇最多 1 条，簇大小 ≥2 生成确定性 `auto:<hash>`，标题取最早发布作品、素材为空）。
- **手工矫正（`store.js` + `dataStats/index.js`）**：`<userData>/data-stats/link-overrides.json`（原子写，读失败/损坏视为空并 warn）；应用顺序为 ①–④ 后套用（`detach` 在 ③④ 前先排除，不再被模糊重合；`assign` 指向不存在 `contentKey` 时忽略并保持自动结果）；支持合并未关联作品为 `manual:<id>`。IPC：`stats:get-link-overrides`、`stats:set-link-override`、`stats:merge-works`、`stats:clear-link-override`（本地页面校验 + 串行写入队列）。
- **界面与导出一致**：`dataStats/index.vue`「作品汇总」tab 增加匹配方式列、顶部筛选（全部/仅模糊待确认/未关联）、确认/拆出/改合并/恢复自动与未关联多选合并；Excel「作品日明细」扩展 `matchedBy` 为 `link/title/fuzzy/manual` 并新增数值列「匹配分数」，「作品跨平台汇总」新增「匹配方式」列（有手动标 `manual`，否则簇内最弱 `fuzzy>title>link`），「字段说明」同步口径。

## 打包
`.github/workflows/fork-build-win.yml`：推 fork/** 或 feat/stats-** 分支自动打 Windows 安装包（Actions Artifacts，14 天）。

## 已知问题
- 〔上游，路线 B 候选 PR〕`src/main/services/accountMigration.js:41` 启动迁移会把带连字符的合法分组目录（如 `品牌-A`，且 `品牌` 目录不存在时）整体改名为 `品牌`，导致该分组统计历史读回为空。应改为按账号记录中明确的旧 phone→group 映射迁移。（GPT Pro 评审 S1 时发现，2026-11-19）
- 适配器把缺失指标写成 0（如抖音 view_count 缺失），会产生「掉 0 再回升」的假增量；需改采集层区分缺失与 0，暂在导出「字段说明」注明。
- 一次采集的账号快照与作品快照若恰跨零点可能分属两天（影响极小，暂不处理）。
