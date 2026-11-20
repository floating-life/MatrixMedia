"use strict";

/**
 * 数据可视化 ECharts option 纯函数构造模块（不依赖 Vue / DOM / Electron，便于单测）。
 *
 * 所有图表共享同一套固定平台配色（PLATFORM_COLORS / getPlatformColor），
 * 同一平台全页同色；空数据统一返回 { __empty: true, emptyText } 占位标记。
 */

const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CONTINUOUS_SPAN_DAYS = 5000;
const LTTB_POINT_THRESHOLD = 2000;
const LOW_SAMPLE_THRESHOLD = 3;
const NEW_WORKS_MAX_LINES = 10;
const RANKING_TOP_LIMIT = 10;

/** 固定平台色表：抖音 / 快手 / 视频号 / 小红书 / 哔哩哔哩(B站) / 头条 / 百家号 各一色，全页共用 */
const PLATFORM_COLORS = Object.freeze({
  抖音: "#1f2937",
  快手: "#ff6a00",
  视频号: "#07c160",
  小红书: "#ff2442",
  哔哩哔哩: "#fb7299",
  B站: "#fb7299",
  头条: "#7c3aed",
  百家号: "#2962ff",
});

const FALLBACK_COLORS = Object.freeze([
  "#0891b2",
  "#ca8a04",
  "#0d9488",
  "#4f46e5",
  "#db2777",
  "#65a30d",
  "#ea580c",
  "#6366f1",
]);

const PLATFORM_ORDER = Object.freeze([
  "抖音",
  "视频号",
  "快手",
  "哔哩哔哩",
  "小红书",
  "百家号",
  "头条",
]);
const PLATFORM_RANK_MAP = new Map(PLATFORM_ORDER.map((p, i) => [p, i]));

const OVERVIEW_METRIC_OPTIONS = Object.freeze([
  { key: "play", label: "播放" },
  { key: "like", label: "点赞" },
  { key: "comment", label: "评论" },
  { key: "share", label: "分享" },
  { key: "favorite", label: "收藏" },
  { key: "fansDelta", label: "涨粉" },
]);

const OVERVIEW_METRIC_LABEL_MAP = Object.freeze({
  play: "播放日增",
  like: "点赞日增",
  comment: "评论日增",
  share: "分享日增",
  favorite: "收藏日增",
  fansDelta: "涨粉日增",
});

const CATEGORY_SPECS = Object.freeze([
  { name: "长尾型", color: "#67c23a" },
  { name: "爆发后平稳", color: "#909399" },
  { name: "其它", color: "#409eff" },
  { name: "数据不足", color: "#e6a23c" },
]);

const HEATMAP_WEEKDAYS = Object.freeze(["周一", "周二", "周三", "周四", "周五", "周六", "周日"]);
const HEATMAP_SLOTS = Object.freeze(["0-6", "6-12", "12-18", "18-24"]);
const SAME_PLATFORM_LINE_TYPES = Object.freeze(["solid", "dashed", "dotted"]);

const NEW_WORK_PALETTE = Object.freeze([
  "#409eff",
  "#67c23a",
  "#e6a23c",
  "#f56c6c",
  "#9b59b6",
  "#13c2c2",
  "#ff6a00",
  "#2f54eb",
  "#eb2f96",
  "#52c41a",
]);

function getPlatformColor(platform) {
  const key = typeof platform === "string" ? platform.trim() : "";
  if (key && Object.prototype.hasOwnProperty.call(PLATFORM_COLORS, key)) {
    return PLATFORM_COLORS[key];
  }
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}

