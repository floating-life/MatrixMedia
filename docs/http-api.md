# 内置 HTTP API

应用图形界面启动后，会自动在本机 **30088** 端口（`BuiltInServerPort`，见 `env/.env`）监听内置 Express 服务。其它程序可通过 HTTP 调用，与 GUI / CLI 共用同一套登录态与 `pushData` 发布记录。

> **与 CLI 的区别**：HTTP API 依赖 GUI 主进程已运行（托盘/窗口在即可）；CLI 可独立启动。单平台请求会等待上传完成或超时；多平台请求与 GUI 批量发布一致，提交到发布队列后立即返回，实际结果写入 `pushData` 发布记录。

**基础地址**：`http://127.0.0.1:30088`

## 路由一览

| 方法 | 路径                   | 说明                                              |
| ---- | ---------------------- | ------------------------------------------------- |
| GET  | `/`                    | 返回 `MatrixMedia API` 欢迎页                     |
| GET  | `/platforms`           | 返回 HTTP 支持的全部视频平台列表（JSON）          |
| GET  | `/creative-statements` | 返回各平台支持的创作声明选项（对齐 GUI 批量设置） |
| POST | `/changeData`          | 读写本地 JSON 数据（账号树、发布历史等）          |
| POST | `/publish`             | 发布视频到单平台或多平台                          |

静态资源：`/public/*` 映射到 `server/public`。

## GET /platforms

查询 `POST /publish` 支持的全部视频平台（与 CLI `cli publish` 一致）。

**响应示例**：

```json
{
  "success": true,
  "platforms": [
    {
      "code": "dy",
      "name": "抖音",
      "aliases": ["douyin", "抖音"],
      "automated": true,
      "note": null,
      "hasConfig": true
    },
    {
      "code": "xhs",
      "name": "小红书",
      "aliases": ["xiaohongshu", "小红书"],
      "automated": true,
      "note": null,
      "hasConfig": true
    },
    {
      "code": "fqsp",
      "name": "番茄视频",
      "aliases": ["fanqie", "fq", "番茄视频"],
      "automated": false,
      "note": "已支持自动发布与审核状态回查",
      "hasConfig": true
    }
  ]
}
```

## 支持的视频平台

`platform` / `platforms` 可使用 **code** 或 **中文名**，以下平台均可通过 HTTP 发布：

| code   | 平台     | 别名                   | 自动化 |
| ------ | -------- | ---------------------- | ------ |
| `dy`   | 抖音     | douyin / 抖音          | 是     |
| `sph`  | 视频号   | 视频号                 | 是     |
| `blbl` | 哔哩哔哩 | bilibili / 哔哩哔哩    | 是     |
| `bjh`  | 百家号   | 百家号                 | 是     |
| `tt`   | 头条     | toutiao / 头条         | 是     |
| `ks`   | 快手     | kuaishou / 快手        | 是     |
| `xhs`  | 小红书   | xiaohongshu / 小红书   | 是     |
| `fqsp` | 番茄视频 | fanqie / fq / 番茄视频 | 可用   |

> 掘金文章请使用 CLI `publish-article`，当前无 HTTP 接口。

## GET /creative-statements

查询各平台支持的创作声明选项，与 GUI「本地视频发布」批量设置创作声明一致。

**响应字段**：

| 字段           | 说明                                                               |
| -------------- | ------------------------------------------------------------------ |
| `default`      | 当前发布设置里的默认创作声明，出厂默认 `ai_generated`（可改 `none` 等） |
| `fallback`     | 平台不支持所选声明时的回退值，固定为 `none`                        |
| `batchOptions` | 全局批量下拉全部选项（value + label）                              |
| `platforms`    | 按平台 code 列出 `supports` 与该平台可用 `options`                 |
| `input`        | HTTP `POST /publish` 入参说明                                      |

**声明 value 一览**（也可用中文 label 或各平台页面原文案）：

| value                 | 说明       | 备注              |
| --------------------- | ---------- | ----------------- |
| `none`                | 无标注     | 平台不支持时回退  |
| `ai_generated`        | AI 生成    | 出厂默认          |
| `fiction`             | 虚构演绎   |                   |
| `marketing`           | 营销推广   | 快手/头条不支持   |
| `personal_opinion`    | 个人观点   | 小红书/头条不支持 |
| `repost`              | 转载       |                   |
| `self_made_no_repost` | 自制禁转载 | 仅哔哩哔哩        |

## POST /changeData

读写本地 JSON 数据，GUI 内部也使用此接口。

