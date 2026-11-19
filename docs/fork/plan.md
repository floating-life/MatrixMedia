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
- **自动匹配四步（`contentLink.js`）**：①直链 1:1 → ②唯一标题 1:1 → ③同组同平台模糊匹配（单遍左到右先按完整闭合话题 `#xx[话题]#`/`#xx#` 边界剥离、再剥单 `#xx`，仅对话题外保护 `C#`/`F#` 等词内 `#`；先汇总发布目标全部标题别名与作品全部标题别名的明确集数/期数/序号并在评分前硬拒绝冲突；排除占位标题与 `core` 长度 `<4`；长度≥6 子串截断 0.95 否则 `Float64Array` 无损编码二元组 Dice；target 仅取自身 `recordDate`/`lastPublishAt`，时间窗按 UTC+8 日历日相差 ≤2 天、缺时间门槛 +0.1；sim≥0.6、最佳比次佳高 ≥0.1、互为最佳，`matchedBy="fuzzy"` 附两位小数 `score`；按时间窗分桶+高频补集倒排提速）→ ④无发布记录作品同组跨平台聚类（同规则互为最佳成边 + Kruskal 合簇前全对相容检查禁止链式传递，每平台每簇最多 1 条，簇大小 ≥2 按不含组名的 `platform|workId` 生成确定性 `auto:<hash>`，标题取最早发布作品、素材为空）。
- **手工矫正与作品身份裁决（`store.js` + `contentLink.js` + `dataStats/index.js`）**：`<userData>/data-stats/link-overrides.json` 按**作品身份 `platform|workId`** 存储覆盖（同一账号挂多分组视为同一作品；严格校验 `version===1`、`updatedAt` 有限数字与条目结构，异常 `console.warn` 并视为空；持久化合成内容 `contents` 表 `{ "<key>": { title, createdAt } }`；原子写）。归属裁决在全量分组上按作品身份执行一次（仅 `detach` 在 ③④ 前按作品身份排除；`assign` 不改变其他作品的自动归属——`auto:` 簇成员资格在阶段 ④ 确定，某成员被 `assign` 走后，剩余成员无论 ≥2 还是仅剩 1 条均保留原 `auto:` 键与 `fuzzy` 标记，仅剩 1 条时汇总显示为单平台），日明细、跨平台汇总、GUI 共用该裁决结果后再按导出分组裁剪。`file:` 仅由完整路径生成；`record:` 仅由不可变唯一记录 `id` 生成 `record:id:<id>`（不含发布日期），缺少不可变身份或 `id` 碰撞的记录退化为位置键并标 `canAssignTarget=false`（禁止手工引用）；仅存在于 `works-daily` 的作品纳入手工覆盖范围。IPC：`stats:get-link-overrides`、`stats:set-link-override`、`stats:merge-works`、`stats:clear-link-override` 与批量原子 `stats:apply-link-overrides`（本地页面校验 + 串行队列内复用 `store.readWorksDailyLatestAsOf` 截至日读取不全量加载历史 + 批量 `ops` 在内存状态上按顺序逐条应用并校验 + 写前按全量重算校验最终归属一致后才一次原子写盘）。
- **界面与导出一致**：`dataStats/index.vue`「作品汇总」tab 增加匹配方式列、顶部筛选（全部/仅模糊待确认/未关联）、确认/拆出/改合并/恢复自动与未关联多选合并（整行确认与合并走 `stats:apply-link-overrides`，汇总确认、展开明细单条确认、待确认筛选与合并目标弹窗共用 `canAssignTarget`，弹窗重开清空当前行）；导出日期区间默认不预设本地当天（未手动调整时不传 `from`/`to`，直接使用与 GUI 共享的后端默认截止日；手动调整后才传）；导出在全量分组上单次匹配复用后再按分组裁剪；Excel「作品日明细」扩展 `matchedBy` 为 `link/title/fuzzy/manual` 并新增数值列「匹配分数」，「作品跨平台汇总」新增「匹配方式」列（有手动标 `manual`，否则簇内最弱 `fuzzy>title>link`），「字段说明」同步口径与 UTC+8 日历日窗说明。

## 打包
`.github/workflows/fork-build-win.yml`：推 fork/** 或 feat/stats-** 分支自动打 Windows 安装包（Actions Artifacts，14 天）。

## 已知问题
- 〔上游，路线 B 候选 PR〕`src/main/services/accountMigration.js:41` 启动迁移会把带连字符的合法分组目录（如 `品牌-A`，且 `品牌` 目录不存在时）整体改名为 `品牌`，导致该分组统计历史读回为空。应改为按账号记录中明确的旧 phone→group 映射迁移。（GPT Pro 评审 S1 时发现，2026-11-19）
- 适配器把缺失指标写成 0（如抖音 view_count 缺失），会产生「掉 0 再回升」的假增量；需改采集层区分缺失与 0，暂在导出「字段说明」注明。
- 一次采集的账号快照与作品快照若恰跨零点可能分属两天（影响极小，暂不处理）。
- `src/main/services/dataStats/index.js` 中各 `stats:*` IPC（含导出、作品汇总与 `link-overrides` 读写接口）沿用 `isLocalFrameEvent` 校验（放行无 host 的 `file:` 与 `localhost`/`127.0.0.1`），授权范围偏宽（生产模式未收紧到受信任应用主窗口 mainFrame 及应用页面路径，开发模式未收紧到配置的开发 server origin）；待后续统一收紧全量 stats IPC 鉴权时一并处理。（Codex 评审 S6 时发现，2026-11-19）