function compareText(a, b) {
  const sa = a == null ? "" : String(a);
  const sb = b == null ? "" : String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function comparePlatform(a, b) {
  const ia = PLATFORM_RANK_MAP.get(a);
  const ib = PLATFORM_RANK_MAP.get(b);
  if (ia !== undefined && ib !== undefined) return ia - ib;
  if (ia !== undefined) return -1;
  if (ib !== undefined) return 1;
  return compareText(a, b);
}

function escapeHtml(raw) {
  return String(raw == null ? "" : raw)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function dateStrToDayNum(ymd) {
  if (typeof ymd !== "string" || !DATE_RE.test(ymd)) return null;
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  const d = Number(ymd.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, m - 1, d);
  const dt = new Date(ms);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return Math.floor(ms / DAY_MS);
}

function dayNumToDateStr(dayNum) {
  return new Date(dayNum * DAY_MS).toISOString().slice(0, 10);
}

/**
 * 构建连续 YYYY-MM-DD 日期数组（缺天补空，避免折线跨缺天直接相连）。
 */
function buildContinuousDates(rawDates, range) {
  let minDay = Infinity;
  let maxDay = -Infinity;

  const rFrom = range && typeof range.from === "string" ? dateStrToDayNum(range.from.trim()) : null;
  const rTo = range && typeof range.to === "string" ? dateStrToDayNum(range.to.trim()) : null;
  if (rFrom !== null && rTo !== null && rFrom <= rTo) {
    minDay = rFrom;
    maxDay = rTo;
  }

  if (Array.isArray(rawDates)) {
    for (let i = 0; i < rawDates.length; i++) {
      const dn = dateStrToDayNum(rawDates[i]);
      if (dn === null) continue;
      if (dn < minDay) minDay = dn;
      if (dn > maxDay) maxDay = dn;
    }
  }

  if (!Number.isFinite(minDay) || !Number.isFinite(maxDay) || minDay > maxDay) {
    return [];
  }
  if (maxDay - minDay + 1 > MAX_CONTINUOUS_SPAN_DAYS) {
    minDay = maxDay - MAX_CONTINUOUS_SPAN_DAYS + 1;
  }

  const len = maxDay - minDay + 1;
  const dates = new Array(len);
  for (let i = 0; i < len; i++) {
    dates[i] = dayNumToDateStr(minDay + i);
  }
  return dates;
}

function toFiniteOrNull(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v === 0 ? 0 : v;
}

function round2(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const rounded = Math.round((v + (v >= 0 ? Number.EPSILON : -Number.EPSILON)) * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

function extractLineDatumValue(datum) {
  if (typeof datum === "number") return Number.isFinite(datum) ? datum : null;
  if (Array.isArray(datum)) {
    return datum.length >= 2 ? toFiniteOrNull(datum[1]) : null;
  }
  if (datum && typeof datum === "object") {
    if (Array.isArray(datum.value)) {
      return datum.value.length >= 2 ? toFiniteOrNull(datum.value[1]) : null;
    }
    return toFiniteOrNull(datum.value);
  }
  return null;
}

/**
 * 找出折线序列中的孤立有效点（前后均为空或越界，connectNulls:false 下无任何线段相连）。
 */
function findIsolatedPointIndices(data) {
  const isolated = new Set();
  let validCount = 0;
  if (!Array.isArray(data) || !data.length) return { isolated, validCount };
  for (let i = 0; i < data.length; i++) {
    if (extractLineDatumValue(data[i]) === null) continue;
    validCount += 1;
    const prevValid = i > 0 && extractLineDatumValue(data[i - 1]) !== null;
    const nextValid = i < data.length - 1 && extractLineDatumValue(data[i + 1]) !== null;
    if (!prevValid && !nextValid) {
      isolated.add(i);
    }
  }
  return { isolated, validCount };
}

/**
 * 构建折线 symbol 显示配置：
 * - 时间轴 <=45 天常规显示圆点；有孤立点时开启 showAllSymbol 防止窄容器抽稀隐藏
 * - 时间轴 >45 天无孤立点时关闭 showSymbol 避免过密；存在孤立有效点时保留孤立点圆点
 */
function buildLineSymbolConfig(data, datesLength) {
  const { isolated, validCount } = findIsolatedPointIndices(data);
  if (datesLength <= 45) {
    const cfg = {
      showSymbol: true,
      symbol: "circle",
      symbolSize: 5,
    };
    if (isolated.size > 0) {
      cfg.showAllSymbol = true;
    }
    return cfg;
  }
  if (isolated.size === 0) {
    return {
      showSymbol: false,
      symbol: "circle",
      symbolSize: 5,
    };
  }
  if (isolated.size === validCount) {
    return {
      showSymbol: true,
      showAllSymbol: true,
      symbol: "circle",
      symbolSize: 5,
    };
  }
  return {
    showSymbol: true,
    showAllSymbol: true,
    symbol(_val, params) {
      return params && isolated.has(params.dataIndex) ? "circle" : "none";
    },
    symbolSize: 5,
  };
}

/**
 * 按当前图例可见系列重算堆叠折线/面积图的 markPoint 纵坐标，返回供 setOption(patch, false) 合并的 patch。
 * 若 option 不含带 markPoint 的堆叠系列则返回 null。
 */
function buildStackedMarkPointPatch(option, selected) {
  if (!option || typeof option !== "object" || !Array.isArray(option.series) || !option.series.length) {
    return null;
  }
  const xData =
    option.xAxis && !Array.isArray(option.xAxis) && Array.isArray(option.xAxis.data)
      ? option.xAxis.data
      : [];
  if (!xData.length) return null;

  const hasStackedMarkPoint = option.series.some(
    (s) =>
      s &&
      s.stack &&
      s.markPoint &&
      Array.isArray(s.markPoint.data) &&
      s.markPoint.data.length > 0
  );
  if (!hasStackedMarkPoint) return null;

  const dateToIdx = new Map();
  for (let i = 0; i < xData.length; i++) dateToIdx.set(xData[i], i);

  const stackAccs = new Map();
  const seriesPatch = option.series.map((s) => {
    if (!s || typeof s !== "object") return {};
    const name = s.name;
    const isVisible =
      !selected ||
      typeof selected !== "object" ||
      !Object.prototype.hasOwnProperty.call(selected, name) ||
      selected[name] !== false;

    if (!s.stack || !isVisible) {
      return name != null ? { name } : {};
    }

    let acc = stackAccs.get(s.stack);
    if (!acc) {
      acc = {
        pos: new Array(xData.length).fill(0),
        neg: new Array(xData.length).fill(0),
      };
      stackAccs.set(s.stack, acc);
    }

    const dataArr = Array.isArray(s.data) ? s.data : [];
    const top = new Array(xData.length).fill(0);
    for (let i = 0; i < xData.length; i++) {
      const v = i < dataArr.length ? extractLineDatumValue(dataArr[i]) : null;
      if (v !== null) {
        if (v >= 0) {
          acc.pos[i] += v;
          top[i] = acc.pos[i];
        } else {
          acc.neg[i] += v;
          top[i] = acc.neg[i];
        }
      } else {
        top[i] = acc.pos[i];
      }
    }

    if (!s.markPoint || !Array.isArray(s.markPoint.data) || !s.markPoint.data.length) {
      return name != null ? { name } : {};
    }

    const nextMarkData = s.markPoint.data.map((mp) => {
      if (!mp || typeof mp !== "object" || !Array.isArray(mp.coord) || mp.coord.length < 2) {
        return mp;
      }
      const xKey = mp.coord[0];
      const idx = dateToIdx.has(xKey)
        ? dateToIdx.get(xKey)
        : typeof xKey === "number" && Number.isInteger(xKey) && xKey >= 0 && xKey < xData.length
        ? xKey
        : -1;
      if (idx < 0) return mp;
      return {
        ...mp,
        coord: [xKey, top[idx]],
      };
    });

    return {
      name,
      markPoint: {
        ...s.markPoint,
        data: nextMarkData,
      },
    };
  });

  return { series: seriesPatch };
}

function recomputeStackedMarkPoints(option, selected) {
  const patch = buildStackedMarkPointPatch(option, selected);
  if (!patch) return option;
  return {
    ...option,
    series: option.series.map((s, idx) => {
      const p = patch.series[idx];
      if (!p || !p.markPoint) return s;
      return {
        ...s,
        markPoint: p.markPoint,
      };
    }),
  };
}

function formatNum(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "-";
  return Number(v).toLocaleString("zh-CN");
}

function formatAxisCompact(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "";
  const abs = Math.abs(v);
  if (abs >= 100000000) return `${(v / 100000000).toFixed(1).replace(/\.0$/, "")}亿`;
  if (abs >= 10000) return `${(v / 10000).toFixed(abs >= 100000 ? 0 : 1).replace(/\.0$/, "")}万`;
  return String(v);
}

function truncateText(str, maxLen = 14) {
  const text = str == null ? "" : String(str);
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(1, maxLen - 1))}…`;
}

function createEmptyOption(emptyText = "暂无数据") {
  return {
    __empty: true,
    emptyText: emptyText || "暂无数据",
  };
}

function isEmptyChartOption(option) {
  if (!option || typeof option !== "object") return true;
  if (option.__empty) return true;
  if (!Array.isArray(option.series) || option.series.length === 0) return true;
  return option.series.every((s) => {
    if (!s) return true;
    const data = Array.isArray(s.data) ? s.data : [];
    const hasVal = data.some((d) => {
      if (d == null) return false;
      if (typeof d === "object") {
        if (Array.isArray(d.value)) return d.value.some((v) => v != null);
        return d.value != null;
      }
      return true;
    });
    const hasMark =
      s.markPoint && Array.isArray(s.markPoint.data) && s.markPoint.data.length > 0;
    return !hasVal && !hasMark;
  });
}

function shouldUseLttb(seriesCount, xLen) {
  return xLen > LTTB_POINT_THRESHOLD || seriesCount * xLen > LTTB_POINT_THRESHOLD;
}

/**
 * 1a. 总览：日趋势折线图（可切 6 项日增指标、可切堆叠面积、标注采集异常空心灰点与上推荐红标）
 */
function buildOverviewTrendOption(analysis, options = {}) {
  const metric =
    options && typeof options.metric === "string" && OVERVIEW_METRIC_LABEL_MAP[options.metric]
      ? options.metric
      : "play";
  const stacked = Boolean(options && options.stacked);
  const metricLabel = OVERVIEW_METRIC_LABEL_MAP[metric];

  const overview = analysis && analysis.overview;
  const trend = overview && overview.dailyTrend;
  const rawDates = trend && Array.isArray(trend.dates) ? trend.dates : [];
  const rawPlatforms = trend && Array.isArray(trend.platforms) ? trend.platforms : [];
  const range = analysis && analysis.currentRange;

  const dates = buildContinuousDates(rawDates, range);
  if (!dates.length) {
    return createEmptyOption("本周期暂无日趋势数据");
  }

  const dateToIdx = new Map();
  for (let i = 0; i < dates.length; i++) dateToIdx.set(dates[i], i);

  // 索引本周期异常（按 platform + date 分组，O(A)）
  const anomalies = analysis && analysis.anomalies;
  const colByPtDate = new Map();
  const colByDate = new Map();
  const recByPtDate = new Map();
  const recByDate = new Map();
  const extraPlatforms = new Set();

  if (anomalies && Array.isArray(anomalies.collectionAnomalies)) {
    for (let i = 0; i < anomalies.collectionAnomalies.length; i++) {
      const a = anomalies.collectionAnomalies[i];
      if (!a || a.metric !== metric || !dateToIdx.has(a.date) || !a.platform) continue;
      extraPlatforms.add(a.platform);
      const key = `${a.platform}\0${a.date}`;
      let list = colByPtDate.get(key);
      if (!list) {
        list = [];
        colByPtDate.set(key, list);
      }
      list.push(a);

      let dList = colByDate.get(a.date);
      if (!dList) {
        dList = [];
        colByDate.set(a.date, dList);
      }
      dList.push(a);
    }
  }

  if (metric === "play" && anomalies && Array.isArray(anomalies.recommendSpikes)) {
    for (let i = 0; i < anomalies.recommendSpikes.length; i++) {
      const r = anomalies.recommendSpikes[i];
      if (!r || !dateToIdx.has(r.date) || !r.platform) continue;
      extraPlatforms.add(r.platform);
      const key = `${r.platform}\0${r.date}`;
      let list = recByPtDate.get(key);
      if (!list) {
        list = [];
        recByPtDate.set(key, list);
      }
      list.push(r);

      let dList = recByDate.get(r.date);
      if (!dList) {
        dList = [];
        recByDate.set(r.date, dList);
      }
      dList.push(r);
    }
  }

  // 对齐各平台数据到连续日期轴（缺天严格补 null）
  const platformRowsByName = new Map();
  for (let i = 0; i < rawPlatforms.length; i++) {
    const row = rawPlatforms[i];
    if (!row || !row.platform) continue;
    const aligned = new Array(dates.length).fill(null);
    const srcArr = Array.isArray(row[metric]) ? row[metric] : [];
    for (let j = 0; j < rawDates.length && j < srcArr.length; j++) {
      const idx = dateToIdx.get(rawDates[j]);
      if (idx === undefined) continue;
      const v = toFiniteOrNull(srcArr[j]);
      if (v !== null) aligned[idx] = v;
    }
    platformRowsByName.set(row.platform, aligned);
  }
  for (const pt of extraPlatforms) {
    if (!platformRowsByName.has(pt)) {
      platformRowsByName.set(pt, new Array(dates.length).fill(null));
    }
  }

  const sortedPlatforms = [...platformRowsByName.keys()].sort(comparePlatform);
  let hasAnyValue = false;
  for (const pt of sortedPlatforms) {
    const arr = platformRowsByName.get(pt);
    if (arr.some((v) => v !== null)) {
      hasAnyValue = true;
      break;
    }
  }
  const hasAnyAnomaly = colByPtDate.size > 0 || recByPtDate.size > 0;
  if (!sortedPlatforms.length || (!hasAnyValue && !hasAnyAnomaly)) {
    return createEmptyOption(`本周期暂无${metricLabel}数据`);
  }

  // 堆叠模式下预先计算每条线在每日的堆叠顶坐标，供 markPoint 精准落点
  const stackedTopByPlatform = new Map();
  if (stacked) {
    const posAcc = new Array(dates.length).fill(0);
    const negAcc = new Array(dates.length).fill(0);
    for (const pt of sortedPlatforms) {
      const arr = platformRowsByName.get(pt);
      const top = new Array(dates.length).fill(0);
      for (let i = 0; i < dates.length; i++) {
        const v = arr[i];
        if (v !== null) {
          if (v >= 0) {
            posAcc[i] += v;
            top[i] = posAcc[i];
          } else {
            negAcc[i] += v;
            top[i] = negAcc[i];
          }
        } else {
          top[i] = posAcc[i];
        }
      }
      stackedTopByPlatform.set(pt, top);
    }
  }

  const useLttb = shouldUseLttb(sortedPlatforms.length, dates.length);
  const series = sortedPlatforms.map((platform) => {
    const color = getPlatformColor(platform);
    const data = platformRowsByName.get(platform);
    const markPoints = [];

    for (let i = 0; i < dates.length; i++) {
      const d = dates[i];
      const key = `${platform}\0${d}`;
      const cols = colByPtDate.get(key);
      if (cols && cols.length) {
        const yVal = stacked
          ? stackedTopByPlatform.get(platform)[i]
          : data[i] !== null
          ? data[i]
          : 0;
        markPoints.push({
          name: "疑似采集异常（已剔除）",
          coord: [d, yVal],
          symbol: "emptyCircle",
          symbolSize: 10,
          itemStyle: {
            color: "#909399",
            borderColor: "#909399",
            borderWidth: 2,
          },
          label: { show: false },
          anomalyType: "collection",
          platform,
          date: d,
          items: cols,
        });
      }
      const recs = recByPtDate.get(key);
      if (recs && recs.length) {
        const yVal = stacked
          ? stackedTopByPlatform.get(platform)[i]
          : data[i] !== null
          ? data[i]
          : 0;
        markPoints.push({
          name: "疑似上推荐",
          coord: [d, yVal],
          symbol: "pin",
          symbolSize: 32,
          itemStyle: {
            color: "#f56c6c",
            borderColor: "#ffffff",
            borderWidth: 1,
          },
          label: {
            show: true,
            formatter: "荐",
            color: "#ffffff",
            fontSize: 11,
          },
          anomalyType: "recommend",
          platform,
          date: d,
          items: recs,
        });
      }
    }

    const s = {
      name: platform,
      type: "line",
      data,
      connectNulls: false,
      ...buildLineSymbolConfig(data, dates.length),
      smooth: false,
      itemStyle: { color },
      lineStyle: { color, width: 2 },
    };
    if (stacked) {
      s.stack = "total";
      s.areaStyle = { opacity: 0.25 };
    }
    if (useLttb) {
      s.sampling = "lttb";
    }
    if (markPoints.length) {
      s.markPoint = {
        silent: false,
        animation: false,
        data: markPoints,
      };
    }
    return s;
  });

  const option = {
    color: sortedPlatforms.map(getPlatformColor),
    tooltip: {
      trigger: "axis",
      confine: true,
      formatter(params) {
        const list = Array.isArray(params) ? params : [params];
        if (!list.length) return "";
        const date = list[0].axisValueLabel || list[0].axisValue || "";
        const lines = [`<div style="font-weight:600;margin-bottom:4px;">${escapeHtml(date)} · ${escapeHtml(metricLabel)}</div>`];
        for (const p of list) {
          if (p.componentType === "markPoint") continue;
          const valStr = p.value == null ? "-" : formatNum(p.value);
          lines.push(
            `<div>${p.marker}${escapeHtml(p.seriesName)}：<b>${escapeHtml(valStr)}</b></div>`
          );
        }
        const dayCols = colByDate.get(date);
        if (dayCols && dayCols.length) {
          lines.push('<div style="margin-top:4px;padding-top:4px;border-top:1px solid #ebeef5;color:#909399;">');
          lines.push(`○ 疑似采集异常（已剔除 ${dayCols.length} 条）：`);
          for (const c of dayCols.slice(0, 3)) {
            lines.push(
              `<div style="padding-left:10px;">${escapeHtml(c.platform)} · ${escapeHtml(truncateText(c.title, 18))}（异常值 ${c.value == null ? "缺失" : c.value}）</div>`
            );
          }
          if (dayCols.length > 3) {
            lines.push(`<div style="padding-left:10px;">…等共 ${dayCols.length} 条</div>`);
          }
          lines.push("</div>");
        }
        const dayRecs = recByDate.get(date);
        if (dayRecs && dayRecs.length) {
          lines.push('<div style="margin-top:4px;padding-top:4px;border-top:1px solid #ebeef5;color:#f56c6c;">');
          lines.push(`● 疑似上推荐（${dayRecs.length} 条）：`);
          for (const r of dayRecs.slice(0, 3)) {
            const ratioTxt = r.ratio != null ? ` · ${r.ratio}x` : "";
            lines.push(
              `<div style="padding-left:10px;">${escapeHtml(r.platform)} · ${escapeHtml(truncateText(r.title, 18))}（+${escapeHtml(formatNum(r.dailyPlayDelta))}${escapeHtml(ratioTxt)}）</div>`
            );
          }
          if (dayRecs.length > 3) {
            lines.push(`<div style="padding-left:10px;">…等共 ${dayRecs.length} 条</div>`);
          }
          lines.push("</div>");
        }
        return lines.join("");
      },
    },
    legend: {
      type: "scroll",
      top: 0,
      left: 0,
      textStyle: { fontSize: 12, color: "#606266" },
    },
    grid: {
      top: 38,
      left: 16,
      right: 18,
      bottom: 14,
      containLabel: true,
    },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: dates,
      axisLabel: {
        color: "#606266",
        fontSize: 11,
        formatter(v) {
          return typeof v === "string" && v.length === 10 ? v.slice(5) : v;
        },
      },
      axisLine: { lineStyle: { color: "#dcdfe6" } },
    },
    yAxis: {
      type: "value",
      name: metricLabel,
      nameTextStyle: { color: "#909399", fontSize: 11 },
      axisLabel: { color: "#606266", fontSize: 11, formatter: formatAxisCompact },
      splitLine: { lineStyle: { color: "#ebeef5" } },
    },
    series,
  };
  if (stacked && options && options.selected && typeof options.selected === "object") {
    return recomputeStackedMarkPoints(option, options.selected);
  }
  return option;
}

/**
 * 1b. 总览：各平台播放日增占比环形图
 */
function buildOverviewPieOption(analysis) {
  const contrib =
    analysis &&
    analysis.overview &&
    Array.isArray(analysis.overview.platformContribution)
      ? analysis.overview.platformContribution
      : [];

  const items = contrib
    .filter((r) => r && r.platform && typeof r.play === "number" && Number.isFinite(r.play) && r.play > 0)
    .map((r) => ({
      name: r.platform,
      value: r.play,
      sharePct: r.sharePct,
      itemStyle: { color: getPlatformColor(r.platform) },
    }));

  if (!items.length) {
    return createEmptyOption("本周期暂无平台播放占比数据");
  }

  return {
    color: items.map((it) => it.itemStyle.color),
    tooltip: {
      trigger: "item",
      confine: true,
      formatter(p) {
        const pct = p.data && p.data.sharePct != null ? p.data.sharePct : p.percent;
        return `${p.marker}${escapeHtml(p.name)}<br/>播放日增：<b>${escapeHtml(formatNum(p.value))}</b>（${escapeHtml(pct)}%）`;
      },
    },
    legend: {
      type: "scroll",
      bottom: 0,
      selectedMode: false,
      textStyle: { fontSize: 12, color: "#606266" },
    },
    series: [
      {
        name: "平台播放占比",
        type: "pie",
        radius: ["44%", "70%"],
        center: ["50%", "44%"],
        avoidLabelOverlap: true,
        itemStyle: {
          borderColor: "#ffffff",
          borderWidth: 2,
        },
        label: {
          show: true,
          fontSize: 11,
          color: "#606266",
          formatter(p) {
            const pct =
              p && p.data && p.data.sharePct != null ? p.data.sharePct : p && p.percent;
            return pct != null ? `${p.name} ${pct}%` : `${p.name}`;
          },
        },
        data: items,
      },
    ],
  };
}

/**
 * 2. 平台对比：分组柱状图（每平台：平均播放柱 + 互动率折线副轴）
 */
function buildPlatformComparisonOption(analysis) {
  const platforms =
    analysis &&
    analysis.platformComparison &&
    Array.isArray(analysis.platformComparison.platforms)
      ? analysis.platformComparison.platforms
      : [];

  if (!platforms.length) {
    return createEmptyOption("暂无覆盖 ≥2 平台的同款内容");
  }

  const names = platforms.map((p) => p.platform);
  const playData = platforms.map((p) => ({
    value: toFiniteOrNull(p.avgPlay),
    platform: p.platform,
    sampleCount: p.sampleCount,
    lowSample: Boolean(p.lowSample),
    itemStyle: {
      color: getPlatformColor(p.platform),
      borderRadius: [4, 4, 0, 0],
    },
  }));
  const engData = platforms.map((p) => toFiniteOrNull(p.engagementRatePct));
  const hasAny =
    playData.some((d) => d.value !== null) || engData.some((v) => v !== null);
  if (!hasAny) {
    return createEmptyOption("暂无可对比的平台播放或互动率数据");
  }

  return {
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      confine: true,
      formatter(params) {
        const list = Array.isArray(params) ? params : [params];
        if (!list.length) return "";
        const idx = list[0].dataIndex;
        const row = platforms[idx];
        if (!row) return "";
        const lines = [
          `<div style="font-weight:600;margin-bottom:4px;">${escapeHtml(row.platform)}（样本 ${row.sampleCount} 条${row.lowSample ? " · 样本少" : ""}）</div>`,
          `<div>平均播放：<b>${escapeHtml(formatNum(row.avgPlay))}</b></div>`,
          `<div>互动率：<b>${row.engagementRatePct != null ? `${escapeHtml(row.engagementRatePct)}%` : "-"}</b></div>`,
        ];
        if (row.avgFansDelta != null) {
          lines.push(`<div>平均涨粉：<b>${escapeHtml(formatNum(row.avgFansDelta))}</b></div>`);
        }
        return lines.join("");
      },
    },
    legend: {
      top: 0,
      left: 0,
      textStyle: { fontSize: 12, color: "#606266" },
    },
    grid: {
      top: 40,
      left: 16,
      right: 20,
      bottom: 14,
      containLabel: true,
    },
    xAxis: {
      type: "category",
      data: names,
      axisLabel: { color: "#303133", fontSize: 12 },
      axisLine: { lineStyle: { color: "#dcdfe6" } },
    },
    yAxis: [
      {
        type: "value",
        name: "平均播放",
        nameTextStyle: { color: "#909399", fontSize: 11 },
        axisLabel: { color: "#606266", fontSize: 11, formatter: formatAxisCompact },
        splitLine: { lineStyle: { color: "#ebeef5" } },
      },
      {
        type: "value",
        name: "互动率(%)",
        nameTextStyle: { color: "#909399", fontSize: 11 },
        axisLabel: { color: "#606266", fontSize: 11, formatter: "{value}%" },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: "平均播放",
        type: "bar",
        yAxisIndex: 0,
        barMaxWidth: 42,
        data: playData,
      },
      {
        name: "互动率",
        type: "line",
        yAxisIndex: 1,
        connectNulls: false,
        symbol: "circle",
        symbolSize: 7,
        itemStyle: { color: "#409eff" },
        lineStyle: { color: "#409eff", width: 2 },
        data: engData,
      },
    ],
  };
}

/**
 * 3. 作品排行：Top10 / Bottom10 横向条形图（按平台堆叠，可切 播放 / 互动率 / 涨粉）
 */
function buildRankingTop10Option(analysis, options = {}) {
  const metric =
    options && (options.metric === "engagement" || options.metric === "fans")
      ? options.metric
      : "play";
  const order = options && options.order === "bottom" ? "bottom" : "top";
  const orderLabel = order === "bottom" ? "Bottom 10" : "Top 10";

  let rawList;
  if (options && Array.isArray(options.items)) {
    rawList = options.items;
  } else {
    const rankings = analysis && analysis.rankings;
    const bucket =
      rankings &&
      (metric === "engagement"
        ? rankings.byEngagement
        : metric === "fans"
        ? rankings.byFans
        : rankings.byPlay);
    rawList = bucket && Array.isArray(bucket[order]) ? bucket[order] : [];
  }
  const items = rawList.slice(0, RANKING_TOP_LIMIT);

  if (!items.length) {
    return createEmptyOption(`暂无作品排行 ${orderLabel} 数据`);
  }

  const unitLabel =
    metric === "engagement" ? "互动率(%)" : metric === "fans" ? "总涨粉" : "总播放";

  // 收集当前排行涉及的所有平台（按固定顺序排序）
  const platformSet = new Set();
  for (const it of items) {
    if (it && Array.isArray(it.platforms)) {
      for (const p of it.platforms) {
        if (p && p.platform) platformSet.add(p.platform);
      }
    }
  }
  const platforms = [...platformSet].sort(comparePlatform);

  const yLabels = items.map((it, idx) => `${idx + 1}. ${truncateText(it.title || "(无标题)", 14)}`);
  let series;

  if (platforms.length > 0) {
    series = platforms.map((platform) => {
      const color = getPlatformColor(platform);
      const data = items.map((it) => {
        const pCell =
          it && Array.isArray(it.platforms)
            ? it.platforms.find((p) => p && p.platform === platform)
            : null;
        if (!pCell) return null;
        if (metric === "engagement") {
          // 优先使用未提前舍入的原始互动率贡献值绘图，避免各平台分段提前舍入导致堆叠合计偏离表格
          const v =
            pCell.rawEngagementContribPct != null
              ? pCell.rawEngagementContribPct
              : pCell.engagementContribPct != null
              ? pCell.engagementContribPct
              : pCell.engagementRatePct;
          return toFiniteOrNull(v);
        }
        if (metric === "fans") return toFiniteOrNull(pCell.fansDelta);
        return toFiniteOrNull(pCell.play);
      });
      return {
        name: platform,
        type: "bar",
        stack: "total",
        barMaxWidth: 20,
        itemStyle: { color },
        data,
      };
    });
  } else {
    // 兜底：当排行条目缺少分平台明细时退化为单系列堆叠条
    const fallbackData = items.map((it) => {
      if (metric === "engagement") return toFiniteOrNull(it.engagementRatePct);
      if (metric === "fans") return toFiniteOrNull(it.totalFansDelta);
      return toFiniteOrNull(it.totalPlay);
    });
    series = [
      {
        name: "全平台",
        type: "bar",
        stack: "total",
        barMaxWidth: 20,
        itemStyle: { color: "#409eff" },
        data: fallbackData,
      },
    ];
  }

  const hasAny = series.some((s) => s.data.some((v) => v !== null));
  if (!hasAny) {
    return createEmptyOption(`暂无作品排行 ${orderLabel} 数据`);
  }

  return {
    color: platforms.length ? platforms.map(getPlatformColor) : ["#409eff"],
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      confine: true,
      formatter(params) {
        const list = Array.isArray(params) ? params : [params];
        if (!list.length) return "";
        const idx = list[0].dataIndex;
        const row = items[idx];
        if (!row) return "";
        let totalText;
        if (metric === "engagement") {
          if (row.engagementRatePct != null) {
            totalText = `${round2(row.engagementRatePct)}%`;
          } else {
            let sumRaw = 0;
            let hasAnyRaw = false;
            for (const p of list) {
              if (typeof p.value === "number" && Number.isFinite(p.value)) {
                sumRaw += p.value;
                hasAnyRaw = true;
              }
            }
            totalText = hasAnyRaw ? `${round2(sumRaw)}%` : "-";
          }
        } else if (metric === "fans") {
          totalText = formatNum(row.totalFansDelta);
        } else {
          totalText = formatNum(row.totalPlay);
        }
        const lines = [
          `<div style="font-weight:600;margin-bottom:4px;">#${idx + 1} ${escapeHtml(row.title || "(无标题)")}</div>`,
          `<div style="margin-bottom:4px;">${escapeHtml(unitLabel)}合计：<b>${escapeHtml(totalText)}</b></div>`,
        ];
        for (const p of list) {
          if (p.value == null) continue;
          if (metric === "engagement") {
            const pCell =
              Array.isArray(row.platforms) &&
              row.platforms.find((x) => x && x.platform === p.seriesName);
            const displayContrib =
              typeof p.value === "number" && Number.isFinite(p.value)
                ? round2(p.value)
                : p.value;
            const ownTxt =
              pCell && pCell.engagementRatePct != null
                ? `（本端互动率 ${round2(pCell.engagementRatePct)}%）`
                : "";
            lines.push(
              `<div>${p.marker}${escapeHtml(p.seriesName)}：<b>${escapeHtml(displayContrib)}%</b>${escapeHtml(ownTxt)}</div>`
            );
          } else {
            lines.push(
              `<div>${p.marker}${escapeHtml(p.seriesName)}：<b>${escapeHtml(formatNum(p.value))}</b></div>`
            );
          }
        }
        return lines.join("");
      },
    },
    legend: {
      type: "scroll",
      top: 0,
      left: 0,
      textStyle: { fontSize: 12, color: "#606266" },
    },
    grid: {
      top: 34,
      left: 12,
      right: 26,
      bottom: 12,
      containLabel: true,
    },
    xAxis: {
      type: "value",
      name: unitLabel,
      nameTextStyle: { color: "#909399", fontSize: 11 },
      axisLabel: {
        color: "#606266",
        fontSize: 11,
        formatter:
          metric === "engagement"
            ? (v) => (typeof v === "number" && Number.isFinite(v) ? `${round2(v)}%` : "")
            : formatAxisCompact,
      },
      splitLine: { lineStyle: { color: "#ebeef5" } },
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: yLabels,
      axisLabel: { color: "#303133", fontSize: 11 },
      axisLine: { lineStyle: { color: "#dcdfe6" } },
    },
    series,
  };
}