**请求体（JSON）**：

| 字段       | 说明                                                     |
| ---------- | -------------------------------------------------------- |
| `fileName` | 数据文件夹名，如 `account`、`pushData`；只允许字母 / 数字 / 下划线 / 短横线（1-64 位），含路径分隔符或 `.` / `..` 一律返回 `success:false` |
| `type`     | 操作类型：`add` / `update` / `delete` / `get` / `config` |
| `item`     | 具体数据项，结构随 `fileName` 与 `type` 变化；`item.date` 必须是 `YYYY-MM-DD` |

## POST /publish

发布视频到单平台或多平台（本地路径或 `http(s)` 远程 URL）。参数解析与 `cli publish` 共用 `parseMultiPublishRequest`。

视频元数据字段与 GUI / CLI 一致：`title` 为标题，`description` 为简介，`shortTitle` 仅视频号短标题，`tags` 为标签。抖音 / 快手 / 视频号会把简介与标签拼进正文；小红书正文写简介、标签走话题控件；哔哩哔哩简介和标签各自独立填写；头条 / 百家号只写标题。旧字段 `bt2` 仍兼容：视频号当短标题，其他平台当简介。

**请求体（JSON）**：

| 字段                 | 必填   | 说明                                                                                                                                     |
| -------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `platform`           | 单平台 | 上表任一平台 code 或中文名，如 `xhs` / `小红书`（与 `platforms` 二选一）                                                                 |
| `platforms`          | 多平台 | 平台数组，可一次包含全部 8 个平台；如 `["dy","xhs","ks"]` 或对象数组 `[{ "platform": "dy", "phone": "138..." }, ...]`                    |
| `file`               | 是     | 本地视频绝对路径，或 `http://` / `https://` 远程视频 URL（会先下载到临时目录，全部平台发布结束后自动删除；定时发布则在到点执行时再下载）。远程下载默认上限 4 GiB，`Content-Type` 不是视频（HTML / JSON 等错误页）或超过上限时直接返回失败，不落盘；当服务端只回通用类型（`application/octet-stream` / 未声明）时，再按视频容器魔数复核一次响应内容 |
| `title`              | 是     | 视频标题                                                                                                                                 |
| `description`        | 否     | 视频简介；抖音、快手、视频号会与标签拼接，小红书写入正文，哔哩哔哩写入简介控件                                                           |
| `shortTitle`         | 否     | 视频号短标题，建议 6 ～ 16 字；其他平台忽略                                                                                              |
| `phone`              | 二选一 | 账号手机号（与 GUI 账号树一致）；多平台时可作为默认值，单个平台对象内可覆盖                                                              |
| `partition`          | 二选一 | 完整 session，如 `persist:13800138000抖音`                                                                                               |
| `bt2`                | 否     | 旧兼容字段：视频号作为短标题，其他平台作为简介                                                                                           |
| `tags`               | 否     | 标签，支持空格 / 逗号分隔；HTTP 会按 GUI 批量发布习惯拆分后再按平台补 `#` 或去 `#`                                                       |
| `publishAt`          | 否     | 一次性定时发布，格式 `YYYY-MM-DD HH:mm:ss`（多平台时需全部一致）                                                                         |
| `draft`              | 否     | `true` 时保存到平台草稿箱，不直接发布                                                                                                    |
| `cover`              | 否     | 自定义封面图片路径（别名 `coverPath` / `cover-path`；抖音 / 快手 / 视频号生效；竖封面 3:4 比例最佳，抖音横封面基于竖封面自动生成；视频号仅收 jpg/png）           |
| `sphProductId`       | 否     | 视频号商品上架快捷字段（商品编号）；仅视频号生效，等价于 `platformOptions.sph.link.type=product` |
| `sphDramaId` | 否 | 视频号小程序短剧挂载快捷字段（**短剧名称**，如 `泳陷错恋`）；仅视频号生效，等价于 `platformOptions.sph.link.type=mini_drama`                                         |
| `sphSeriesId` | 否 | 视频号剧集挂载快捷字段（**剧集名称**，视频号原生剧集）；仅视频号生效，等价于 `platformOptions.sph.link.type=sph_series`                                         |
| `sphLink`            | 否     | 视频号链接对象，如 `{ "type": "product", "value": "商品编号" }`、`{ "type": "mini_drama", "value": "短剧名称" }` 或 `{ "type": "sph_series", "value": "剧集名称" }`；与三个快捷字段同时传时优先快捷字段                           |
| `platformOptions`    | 否     | 平台专属参数容器；视频号商品也可用 `platformOptions.sph.link`，不会应用到其他平台                                                        |
| `creativeStatement`  | 否     | 全局创作声明，等同 GUI「批量设置创作声明」；未传时套用发布设置里的默认声明（出厂默认 `ai_generated`，可在 GUI「发布节流设置」修改为 `none` 等）；支持 value、中文 label 或平台页面原文案（如 `内容由AI生成`） |
| `creativeStatements` | 否     | 按平台覆盖声明，key 用 code 或中文名，如 `{ "dy": "ai_generated", "blbl": "fiction" }`；某平台不支持所选值时回退 `none`                  |
| `allowDuplicate`     | 否     | 默认 `false`；7 天内同平台+同账号+清洗后同标题已有成功/进行中记录时默认拦截，传 `true` 才放行（亦可在多平台 `platforms[]` 子对象内按平台单独指定） |
| `noThrottle`         | 否     | 默认 `false`；开启发布节流时同账号间隔不足、超出允许发布时段（默认 06:00–23:30 UTC+8）、达当日上限或配置了平台错峰延迟会自动顺延为定时任务（显式 `publishAt` 同样只顺延不提前），传 `true` 可绕过（支持顶层或 `platforms[]` 单平台覆盖） |

