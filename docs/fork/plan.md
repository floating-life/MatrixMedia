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
| S7 | feat/stats-analysis | 纯规则「数据分析」页（7 节分析 + 采集掉0异常剔除重算 + 上推荐识别 + 文字小结）+ Excel「分析」sheet（与 GUI 共用计算与默认截止日） |
| S8 | feat/stats-charts | ECharts 5.5.1 按需封装 `StatsChart.vue` +「数据分析」6 节可视化图表 + 导出单图/全部图表 PNG +「作品汇总」单内容播放走势弹窗 |
| S9 | feat/stats-intraday | 固定时段内每 N 小时（默认 2）自动采集 + 分时段作品快照 `works-intraday/YYYY-MM-DD.json`（含保留期清理）+ 作品趋势「按天/按时段」+「最近采集」列 +「新作品前 24 小时」图 + Excel「作品时段明细」sheet |

## S9：固定时段循环自动采集 + 作品分时段数据（`feat/stats-intraday`）
- **设置与时段槽调度（`src/renderer/utils/statsScheduler.js` + `src/main/services/dataStats/index.js` + `store.js`）**：
  - 设置扩展为 `{ enabled, mode: "interval"|"daily", startTime: "08:00", endTime: "22:00", intervalHours: 2, time: "10:00", retentionDays: 60 }`，`intervalHours` 支持 `1/2/3/4/6`；旧设置 `{ enabled, time }` 自动迁移为 `mode: "daily"`，保持旧行为不擅自加大频率；时段槽从 `startTime` 起每 `intervalHours` 一槽（含恰好落点的 `endTime`），`endTime < startTime` 按跨零点计算且槽日期按槽开始时刻的 UTC+8 日历日。
  - 渲染层维持 60s 轮询，在 `[slotStart, nextSlotStart)` 内且未跑过时向主进程发送 `stats:auto-run { slot: "YYYY-MM-DD HH:mm", slotEndMs }`（采集 IPC 不携带/覆盖 `retentionDays`，保留期仅由主进程 `auto-settings.json` 权威保存并通过设置保存 IPC 修改，渲染层旧缓存仅在主进程尚无设置时做一次性迁移）；主进程 `auto-run.json` 升级为兼容旧日期记录与新时段槽记录（按日历日保留最近 14 天），槽认领与限流时间戳分开记录（仅在实际发起至少一个分区的自动采集时更新上次自动采集时间，全跳过只记槽认领），保持内存守卫、开跑前落盘与 `collecting` 互斥（忙则下一轮重试，已过下一槽时刻返回 `expired` 放弃不补采，休眠/关机漏槽直接跳过），分区跳重在分时段模式下按采集成功时间是否落入当前槽判断，`daily` 模式行为与历史完全一致。
- **分时段快照存储（`src/main/services/dataStats/store.js` + `statsTable.js`）**：
  - 每次 `mergeWorks` 维持 `works-daily` 语义不变，同时原子写入 `<userData>/data-stats/<group>/<platform>/works-intraday/YYYY-MM-DD.json`（自动采集用槽键，手动采集按 UTC+8 实际时刻向下取整为 `"HH:00"`，同槽覆盖；整次写入统一以采集返回时刻 `collectNow` 的 UTC+8 日期归档，daily/works-daily/intraday 一致）；每天首次写入成功后自动清理 `works-intraday/` 下严格早于（今天 − 主进程 `retentionDays`）的合法 `YYYY-MM-DD.json` 普通文件；提供 `readWorksIntraday(group, platform, { from, to })`（按时间升序，损坏文件 warn 跳过）与 `buildWorkIntradayRows`（计算播放/点赞/评论较上次增量与距上次小时数）。