/**
 * 4a. 新作品走势：D1 / D3 / D7 折线图（最多 10 条，按 D7 排序，图例可点选）
 */
function buildNewWorksTrajectoryOption(analysis) {
  const rawItems =
    analysis && analysis.newWorks && Array.isArray(analysis.newWorks.items)
      ? analysis.newWorks.items
      : [];

  const validItems = rawItems.filter(
    (it) =>
      it &&
      (toFiniteOrNull(it.d1Play) !== null ||
        toFiniteOrNull(it.d3Play) !== null ||
        toFiniteOrNull(it.d7Play) !== null)
  );

  if (!validItems.length) {
    return createEmptyOption("本周期暂无新作品 D1/D3/D7 走势数据");
  }

  // 按 D7 降序排序（有 D7 的排前，缺 D7 回退 D3/D1/latestPlay）
  const sorted = [...validItems]
    .sort((a, b) => {
      const ad7 = toFiniteOrNull(a.d7Play);
      const bd7 = toFiniteOrNull(b.d7Play);
      if (ad7 !== null && bd7 === null) return -1;
      if (ad7 === null && bd7 !== null) return 1;
      if (ad7 !== null && bd7 !== null && bd7 !== ad7) return bd7 - ad7;
      const aFb = toFiniteOrNull(a.d3Play) ?? toFiniteOrNull(a.d1Play) ?? toFiniteOrNull(a.latestPlay) ?? -Infinity;
      const bFb = toFiniteOrNull(b.d3Play) ?? toFiniteOrNull(b.d1Play) ?? toFiniteOrNull(b.latestPlay) ?? -Infinity;
      if (bFb !== aFb) return bFb - aFb;
      return compareText(a.contentKey, b.contentKey);
    })
    .slice(0, NEW_WORKS_MAX_LINES);

  const nameCounts = new Map();
  const series = sorted.map((it, idx) => {
    const baseName = truncateText(it.title || "(无标题)", 14);
    const seen = nameCounts.get(baseName) || 0;
    nameCounts.set(baseName, seen + 1);
    const name = seen > 0 ? `${baseName} (${seen + 1})` : baseName;
    const color = NEW_WORK_PALETTE[idx % NEW_WORK_PALETTE.length];
    return {
      name,
      type: "line",
      connectNulls: false,
      symbol: "circle",
      symbolSize: 6,
      itemStyle: { color },
      lineStyle: { color, width: 2 },
      data: [
        toFiniteOrNull(it.d1Play),
        toFiniteOrNull(it.d3Play),
        toFiniteOrNull(it.d7Play),
      ],
      contentKey: it.contentKey,
      fullTitle: it.title || "(无标题)",
      category: it.category || "",
    };
  });

  return {
    color: sorted.map((_, idx) => NEW_WORK_PALETTE[idx % NEW_WORK_PALETTE.length]),
    tooltip: {
      trigger: "axis",
      confine: true,
      formatter(params) {
        const list = Array.isArray(params) ? params : [params];
        if (!list.length) return "";
        const milestone = list[0].axisValueLabel || list[0].axisValue || "";
        const lines = [`<div style="font-weight:600;margin-bottom:4px;">${escapeHtml(milestone)} 累计播放</div>`];
        for (const p of list) {
          const valStr = p.value == null ? "-" : formatNum(p.value);
          lines.push(
            `<div>${p.marker}${escapeHtml(p.seriesName)}：<b>${escapeHtml(valStr)}</b></div>`
          );
        }
        return lines.join("");
      },
    },
    legend: {
      type: "scroll",
      bottom: 0,
      selectedMode: true,
      textStyle: { fontSize: 11, color: "#606266" },
    },
    grid: {
      top: 26,
      left: 16,
      right: 18,
      bottom: 36,
      containLabel: true,
    },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: ["D1", "D3", "D7"],
      axisLabel: { color: "#303133", fontSize: 12 },
      axisLine: { lineStyle: { color: "#dcdfe6" } },
    },
    yAxis: {
      type: "value",
      name: "累计播放",
      nameTextStyle: { color: "#909399", fontSize: 11 },
      axisLabel: { color: "#606266", fontSize: 11, formatter: formatAxisCompact },
      splitLine: { lineStyle: { color: "#ebeef5" } },
    },
    series,
  };
}