**创作声明优先级**（与 GUI 一致）：`platforms[].creativeStatement` > `creativeStatements[平台]` > `creativeStatement` > 主进程发布设置 `defaultCreativeStatement`（出厂默认 `ai_generated`）。

视频号已支持「视频标注」创作声明。某平台不支持所选值（如番茄视频）时按现有规则自动回退为 `none`。响应体及多平台 `results[]` 明细中均会写出最终生效的 `creativeStatement`。可用 `GET /creative-statements` 查询当前默认值与各平台可用选项。

**发布节流与重复拦截执行顺序**：先执行 7 天同平台重复发布拦截，再进入节流排期；被判定为 `duplicate` 的平台不会进入排期。对于通过重复校验的平台：若计划时刻 `≤ 现在 + 1 分钟` 则立即提交发布；否则自动创建定时发布任务（复用 `scheduledPublish` 与去重，应用重启不丢失），该平台返回 `status: "scheduled"`、`scheduled: true`、`publishAt`、`throttled: true` 及 `throttleReason`（如「距上次抖音发布不足 6 小时」「百家号相对首发延迟 10 小时」）。多平台请求中可同时出现部分平台立即提交（`status: "submitted"`）、部分平台节流定时（`status: "scheduled"`）与部分平台重复拦截（`status: "duplicate"`）。

**响应体（JSON）**：

| 字段                             | 说明                                                 |
| -------------------------------- | ---------------------------------------------------- |
| `success`                        | 请求是否被接受；多平台表示已成功提交到发布队列或已创建定时任务 |
| `status`                         | 单平台为最终状态（重复拦截为 `duplicate`，节流或显式定时为 `scheduled`）；多平台全立即或混合为 `submitted`，全定时为 `scheduled`，部分重复拦截为 `partial_duplicate`，全拦截为 `duplicate` |
| `exitCode`                       | 单平台同 CLI（重复拦截为 `6`）；多平台提交/排期成功为 `0` |
| `duplicate`                      | 触发 7 天内重复发布拦截时为 `true`                   |
| `lastPublishAt` / `lastPublishAtText` | 触发重复发布拦截时返回上次匹配记录的时间戳（ms）与 UTC+8 时间文本 |
| `creativeStatement`              | 单平台响应写出最终生效的创作声明（多平台写在每个 `results[]` 条目中） |
| `throttled` / `throttleReason` / `reason` / `reasons` | 触发节流顺延为定时任务时返回 `throttled: true`、顺延原因文案及结构化原因数组 `reasons` |
| `message`                        | 结果说明（重复拦截时含上次发布时间；节流排期时含计划时间与原因） |
| `total` / `succeeded` / `failed` | 多平台提交汇总；最终成功失败以 `pushData` 记录为准   |
| `results`                        | 多平台时各平台提交明细数组（含最终 `creativeStatement`、`status`、`scheduled`、`publishAt`、`throttled`、`throttleReason`、`reasons`；重复平台单独标 `status: "duplicate"`、`exitCode: 6`，混合平台中立即平台下载失败不影响待排平台照常建定时任务） |
| `id`                             | 单平台时写入 `pushData` 的记录 id                    |
| `scheduled` / `publishAt`        | 定时发布或被节流顺延为定时任务时返回（所有 `publishAt` 统一按 UTC+8 解析与格式化；草稿不节流不进账本；复用同文件同时刻既有定时任务若声明冲突返回 `status: "needs_attention"`、`exitCode: 4`；排期搜索上限 60 天，超限返回「排期已满」） |

