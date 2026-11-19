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
- **自动匹配四步（`contentLink.js` + `adapters.js`）**：视频号采集同时保留短标题（`title`）与描述标题（`altTitles` 数组，`store.js` 原样保存、旧数据缺省为空）；①直链 1:1 → ②唯一标题 1:1（与 ③④ 共用集数冲突硬拒绝）→ ③同组同平台模糊匹配（单遍左到右先识别完整 `#…[话题]#`〔允许内部 `C#`/`F#` 等〕、再处理通用 `#…#` 边界与单 `#…`，最后才保护话题外 `C#`/`F#`；汇总作品侧 `title+altTitles` 与目标侧全部别名的明确集数/期数/序号并在评分前硬拒绝冲突；排除占位标题与 `core` 长度 `<4`；长度≥6 子串截断 0.95 否则 `Float64Array` 无损编码二元组 Dice；target 仅取自身 `recordDate`/`lastPublishAt`，时间窗按 UTC+8 日历日相差 ≤2 天、缺时间门槛 +0.1；sim≥0.6、最佳比次佳高 ≥0.1、互为最佳，`matchedBy="fuzzy"` 附两位小数 `score`；按时间窗分桶+高频补集倒排提速）→ ④无发布记录作品同组跨平台聚类（同规则互为最佳成边 + Kruskal 合簇前全对相容检查禁止链式传递，每平台每簇最多 1 条，簇大小 ≥2 按不含组名的 `platform|workId` 生成确定性 `auto:<hash>`，标题取最早发布作品、素材为空）。
- **手工矫正与作品身份裁决（`store.js` + `contentLink.js` + `dataStats/index.js`）**：`<userData>/data-stats/link-overrides.json` 按**作品身份 `platform|workId`** 分开存储自动匹配排除状态 `excludedAuto`（由 `detach` 产生）与手工归属 `overrides`（同一账号挂多分组视为同一作品；严格校验 `version===1`、`updatedAt` 有限数字与 `contents`/`excludedAuto`/`overrides` 结构，异常 `console.warn` 并视为空；持久化合成内容 `contents` 表 `{ "<key>": { title, createdAt } }`；原子写）。作品可同时「排除自动」+「assign」，被排除作品在 ③④ 中始终不参与、再 `assign`/`merge` 不得改变其他作品自动结果，「恢复自动（clear）」同时清除两者；未排除作品的 `assign` 照常参与占位且不改变其他作品的自动归属（`auto:` 簇成员资格在阶段 ④ 确定，某成员被 `assign` 走后，剩余成员无论 ≥2 还是仅剩 1 条均保留原 `auto:` 键与 `fuzzy` 标记）。归属裁决在全量分组上按作品身份执行一次，日明细、跨平台汇总、GUI 共用该裁决结果后再按导出分组裁剪。`file:` 仅由完整路径生成；`record:` 仅由不可变唯一记录 `id` 生成 `record:id:<id>`（不含发布日期），缺少不可变身份或 `id` 碰撞的记录退化为位置键并标 `canAssignTarget=false`（禁止手工引用）；仅存在于 `works-daily` 的作品纳入手工覆盖范围。IPC：`stats:get-link-overrides`、`stats:set-link-override`、`stats:merge-works`、`stats:clear-link-override` 与批量原子 `stats:apply-link-overrides`（本地页面校验 + 串行队列内复用 `store.readWorksDailyLatestAsOf` 截至日读取不全量加载历史 + 批量 `ops` 在内存状态上按顺序逐条应用并校验 + 写前按全量重算校验最终归属一致后才一次原子写盘）。
- **界面与导出一致**：`dataStats/index.vue`「作品汇总」tab 增加匹配方式列、顶部筛选（全部/仅模糊待确认/未关联）、确认/拆出/改合并/恢复自动与未关联多选合并（整行确认与合并走 `stats:apply-link-overrides`，汇总确认、展开明细单条确认、待确认筛选与合并目标弹窗共用 `canAssignTarget`，弹窗重开清空当前行）；导出日期区间默认不预设本地当天（未手动调整时不传 `from`/`to`，直接使用与 GUI 共享的后端默认截止日，保存框建议文件名不带日期如 `MatrixMedia-作品数据.xlsx`；手动调整显式区间后才传并带日期）；导出在全量分组上单次匹配复用后再按分组裁剪；Excel「作品日明细」扩展 `matchedBy` 为 `link/title/fuzzy/manual` 并新增数值列「匹配分数」，「作品跨平台汇总」新增「匹配方式」列（有手动标 `manual`，否则簇内最弱 `fuzzy>title>link`），「字段说明」同步口径与 UTC+8 日历日窗说明。