/**
 * 4b. 新作品走势：分类占比小饼图
 */
function buildNewWorksCategoryPieOption(analysis) {
  const counts =
    analysis && analysis.newWorks && analysis.newWorks.categoryCounts
      ? analysis.newWorks.categoryCounts
      : null;

  if (!counts) {
    return createEmptyOption("暂无新作品分类数据");
  }

  const data = [];
  for (const spec of CATEGORY_SPECS) {
    const val = toFiniteOrNull(counts[spec.name]);
    if (val !== null && val > 0) {
      data.push({
        name: spec.name,
        value: val,
        itemStyle: { color: spec.color },
      });
    }
  }

  if (!data.length) {
    return createEmptyOption("本周期暂无新发布内容");
  }

  return {
    color: data.map((d) => d.itemStyle.color),
    tooltip: {
      trigger: "item",
      confine: true,
      formatter(p) {
        return `${p.marker}${escapeHtml(p.name)}：<b>${escapeHtml(p.value)}</b> 条（${escapeHtml(p.percent)}%）`;
      },
    },
    legend: {
      bottom: 0,
      textStyle: { fontSize: 11, color: "#606266" },
    },
    series: [
      {
        name: "走势分类占比",
        type: "pie",
        radius: ["38%", "68%"],
        center: ["50%", "42%"],
        itemStyle: {
          borderColor: "#ffffff",
          borderWidth: 2,
        },
        label: {
          show: true,
          fontSize: 11,
          color: "#606266",
          formatter: "{b} {c}条",
        },
        data,
      },
    ],
  };
}