**HTTP 状态码**：

- 参数错误：HTTP `400`
- 单平台发布失败（如上传/填写失败）：HTTP `200`，但 `success: false`、`exitCode: 3`
- 登录态失效：HTTP `200`，`success: false`、`status: login_required`、`exitCode: 5`（需重新扫码后重跑）
- 视频号链接添加失败但草稿保存成功：HTTP `200`，`success: false`、`status: needs_attention`、`exitCode: 4`
- 7 天内同平台重复发布拦截：HTTP `200`，`success: false`、`status: duplicate`、`exitCode: 6`、`duplicate: true`（`message` 写明上次发布时间；传 `allowDuplicate: true` 可放行）
- 多平台：HTTP 只表示任务是否提交成功（重复平台仅拦截对应平台，其余照常提交），最终结果请查询发布记录
- 服务已配置 CORS，浏览器或本机脚本均可调用

## 示例

单平台发布：

```bash
curl -X POST http://127.0.0.1:30088/publish \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "dy",
    "phone": "13800138000",
    "file": "/Users/me/video.mp4",
    "title": "我的视频标题",
    "tags": "减脂 健身"
  }'
```

视频号商品上架并保存草稿（推荐快捷字段）：

```bash
curl -X POST http://127.0.0.1:30088/publish \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "sph",
    "phone": "13800138000",
    "file": "/Users/me/video.mp4",
    "title": "视频标题",
    "description": "视频简介",
    "shortTitle": "视频号短标题",
    "draft": true,
    "sphProductId": "10000591263144",
    "creativeStatement": "含AI生成内容"
  }'
```

也可用完整对象（视频号商品 / 小程序短剧 / 剧集）：

```json
{
  "platformOptions": {
    "sph": { "link": { "type": "product", "value": "10000591263144" } }
  }
}
```

```json
{
  "platformOptions": {
    "sph": { "link": { "type": "mini_drama", "value": "泳陷错恋" } }
  }
}
```

```json
{
  "platformOptions": {
    "sph": { "link": { "type": "sph_series", "value": "儿媳给我办寿宴" } }
  }
}
```

`sphProductId` / `sphDramaId` / `sphSeriesId` / `sphLink` / `platformOptions.sph` 只会被视频号任务读取。多平台发布时其他平台会忽略它们；不同视频号账号可在各个 `platforms[]` 对象内分别覆盖商品 / 短剧 / 剧集名称。短剧或剧集添加失败时同样走「转存草稿」兜底：HTTP `200`、`status: needs_attention`、`exitCode: 4`。

远程视频 URL：

```bash
curl -X POST http://127.0.0.1:30088/publish \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "dy",
    "phone": "13800138000",
    "file": "https://example.com/video.mp4",
    "title": "我的视频标题"
  }'
```

多平台一次发布（含按平台创作声明，对齐 GUI 批量设置）：

```bash
curl -X POST http://127.0.0.1:30088/publish \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "13800138000",
    "file": "/Users/me/video.mp4",
    "title": "我的视频标题",
    "creativeStatement": "ai_generated",
    "creativeStatements": {
      "blbl": "fiction",
      "xhs": "marketing"
    },
    "platforms": ["dy", "blbl", "xhs", "ks"]
  }'
```

多平台一次发布（`platforms` 字符串数组）：

```bash
curl -X POST http://127.0.0.1:30088/publish \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "13800138000",
    "file": "https://example.com/video.mp4",
    "title": "我的视频标题",
    "description": "记录第一次完成五公里的真实体验",
    "shortTitle": "5公里新手挑战",
    "tags": "跑步 新手",
    "platforms": ["dy", "sph", "blbl", "bjh", "tt", "ks", "xhs"]
  }'
```

多平台一次发布（`platforms` 对象数组，各平台可覆盖 `phone`）：

```bash
curl -X POST http://127.0.0.1:30088/publish \
  -H "Content-Type: application/json" \
  -d '{
    "file": "/Users/me/video.mp4",
    "title": "我的视频标题",
    "tags": "日常 vlog",
    "platforms": [
      { "platform": "dy", "phone": "13800138000" },
      { "platform": "sph", "phone": "13800138000" },
      { "platform": "ks", "phone": "13900139000" }
    ]
  }'
```