## 打包
`.github/workflows/fork-build-win.yml`：推 fork/** 或 feat/stats-** 分支自动打 Windows 安装包（Actions Artifacts，14 天）。

## 已知问题
- 〔上游，路线 B 候选 PR〕`src/main/services/accountMigration.js:41` 启动迁移会把带连字符的合法分组目录（如 `品牌-A`，且 `品牌` 目录不存在时）整体改名为 `品牌`，导致该分组统计历史读回为空。应改为按账号记录中明确的旧 phone→group 映射迁移。（GPT Pro 评审 S1 时发现，2026-11-19）
- 适配器把缺失指标写成 0（如抖音 view_count 缺失），会产生「掉 0 再回升」的假增量；需改采集层区分缺失与 0，暂在导出「字段说明」注明。
- 一次采集的账号快照与作品快照若恰跨零点可能分属两天（影响极小，暂不处理）。
- `src/main/services/dataStats/index.js` 中各 `stats:*` IPC（含导出、作品汇总与 `link-overrides` 读写接口）沿用 `isLocalFrameEvent` 校验（放行无 host 的 `file:` 与 `localhost`/`127.0.0.1`），授权范围偏宽（生产模式未收紧到受信任应用主窗口 mainFrame 及应用页面路径，开发模式未收紧到配置的开发 server origin）；待后续统一收紧全量 stats IPC 鉴权时一并处理。（Codex 评审 S6 时发现，2026-11-19）
- 仅有 `id`、缺 `filePath` 的旧发布记录在重发补齐 `filePath` 后，内容键会从 `record:id:…` 变为 `file:…`，导致指向原 `record:id:…` 的既有手工关联失效，后续可维护记录 ID 到当前内容键的映射。（Codex 评审 S6-r3 #4，2026-11-19）
- 跨组同一作品在不同分组元数据里的 `publishTime` 跨过导出截止日冲突时，Excel「作品日明细」与「作品跨平台汇总」对截止日资格与归属的裁决存在不一致，后续需按作品身份统一裁决两表消费。（Codex 评审 S6-r3 #5，2026-11-19）
- 按分组导出 Excel 时 `statsExport.js` 仍会为未选分组加载完整 `works-daily` 历史，大历史数据下内存与耗时偏高，后续可对未选分组改用截至日读取路径参与全量归属裁决。（Codex 评审 S6-r3 #6，2026-11-19）
- 旧版单文件快照 `works-daily.json` 在单次手工指定校验时仍会整份 `JSON.parse`，大数据量下额外堆占用偏高，后续可改为逐作品流式读取仅保留截止日前最新快照。（Codex 评审 S6-r3 #7，2026-11-19）

### S6 已知问题（评审第 3 轮列出，暂不修）
- 旧发布记录事后补上 filePath 时，内容键从 record:id 变成 file:，原手工关联失效，需重新指定。
- 同一作品跨组且两组元数据发布日期不同时，按分组导出的两张表对该作品的截止日资格可能不一致。
- 按分组导出时未选分组也会加载完整日明细历史（大数据量下内存偏高）。
- 旧版单文件 works-daily.json 在手工指定时会整份解析。
- 新手工矫正 IPC 沿用现有 stats IPC 的本地页面校验（范围偏宽，仅本机使用）。