/**
 * 5. 发布时间：星期 × 时段热力图（颜色=平均 D7 播放，tooltip 显样本数，样本 <3 半透明）
 */
function buildPublishTimeHeatmapOption(analysis) {
  const groups =
    analysis &&
    analysis.publishTime &&
    Array.isArray(analysis.publishTime.groups)
      ? analysis.publishTime.groups
      : [];

  if (!groups.length) {
    return createEmptyOption("暂无带发布时间与快照的内容样本");
  }

  const data = [];
  let maxVal = 0;

  for (const g of groups) {
    if (!g) continue;
    const xIdx =
      typeof g.weekday === "number" && g.weekday >= 1 && g.weekday <= 7
        ? g.weekday - 1
        : HEATMAP_WEEKDAYS.indexOf(g.weekdayLabel);
    const yIdx = HEATMAP_SLOTS.indexOf(g.slot);
    if (xIdx < 0 || yIdx < 0) continue;
    const avgPlay = toFiniteOrNull(g.avgD7Play);
    if (avgPlay === null) continue;
    if (avgPlay > maxVal) maxVal = avgPlay;

    const sampleCount = typeof g.sampleCount === "number" ? g.sampleCount : 0;
    const lowSample = Boolean(g.lowSample || sampleCount < LOW_SAMPLE_THRESHOLD);
    data.push({
      value: [xIdx, yIdx, avgPlay],
      weekdayLabel: g.weekdayLabel || HEATMAP_WEEKDAYS[xIdx],
      slot: g.slot,
      sampleCount,
      lowSample,
      fallbackCount: g.fallbackCount || 0,
      hasFallback: Boolean(g.hasFallback),
      note: g.note || "",
      itemStyle: {
        opacity: lowSample ? 0.45 : 1,
      },
    });
  }

  if (!data.length) {
    return createEmptyOption("暂无带发布时间与快照的内容样本");
  }

  return {
    tooltip: {
      position: "top",
      confine: true,
      formatter(p) {
        const d = p && p.data;
        if (!d) return "";
        const val = Array.isArray(d.value) ? d.value[2] : null;
        const lines = [
          `<div style="font-weight:600;margin-bottom:4px;">${escapeHtml(d.weekdayLabel)} ${escapeHtml(d.slot)}（UTC+8）</div>`,
          `<div>平均 D7 播放：<b>${escapeHtml(formatNum(val))}</b></div>`,
          `<div>样本数：<b>${escapeHtml(d.sampleCount)}</b> 条${d.lowSample ? ' <span style="color:#e6a23c;">（样本 &lt; 3，仅供参考）</span>' : ""}</div>`,
        ];
        if (d.hasFallback) {
          lines.push(
            `<div style="color:#909399;">含不足 7 天最新累计样本：${escapeHtml(d.fallbackCount)} 条</div>`
          );
        }
        return lines.join("");
      },
    },
    grid: {
      top: 16,
      left: 16,
      right: 20,
      bottom: 48,
      containLabel: true,
    },
    xAxis: {
      type: "category",
      data: [...HEATMAP_WEEKDAYS],
      splitArea: { show: true },
      axisLabel: { color: "#303133", fontSize: 12 },
      axisLine: { lineStyle: { color: "#dcdfe6" } },
    },
    yAxis: {
      type: "category",
      data: [...HEATMAP_SLOTS],
      splitArea: { show: true },
      axisLabel: { color: "#303133", fontSize: 12 },
      axisLine: { lineStyle: { color: "#dcdfe6" } },
    },
    visualMap: {
      min: 0,
      max: maxVal > 0 ? maxVal : 1,
      calculable: false,
      orient: "horizontal",
      left: "center",
      bottom: 0,
      itemWidth: 12,
      itemHeight: 140,
      text: ["高", "低"],
      textStyle: { color: "#606266", fontSize: 11 },
      inRange: {
        color: ["#edf5ff", "#a0cfff", "#409eff", "#1b5ec2"],
      },
    },
    series: [
      {
        name: "平均 D7 播放",
        type: "heatmap",
        data,
        label: {
          show: true,
          fontSize: 11,
          color: "#303133",
          formatter(p) {
            const val = p && p.data && Array.isArray(p.data.value) ? p.data.value[2] : null;
            return val == null ? "" : formatAxisCompact(val);
          },
        },
        emphasis: {
          itemStyle: {
            shadowBlur: 6,
            shadowColor: "rgba(0, 0, 0, 0.25)",
          },
        },
      },
    ],
  };
}

/**
 * 6. 粉丝趋势：各账号粉丝数折线（来自账号日快照，支持按账号筛选）
 */