多平台响应示例：

```json
{
  "success": true,
  "exitCode": 0,
  "status": "submitted",
  "message": "已提交 3 个平台发布",
  "total": 3,
  "succeeded": 0,
  "failed": 0,
  "results": [
    {
      "platform": "抖音",
      "success": true,
      "exitCode": 0,
      "status": "submitted",
      "message": "已提交发布任务"
    },
    {
      "platform": "视频号",
      "success": true,
      "exitCode": 0,
      "status": "submitted",
      "message": "已提交发布任务"
    },
    {
      "platform": "快手",
      "phone": "13900139000",
      "creativeStatement": "ai_generated",
      "success": true,
      "exitCode": 0,
      "status": "submitted",
      "scheduled": false,
      "throttled": false,
      "message": "已提交发布任务"
    }
  ]
}
```

多平台节流排期与绕过示例（假设抖音 1 小时前刚发过、百家号配置了相对首发延迟 10 小时，快手无记录）：

```bash
# 按节流自动错峰（抖音与百家号自动建定时任务，快手立即提交；未传声明时套用默认 ai_generated）
curl -X POST http://127.0.0.1:30088/publish \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "13800138000",
    "file": "/Users/me/video.mp4",
    "title": "我的视频标题",
    "platforms": ["dy", "ks", "bjh"]
  }'

# 显式绕过节流并覆盖创作声明为 none
curl -X POST http://127.0.0.1:30088/publish \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "dy",
    "phone": "13800138000",
    "file": "/Users/me/video.mp4",
    "title": "紧急视频",
    "noThrottle": true,
    "creativeStatement": "none"
  }'
```

多平台部分立即、部分节流定时的响应示例：

```json
{
  "success": true,
  "exitCode": 0,
  "status": "submitted",
  "scheduled": false,
  "scheduledCount": 2,
  "submittedCount": 1,
  "message": "已提交 1 个平台立即发布，2 个平台已按节流排期定时发布",
  "total": 3,
  "succeeded": 2,
  "failed": 0,
  "results": [
    {
      "platform": "抖音",
      "phone": "13800138000",
      "creativeStatement": "ai_generated",
      "success": true,
      "exitCode": 0,
      "status": "scheduled",
      "scheduled": true,
      "publishAt": "2026-11-21 15:00:00",
      "throttled": true,
      "throttleReason": "距上次抖音发布不足 6 小时",
      "message": "已按发布节流排期至 2026-11-21 15:00:00（距上次抖音发布不足 6 小时）"
    },
    {
      "platform": "快手",
      "phone": "13800138000",
      "creativeStatement": "ai_generated",
      "success": true,
      "exitCode": 0,
      "status": "submitted",
      "scheduled": false,
      "throttled": false,
      "message": "已提交发布任务"
    },
    {
      "platform": "百家号",
      "phone": "13800138000",
      "creativeStatement": "ai_generated",
      "success": true,
      "exitCode": 0,
      "status": "scheduled",
      "scheduled": true,
      "publishAt": "2026-11-21 20:00:00",
      "throttled": true,
      "throttleReason": "百家号相对首发延迟 10 小时",
      "message": "已按发布节流排期至 2026-11-21 20:00:00（百家号相对首发延迟 10 小时）"
    }
  ]
}
```

## 数据统计接口（Stats API）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/stats?phone=<分组>&pt=<平台>` | 读本地快照中的账号粉丝数据（同步返回 `collectAlert` / `hasCollectAlert` 连续采集失败告警状态） |
| POST | `/stats/sync` | 主动采集：`{"phone":"123","pt":"blbl"}` |
| GET | `/stats/work?phone=<分组>&pt=<平台>&title=<标题>` | 按完整标题查视频发布数据 |

- 平台支持短码（`dy` `sph` `blbl` `bjh` `tt` `ks` `xhs`）或中文名
- 与 `/changeData` 相同守卫：需 `X-Matrix-Token` 头或 localhost/file Origin
- `POST /stats/sync` 复用 GUI 登录态采集，返回 `overview`（fans/plays/likes/comments/shares/favorites）与 `workCount`

示例：

```bash
curl -H "Origin: http://localhost:30088" "http://localhost:30088/stats?phone=123&pt=blbl"
curl -X POST -H "Content-Type: application/json" -H "Origin: http://localhost:30088" \
  -d '{"phone":"123","pt":"sph"}' http://localhost:30088/stats/sync
```
