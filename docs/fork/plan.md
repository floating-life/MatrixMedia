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

## 打包
`.github/workflows/fork-build-win.yml`：推 fork/** 或 feat/stats-** 分支自动打 Windows 安装包（Actions Artifacts，14 天）。