function buildFansTrendOption(analysis, options = {}) {
  const ft = analysis && analysis.fansTrend;
  const rawDates = ft && Array.isArray(ft.dates) ? ft.dates : [];
  const rawAccounts = ft && Array.isArray(ft.accounts) ? ft.accounts : [];
  const range = analysis && analysis.currentRange;

  const selected =
    options && Array.isArray(options.selectedAccounts) && options.selectedAccounts.length > 0
      ? new Set(options.selectedAccounts)
      : null;

  const filtered = selected
    ? rawAccounts.filter((a) => a && selected.has(a.accountKey))
    : rawAccounts.filter(Boolean);

  const dates = buildContinuousDates(rawDates, range);
  if (!dates.length || !filtered.length) {
    return createEmptyOption("暂无账号粉丝快照数据");
  }

  const dateToIdx = new Map();
  for (let i = 0; i < dates.length; i++) dateToIdx.set(dates[i], i);

  const platformLineCount = new Map();
  const useLttb = shouldUseLttb(filtered.length, dates.length);
  const series = [];
  let hasAnyVal = false;

  for (const acc of filtered) {
    const aligned = new Array(dates.length).fill(null);
    const src = Array.isArray(acc.fans) ? acc.fans : [];
    for (let i = 0; i < rawDates.length && i < src.length; i++) {
      const idx = dateToIdx.get(rawDates[i]);
      if (idx === undefined) continue;
      const v = toFiniteOrNull(src[i]);
      if (v !== null) {
        aligned[idx] = v;
        hasAnyVal = true;
      }
    }
    const color = getPlatformColor(acc.platform);
    const ptIdx = platformLineCount.get(acc.platform) || 0;
    platformLineCount.set(acc.platform, ptIdx + 1);
    const lineType = SAME_PLATFORM_LINE_TYPES[ptIdx % SAME_PLATFORM_LINE_TYPES.length];

    const s = {
      name: acc.label || (acc.group ? `${acc.platform}·${acc.group}` : acc.platform),
      type: "line",
      data: aligned,
      connectNulls: false,
      ...buildLineSymbolConfig(aligned, dates.length),
      itemStyle: { color },
      lineStyle: { color, width: 2, type: lineType },
      platform: acc.platform,
      accountKey: acc.accountKey,
    };
    if (useLttb) {
      s.sampling = "lttb";
    }
    series.push(s);
  }

  if (!hasAnyVal) {
    return createEmptyOption("暂无账号粉丝快照数据");
  }

  return {
    color: series.map((s) => s.itemStyle.color),
    tooltip: {
      trigger: "axis",
      confine: true,
      formatter(params) {
        const list = Array.isArray(params) ? params : [params];
        if (!list.length) return "";
        const date = list[0].axisValueLabel || list[0].axisValue || "";
        const lines = [`<div style="font-weight:600;margin-bottom:4px;">${escapeHtml(date)} · 粉丝数</div>`];
        for (const p of list) {
          const valStr = p.value == null ? "-" : formatNum(p.value);
          lines.push(
            `<div>${p.marker}${escapeHtml(p.seriesName)}：<b>${escapeHtml(valStr)}</b></div>`
          );
        }
        return lines.join("");
      },
    },
    legend: {
      type: "scroll",
      top: 0,
      left: 0,
      textStyle: { fontSize: 12, color: "#606266" },
    },
    grid: {
      top: 38,
      left: 16,
      right: 18,
      bottom: 14,
      containLabel: true,
    },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: dates,
      axisLabel: {
        color: "#606266",
        fontSize: 11,
        formatter(v) {
          return typeof v === "string" && v.length === 10 ? v.slice(5) : v;
        },
      },
      axisLine: { lineStyle: { color: "#dcdfe6" } },
    },
    yAxis: {
      type: "value",
      name: "粉丝数",
      scale: true,
      nameTextStyle: { color: "#909399", fontSize: 11 },
      axisLabel: { color: "#606266", fontSize: 11, formatter: formatAxisCompact },
      splitLine: { lineStyle: { color: "#ebeef5" } },
    },
    series,
  };
}

/**
 * 作品汇总弹窗：单条内容各平台累计播放折线 + 播放日增柱（x=连续日期，缺天补空不断连）
 */
function buildContentTrendOption(trendData) {
  if (!trendData || typeof trendData !== "object") {
    return createEmptyOption("该内容暂无作品日明细数据");
  }
  const rawDates = Array.isArray(trendData.dates) ? trendData.dates : [];
  const rawPlatforms = Array.isArray(trendData.platforms) ? trendData.platforms : [];
  const rawTotalDelta = Array.isArray(trendData.totalPlayDelta) ? trendData.totalPlayDelta : [];

  const dates = buildContinuousDates(rawDates, {
    from: trendData.from,
    to: trendData.to,
  });
  if (!dates.length || !rawPlatforms.length) {
    return createEmptyOption("该内容暂无作品日明细快照");
  }

  const dateToIdx = new Map();
  for (let i = 0; i < dates.length; i++) dateToIdx.set(dates[i], i);

  const sortedPlatforms = [...rawPlatforms]
    .filter((p) => p && p.platform)
    .sort((a, b) => comparePlatform(a.platform, b.platform));

  const useLttb = shouldUseLttb(sortedPlatforms.length, dates.length);
  const series = [];
  const platformDeltaAligned = new Map();
  let hasAnyVal = false;

  for (const pt of sortedPlatforms) {
    const playAligned = new Array(dates.length).fill(null);
    const deltaAligned = new Array(dates.length).fill(null);
    const srcPlay = Array.isArray(pt.play) ? pt.play : [];
    const srcDelta = Array.isArray(pt.playDelta) ? pt.playDelta : [];
    for (let i = 0; i < rawDates.length; i++) {
      const idx = dateToIdx.get(rawDates[i]);
      if (idx === undefined) continue;
      const pv = i < srcPlay.length ? toFiniteOrNull(srcPlay[i]) : null;
      const dv = i < srcDelta.length ? toFiniteOrNull(srcDelta[i]) : null;
      if (pv !== null) {
        playAligned[idx] = pv;
        hasAnyVal = true;
      }
      if (dv !== null) {
        deltaAligned[idx] = dv;
        hasAnyVal = true;
      }
    }
    platformDeltaAligned.set(pt.platform, deltaAligned);

    const color = getPlatformColor(pt.platform);
    const s = {
      name: pt.platform,
      type: "line",
      yAxisIndex: 0,
      connectNulls: false,
      ...buildLineSymbolConfig(playAligned, dates.length),
      itemStyle: { color },
      lineStyle: { color, width: 2 },
      data: playAligned,
    };
    if (useLttb) {
      s.sampling = "lttb";
    }
    series.push(s);
  }

  const totalDeltaAligned = new Array(dates.length).fill(null);
  for (let i = 0; i < rawDates.length && i < rawTotalDelta.length; i++) {
    const idx = dateToIdx.get(rawDates[i]);
    if (idx === undefined) continue;
    const dv = toFiniteOrNull(rawTotalDelta[i]);
    if (dv !== null) {
      totalDeltaAligned[idx] = dv;
      hasAnyVal = true;
    }
  }

  if (!hasAnyVal) {
    return createEmptyOption("该内容暂无播放明细快照");
  }

  series.push({
    name: "播放日增",
    type: "bar",
    yAxisIndex: 1,
    barMaxWidth: 24,
    itemStyle: {
      color: "rgba(64, 158, 255, 0.35)",
      borderRadius: [3, 3, 0, 0],
    },
    data: totalDeltaAligned,
  });

  return {
    color: [...sortedPlatforms.map((p) => getPlatformColor(p.platform)), "#409eff"],
    tooltip: {
      trigger: "axis",
      confine: true,
      formatter(params) {
        const list = Array.isArray(params) ? params : [params];
        if (!list.length) return "";
        const idx = list[0].dataIndex;
        const date = list[0].axisValueLabel || list[0].axisValue || "";
        const lines = [`<div style="font-weight:600;margin-bottom:4px;">${escapeHtml(date)}</div>`];
        for (const p of list) {
          if (p.seriesType === "bar") {
            const sign = typeof p.value === "number" && p.value > 0 ? "+" : "";
            const valStr = p.value == null ? "-" : `${sign}${formatNum(p.value)}`;
            lines.push(
              `<div style="margin-top:2px;">${p.marker}${escapeHtml(p.seriesName)}：<b>${escapeHtml(valStr)}</b></div>`
            );
          } else {
            const pDeltas = platformDeltaAligned.get(p.seriesName);
            const dv = pDeltas ? pDeltas[idx] : null;
            const deltaSuffix =
              dv != null ? `（日增 ${dv > 0 ? "+" : ""}${formatNum(dv)}）` : "";
            const valStr = p.value == null ? "-" : formatNum(p.value);
            lines.push(
              `<div>${p.marker}${escapeHtml(p.seriesName)}累计：<b>${escapeHtml(valStr)}</b>${escapeHtml(deltaSuffix)}</div>`
            );
          }
        }
        return lines.join("");
      },
    },
    legend: {
      type: "scroll",
      top: 0,
      left: 0,
      textStyle: { fontSize: 12, color: "#606266" },
    },
    grid: {
      top: 40,
      left: 16,
      right: 20,
      bottom: 14,
      containLabel: true,
    },
    xAxis: {
      type: "category",
      boundaryGap: true,
      data: dates,
      axisLabel: {
        color: "#606266",
        fontSize: 11,
        formatter(v) {
          return typeof v === "string" && v.length === 10 ? v.slice(5) : v;
        },
      },
      axisLine: { lineStyle: { color: "#dcdfe6" } },
    },
    yAxis: [
      {
        type: "value",
        name: "累计播放",
        nameTextStyle: { color: "#909399", fontSize: 11 },
        axisLabel: { color: "#606266", fontSize: 11, formatter: formatAxisCompact },
        splitLine: { lineStyle: { color: "#ebeef5" } },
      },
      {
        type: "value",
        name: "播放日增",
        nameTextStyle: { color: "#909399", fontSize: 11 },
        axisLabel: { color: "#606266", fontSize: 11, formatter: formatAxisCompact },
        splitLine: { show: false },
      },
    ],
    series,
  };
}

const SLOT_KEY_RE = /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3]):([0-5]\d)$/;

function parseIntradayTimestampMs(raw) {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const s = raw.trim();
    const ms = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return null;
}