- **展示、分析与 Excel（`statsAnalysis.js` + `statsExport.js` + `statsChartOptions.js` + `dataStats/index.vue`）**：
  - 设置栏支持模式切换、起止时段、间隔与风控/平曲线提示；「作品汇总」表新增「最近采集」列（取内容各平台作品最新 `collectedAt`）；趋势弹窗新增「按天 / 按时段」切换及 1/3/7 天区间（默认 3 天），对接新 IPC `stats:get-content-intraday`（与汇总共用关联与 `link-overrides`）；「数据分析」新增「新作品前 24 小时」折线图（近 7 天内发布内容，x=发布后小时数，最多 10 条，复用 `StatsChart` 与平台色）。
  - Excel 在「作品日明细」后新增「作品时段明细」sheet（19 列，含播放/点赞/评论较上次增量与距上次小时数），行数计入现有 `200000` 行上限并同步补充「字段说明」。

## S8：数据可视化（`feat/stats-charts`）
- **依赖与通用组件（`package.json` + `src/renderer/components/StatsChart.vue` + `src/renderer/utils/statsChartOptions.js`）**：引入 `echarts@5.5.1`（本地打包，按需注册 `LineChart`/`BarChart`/`PieChart`/`HeatmapChart` 与必要组件）；自研 `StatsChart.vue` 通用组件（`ResizeObserver` 自适应与 `el-tabs` 隐藏切回重算尺寸、空数据展示「暂无数据」占位、暴露 `getDataURL()` 供导出 PNG）；全页共用固定 7 平台配色常量（`PLATFORM_COLORS` / `getPlatformColor`）；图表 option 全部抽离为纯函数 `statsChartOptions.js`（缺天补空连续日期轴 + `connectNulls: false`、折线数据点 `> 2000` 自动启用 `sampling: "lttb"`）。
- **后端结构化数据与新 IPC（`statsAnalysis.js` + `statsExport.js` + `dataStats/index.js`）**：
  - `statsAnalysis.js` 在不改变既有口径的前提下补充：`overview.dailyTrend`（本周期连续日期各平台 6 项日增序列）、`rankings` 各 Top/Bottom 条目的 `platforms` 分平台明细（含互动率贡献占比）以及 `fansTrend`（本周期各账号粉丝日快照序列）。
  - `statsExport.js` 新增 `buildContentTrendData`，复用与 `buildContentSummaryData` 同一套跨平台关联（自动 + `link-overrides`）与默认截止日，按作品日明细汇总单条内容的各平台累计播放与总播放日增（连续日期补空）。
  - `dataStats/index.js` 新增 3 个 IPC（均沿用本地页面校验）：`stats:get-content-trend { contentKey, from?, to? }`、`stats:save-chart-image { dataUrl, name }`（严格校验 `data:image/png;base64,` 前缀、PNG 魔数与 `≤10MB` 大小，弹出保存对话框默认 Documents）与 `stats:save-chart-images-batch`（一次目录选择对话框批量导出本页全部图表 PNG）。
- **GUI 交互（`src/renderer/views/dataStats/index.vue`）**：
  - 「数据分析」tab 顶部新增「导出全部图表」；6 节全部配图（①总览日趋势折线/堆叠面积+异常空心灰点与上推荐红标+平台占比环形图；②平台对比均播柱+互动率副轴折线；③作品排行 Top10 按平台横向堆叠条形图；④新作品 D1/D3/D7 走势 Top10 折线+分类占比饼图；⑤发布时间星期×时段热力图、样本 `<3` 半透明；⑥账号粉丝趋势折线+多选账号筛选），每张图右上角均支持单独保存 PNG。
  - 「作品汇总」tab 内容行与未关联行新增「趋势」按钮，弹窗展示该内容各平台累计播放折线 + 播放日增柱并支持保存 PNG。

