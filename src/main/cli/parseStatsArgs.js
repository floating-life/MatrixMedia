"use strict";

import { PLATFORM_ALIASES } from "../../shared/publishPlatforms.js";

/** 数据统计支持的平台（番茄视频、掘金无数据接口） */
const STATS_CANONICAL = [
  "抖音",
  "视频号",
  "哔哩哔哩",
  "百家号",
  "头条",
  "快手",
  "小红书",
];

const ACTIONS = new Set(["get", "sync", "work", "export"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidYmd(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (!Number.isFinite(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === s;
}

function readValue(args, i, flag) {
  const v = args[i + 1];
  if (v === undefined || (typeof v === "string" && /^-/.test(v))) {
    return { ok: false, error: `${flag} 需要一个值，例如 ${flag} <值>` };
  }
  return { ok: true, value: v, next: i + 1 };
}

function parseStatsExportArgs(args) {
  const out = { action: "export", out: null, from: null, to: null, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out" || a === "-o") {
      const v = readValue(args, i, a);
      if (!v.ok) return v;
      const val = String(v.value);
      if (!val.trim()) return { ok: false, error: "--out 需要一个非空路径" };
      out.out = val;
      i = v.next;
    } else if (typeof a === "string" && a.startsWith("--out=")) {
      const val = a.slice("--out=".length);
      if (!val.trim()) return { ok: false, error: "--out 需要一个非空路径" };
      out.out = val;
    } else if (a === "--from") {
      const v = readValue(args, i, a);
      if (!v.ok) return v;
      out.from = String(v.value).trim();
      i = v.next;
    } else if (typeof a === "string" && a.startsWith("--from=")) {
      const val = a.slice("--from=".length).trim();
      if (!val) return { ok: false, error: "--from 需要 YYYY-MM-DD 日期" };
      out.from = val;
    } else if (a === "--to") {
      const v = readValue(args, i, a);
      if (!v.ok) return v;
      out.to = String(v.value).trim();
      i = v.next;
    } else if (typeof a === "string" && a.startsWith("--to=")) {
      const val = a.slice("--to=".length).trim();
      if (!val) return { ok: false, error: "--to 需要 YYYY-MM-DD 日期" };
      out.to = val;
    } else if (a === "--json") {
      out.json = true;
    } else {
      return {
        ok: false,
        error: `未知参数: ${a}（可用: --out、--from、--to、--json）`,
      };
    }
  }

  if (!out.out) {
    return { ok: false, error: "缺少 --out <路径.xlsx>" };
  }
  if (!/\.xlsx$/i.test(out.out)) {
    return { ok: false, error: `--out 必须以 .xlsx 结尾：${out.out}` };
  }
  if (out.from !== null && !isValidYmd(out.from)) {
    return { ok: false, error: `--from 不是合法日期（需 YYYY-MM-DD）：${out.from}` };
  }
  if (out.to !== null && !isValidYmd(out.to)) {
    return { ok: false, error: `--to 不是合法日期（需 YYYY-MM-DD）：${out.to}` };
  }
  if (out.from && out.to && out.from > out.to) {
    return { ok: false, error: `--from 不能晚于 --to（${out.from} > ${out.to}）` };
  }
  return { ok: true, value: out };
}

export function parseStatsArgs(subArgv, action) {
  const args = Array.isArray(subArgv) ? subArgv : [];
  if (args.includes("--help") || args.includes("-h")) {
    return { ok: true, value: { help: true } };
  }
  if (!ACTIONS.has(action)) {
    return { ok: false, error: `未知统计动作: ${action}` };
  }
  if (action === "export") {
    return parseStatsExportArgs(args);
  }
  const out = { action, platform: null, phone: null, title: null, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--platform" || a === "-p") {
      out.platform = args[++i];
    } else if (a === "--phone") {
      out.phone = args[++i];
    } else if (a === "--title") {
      out.title = args[++i];
    } else if (a === "--json") {
      out.json = true;
    } else {
      return {
        ok: false,
        error: `未知参数: ${a}（可用: -p/--platform、--phone、--title、--json）`,
      };
    }
  }

  if (!out.platform) return { ok: false, error: "缺少 -p/--platform" };
  const raw = String(out.platform).trim();
  const pt = PLATFORM_ALIASES[raw] || PLATFORM_ALIASES[raw.toLowerCase()] || raw;
  if (!STATS_CANONICAL.includes(pt)) {
    return {
      ok: false,
      error: `不支持的平台: ${out.platform}（统计支持：${STATS_CANONICAL.join("/")}）`,
    };
  }
  out.platform = pt;

  if (!out.phone) return { ok: false, error: "缺少 --phone（分组名）" };
  out.phone = String(out.phone).trim();

  if (out.action === "work" && !out.title) {
    return { ok: false, error: "stats-work 需要 --title（视频标题）" };
  }
  return { ok: true, value: out };
}

export function statsHelpText(cmd) {
  if (cmd === "stats-export" || cmd === "export") {
    return `
用法: <应用> cli stats-export --out <路径.xlsx> [--from YYYY-MM-DD] [--to YYYY-MM-DD]

将本地作品日明细、跨平台汇总、平台日汇总与账号日快照导出为 Excel（.xlsx）

选项:
  -o, --out <路径>      输出 .xlsx 文件路径（必填，须以 .xlsx 结尾）
      --from <日期>     起始日期（含），YYYY-MM-DD，默认结束日期往前 29 天
      --to <日期>       结束日期（含），YYYY-MM-DD，默认最新有数据日期
      --json            以 JSON 输出（默认即 JSON，便于脚本消费）
  -h, --help            显示本帮助

退出码: 0 成功, 1 异常, 2 参数错误, 3 业务失败（如单表超过 200000 行）

示例:
  matrixmedia cli stats-export --out ./stats.xlsx
  matrixmedia cli stats-export --out ./stats.xlsx --from 2026-11-01 --to 2026-11-30
`.trim();
  }
  const usage = {
    stats: "读取本地快照中的账号粉丝数据（粉丝/播放/点赞/评论/收藏）",
    get: "读取本地快照中的账号粉丝数据（粉丝/播放/点赞/评论/收藏）",
    "stats-sync": "立即采集该账号最新数据并写入本地快照（需该分组此平台已在 GUI 登录）",
    sync: "立即采集该账号最新数据并写入本地快照（需该分组此平台已在 GUI 登录）",
    "stats-work": "按标题查询某个视频的发布数据（播放/赞/评/收藏/分享/发布时间）",
    work: "按标题查询某个视频的发布数据（播放/赞/评/收藏/分享/发布时间）",
  }[cmd];
  return `
用法: <应用> cli ${cmd} -p <平台> --phone <分组> [选项]

${usage}

选项:
  -p, --platform <id>   平台：dy|抖音、sph|视频号、blbl|哔哩哔哩、bjh|百家号、tt|头条、ks|快手、xhs|小红书
      --phone <id>      分组名（与 GUI「媒体平台管理」里的分组一致）
      --title <标题>    仅 stats-work：完整视频标题
      --json            以 JSON 输出（默认即 JSON，便于脚本消费）
  -h, --help            显示本帮助

退出码: 0 成功, 1 异常（如未登录/未找到）, 2 参数错误

示例:
  matrixmedia cli stats -p sph --phone 123
  matrixmedia cli stats-sync -p dy --phone 123
  matrixmedia cli stats-work -p ks --phone 123 --title "你家猫也这样睡？"
  matrixmedia cli stats-export --out ./stats.xlsx --from 2026-11-01 --to 2026-11-30
`.trim();
}