function parseSlotKeyToUtc8Ms(slotKey) {
  if (typeof slotKey !== "string") return null;
  const m = SLOT_KEY_RE.exec(slotKey.trim());
  if (!m) return null;
  const dayNum = dateStrToDayNum(m[1]);
  if (dayNum === null) return null;
  return dayNum * DAY_MS + (Number(m[2]) * 60 + Number(m[3])) * 60000 - 8 * 3600e3;
}

function formatUtc8AxisDateTime(ms) {
  const n = typeof ms === "number" ? ms : Number(ms);
  if (!Number.isFinite(n)) return "";
  const iso = new Date(n + 8 * 3600e3).toISOString();
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

function formatUtc8TooltipDateTime(ms) {
  const n = typeof ms === "number" ? ms : Number(ms);
  if (!Number.isFinite(n)) return "";
  const iso = new Date(n + 8 * 3600e3).toISOString();
  const sec = iso.slice(17, 19);
  return sec === "00"
    ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
    : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

/**
 * 作品汇总弹窗「按时段」：
 * - x 轴为真实时间轴（type: "time"），各平台曲线用各自实际 collectedAt 作为 x
 * - 增量按各自平台上一点计算；槽键仅在 tooltip 显示归属
 */
function buildContentIntradayOption(intradayData) {
  if (!intradayData || typeof intradayData !== "object") {
    return createEmptyOption("该内容在所选时段内暂无分时段快照");
  }
  const timePoints = Array.isArray(intradayData.timePoints)
    ? intradayData.timePoints.map((t) => (typeof t === "string" ? t.trim() : ""))
    : [];
  const rawCollectedAts = Array.isArray(intradayData.collectedAts)
    ? intradayData.collectedAts
    : [];
  const rawPlatforms = Array.isArray(intradayData.platforms) ? intradayData.platforms : [];
  const rawTotalDelta = Array.isArray(intradayData.totalPlayDelta)
    ? intradayData.totalPlayDelta
    : [];

  if (!rawPlatforms.length) {
    return createEmptyOption("该内容在所选时段内暂无分时段快照");
  }

  const sortedPlatforms = [...rawPlatforms]
    .filter((p) => p && p.platform)
    .sort((a, b) => comparePlatform(a.platform, b.platform));

  if (!sortedPlatforms.length) {
    return createEmptyOption("该内容在所选时段内暂无分时段快照");
  }

  const platformLineEntries = [];
  const deltaByXMs = new Map();
  let usedStructuredPoints = false;
  let hasAnyVal = false;
  let totalLinePointCount = 0;
  let maxPlatformPointCount = 0;

  for (const pt of sortedPlatforms) {
    const pts = [];
    if (Array.isArray(pt.points)) {
      usedStructuredPoints = true;
      for (let i = 0; i < pt.points.length; i++) {
        const rawPt = pt.points[i];
        if (!rawPt || typeof rawPt !== "object") continue;
        const dStr = typeof rawPt.date === "string" ? rawPt.date.trim() : "";
        const sStr = typeof rawPt.slot === "string" ? rawPt.slot.trim() : "";
        const tk =
          typeof rawPt.timeKey === "string" && rawPt.timeKey.trim()
            ? rawPt.timeKey.trim()
            : dStr && sStr
            ? `${dStr} ${sStr}`
            : "";
        const xMs =
          parseIntradayTimestampMs(rawPt.collectedAt) ?? parseSlotKeyToUtc8Ms(tk);
        if (xMs === null) continue;
        const pv = toFiniteOrNull(rawPt.play);
        const dv = toFiniteOrNull(rawPt.playDelta);
        if (pv !== null || dv !== null) hasAnyVal = true;
        pts.push({
          xMs,
          date: dStr || (tk.length >= 10 ? tk.slice(0, 10) : ""),
          slot: sStr || (tk.length >= 16 ? tk.slice(11, 16) : ""),
          timeKey: tk,
          play: pv,
          playDelta: dv,
        });
      }
    } else {
      const srcPlay = Array.isArray(pt.play) ? pt.play : [];
      const srcDelta = Array.isArray(pt.playDelta) ? pt.playDelta : [];
      const len = Math.max(timePoints.length, rawCollectedAts.length, srcPlay.length, srcDelta.length);
      for (let i = 0; i < len; i++) {
        const pv = i < srcPlay.length ? toFiniteOrNull(srcPlay[i]) : null;
        const dv = i < srcDelta.length ? toFiniteOrNull(srcDelta[i]) : null;
        if (pv === null && dv === null) continue;
        const tk = i < timePoints.length ? timePoints[i] : "";
        const xMs =
          (i < rawCollectedAts.length ? parseIntradayTimestampMs(rawCollectedAts[i]) : null) ??
          parseSlotKeyToUtc8Ms(tk);
        if (xMs === null) continue;
        hasAnyVal = true;
        pts.push({
          xMs,
          date: tk.length >= 10 ? tk.slice(0, 10) : "",
          slot: tk.length >= 16 ? tk.slice(11, 16) : "",
          timeKey: tk,
          play: pv,
          playDelta: dv,
        });
      }
    }

    pts.sort((a, b) => {
      if (a.xMs !== b.xMs) return a.xMs - b.xMs;
      return compareText(a.timeKey, b.timeKey);
    });

    if (pts.length > maxPlatformPointCount) maxPlatformPointCount = pts.length;
    totalLinePointCount += pts.length;

    const lineData = pts.map((p) => {
      if (p.playDelta !== null) {
        let agg = deltaByXMs.get(p.xMs);
        if (!agg) {
          agg = { xMs: p.xMs, delta: p.playDelta, slots: new Set() };
          deltaByXMs.set(p.xMs, agg);
        } else {
          const sum = agg.delta + p.playDelta;
          agg.delta = sum === 0 ? 0 : sum;
        }
        if (p.timeKey) agg.slots.add(p.timeKey);
      }
      return {
        value: [p.xMs, p.play],
        collectedAt: p.xMs,
        date: p.date,
        slot: p.slot,
        timeKey: p.timeKey,
        playDelta: p.playDelta,
      };
    });

    platformLineEntries.push({ platform: pt.platform, lineData });
  }

  // 兼容旧结构仅提供 totalPlayDelta 而未提供各平台 playDelta 的场景
  if (!usedStructuredPoints && deltaByXMs.size === 0 && rawTotalDelta.length > 0) {
    for (let i = 0; i < rawTotalDelta.length; i++) {
      const dv = toFiniteOrNull(rawTotalDelta[i]);
      if (dv === null) continue;
      const tk = i < timePoints.length ? timePoints[i] : "";
      const xMs =
        (i < rawCollectedAts.length ? parseIntradayTimestampMs(rawCollectedAts[i]) : null) ??
        parseSlotKeyToUtc8Ms(tk);
      if (xMs === null) continue;
      hasAnyVal = true;
      let agg = deltaByXMs.get(xMs);
      if (!agg) {
        agg = { xMs, delta: dv, slots: new Set() };
        deltaByXMs.set(xMs, agg);
      } else {
        const sum = agg.delta + dv;
        agg.delta = sum === 0 ? 0 : sum;
      }
      if (tk) agg.slots.add(tk);
    }
  }

  if (!hasAnyVal) {
    return createEmptyOption("该内容在所选时段内暂无分时段播放快照");
  }

  const useLttb =
    maxPlatformPointCount > LTTB_POINT_THRESHOLD || totalLinePointCount > LTTB_POINT_THRESHOLD;
  const series = platformLineEntries.map(({ platform, lineData }) => {
    const color = getPlatformColor(platform);
    const s = {
      name: platform,
      type: "line",
      yAxisIndex: 0,
      connectNulls: false,
      ...buildLineSymbolConfig(lineData, lineData.length),
      itemStyle: { color },
      lineStyle: { color, width: 2 },
      data: lineData,
    };
    if (useLttb) {
      s.sampling = "lttb";
    }
    return s;
  });

  const barData = [...deltaByXMs.values()]
    .sort((a, b) => a.xMs - b.xMs)
    .map((agg) => ({
      value: [agg.xMs, agg.delta === 0 ? 0 : agg.delta],
      collectedAt: agg.xMs,
      timeKey: [...agg.slots].sort(compareText).join(" / "),
    }));

  series.push({
    name: "较上次增量",
    type: "bar",
    yAxisIndex: 1,
    barMaxWidth: 20,
    itemStyle: {
      color: "rgba(64, 158, 255, 0.35)",
      borderRadius: [3, 3, 0, 0],
    },
    data: barData,
  });

  return {
    color: [...sortedPlatforms.map((p) => getPlatformColor(p.platform)), "#409eff"],
    tooltip: {
      trigger: "axis",
      confine: true,
      formatter(params) {
        const list = Array.isArray(params) ? params : [params];
        if (!list.length) return "";
        const first = list[0] || {};
        const firstData = first.data && typeof first.data === "object" ? first.data : null;
        const headerTs =
          (firstData && parseIntradayTimestampMs(firstData.collectedAt)) ??
          (Array.isArray(first.value) ? parseIntradayTimestampMs(first.value[0]) : null) ??
          parseIntradayTimestampMs(first.axisValue);
        const headerLabel =
          headerTs !== null
            ? formatUtc8TooltipDateTime(headerTs)
            : String(first.axisValueLabel || first.axisValue || "");
        const lines = [
          `<div style="font-weight:600;margin-bottom:4px;">${escapeHtml(headerLabel)}</div>`,
        ];
        for (const p of list) {
          if (!p) continue;
          const d = p.data && typeof p.data === "object" ? p.data : null;
          const yVal = Array.isArray(p.value)
            ? p.value[1]
            : d && Array.isArray(d.value)
            ? d.value[1]
            : p.value;
          const slotText =
            (d && typeof d.timeKey === "string" && d.timeKey) ||
            (d && d.date && d.slot ? `${d.date} ${d.slot}` : "") ||
            (d && typeof d.slot === "string" ? d.slot : "");
          if (p.seriesType === "bar") {
            const sign = typeof yVal === "number" && yVal > 0 ? "+" : "";
            const valStr = yVal == null ? "-" : `${sign}${formatNum(yVal)}`;
            const slotSuffix = slotText ? `（归属槽 ${slotText}）` : "";
            lines.push(
              `<div style="margin-top:2px;">${p.marker}${escapeHtml(p.seriesName)}：<b>${escapeHtml(valStr)}</b>${escapeHtml(slotSuffix)}</div>`
            );
          } else {
            const dv = d && d.playDelta !== undefined ? toFiniteOrNull(d.playDelta) : null;
            const deltaSuffix =
              dv != null ? `（较上次 ${dv > 0 ? "+" : ""}${formatNum(dv)}）` : "";
            const slotSuffix = slotText ? ` · 归属槽 ${slotText}` : "";
            const valStr = yVal == null ? "-" : formatNum(yVal);
            lines.push(
              `<div>${p.marker}${escapeHtml(p.seriesName)}累计：<b>${escapeHtml(valStr)}</b>${escapeHtml(deltaSuffix)}${escapeHtml(slotSuffix)}</div>`
            );
          }
        }
        return lines.join("");
      },
    },
    legend: {
      type: "scroll",
      top: 0,
      left: 0,
      textStyle: { fontSize: 12, color: "#606266" },
    },
    grid: {
      top: 40,
      left: 16,
      right: 20,
      bottom: 18,
      containLabel: true,
    },
    xAxis: {
      type: "time",
      axisLabel: {
        color: "#606266",
        fontSize: 11,
        formatter(v) {
          return formatUtc8AxisDateTime(v);
        },
      },
      axisLine: { lineStyle: { color: "#dcdfe6" } },
    },
    yAxis: [
      {
        type: "value",
        name: "累计播放",
        nameTextStyle: { color: "#909399", fontSize: 11 },
        axisLabel: { color: "#606266", fontSize: 11, formatter: formatAxisCompact },
        splitLine: { lineStyle: { color: "#ebeef5" } },
      },
      {
        type: "value",
        name: "较上次增量",
        nameTextStyle: { color: "#909399", fontSize: 11 },
        axisLabel: { color: "#606266", fontSize: 11, formatter: formatAxisCompact },
        splitLine: { show: false },
      },
    ],
    series,
  };
}

/**
 * 4b. 新作品前 24 小时起量折线图：
 * - 近 7 天内发布的内容，x = 发布后小时数 (0..24h)，y = 累计播放
 * - 最多 10 条，按发布时间降序，复用平台配色（同平台多条用线型区分）
 */
function buildNewWorksFirst24hOption(analysis, options = {}) {
  const sec = analysis && analysis.newWorksFirst24h;
  const rawItems = sec && Array.isArray(sec.items) ? sec.items : [];
  const filterPlatform =
    options && typeof options.platform === "string" && options.platform.trim() && options.platform !== "all"
      ? options.platform.trim()
      : "";

  const candidates = [];
  for (const it of rawItems) {
    if (!it || typeof it !== "object") continue;
    let rawPoints = null;
    let colorPlatform = "";
    if (filterPlatform) {
      const pEntry = Array.isArray(it.platforms)
        ? it.platforms.find((p) => p && p.platform === filterPlatform)
        : null;
      if (!pEntry || !Array.isArray(pEntry.points)) continue;
      rawPoints = pEntry.points;
      colorPlatform = filterPlatform;
    } else {
      rawPoints = Array.isArray(it.points) ? it.points : [];
      colorPlatform =
        it.primaryPlatform ||
        (Array.isArray(it.platforms) && it.platforms[0] && it.platforms[0].platform) ||
        "";
    }

    const cleanPoints = [];
    for (const pt of rawPoints) {
      if (!pt || typeof pt !== "object") continue;
      const h = toFiniteOrNull(pt.hours);
      const play = toFiniteOrNull(pt.play);
      if (h === null || h < 0 || h > 24 || play === null) continue;
      cleanPoints.push({
        hours: h,
        play,
        date: typeof pt.date === "string" ? pt.date : "",
        slot: typeof pt.slot === "string" ? pt.slot : "",
        collectedAt: pt.collectedAt || null,
      });
    }
    if (!cleanPoints.length) continue;
    cleanPoints.sort((a, b) => a.hours - b.hours);
    candidates.push({
      contentKey: it.contentKey || "",
      title: it.title || "(无标题)",
      publishDate: it.publishDate || "",
      publishTimeMs: toFiniteOrNull(it.publishTimeMs) || 0,
      platform: colorPlatform,
      points: cleanPoints,
    });
  }

  if (!candidates.length) {
    return createEmptyOption(
      filterPlatform
        ? `近 7 天暂无 ${filterPlatform} 新作品的前 24 小时分时段快照`
        : "近 7 天暂无带分时段快照的新作品"
    );
  }

  const topList = candidates.slice(0, NEW_WORKS_MAX_LINES);
  const nameCounts = new Map();
  const platformLineCount = new Map();

  const series = topList.map((item) => {
    const baseName = truncateText(item.title, 14);
    const seen = nameCounts.get(baseName) || 0;
    nameCounts.set(baseName, seen + 1);
    const name = seen > 0 ? `${baseName} (${seen + 1})` : baseName;

    const color = getPlatformColor(item.platform);
    const ptIdx = platformLineCount.get(item.platform) || 0;
    platformLineCount.set(item.platform, ptIdx + 1);
    const lineType = SAME_PLATFORM_LINE_TYPES[ptIdx % SAME_PLATFORM_LINE_TYPES.length];

    return {
      name,
      type: "line",
      connectNulls: false,
      symbol: "circle",
      symbolSize: 6,
      itemStyle: { color },
      lineStyle: { color, width: 2, type: lineType },
      data: item.points.map((pt) => ({
        value: [pt.hours, pt.play],
        date: pt.date,
        slot: pt.slot,
        collectedAt: pt.collectedAt,
      })),
      contentKey: item.contentKey,
      fullTitle: item.title,
      platform: item.platform,
      publishDate: item.publishDate,
    };
  });

  return {
    color: series.map((s) => s.itemStyle.color),
    tooltip: {
      trigger: "item",
      confine: true,
      formatter(p) {
        if (!p || !p.data || !Array.isArray(p.data.value)) return "";
        const [hours, play] = p.data.value;
        const sObj = series[p.seriesIndex] || {};
        const title = sObj.fullTitle || p.seriesName || "";
        const ptLabel = sObj.platform ? `（${sObj.platform}）` : "";
        const timeStr =
          p.data.date && p.data.slot ? `${p.data.date} ${p.data.slot}` : "";
        const lines = [
          `<div style="font-weight:600;margin-bottom:4px;">${escapeHtml(title)}${escapeHtml(ptLabel)}</div>`,
          `<div>${p.marker}发布后 <b>+${escapeHtml(String(hours))}h</b>：<b>${escapeHtml(formatNum(play))}</b></div>`,
        ];
        if (timeStr) {
          lines.push(`<div style="color:#909399;font-size:11px;">采集时点：${escapeHtml(timeStr)}</div>`);
        }
        return lines.join("");
      },
    },
    legend: {
      type: "scroll",
      bottom: 0,
      selectedMode: true,
      textStyle: { fontSize: 11, color: "#606266" },
    },
    grid: {
      top: 28,
      left: 16,
      right: 22,
      bottom: 48,
      containLabel: true,
    },
    xAxis: {
      type: "value",
      min: 0,
      max: 24,
      interval: 4,
      name: "发布后小时数",
      nameLocation: "middle",
      nameGap: 24,
      nameTextStyle: { color: "#909399", fontSize: 11 },
      axisLabel: {
        color: "#606266",
        fontSize: 11,
        formatter: "{value}h",
      },
      axisLine: { lineStyle: { color: "#dcdfe6" } },
      splitLine: { lineStyle: { color: "#f2f6fc" } },
    },
    yAxis: {
      type: "value",
      name: "累计播放",
      nameTextStyle: { color: "#909399", fontSize: 11 },
      axisLabel: { color: "#606266", fontSize: 11, formatter: formatAxisCompact },
      splitLine: { lineStyle: { color: "#ebeef5" } },
    },
    series,
  };
}

module.exports = {
  PLATFORM_COLORS,
  PLATFORM_ORDER,
  OVERVIEW_METRIC_OPTIONS,
  LTTB_POINT_THRESHOLD,
  HEATMAP_WEEKDAYS,
  HEATMAP_SLOTS,
  getPlatformColor,
  buildContinuousDates,
  createEmptyOption,
  isEmptyChartOption,
  buildStackedMarkPointPatch,
  recomputeStackedMarkPoints,
  buildOverviewTrendOption,
  buildOverviewPieOption,
  buildPlatformComparisonOption,
  buildRankingTop10Option,
  buildNewWorksTrajectoryOption,
  buildNewWorksCategoryPieOption,
  buildNewWorksFirst24hOption,
  buildPublishTimeHeatmapOption,
  buildFansTrendOption,
  buildContentTrendOption,
  buildContentIntradayOption,
};