## S7：纯规则数据分析 + Excel「分析」sheet（`feat/stats-analysis`）
- **核心模块（`src/main/services/dataStats/statsAnalysis.js`）**：纯函数 `buildStatsAnalysis({ dailyRows, summaryRows, accountRows, to, period, now })`，不依赖 electron/fs、不调 AI、确定性输出 7 节结构化结果并导出全部阈值常量（`ANALYSIS_THRESHOLDS` 及各单项常量）：
  1. **总览**：本周期（`to` 往前 `period` 天含起止日）与紧邻上一同长周期的 6 项指标日增合计、环比%（上期为 0 或无数据为空，不输出 Infinity）与各平台播放日增贡献占比。
  2. **平台对比**：仅纳入覆盖 `≥2` 个去重平台的同款内容，按平台计算平均播放、互动率 `=(点赞+评论+分享)/播放`（单条播放为 0 或空不计）、平均涨粉与样本数；规则生成 1–3 句中文结论（均播相差 `<5%` 视为并列，文案写「播放接近」），样本 `<3` 注明「样本少，仅供参考」。
  3. **作品排行与平台偏科**：按跨平台合并内容截至 `to` 的总播放 / 互动率（总播放 `≥100` 才参与，按原始比率排序后再输出舍入值）/ 总涨粉各取 Top10 与 Bottom10；列出单平台播放 `≥` 其它平台均值 `3` 倍且 `≥500` 的偏科内容。
  4. **新作品走势**：周期内发布内容（内容首发日按作品取「平台实采 `publishTime` > 发布记录已确认发布时间 `lastPublishAt` > 记录创建时间 `createTime`」后再取最早已知首发，补发不算新作品）按作品各自发布日 UTC+8 日历日起算发布后第 1/3/7 天（D1/D3/D7）累计播放再汇总到平台与内容（与第 5 节共用同一里程碑结果；缺快照取 `≤` 该日最近有效快照，截止日上限为 UTC+8 今天，未到第 N 天为空）；同行 `D3/D1` 与 `D7/D3` 倍数按同一行累计播放计算，跨平台/跨作品走势分类只使用在 D1/D3/D7 三个里程碑均有值的同一组可比样本并在「分类依据」列注明，不存在可比样本时标「数据不足」，其余按阈值分类为长尾型（`D7/D3 ≥ 1.5`）、爆发后平稳（`D3/D1 < 1.3` 且 `D7/D3 < 1.1`）、其它。
  5. **发布时间**：按作品发布时间优先级（平台实采 `publishTime` > 发布记录已确认发布时间 `lastPublishAt` > 记录创建时间 `createTime`）汇总出的内容最早已知首发时间（UTC+8）按星期几 × 时段（`0-6`/`6-12`/`12-18`/`18-24`）分组，共用第 4 节按作品发布日期计算的 D7 里程碑再汇总（不足 7 天用截至 `to` 最新累计并标注）与样本数，样本 `<3` 标「样本少」。
  6. **异常提醒与剔除**：疑似采集异常（某作品某指标某日为 0 或缺失而前后有记录日均 `>0`）使用全部快照（含截止日之后的恢复快照）识别并在本周期标出，且在截止日内重算第 1–5 节全部日增、走势与排行；疑似上推荐仅对连续单日实测播放日增（`daySpan === 1`，断档后首日不触发）判定，要求 `≥` 前 7 个日历日窗口日均 `×5` 且 `≥1000`（窗内跨断档增量按天数均摊）。
  7. **文字小结**：从 1–6 节生成 5–8 行中文要点；按实际有作品快照天数 `<14` 天时附加「数据积累少于 14 天，走势与发布时间结论仅供参考」。
- **GUI 与 IPC（`dataStats/index.js` + `dataStats/index.vue`）**：新增 `stats:get-analysis { period, to? }`（沿用本地页面校验与串行写入队列等待，复用 `statsExport.js` 的 `buildStatsAnalysisData` 结构化行读取路径与共享默认截止日，不构建 Excel 二维表，并将未来 `to` 夹到 UTC+8 今天）；`dataStats/index.vue` 新增「数据分析」tab，支持近 7 天 / 近 30 天切换、截止日选择（`disabledDate` 禁选 UTC+8 未来日期）与一键复制小结，置顶展示文字小结，其下按 1–6 节以 `el-table` + CSS 宽度条分块呈现（走势表主表与展开表均列「分类依据」），异常列表支持展开查看作品与日期详情。
- **采集时区与重采修正（`adapters.js` + `store.js`）**：百家号、小红书无时区发布时间字符串改为按 UTC+8 显式解析，不再依赖宿主机系统时区；`store.mergeWorks` 在重采得到有效 `publishTime`（`>0` 且可解析）时同步更新已有作品的 `publishTime`，自动修正非 UTC+8 主机遗留存量。
- **Excel 导出（`statsExport.js`）**：导出区间先与「`≤` UTC+8 今天」取交集，交集为空直接返回错误「所选日期都在未来」且不生成文件；在「字段说明」前新增「分析」sheet（首块文字小结每行一句，其后各节标题+表头+长表数据、节间空行，走势表同步含「分类依据」列，数值单元格保持 number 类型，周期取 `min(30, 交集天数)`）；「字段说明」补充「分析」sheet 各项口径与剔除说明；「导出信息」新增 `analysisPeriod`。

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
- `src/main/services/dataStats/index.js` 中各 `stats:*` IPC（含导出、作品汇总与 `link-overrides` 读写接口）沿用 `isLocalFrameEvent` 校验（放行无 host 的 `file:` 与 `localhost`/`127.0.0.1`），授权范围偏宽（生产模式未收紧到受信任应用主窗口 mainFrame 及应用页面路径，开发模式未收紧到配置的开发 server origin）；待后续统一收紧全量 stats IPC 鉴权时一并处理。（Codex 评审 S6 时发现，2026-11-19）
- 仅有 `id`、缺 `filePath` 的旧发布记录在重发补齐 `filePath` 后，内容键会从 `record:id:…` 变为 `file:…`，导致指向原 `record:id:…` 的既有手工关联失效，后续可维护记录 ID 到当前内容键的映射。（Codex 评审 S6-r3 #4，2026-11-19）
- 跨组同一作品在不同分组元数据里的 `publishTime` 跨过导出截止日冲突时，Excel「作品日明细」与「作品跨平台汇总」对截止日资格与归属的裁决存在不一致，后续需按作品身份统一裁决两表消费。（Codex 评审 S6-r3 #5，2026-11-19）
- 按分组导出 Excel 时 `statsExport.js` 仍会为未选分组加载完整 `works-daily` 历史，大历史数据下内存与耗时偏高，后续可对未选分组改用截至日读取路径参与全量归属裁决。（Codex 评审 S6-r3 #6，2026-11-19）
- 旧版单文件快照 `works-daily.json` 在单次手工指定校验时仍会整份 `JSON.parse`，大数据量下额外堆占用偏高，后续可改为逐作品流式读取仅保留截止日前最新快照。（Codex 评审 S6-r3 #7，2026-11-19）
- 百家号、小红书适配器在 S7-fix 前曾按宿主机系统时区解析无时区发布时间字符串；S7-fix 已改为显式按 UTC+8 解析，S7-r3 已在 `store.mergeWorks` 中支持重采得到有效 `publishTime` 时更新存量作品（未重新采集前的旧存量时间戳仍维持原值，重采后自动修正）。（Codex 评审 S7 #5 / S7-review2 #5，2026-11-20）
- 根目录 `package-lock.json` 未随 S8 同步新增的 `echarts@5.5.1`（及 `zrender`/`tslib`）条目：本 fork 统一使用 `yarn` 管理依赖与 CI 冻结安装（`yarn.lock` 已同步），暂不维护 npm 锁文件。（Codex 评审 S8 #10，2026-11-20）

### S6 已知问题（评审第 3 轮列出，暂不修）
- 旧发布记录事后补上 filePath 时，内容键从 record:id 变成 file:，原手工关联失效，需重新指定。
- 同一作品跨组且两组元数据发布日期不同时，按分组导出的两张表对该作品的截止日资格可能不一致。
- 按分组导出时未选分组也会加载完整日明细历史（大数据量下内存偏高）。
- 旧版单文件 works-daily.json 在手工指定时会整份解析。
- 新手工矫正 IPC 沿用现有 stats IPC 的本地页面校验（范围偏宽，仅本机使用）。
