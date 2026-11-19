"use strict";

/**
 * 跨平台作品关联与内容级汇总行构建（纯函数模块，不依赖 electron / fs）。
 *
 * 原则：误关联比漏关联更糟；证据不足一律留空（未关联作品单独成行）。
 *
 * 已知限制：同一分组同一平台挂多个账号时，统计存储（userData/data-stats/<分组>/<平台>/）
 * 本身按「分组/平台」合并（上游结构），跨平台关联也只能到这一粒度。
 */

const crypto = require("crypto");
const { WORK_STAT_KEYS, DELETED_WORK_TITLE, normalizeMetric } = require("./statsTable");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;
const ZERO_WIDTH_RE = /[\u200B-\u200F\u2060\uFEFF\u00AD]/g;
const FULLWIDTH_ASCII_RE = /[\uFF01-\uFF5E]/g;
const TRACKING_PARAM_RE =
  /^(?:utm_|share_|spm(?:$|_)|from$|modefrom$|vd_source$|fbclid$|gclid$|xsec_token$|xsec_source$)/i;
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;
const UTC8_MS = 8 * 3600e3;

// 模糊匹配阈值常量（模块导出便于后续调优）
const FUZZY_SIM_THRESHOLD = 0.6;
const FUZZY_MISSING_TIME_PENALTY = 0.1;
const FUZZY_MARGIN_MIN = 0.1;
const FUZZY_MAX_DAY_DIFF = 2;
const FUZZY_SUBSTRING_MIN_LEN = 6;
const FUZZY_SUBSTRING_SCORE = 0.95;
const FUZZY_EPS = 1e-9;
const FUZZY_THRESHOLDS = Object.freeze({
  simThreshold: FUZZY_SIM_THRESHOLD,
  missingTimePenalty: FUZZY_MISSING_TIME_PENALTY,
  marginMin: FUZZY_MARGIN_MIN,
  maxDayDiff: FUZZY_MAX_DAY_DIFF,
  substringMinLen: FUZZY_SUBSTRING_MIN_LEN,
  substringScore: FUZZY_SUBSTRING_SCORE,
});

const XHS_TOPIC_RE = /#[^\s#]+\[话题\]#/g;
const WRAPPED_TOPIC_RE = /(?<![A-Za-z0-9])#[\p{L}\p{N}_-]+#(?=$|[\s\p{P}\p{S}])/gu;
const SINGLE_TOPIC_RE = /(?<![A-Za-z0-9])#[\p{L}\p{N}_-]+/gu;
const KEYCAP_EMOJI_RE = /[#*0-9]\uFE0F?\u20E3/g;
const EXT_PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/gu;
const NON_LETTER_NUM_RE = /[^\p{L}\p{N}]/gu;

const CJK_PUNCT_MAP = {
  "。": ".", "、": ",", "“": '"', "”": '"', "‘": "'", "’": "'",
  "【": "[", "】": "]", "「": "[", "」": "]", "『": "[", "』": "]", "〔": "[", "〕": "]",
  "《": "<", "》": ">", "〈": "<", "〉": ">", "｟": "(", "｠": ")",
  "—": "-", "–": "-", "―": "-", "…": "...", "〜": "~", "·": ".", "・": ".", "｡": ".", "､": ",",
};
const CJK_PUNCT_RE = new RegExp(
  `[${Object.keys(CJK_PUNCT_MAP).map((c) => c.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("")}]`,
  "g"
);

const STAT_TO_TOTAL_KEY = {
  play: "totalPlay", like: "totalLike", comment: "totalComment",
  share: "totalShare", favorite: "totalFavorite", fansDelta: "totalFansDelta",
};

// 对齐 src/main/config/ptConfig.js（index / listIndex / upload），管理页兜底链接不参与直链匹配
const MANAGEMENT_URL_KEYS = new Set([
  "creator.douyin.com/creator-micro/home", "creator.douyin.com/creator-micro/content/manage", "creator.douyin.com/creator-micro/content/post/video",
  "channels.weixin.qq.com/platform", "channels.weixin.qq.com/platform/post/list", "channels.weixin.qq.com/platform/post/create",
  "member.bilibili.com/platform/home", "member.bilibili.com/platform/upload-manager/article", "member.bilibili.com/platform/upload/video/frame",
  "baijiahao.baidu.com/builder/rc/home", "baijiahao.baidu.com/builder/rc/content", "baijiahao.baidu.com/builder/rc/edit",
  "mp.toutiao.com/profile_v4/index", "mp.toutiao.com/profile_v4/manage/content/all", "mp.toutiao.com/profile_v4/xigua/upload-video",
  "cp.kuaishou.com/profile", "cp.kuaishou.com/article/manage/video", "cp.kuaishou.com/article/publish/video",
  "creator.xiaohongshu.com/new/home", "creator.xiaohongshu.com/new/note-manager", "creator.xiaohongshu.com/publish/publish",
  "juejin.cn/login", "juejin.cn/creator/content/article/essays", "juejin.cn/editor/drafts/new",
  "pugc.yueduwuxian.com/fqvideo/login", "pugc.yueduwuxian.com/fqvideo/home/video-list", "pugc.yueduwuxian.com/fqvideo/home/publish-video",
]);

const hasOwn = (obj, k) => Boolean(obj && Object.prototype.hasOwnProperty.call(obj, k));
const isPlainObject = (v) => Boolean(v && typeof v === "object" && !Array.isArray(v));
/** 安全读取文本字段：仅接受 string 或有限 number，对象/数组/null 等视为空串，绝不调用 toString */
function toSafeString(v) {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}
const toSafeTrimmed = (v) => toSafeString(v).trim();
const pushToMap = (map, k, v) => {
  const arr = map.get(k);
  if (arr) arr.push(v);
  else map.set(k, [v]);
};

function isValidDateStr(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (!Number.isFinite(ms)) return false;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  return y >= MIN_YEAR && y <= MAX_YEAR && d.toISOString().slice(0, 10) === s;
}

/** 校验时间戳为合法 Date 且年份（含 UTC+8 偏移）在 2000–2100 内，否则返回 null，不抛错 */
function parseValidTimestampMs(raw) {
  if (raw == null || raw === "") return null;
  let ms = NaN;
  if (typeof raw === "number") ms = raw;
  else if (raw instanceof Date) ms = raw.getTime();
  else if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return null;
    ms = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  }
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const t = d.getTime();
  if (!Number.isFinite(t)) return null;
  const shifted = new Date(t + UTC8_MS);
  if (!Number.isFinite(shifted.getTime())) return null;
  const y = d.getUTCFullYear();
  const sy = shifted.getUTCFullYear();
  return y >= MIN_YEAR && y <= MAX_YEAR && sy >= MIN_YEAR && sy <= MAX_YEAR ? t : null;
}

function toUtc8DateStr(raw) {
  const ms = parseValidTimestampMs(raw);
  return ms === null ? "" : new Date(ms + UTC8_MS).toISOString().slice(0, 10);
}

/** 标题归一化（仅用于匹配）：去零宽字符、全角/中文标点归一、空白归一、去末尾独立话题标签 */
function normalizeTitle(s) {
  let out = toSafeString(s)
    .replace(ZERO_WIDTH_RE, "")
    .replace(FULLWIDTH_ASCII_RE, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(CJK_PUNCT_RE, (ch) => CJK_PUNCT_MAP[ch] || ch)
    .replace(/\s+/g, " ")
    .trim();
  while (out) {
    // 仅剥离尾部、且 # 前为字符串开头或空白的话题标签（保留 C#入门 等词内 #）；
    // 结尾 # 只在小红书 `#xx[话题]#` 格式下允许，避免把 `#2025#` 这类编号剥掉
    const next = out.replace(/(?:^|\s)#(?:[^\s#]+\[话题\]#|[^\s#]+)$/, "").trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

/** 「获取状态」用的精确标题键：仅去零宽字符与首尾空白（与原入口一致，不剥话题/标点） */
function normalizeStatusTitle(s) {
  return toSafeString(s).replace(ZERO_WIDTH_RE, "").trim();
}

/**
 * 提取模糊匹配核心标题：
 * normalizeTitle 后再去掉所有 #话题（含中间的）、emoji、标点与空白，并转小写。
 */
function extractCoreTitle(s) {
  const normalized = normalizeTitle(s);
  if (!normalized) return "";
  return normalized
    .replace(XHS_TOPIC_RE, " ")
    .replace(WRAPPED_TOPIC_RE, " ")
    .replace(SINGLE_TOPIC_RE, " ")
    .replace(KEYCAP_EMOJI_RE, "")
    .replace(EXT_PICTOGRAPHIC_RE, "")
    .replace(NON_LETTER_NUM_RE, "")
    .toLowerCase();
}

function prepareCore(rawTitle) {
  const core = extractCoreTitle(rawTitle);
  if (!core) {
    return { core: "", len: 0, bigrams: [], uniqueBigrams: [] };
  }
  const chars = Array.from(core);
  const len = chars.length;
  if (len < 2) {
    return { core, len, bigrams: [], uniqueBigrams: [] };
  }
  const bigrams = new Array(len - 1);
  for (let i = 0; i < len - 1; i++) {
    bigrams[i] = chars[i].codePointAt(0) * 0x110000 + chars[i + 1].codePointAt(0);
  }
  bigrams.sort((a, b) => a - b);
  const uniqueBigrams = [];
  for (let i = 0; i < bigrams.length; i++) {
    if (i === 0 || bigrams[i] !== bigrams[i - 1]) {
      uniqueBigrams.push(bigrams[i]);
    }
  }
  return { core, len, bigrams, uniqueBigrams };
}

function countSortedOverlap(a, b) {
  let i = 0;
  let j = 0;
  let overlap = 0;
  const al = a.length;
  const bl = b.length;
  while (i < al && j < bl) {
    const va = a[i];
    const vb = b[j];
    if (va === vb) {
      overlap++;
      i++;
      j++;
    } else if (va < vb) {
      i++;
    } else {
      j++;
    }
  }
  return overlap;
}

function computePreparedSimilarity(pa, pb) {
  if (!pa || !pb || pa.len === 0 || pb.len === 0) return 0;
  if (pa.core === pb.core) return 1;
  if (pa.bigrams.length === 0 || pb.bigrams.length === 0) return 0;
  const overlap = countSortedOverlap(pa.bigrams, pb.bigrams);
  if (overlap === 0) return 0;
  const shorter = pa.len <= pb.len ? pa : pb;
  const longer = pa.len <= pb.len ? pb : pa;
  // 若 shorter 是 longer 的子串，其全部二元组必然被 longer 覆盖（overlap === shorter.bigrams.length）
  if (
    shorter.len >= FUZZY_SUBSTRING_MIN_LEN &&
    overlap === shorter.bigrams.length &&
    longer.core.includes(shorter.core)
  ) {
    return FUZZY_SUBSTRING_SCORE;
  }
  return (2 * overlap) / (pa.bigrams.length + pb.bigrams.length);
}

/** 计算两个标题的模糊相似度 ∈ [0, 1] */
function computeTitleSimilarity(titleA, titleB) {
  return computePreparedSimilarity(prepareCore(titleA), prepareCore(titleB));
}

function roundScore(sim) {
  return Math.round((sim + Number.EPSILON) * 100) / 100;
}

function dateStrToDayNum(dateStr) {
  if (!isValidDateStr(dateStr)) return null;
  return Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / DAY_MS);
}

function checkFuzzyTimeWindow(dayA, dayB) {
  if (dayA !== null && dayB !== null) {
    if (Math.abs(dayA - dayB) > FUZZY_MAX_DAY_DIFF) {
      return { eligible: false, threshold: Infinity };
    }
    return { eligible: true, threshold: FUZZY_SIM_THRESHOLD };
  }
  return {
    eligible: true,
    threshold: FUZZY_SIM_THRESHOLD + FUZZY_MISSING_TIME_PENALTY,
  };
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isValidManualContentKey(key) {
  return typeof key === "string" && key.startsWith("manual:") && key.length > "manual:".length;
}

function isValidAutoContentKey(key) {
  return typeof key === "string" && key.startsWith("auto:") && key.length > "auto:".length;
}

function computeAutoClusterKey(sortedWorkKeys) {
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify(sortedWorkKeys))
    .digest("hex")
    .slice(0, 16);
  return `auto:${hash}`;
}

/**
 * 清洗手工矫正表，兼容传入 `{ version, updatedAt, overrides }` 或直接传入 overrides 字典。
 * 返回 Map<workKey, { action: "assign", contentKey } | { action: "detach" }>。
 */
function normalizeOverridesInput(raw) {
  const map = new Map();
  if (!isPlainObject(raw)) return map;
  const source =
    hasOwn(raw, "overrides") && isPlainObject(raw.overrides) && typeof raw.action !== "string"
      ? raw.overrides
      : raw;
  for (const workKey of Object.keys(source)) {
    if (!workKey) continue;
    const desc = Object.getOwnPropertyDescriptor(source, workKey);
    const entry = desc ? desc.value : null;
    if (!isPlainObject(entry)) continue;
    const action = toSafeTrimmed(entry.action);
    if (action === "detach") {
      map.set(workKey, { action: "detach" });
    } else if (action === "assign") {
      const contentKey = toSafeTrimmed(entry.contentKey);
      if (contentKey && !contentKey.startsWith("unlinked:")) {
        map.set(workKey, { action: "assign", contentKey });
      }
    }
  }
  return map;
}

function buildPreparedCores(titles) {
  const list = [];
  const seen = new Set();
  for (const t of titles) {
    const p = prepareCore(t);
    if (!p.core || seen.has(p.core)) continue;
    seen.add(p.core);
    list.push(p);
  }
  return list;
}

function computeWorkTargetSimilarity(workPrepared, targetPreparedList) {
  let best = 0;
  for (let i = 0; i < targetPreparedList.length; i++) {
    const sim = computePreparedSimilarity(workPrepared, targetPreparedList[i]);
    if (sim > best) {
      best = sim;
      if (best >= 1) return 1;
    }
  }
  return best;
}

/**
 * ③ 同 group+platform 内对未关联作品与未占用 target 做模糊匹配。
 * 利用倒排索引将非零相似度候选检索降到接近线性，最坏 O(n·m) 且数学结果与两两全比完全等价。
 */
function matchFuzzyGroupTargets(freeWorks, freeTargets, result, matchedWorks, occupiedTargets) {
  if (!freeWorks.length || !freeTargets.length) return;

  const bigramIndex = new Map();
  const singleCharIndex = new Map();

  for (let ti = 0; ti < freeTargets.length; ti++) {
    const t = freeTargets[ti];
    const seenBg = new Set();
    const seenSingle = new Set();
    for (const p of t.preparedCores) {
      if (p.len === 1) {
        if (!seenSingle.has(p.core)) {
          seenSingle.add(p.core);
          pushToMap(singleCharIndex, p.core, ti);
        }
      } else {
        for (let bi = 0; bi < p.uniqueBigrams.length; bi++) {
          const g = p.uniqueBigrams[bi];
          if (!seenBg.has(g)) {
            seenBg.add(g);
            pushToMap(bigramIndex, g, ti);
          }
        }
      }
    }
  }

  const wCount = freeWorks.length;
  const tCount = freeTargets.length;
  const wBestSim = new Float64Array(wCount);
  const wSecondSim = new Float64Array(wCount);
  const wBestTarget = new Int32Array(wCount).fill(-1);
  const wBestThreshold = new Float64Array(wCount).fill(Infinity);

  const tBestSim = new Float64Array(tCount);
  const tSecondSim = new Float64Array(tCount);
  const tBestWork = new Int32Array(tCount).fill(-1);
  const tBestTied = new Uint8Array(tCount);

  const seenStamp = new Int32Array(tCount);
  let stamp = 0;
  const touched = [];

  for (let wi = 0; wi < wCount; wi++) {
    const w = freeWorks[wi];
    const wp = w.preparedCore;
    if (!wp || wp.len === 0) continue;

    stamp++;
    touched.length = 0;
    if (wp.len === 1) {
      const list = singleCharIndex.get(wp.core);
      if (list) {
        for (let k = 0; k < list.length; k++) {
          const ti = list[k];
          if (seenStamp[ti] !== stamp) {
            seenStamp[ti] = stamp;
            touched.push(ti);
          }
        }
      }
    } else {
      for (let bi = 0; bi < wp.uniqueBigrams.length; bi++) {
        const list = bigramIndex.get(wp.uniqueBigrams[bi]);
        if (!list) continue;
        for (let k = 0; k < list.length; k++) {
          const ti = list[k];
          if (seenStamp[ti] !== stamp) {
            seenStamp[ti] = stamp;
            touched.push(ti);
          }
        }
      }
    }

    let bestSim = 0;
    let secondSim = 0;
    let bestTi = -1;
    let bestThreshold = Infinity;

    for (let k = 0; k < touched.length; k++) {
      const ti = touched[k];
      const t = freeTargets[ti];
      // 保留直链冲突排除：target 已有明确直链且与作品直链不同时禁止模糊关联
      if (t.normUrl && t.normUrl !== w.normUrl) continue;
      const tw = checkFuzzyTimeWindow(w.dayNum, t.dayNum);
      if (!tw.eligible) continue;

      const sim = computeWorkTargetSimilarity(wp, t.preparedCores);
      if (sim <= 0) continue;

      if (sim > bestSim + FUZZY_EPS) {
        secondSim = bestSim;
        bestSim = sim;
        bestTi = ti;
        bestThreshold = tw.threshold;
      } else if (Math.abs(sim - bestSim) <= FUZZY_EPS) {
        secondSim = sim;
      } else if (sim > secondSim) {
        secondSim = sim;
      }

      if (sim > tBestSim[ti] + FUZZY_EPS) {
        tSecondSim[ti] = tBestSim[ti];
        tBestSim[ti] = sim;
        tBestWork[ti] = wi;
        tBestTied[ti] = 0;
      } else if (Math.abs(sim - tBestSim[ti]) <= FUZZY_EPS) {
        tSecondSim[ti] = sim;
        tBestTied[ti] = 1;
      } else if (sim > tSecondSim[ti]) {
        tSecondSim[ti] = sim;
      }
    }

    wBestSim[wi] = bestSim;
    wSecondSim[wi] = secondSim;
    wBestTarget[wi] = bestTi;
    wBestThreshold[wi] = bestThreshold;
  }

  for (let wi = 0; wi < wCount; wi++) {
    const ti = wBestTarget[wi];
    if (ti < 0) continue;
    const sim = wBestSim[wi];
    if (sim < wBestThreshold[wi] - FUZZY_EPS) continue;
    if (sim - wSecondSim[wi] < FUZZY_MARGIN_MIN - FUZZY_EPS) continue;
    // 互为最佳且 target 侧无并列最高分（防止同分时按输入顺序任选其一）
    if (tBestWork[ti] !== wi || tBestTied[ti]) continue;

    const w = freeWorks[wi];
    const t = freeTargets[ti];
    matchedWorks.add(w.idx);
    occupiedTargets.add(t.idx);
    result.set(w.workKey, {
      contentKey: t.contentKey,
      matchedBy: "fuzzy",
      score: roundScore(sim),
    });
  }
}

/**
 * ④ 无发布记录作品跨平台聚类（同 group，不同 platform）。
 * - 每对平台 (P1, P2) 做对称互为最佳 + 差值 ≥0.1 + 时间窗 ≤2 天（缺时间 +0.1）成边
 * - 按 (sim desc, minWorkKey asc, maxWorkKey asc) 全序做 Kruskal 合并，保证每平台每簇最多 1 条且 100% 确定性
 * - 簇大小 ≥2 才成立，生成稳定 auto:<hash>
 */
function clusterUnlinkedAcrossPlatforms(unlinkedWorks, result) {
  const autoKeys = new Set();
  if (!unlinkedWorks.length) return autoKeys;

  const byGroup = new Map();
  for (const w of unlinkedWorks) {
    pushToMap(byGroup, w.groupKey, w);
  }

  for (const groupWorks of byGroup.values()) {
    const byPlatform = new Map();
    for (const w of groupWorks) {
      pushToMap(byPlatform, w.platformKey, w);
    }
    const platforms = [...byPlatform.keys()].sort(compareText);
    if (platforms.length < 2) continue;

    // 统一按 workKey 升序赋局部节点编号，保证全流程确定性
    const nodes = [...groupWorks].sort((a, b) => compareText(a.workKey, b.workKey));
    const nodeIdxByWorkKey = new Map();
    for (let i = 0; i < nodes.length; i++) {
      nodeIdxByWorkKey.set(nodes[i].workKey, i);
    }

    const edges = [];
    for (let pi = 0; pi < platforms.length; pi++) {
      const listA = byPlatform.get(platforms[pi]);
      for (let pj = pi + 1; pj < platforms.length; pj++) {
        const listB = byPlatform.get(platforms[pj]);
        findCrossPlatformPairEdges(listA, listB, nodeIdxByWorkKey, edges);
      }
    }
    if (!edges.length) continue;

    edges.sort((a, b) => {
      if (Math.abs(a.sim - b.sim) > FUZZY_EPS) return b.sim - a.sim;
      const c1 = compareText(a.key1, b.key1);
      if (c1 !== 0) return c1;
      return compareText(a.key2, b.key2);
    });

    const n = nodes.length;
    const parent = new Int32Array(n);
    const clusterPlatforms = new Array(n);
    for (let i = 0; i < n; i++) {
      parent[i] = i;
      clusterPlatforms[i] = new Set([nodes[i].platformKey]);
    }
    const find = (x) => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };

    const acceptedEdges = [];
    for (let ei = 0; ei < edges.length; ei++) {
      const e = edges[ei];
      const ru = find(e.u);
      const rv = find(e.v);
      if (ru === rv) {
        acceptedEdges.push(e);
        continue;
      }
      const setU = clusterPlatforms[ru];
      const setV = clusterPlatforms[rv];
      let conflict = false;
      const smaller = setU.size <= setV.size ? setU : setV;
      const larger = setU.size <= setV.size ? setV : setU;
      for (const pt of smaller) {
        if (larger.has(pt)) {
          conflict = true;
          break;
        }
      }
      if (conflict) continue;

      // 按节点编号小的为根合并
      const root = ru < rv ? ru : rv;
      const child = ru < rv ? rv : ru;
      parent[child] = root;
      for (const pt of clusterPlatforms[child]) clusterPlatforms[root].add(pt);
      clusterPlatforms[child] = null;
      acceptedEdges.push(e);
    }

    const clusters = new Map();
    for (let i = 0; i < n; i++) {
      pushToMap(clusters, find(i), i);
    }

    const bestIncidentSim = new Float64Array(n);
    for (let ei = 0; ei < acceptedEdges.length; ei++) {
      const e = acceptedEdges[ei];
      if (e.sim > bestIncidentSim[e.u]) bestIncidentSim[e.u] = e.sim;
      if (e.sim > bestIncidentSim[e.v]) bestIncidentSim[e.v] = e.sim;
    }

    for (const memberIndices of clusters.values()) {
      if (memberIndices.length < 2) continue;
      const sortedWorkKeys = memberIndices.map((idx) => nodes[idx].workKey).sort(compareText);
      const contentKey = computeAutoClusterKey(sortedWorkKeys);
      autoKeys.add(contentKey);
      for (const idx of memberIndices) {
        const w = nodes[idx];
        result.set(w.workKey, {
          contentKey,
          matchedBy: "fuzzy",
          score: roundScore(bestIncidentSim[idx]),
        });
      }
    }
  }

  return autoKeys;
}

function findCrossPlatformPairEdges(listA, listB, nodeIdxByWorkKey, edgesOut) {
  if (!listA.length || !listB.length) return;

  const bigramIndex = new Map();
  const singleCharIndex = new Map();
  for (let bi = 0; bi < listB.length; bi++) {
    const p = listB[bi].preparedCore;
    if (!p || p.len === 0) continue;
    if (p.len === 1) {
      pushToMap(singleCharIndex, p.core, bi);
    } else {
      for (let k = 0; k < p.uniqueBigrams.length; k++) {
        pushToMap(bigramIndex, p.uniqueBigrams[k], bi);
      }
    }
  }

  const aCount = listA.length;
  const bCount = listB.length;
  const aBestSim = new Float64Array(aCount);
  const aSecondSim = new Float64Array(aCount);
  const aBestB = new Int32Array(aCount).fill(-1);
  const aBestThreshold = new Float64Array(aCount).fill(Infinity);

  const bBestSim = new Float64Array(bCount);
  const bSecondSim = new Float64Array(bCount);
  const bBestA = new Int32Array(bCount).fill(-1);
  const bBestThreshold = new Float64Array(bCount).fill(Infinity);

  const seenStamp = new Int32Array(bCount);
  let stamp = 0;
  const touched = [];

  for (let ai = 0; ai < aCount; ai++) {
    const wa = listA[ai];
    const pa = wa.preparedCore;
    if (!pa || pa.len === 0) continue;

    stamp++;
    touched.length = 0;
    if (pa.len === 1) {
      const list = singleCharIndex.get(pa.core);
      if (list) {
        for (let k = 0; k < list.length; k++) {
          const bi = list[k];
          if (seenStamp[bi] !== stamp) {
            seenStamp[bi] = stamp;
            touched.push(bi);
          }
        }
      }
    } else {
      for (let k = 0; k < pa.uniqueBigrams.length; k++) {
        const list = bigramIndex.get(pa.uniqueBigrams[k]);
        if (!list) continue;
        for (let m = 0; m < list.length; m++) {
          const bi = list[m];
          if (seenStamp[bi] !== stamp) {
            seenStamp[bi] = stamp;
            touched.push(bi);
          }
        }
      }
    }

    let bestSim = 0;
    let secondSim = 0;
    let bestBi = -1;
    let bestThreshold = Infinity;

    for (let k = 0; k < touched.length; k++) {
      const bi = touched[k];
      const wb = listB[bi];
      const tw = checkFuzzyTimeWindow(wa.dayNum, wb.dayNum);
      if (!tw.eligible) continue;

      const sim = computePreparedSimilarity(pa, wb.preparedCore);
      if (sim <= 0) continue;

      if (sim > bestSim + FUZZY_EPS) {
        secondSim = bestSim;
        bestSim = sim;
        bestBi = bi;
        bestThreshold = tw.threshold;
      } else if (Math.abs(sim - bestSim) <= FUZZY_EPS) {
        secondSim = sim;
      } else if (sim > secondSim) {
        secondSim = sim;
      }

      if (sim > bBestSim[bi] + FUZZY_EPS) {
        bSecondSim[bi] = bBestSim[bi];
        bBestSim[bi] = sim;
        bBestA[bi] = ai;
        bBestThreshold[bi] = tw.threshold;
      } else if (Math.abs(sim - bBestSim[bi]) <= FUZZY_EPS) {
        bSecondSim[bi] = sim;
      } else if (sim > bSecondSim[bi]) {
        bSecondSim[bi] = sim;
      }
    }

    aBestSim[ai] = bestSim;
    aSecondSim[ai] = secondSim;
    aBestB[ai] = bestBi;
    aBestThreshold[ai] = bestThreshold;
  }

  for (let ai = 0; ai < aCount; ai++) {
    const bi = aBestB[ai];
    if (bi < 0) continue;
    if (bBestA[bi] !== ai) continue;
    const sim = aBestSim[ai];
    if (sim < aBestThreshold[ai] - FUZZY_EPS) continue;
    if (sim < bBestThreshold[bi] - FUZZY_EPS) continue;
    if (sim - aSecondSim[ai] < FUZZY_MARGIN_MIN - FUZZY_EPS) continue;
    if (bBestSim[bi] - bSecondSim[bi] < FUZZY_MARGIN_MIN - FUZZY_EPS) continue;

    const wa = listA[ai];
    const wb = listB[bi];
    const u = nodeIdxByWorkKey.get(wa.workKey);
    const v = nodeIdxByWorkKey.get(wb.workKey);
    const key1 = wa.workKey < wb.workKey ? wa.workKey : wb.workKey;
    const key2 = wa.workKey < wb.workKey ? wb.workKey : wa.workKey;
    edgesOut.push({ u, v, sim, key1, key2 });
  }
}

/**
 * 按归一标题构建作品索引（供「获取状态」等入口复用）：
 * - 同一归一标题仅对应 1 个作品 → `{ work, ambiguous: false }`
 * - 同一归一标题对应 ≥2 个作品 → `{ work: null, ambiguous: true }`
 * normalize 可替换：「获取状态」用 normalizeStatusTitle（仅去零宽与首尾空白，保持该入口原有精确匹配语义）
 */
function buildTitleIndex(works, normalize = normalizeTitle) {
  const byTitle = new Map();
  if (!Array.isArray(works)) return byTitle;
  for (const w of works) {
    if (!isPlainObject(w)) continue;
    const key = normalize(w.title);
    if (!key) continue;
    const prev = byTitle.get(key);
    if (!prev) {
      byTitle.set(key, { work: w, ambiguous: false });
    } else if (!prev.ambiguous) {
      const prevId = toSafeTrimmed(prev.work.workId);
      const currId = toSafeTrimmed(w.workId);
      const prevUrl = toSafeTrimmed(prev.work.url);
      const currUrl = toSafeTrimmed(w.url);
      if (prevId && currId && prevId === currId && prevUrl === currUrl) continue;
      byTitle.set(key, { work: null, ambiguous: true });
    }
  }
  return byTitle;
}

function parseHttpUrl(raw) {
  const trimmed = toSafeTrimmed(raw);
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch (_) {
    return null;
  }
}

/** URL 归一化：保留 path 与非追踪 query，去除 fragment、尾斜杠与常见追踪参数 */
function normalizeUrl(raw) {
  const trimmed = toSafeTrimmed(raw);
  if (!trimmed) return "";
  const parsed = parseHttpUrl(trimmed);
  if (parsed) {
    const pathname = parsed.pathname.replace(/\/+$/, "");
    const kept = [...parsed.searchParams.entries()]
      .filter(([k]) => !TRACKING_PARAM_RE.test(k))
      .sort((a, b) =>
        a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0
      );
    const qs = kept.length ? `?${new URLSearchParams(kept).toString()}` : "";
    return `${parsed.origin}${pathname}${qs}`;
  }
  const noHash = trimmed.split("#")[0];
  const qIdx = noHash.indexOf("?");
  return qIdx === -1
    ? noHash.replace(/\/+$/, "")
    : `${noHash.slice(0, qIdx).replace(/\/+$/, "")}${noHash.slice(qIdx)}`;
}

function isManagementUrl(raw) {
  const parsed = parseHttpUrl(raw);
  return Boolean(
    parsed && MANAGEMENT_URL_KEYS.has(`${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}`)
  );
}

function normalizeDirectUrl(raw) {
  return parseHttpUrl(raw) && !isManagementUrl(raw) ? normalizeUrl(raw) : "";
}

/** 规范化完整本地路径（Win 盘符 / UNC / POSIX 绝对路径），非完整路径返回 "" */
function normalizeFullPath(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.trim().replace(/\\/g, "/");
  if (!s) return "";
  const isUnc = s.startsWith("//");
  s = isUnc ? `//${s.slice(2).replace(/\/+/g, "/")}` : s.replace(/\/+/g, "/");
  if (s.endsWith("/")) return "";
  if (/^[a-zA-Z]:\/.+/.test(s) || (!isUnc && /^\/.+/.test(s)) || (isUnc && /^\/\/[^/]+\/[^/]+\/.+/.test(s))) {
    return s;
  }
  return "";
}

function makeWorkKey(group, platform, workId) {
  return `${toSafeString(group)}|${toSafeString(platform)}|${toSafeString(workId)}`;
}

function extractRecordDate(rec, status) {
  const baseDate = typeof rec.date === "string" && isValidDateStr(rec.date.trim())
    ? rec.date.trim()
    : "";
  // 发布成功（含定时任务、换文件重发）时以最后一次发布日期为准：晚于登记日才采用
  if (status === "success") {
    const doneDate = toUtc8DateStr(rec.lastPublishAt);
    if (doneDate && (!baseDate || doneDate > baseDate)) return doneDate;
  }
  return baseDate || toUtc8DateStr(rec.lastPublishAt) || toUtc8DateStr(rec.createTime);
}

function collectMatchTitles(values) {
  const out = [];
  for (const item of values) {
    const norm = normalizeTitle(item);
    if (norm && !out.includes(norm)) out.push(norm);
  }
  return out;
}

/**
 * 构建内容索引：
 * - 排除图文记录
 * - publishStatus 存在且不是 success → 直接排除（即使有 videoLink）；
 *   仅 publishStatus 缺失的历史记录允许凭有效非管理页直链纳入；
 *   republishCount > 0 时其 videoLink 不作为直链证据（仅走唯一标题规则）
 * - 仅按完整路径归桶（小写、/ 分隔）；无完整路径各自独立为 `record:<日期>:<id或序号>`
 * - 每条平台记录独立成 target，不再按文件+平台折叠
 */
function buildContentIndex(pushRecords) {
  if (!Array.isArray(pushRecords)) return [];
  const buckets = new Map();

  for (let idx = 0; idx < pushRecords.length; idx++) {
    const rec = pushRecords[idx];
    if (!isPlainObject(rec)) continue;
    if (toSafeTrimmed(rec.textType).toLowerCase() === "article") continue;

    // 字段存在（含空串、数组等异常值）即只接受 success；仅字段缺失的历史记录可凭直链兜底
    const hasStatusField = Object.prototype.hasOwnProperty.call(rec, "publishStatus") &&
      rec.publishStatus !== undefined;
    const rawStatus = rec.publishStatus;
    const status = typeof rawStatus === "string" ? rawStatus.trim().toLowerCase() : "";
    if (hasStatusField && status !== "success") continue;
    const rawVideoLink = toSafeTrimmed(rec.videoLink);
    const validLink = normalizeDirectUrl(rawVideoLink);
    const republishCount = normalizeMetric(rec.republishCount);
    const attemptCount = normalizeMetric(rec.publishAttemptCount);
    const isRepublished =
      (republishCount !== null && republishCount > 0) ||
      (republishCount === null && attemptCount !== null && attemptCount > 1);
    const directVideoLink = !isRepublished && validLink ? rawVideoLink : "";

    if (!hasStatusField && !directVideoLink) continue;

    const platform = toSafeTrimmed(rec.pt);
    const group = toSafeTrimmed(rec.group) || toSafeString(rec.phone).split("-")[0].trim();
    const recordDate = extractRecordDate(rec, status);
    // 真实 pushData 完整路径在 filePath（LocalVideoPublish.vue:2095），兼容完整路径写入 selectedFile
    const fullPath = normalizeFullPath(rec.filePath) || normalizeFullPath(rec.selectedFile);
    const title = [rec.title, rec.bt, rec.textOtherName, rec.bookName]
      .map(toSafeTrimmed)
      .find(Boolean) || "";
    const matchRaw = platform === "视频号"
      ? [rec.title, rec.bt, rec.textOtherName, rec.shortTitle, rec.bt2Filled]
      : [rec.title, rec.bt, rec.textOtherName];

    let contentKey;
    if (fullPath) {
      contentKey = `file:${fullPath.toLowerCase()}`;
    } else {
      const idPart = toSafeTrimmed(rec.id) || String(idx);
      const baseKey = `record:${recordDate || "unknown"}:${idPart}`;
      contentKey = buckets.has(baseKey) ? `${baseKey}:${idx}` : baseKey;
    }

    let bucket = buckets.get(contentKey);
    if (!bucket) {
      bucket = {
        contentKey,
        displayTitle: "",
        displayTitleDate: "",
        file: fullPath || toSafeTrimmed(rec.selectedFile),
        fileDate: recordDate,
        firstPublishDate: "",
        targets: [],
      };
      buckets.set(contentKey, bucket);
    }

    if (fullPath && recordDate && (!bucket.fileDate || recordDate < bucket.fileDate)) {
      bucket.file = fullPath;
      bucket.fileDate = recordDate;
    }
    if (recordDate && (!bucket.firstPublishDate || recordDate < bucket.firstPublishDate)) {
      bucket.firstPublishDate = recordDate;
    }
    if (title && (!bucket.displayTitle || (recordDate && (!bucket.displayTitleDate || recordDate < bucket.displayTitleDate)))) {
      bucket.displayTitle = title;
      bucket.displayTitleDate = recordDate;
    }

    bucket.targets.push({
      contentKey,
      group,
      platform,
      recordDate,
      status,
      videoLink: directVideoLink,
      matchTitles: collectMatchTitles(matchRaw),
    });
  }

  return [...buckets.values()]
    .map((b) => ({
      contentKey: b.contentKey,
      displayTitle: b.displayTitle || (b.file ? b.file.split("/").pop() : "") || "(无标题)",
      file: b.file,
      firstPublishDate: b.firstPublishDate,
      targets: b.targets,
    }))
    .sort((a, b) => {
      if (a.firstPublishDate !== b.firstPublishDate) {
        if (!a.firstPublishDate) return 1;
        if (!b.firstPublishDate) return -1;
        return a.firstPublishDate < b.firstPublishDate ? -1 : 1;
      }
      return a.contentKey < b.contentKey ? -1 : a.contentKey > b.contentKey ? 1 : 0;
    });
}

function parseCutoffDate(date) {
  if (date === undefined || date === null) return { ok: true, cutoffDate: "" };
  if (typeof date !== "string") return { ok: false, cutoffDate: "" };
  const trimmed = date.trim();
  if (!trimmed) return { ok: true, cutoffDate: "" };
  return isValidDateStr(trimmed) ? { ok: true, cutoffDate: trimmed } : { ok: false, cutoffDate: "" };
}

/**
 * 关联作品与内容，返回 Map<`group|platform|workId`, { contentKey, matchedBy, score? }>。
 * - 可选截止日 date：排除 recordDate > date 的 target 与有效 publishTime > date 的 work
 * - 可选手工矫正 overrides：detach 在 ③④ 之前排除，最终套用（assign 指向不存在 contentKey 时忽略）
 * ① 有效直链 1:1 唯一匹配（多对一/一对多全部留空且禁止标题兜底）；
 * ② 标题命中且同 group+platform 内唯一 work、唯一未被①占用的 target，且 target 无冲突直链；
 * ③ 模糊匹配（同 group+platform，标题 core 子串≥6=0.95 / 二元组 Dice，时间窗 ≤2 天，缺时间门槛 +0.1，
 *    sim≥0.6、最佳比次佳高≥0.1、互为最佳）；
 * ④ 无发布记录作品跨平台聚类（同 group 不同 platform，同规则互为最佳成边 + Kruskal 合并每平台最多 1 条，
 *    簇大小≥2，生成稳定 auto:<hash>）。
 */
function linkWorks({ contents, accounts, date, overrides } = {}) {
  const result = new Map();
  if (!Array.isArray(accounts)) return result;
  const { ok, cutoffDate } = parseCutoffDate(date);
  if (!ok) return result;

  const overrideMap = normalizeOverridesInput(overrides);
  const eligibleContentKeys = new Set();
  const targetsByGp = new Map();
  let targetSeq = 0;

  for (const c of Array.isArray(contents) ? contents : []) {
    if (!isPlainObject(c)) continue;
    const contentKey = toSafeString(c.contentKey);
    if (!contentKey) continue;
    const rawContentDate = toSafeTrimmed(c.firstPublishDate);
    const contentDate = isValidDateStr(rawContentDate) ? rawContentDate : "";
    const rawTargets = Array.isArray(c.targets) ? c.targets.filter(isPlainObject) : [];
    const hasTargets = rawTargets.length > 0;
    let eligibleTargetCount = 0;

    for (const t of rawTargets) {
      const rawTargetDate = toSafeTrimmed(t.recordDate);
      const targetDate = isValidDateStr(rawTargetDate)
        ? rawTargetDate
        : toUtc8DateStr(t.lastPublishAt) || contentDate;
      if (cutoffDate && targetDate && targetDate > cutoffDate) continue;
      eligibleTargetCount++;
      const gpKey = `${toSafeTrimmed(t.group)}|${toSafeTrimmed(t.platform)}`;
      const rawTitles = Array.isArray(t.matchTitles) ? t.matchTitles : [t.title];
      const matchTitles = collectMatchTitles(rawTitles);
      pushToMap(targetsByGp, gpKey, {
        idx: targetSeq++,
        contentKey,
        normUrl: normalizeDirectUrl(t.videoLink),
        matchTitles,
        preparedCores: buildPreparedCores(rawTitles),
        dayNum: dateStrToDayNum(targetDate),
      });
    }

    const contentEligible = hasTargets
      ? eligibleTargetCount > 0
      : !cutoffDate || !contentDate || contentDate <= cutoffDate;
    if (contentEligible) {
      eligibleContentKeys.add(contentKey);
    }
  }

  const worksByGp = new Map();
  const activeWorkKeys = new Set();
  const detachedWorkKeys = new Set();
  const preAssignedWorkKeys = new Set();
  let workSeq = 0;

  for (const acc of accounts) {
    if (!isPlainObject(acc)) continue;
    const rawGroup = toSafeString(acc.group);
    const rawPlatform = toSafeString(acc.platform);
    const groupKey = rawGroup.trim();
    const platformKey = rawPlatform.trim();
    const gpKey = `${groupKey}|${platformKey}`;
    for (const w of Array.isArray(acc.works) ? acc.works : []) {
      if (!isPlainObject(w)) continue;
      const workId = toSafeString(w.workId);
      if (!workId) continue;
      const workKey = makeWorkKey(rawGroup, rawPlatform, workId);
      if (result.has(workKey)) continue;
      result.set(workKey, { contentKey: null, matchedBy: null });
      const pubMs = parseValidTimestampMs(w.publishTime);
      const pubDate = pubMs !== null ? toUtc8DateStr(pubMs) : "";
      if (cutoffDate && pubDate && pubDate > cutoffDate) continue;

      activeWorkKeys.add(workKey);
      const ov = overrideMap.get(workKey);
      if (ov) {
        if (ov.action === "detach") {
          detachedWorkKeys.add(workKey);
        } else if (
          ov.action === "assign" &&
          (eligibleContentKeys.has(ov.contentKey) || isValidManualContentKey(ov.contentKey))
        ) {
          preAssignedWorkKeys.add(workKey);
        }
      }

      pushToMap(worksByGp, gpKey, {
        idx: workSeq++,
        workKey,
        groupKey,
        platformKey,
        normTitle: normalizeTitle(w.title),
        preparedCore: prepareCore(w.title),
        normUrl: normalizeDirectUrl(w.url),
        dayNum: dateStrToDayNum(pubDate),
      });
    }
  }

  const unlinkedForCluster = [];

  for (const [gpKey, gpWorks] of worksByGp.entries()) {
    const gpTargets = targetsByGp.get(gpKey);
    const matchedWorks = new Set();
    const occupiedTargets = new Set();
    const blockedWorks = new Set();
    const blockedTargets = new Set();

    if (gpTargets && gpTargets.length) {
      // ① 有效直链严格 1:1 匹配
      const targetsByUrl = new Map();
      const worksByUrl = new Map();
      for (const t of gpTargets) if (t.normUrl) pushToMap(targetsByUrl, t.normUrl, t);
      for (const w of gpWorks) if (w.normUrl) pushToMap(worksByUrl, w.normUrl, w);

      for (const [url, urlWorks] of worksByUrl.entries()) {
        const urlTargets = targetsByUrl.get(url);
        if (!urlTargets) continue;
        if (urlWorks.length === 1 && urlTargets.length === 1) {
          matchedWorks.add(urlWorks[0].idx);
          occupiedTargets.add(urlTargets[0].idx);
          result.set(urlWorks[0].workKey, { contentKey: urlTargets[0].contentKey, matchedBy: "link" });
        } else {
          for (const w of urlWorks) blockedWorks.add(w.idx);
          for (const t of urlTargets) blockedTargets.add(t.idx);
        }
      }

      // ② 同 group+platform 唯一标题匹配
      const worksByTitle = new Map();
      const freeTargetsByTitle = new Map();
      for (const w of gpWorks) if (w.normTitle) pushToMap(worksByTitle, w.normTitle, w);
      for (const t of gpTargets) {
        if (occupiedTargets.has(t.idx)) continue;
        for (const mt of t.matchTitles) pushToMap(freeTargetsByTitle, mt, t);
      }

      const candidatesByTarget = new Map();
      for (const w of gpWorks) {
        if (matchedWorks.has(w.idx) || blockedWorks.has(w.idx) || !w.normTitle) continue;
        if (worksByTitle.get(w.normTitle).length !== 1) continue;
        const titleTargets = freeTargetsByTitle.get(w.normTitle);
        if (!titleTargets || titleTargets.length !== 1) continue;
        const t = titleTargets[0];
        if (blockedTargets.has(t.idx) || (t.normUrl && t.normUrl !== w.normUrl)) continue;
        pushToMap(candidatesByTarget, t.idx, { work: w, target: t });
      }

      for (const pairs of candidatesByTarget.values()) {
        if (pairs.length === 1) {
          matchedWorks.add(pairs[0].work.idx);
          occupiedTargets.add(pairs[0].target.idx);
          result.set(pairs[0].work.workKey, { contentKey: pairs[0].target.contentKey, matchedBy: "title" });
        }
      }

      // ③ 作品↔发布记录 target 模糊匹配（排除已匹配/已阻断/manual-detach/已有效手工指定作品）
      const freeWorks = [];
      for (const w of gpWorks) {
        if (
          matchedWorks.has(w.idx) ||
          blockedWorks.has(w.idx) ||
          detachedWorkKeys.has(w.workKey) ||
          preAssignedWorkKeys.has(w.workKey)
        ) {
          continue;
        }
        freeWorks.push(w);
      }
      const freeTargets = [];
      for (const t of gpTargets) {
        if (occupiedTargets.has(t.idx) || blockedTargets.has(t.idx)) continue;
        freeTargets.push(t);
      }

      matchFuzzyGroupTargets(freeWorks, freeTargets, result, matchedWorks, occupiedTargets);
    }

    for (const w of gpWorks) {
      if (
        matchedWorks.has(w.idx) ||
        detachedWorkKeys.has(w.workKey) ||
        preAssignedWorkKeys.has(w.workKey)
      ) {
        continue;
      }
      unlinkedForCluster.push(w);
    }
  }

  // ④ 无发布记录作品跨平台聚类（同 group，不同 platform）
  const autoKeys = clusterUnlinkedAcrossPlatforms(unlinkedForCluster, result);

  // 套用手工矫正 overrides（手工结果永远优先于自动结果；指向不存在 contentKey 时忽略）
  if (overrideMap.size > 0) {
    // 统计指向同一 auto:* key 的现存有效作品数（已固化的自动簇即使成员变动仍可保持有效）
    const assignedAutoCounts = new Map();
    for (const [workKey, ov] of overrideMap.entries()) {
      if (!activeWorkKeys.has(workKey)) continue;
      if (ov.action === "assign" && isValidAutoContentKey(ov.contentKey)) {
        assignedAutoCounts.set(ov.contentKey, (assignedAutoCounts.get(ov.contentKey) || 0) + 1);
      }
    }

    const isValidAssignTarget = (contentKey) => {
      if (eligibleContentKeys.has(contentKey)) return true;
      if (isValidManualContentKey(contentKey)) return true;
      if (isValidAutoContentKey(contentKey)) {
        return autoKeys.has(contentKey) || (assignedAutoCounts.get(contentKey) || 0) >= 2;
      }
      return false;
    };

    for (const [workKey, ov] of overrideMap.entries()) {
      if (!activeWorkKeys.has(workKey)) continue;
      if (ov.action === "detach") {
        result.set(workKey, { contentKey: null, matchedBy: "manual-detach" });
      } else if (ov.action === "assign" && isValidAssignTarget(ov.contentKey)) {
        result.set(workKey, { contentKey: ov.contentKey, matchedBy: "manual" });
      }
    }

    // 清理因部分成员被移走而只剩 1 条纯 fuzzy 作品的孤儿 auto:* 簇
    const autoMembers = new Map();
    for (const [workKey, entry] of result.entries()) {
      if (entry && isValidAutoContentKey(entry.contentKey)) {
        pushToMap(autoMembers, entry.contentKey, { workKey, entry });
      }
    }
    for (const members of autoMembers.values()) {
      if (members.length < 2 && members.every((m) => m.entry.matchedBy === "fuzzy")) {
        for (const m of members) {
          result.set(m.workKey, { contentKey: null, matchedBy: null });
        }
      }
    }
  }

  return result;
}

function mergeMetricValue(prev, next) {
  if (prev == null) return next == null ? null : next;
  if (next == null) return prev;
  const total = prev + next;
  return total === 0 ? 0 : total;
}

/** 仅从 worksDaily 中取 ≤ cutoffDate 的最近有效快照，返回 { date, metrics }，不回退 works.json */
function resolveWorkSnapshotAsOf(workId, accWorksDaily, cutoffDate) {
  if (!isPlainObject(accWorksDaily) || !hasOwn(accWorksDaily, workId)) return null;
  const dateMap = accWorksDaily[workId];
  if (!isPlainObject(dateMap)) return null;

  let bestDate = "";
  let bestSnap = null;
  for (const [d, snap] of Object.entries(dateMap)) {
    if (!isPlainObject(snap) || !isValidDateStr(d)) continue;
    if (cutoffDate && d > cutoffDate) continue;
    if (!bestDate || d > bestDate) {
      bestDate = d;
      bestSnap = snap;
    }
  }
  if (!bestSnap) return null;

  const metrics = {};
  for (const k of WORK_STAT_KEYS) {
    metrics[k] = hasOwn(bestSnap, k) ? normalizeMetric(bestSnap[k]) : null;
  }
  return { date: bestDate, metrics };
}

function addWorkToBucket(bucket, workItem, metrics) {
  const { platform, group, workId, url } = workItem;
  const workUrl = toSafeTrimmed(url);
  const pgKey = `${platform}|${group}`;
  if (platform) bucket.platforms.add(platform);
  bucket.workItems.push(workItem);

  if (!hasOwn(bucket.perPlatform, pgKey)) {
    bucket.perPlatform[pgKey] = {
      ...metrics,
      urls: workUrl ? [workUrl] : [],
      workIds: [workId],
      works: [workItem],
    };
  } else {
    const cell = bucket.perPlatform[pgKey];
    for (const k of WORK_STAT_KEYS) cell[k] = mergeMetricValue(cell[k], metrics[k]);
    if (workUrl && !cell.urls.includes(workUrl)) cell.urls.push(workUrl);
    cell.workIds.push(workId);
    cell.works.push(workItem);
  }
}

function summarizeBucketMatch(bucket) {
  if (bucket.isUnlinked) {
    const isManualDetach = bucket.workItems.some((w) => w.matchedBy === "manual-detach");
    return {
      matchMethod: null,
      matchScore: null,
      hasFuzzy: false,
      hasManual: false,
      isManualDetach,
    };
  }
  let hasManual = false;
  let hasFuzzy = false;
  let hasTitle = false;
  let hasLink = false;
  let minFuzzyScore = null;

  for (const w of bucket.workItems) {
    if (w.matchedBy === "manual") hasManual = true;
    else if (w.matchedBy === "fuzzy") {
      hasFuzzy = true;
      if (typeof w.score === "number" && Number.isFinite(w.score)) {
        if (minFuzzyScore === null || w.score < minFuzzyScore) {
          minFuzzyScore = w.score;
        }
      }
    } else if (w.matchedBy === "title") hasTitle = true;
    else if (w.matchedBy === "link") hasLink = true;
  }

  let matchMethod = null;
  if (hasManual) matchMethod = "manual";
  else if (hasFuzzy) matchMethod = "fuzzy";
  else if (hasTitle) matchMethod = "title";
  else if (hasLink) matchMethod = "link";

  return {
    matchMethod,
    matchScore: minFuzzyScore,
    hasFuzzy,
    hasManual,
    isManualDetach: false,
  };
}

function pickLatestSnapshot(obsList) {
  let best = null;
  for (const o of obsList) {
    if (!o.snap) continue;
    if (!best || o.snap.date > best.date) best = o.snap;
  }
  return best;
}

function pickMinValidPubMs(obsList) {
  let minMs = null;
  for (const o of obsList) {
    if (o.pubMs !== null && (minMs === null || o.pubMs < minMs)) minMs = o.pubMs;
  }
  return minMs;
}

/**
 * 构建跨平台内容级汇总行（截至 date，默认最新快照日）。
 * - link：已忽略（保留参数兼容），关联总按截止日用 linkWorks 重算
 * - overrides：可选手工矫正配置（与 linkWorks 口径一致）
 * - worksDaily：`{ "group|platform": readWorksDaily(group, platform) }`
 * - 按 `platform|workId` 跨组去重：只取一份 ≤date 的最近快照，归入按分组名排序的第一个分组
 * - worksDaily 中出现但 works.json 缺失的作品 ID 保留为未关联行（title "(已删除或未匹配)"）
 */
function buildContentSummaryRows({ contents, accounts, link, worksDaily, date, overrides } = {}) {
  const { ok, cutoffDate } = parseCutoffDate(date);
  if (!ok) return [];

  const accountList = Array.isArray(accounts) ? accounts : [];
  // 关联总是按同一截止日重算（忽略传入的 link）：预计算关联可能基于不同截止日，复用会绕过唯一性校验
  void link;
  const overrideMap = normalizeOverridesInput(overrides);
  const resolvedLink = linkWorks({
    contents,
    accounts: accountList,
    date: cutoffDate,
    overrides,
  });
  const dailyByGp = isPlainObject(worksDaily) ? worksDaily : null;

  const contentByKey = new Map();
  const buckets = new Map();
  const makeBucket = (contentKey, title, file, recordFirstDate, minWorkPublishMs, isUnlinked) => ({
    contentKey,
    title: title || "(无标题)",
    file: file || "",
    recordFirstDate: recordFirstDate || "",
    minWorkPublishMs,
    isUnlinked,
    platforms: new Set(),
    perPlatform: {},
    workItems: [],
  });

  for (const c of Array.isArray(contents) ? contents : []) {
    if (!isPlainObject(c)) continue;
    const contentKey = toSafeString(c.contentKey);
    if (!contentKey) continue;
    const rawDate = toSafeTrimmed(c.firstPublishDate);
    const contentDate = isValidDateStr(rawDate) ? rawDate : "";

    const rawTargets = Array.isArray(c.targets) ? c.targets.filter(isPlainObject) : [];
    const hasTargets = rawTargets.length > 0;
    const eligibleTargetsByGp = new Map();
    let eligibleCount = 0;
    let minEligibleTargetDate = "";

    for (const t of rawTargets) {
      const rawTDate = toSafeTrimmed(t.recordDate);
      const tDate = isValidDateStr(rawTDate)
        ? rawTDate
        : toUtc8DateStr(t.lastPublishAt) || contentDate;
      if (cutoffDate && tDate && tDate > cutoffDate) continue;
      eligibleCount++;
      if (tDate && (!minEligibleTargetDate || tDate < minEligibleTargetDate)) {
        minEligibleTargetDate = tDate;
      }
      const gpKey = `${toSafeTrimmed(t.group)}|${toSafeTrimmed(t.platform)}`;
      pushToMap(eligibleTargetsByGp, gpKey, {
        normUrl: normalizeDirectUrl(t.videoLink),
        matchTitles: collectMatchTitles(Array.isArray(t.matchTitles) ? t.matchTitles : [t.title]),
      });
    }

    const eligible = hasTargets
      ? eligibleCount > 0
      : !cutoffDate || !contentDate || contentDate <= cutoffDate;
    const effectiveRecordDate = hasTargets
      ? minEligibleTargetDate || (!cutoffDate || !contentDate || contentDate <= cutoffDate ? contentDate : "")
      : contentDate;

    contentByKey.set(contentKey, {
      c,
      recordDate: effectiveRecordDate,
      hasTargets,
      eligible,
      eligibleTargetsByGp,
    });

    if (!eligible) continue;
    const bucketId = `linked:${contentKey}`;
    if (!buckets.has(bucketId)) {
      buckets.set(
        bucketId,
        makeBucket(contentKey, toSafeString(c.displayTitle), toSafeString(c.file), effectiveRecordDate, null, false)
      );
    }
  }

  // 1. 收集 accounts[*].works 中的作品观测（排除有效 publishTime > cutoffDate 的作品）
  const seenGpWorkKeys = new Set();
  const gpInfoByKey = new Map();
  const excludedFuturePwKeys = new Set();
  const obsByPw = new Map();
  const syntheticObsByContentKey = new Map();

  for (const acc of accountList) {
    if (!isPlainObject(acc)) continue;
    const group = toSafeString(acc.group);
    const platform = toSafeString(acc.platform);
    const gpKey = `${group}|${platform}`;
    if (!gpInfoByKey.has(gpKey)) gpInfoByKey.set(gpKey, { group, platform });
    const accWorksDaily = dailyByGp && hasOwn(dailyByGp, gpKey) ? dailyByGp[gpKey] : null;

    for (const w of Array.isArray(acc.works) ? acc.works : []) {
      if (!isPlainObject(w)) continue;
      const workId = toSafeString(w.workId);
      if (!workId) continue;
      const workKey = makeWorkKey(group, platform, workId);
      if (seenGpWorkKeys.has(workKey)) continue;
      seenGpWorkKeys.add(workKey);

      const pwKey = `${platform}|${workId}`;
      const pubMs = parseValidTimestampMs(w.publishTime);
      const pubDate = pubMs !== null ? toUtc8DateStr(pubMs) : "";
      if (cutoffDate && pubDate && pubDate > cutoffDate) {
        excludedFuturePwKeys.add(pwKey);
        continue;
      }

      const linkEntry = resolvedLink.get(workKey);
      const linkedKey = linkEntry ? toSafeString(linkEntry.contentKey) || null : null;
      const matchedBy = linkEntry ? linkEntry.matchedBy || null : null;
      const score =
        linkEntry && matchedBy === "fuzzy" && typeof linkEntry.score === "number" && Number.isFinite(linkEntry.score)
          ? linkEntry.score
          : null;
      const hasOverride = overrideMap.has(workKey);

      const snap = resolveWorkSnapshotAsOf(workId, accWorksDaily, cutoffDate);
      const obs = {
        workKey,
        group,
        platform,
        workId,
        title: toSafeString(w.title),
        url: toSafeTrimmed(w.url),
        pubMs,
        pubDate,
        linkedKey,
        matchedBy,
        score,
        hasOverride,
        snap,
        fromWorksJson: true,
      };
      pushToMap(obsByPw, pwKey, obs);
      if (linkedKey && !contentByKey.has(linkedKey)) {
        pushToMap(syntheticObsByContentKey, linkedKey, obs);
      }
    }
  }

  // 为 auto:* / manual:* 合成桶确定性地选取簇内最早发布作品的标题（不依赖输入顺序）
  const syntheticTitleByKey = new Map();
  for (const [ck, list] of syntheticObsByContentKey.entries()) {
    const sorted = [...list].sort((a, b) => {
      const aHas = a.pubMs !== null;
      const bHas = b.pubMs !== null;
      if (aHas !== bHas) return aHas ? -1 : 1;
      if (aHas && a.pubMs !== b.pubMs) return a.pubMs - b.pubMs;
      return compareText(a.workKey, b.workKey);
    });
    const chosen = sorted.find((o) => o.fromWorksJson && o.title) || sorted[0];
    syntheticTitleByKey.set(ck, (chosen && chosen.title) || "(无标题)");
  }

  // 2. 遍历 worksDaily 中出现但 works.json 缺失的作品 ID，作为未关联观测保留
  if (dailyByGp) {
    for (const [gpKey, accWorksDaily] of Object.entries(dailyByGp)) {
      if (!isPlainObject(accWorksDaily)) continue;
      let gpInfo = gpInfoByKey.get(gpKey);
      if (!gpInfo) {
        const sep = gpKey.lastIndexOf("|");
        if (sep === -1) continue;
        gpInfo = { group: gpKey.slice(0, sep), platform: gpKey.slice(sep + 1) };
      }
      const { group, platform } = gpInfo;
      for (const workId of Object.keys(accWorksDaily)) {
        if (!workId) continue;
        const workKey = makeWorkKey(group, platform, workId);
        if (seenGpWorkKeys.has(workKey)) continue;
        seenGpWorkKeys.add(workKey);

        const snap = resolveWorkSnapshotAsOf(workId, accWorksDaily, cutoffDate);
        if (!snap) continue;
        const pwKey = `${platform}|${workId}`;
        pushToMap(obsByPw, pwKey, {
          workKey,
          group,
          platform,
          workId,
          title: DELETED_WORK_TITLE,
          url: "",
          pubMs: null,
          pubDate: "",
          linkedKey: null,
          matchedBy: null,
          score: null,
          hasOverride: false,
          snap,
          fromWorksJson: false,
        });
      }
    }
  }

  // 3. 按 platform|workId 跨组去重：同一作品只取一份 ≤date 最近快照，归入按分组名排序的首个分组
  for (const [pwKey, obsList] of obsByPw.entries()) {
    if (excludedFuturePwKeys.has(pwKey)) continue;
    obsList.sort((a, b) => compareText(a.group, b.group));

    const { platform, workId } = obsList[0];
    const manualAssignObs = obsList.filter((o) => o.matchedBy === "manual" && o.linkedKey != null);
    const manualDetachObs = obsList.filter((o) => o.matchedBy === "manual-detach");
    let linkedObs;
    if (manualAssignObs.length > 0) {
      // 手工指定优先于自动结果；若多组手工指定指向不同内容仍视为冲突
      linkedObs =
        new Set(manualAssignObs.map((o) => o.linkedKey)).size === 1 ? manualAssignObs : [];
    } else if (manualDetachObs.length > 0) {
      // 手工拆出优先于自动结果
      linkedObs = [];
    } else {
      linkedObs = obsList.filter((o) => o.linkedKey != null);
      // 同一平台作品在不同分组关联到不同内容：证据冲突无法裁决，整体作未关联行
      if (new Set(linkedObs.map((o) => o.linkedKey)).size > 1) linkedObs = [];
    }
    const bestSnap = pickLatestSnapshot(obsList);

    if (linkedObs.length > 0) {
      const linkedKey = linkedObs[0].linkedKey;
      const sameContentObs = linkedObs.filter((o) => o.linkedKey === linkedKey);
      const primaryObs = sameContentObs[0];
      const primaryGroup = primaryObs.group;
      const bestTitle =
        (sameContentObs.find((o) => o.fromWorksJson && o.title) ||
          obsList.find((o) => o.fromWorksJson && o.title) ||
          primaryObs).title || "(无标题)";
      const bestUrl =
        (sameContentObs.find((o) => o.url) || obsList.find((o) => o.url) || {}).url || "";
      const bestPubMs = pickMinValidPubMs(sameContentObs) ?? pickMinValidPubMs(obsList);

      const bucketId = `linked:${linkedKey}`;
      let bucket = buckets.get(bucketId);
      if (!bucket) {
        if (!bestSnap) continue;
        const meta = contentByKey.get(linkedKey);
        const fallbackTitle =
          syntheticTitleByKey.get(linkedKey) ||
          (sameContentObs.find((o) => o.fromWorksJson && o.title) || {}).title ||
          "";
        bucket = meta
          ? makeBucket(linkedKey, toSafeString(meta.c.displayTitle), toSafeString(meta.c.file), meta.recordDate, null, false)
          : makeBucket(linkedKey, fallbackTitle, "", "", null, false);
        buckets.set(bucketId, bucket);
      }

      if (bestPubMs !== null) {
        if (bucket.minWorkPublishMs === null || bestPubMs < bucket.minWorkPublishMs) {
          bucket.minWorkPublishMs = bestPubMs;
        }
      }
      if (bestSnap) {
        addWorkToBucket(
          bucket,
          {
            workKey: primaryObs.workKey,
            workId,
            group: primaryGroup,
            platform,
            title: bestTitle,
            url: bestUrl,
            publishDate: bestPubMs !== null ? toUtc8DateStr(bestPubMs) : "",
            matchedBy: primaryObs.matchedBy,
            score: primaryObs.score,
            hasOverride: primaryObs.hasOverride,
            ...bestSnap.metrics,
          },
          bestSnap.metrics
        );
      }
    } else if (bestSnap) {
      const primaryObs = manualDetachObs.length > 0 ? manualDetachObs[0] : obsList[0];
      const primaryGroup = primaryObs.group;
      const metaObs = obsList.find((o) => o.fromWorksJson);
      const bestTitle = metaObs
        ? (obsList.find((o) => o.fromWorksJson && o.title) || metaObs).title
        : DELETED_WORK_TITLE;
      const bestUrl = (obsList.find((o) => o.url) || {}).url || "";
      const bestPubMs = pickMinValidPubMs(obsList);

      const bucket = makeBucket(
        `unlinked:${platform}:${workId}`,
        bestTitle,
        "",
        "",
        bestPubMs,
        true
      );
      addWorkToBucket(
        bucket,
        {
          workKey: primaryObs.workKey,
          workId,
          group: primaryGroup,
          platform,
          title: bestTitle || "(无标题)",
          url: bestUrl,
          publishDate: bestPubMs !== null ? toUtc8DateStr(bestPubMs) : "",
          matchedBy: primaryObs.matchedBy === "manual-detach" ? "manual-detach" : null,
          score: null,
          hasOverride: primaryObs.hasOverride,
          ...bestSnap.metrics,
        },
        bestSnap.metrics
      );
      buckets.set(`unlinked:${pwKey}`, bucket);
    }
  }

  const rows = [];
  for (const b of buckets.values()) {
    // 保证每个平台单元格内 works / workIds 顺序确定（按 workId 升序）
    for (const cell of Object.values(b.perPlatform)) {
      if (Array.isArray(cell.works) && cell.works.length > 1) {
        cell.works.sort((a, bItem) => compareText(a.workId, bItem.workId));
        cell.workIds = cell.works.map((w) => w.workId);
      }
    }
    const hasWorkPub = b.minWorkPublishMs !== null;
    const matchInfo = summarizeBucketMatch(b);
    const row = {
      contentKey: b.contentKey,
      title: b.title,
      file: b.file,
      firstPublishDate: hasWorkPub ? toUtc8DateStr(b.minWorkPublishMs) : b.recordFirstDate,
      firstPublishDateSource: hasWorkPub || b.isUnlinked ? "work" : "record",
      platformCount: b.platforms.size,
      isUnlinked: b.isUnlinked,
      matchMethod: matchInfo.matchMethod,
      matchScore: matchInfo.matchScore,
      hasFuzzy: matchInfo.hasFuzzy,
      hasManual: matchInfo.hasManual,
      isManualDetach: matchInfo.isManualDetach,
    };
    const cells = Object.values(b.perPlatform);
    for (const k of WORK_STAT_KEYS) {
      let total = null;
      for (const cell of cells) total = mergeMetricValue(total, cell[k]);
      row[STAT_TO_TOTAL_KEY[k]] = total;
    }
    row.perPlatform = b.perPlatform;
    rows.push(row);
  }

  return rows.sort((a, b) => {
    if (a.firstPublishDate !== b.firstPublishDate) {
      if (!a.firstPublishDate) return 1;
      if (!b.firstPublishDate) return -1;
      return a.firstPublishDate > b.firstPublishDate ? -1 : 1;
    }
    if (a.totalPlay !== b.totalPlay) {
      if (a.totalPlay === null) return 1;
      if (b.totalPlay === null) return -1;
      return b.totalPlay - a.totalPlay;
    }
    return compareText(a.contentKey, b.contentKey);
  });
}

module.exports = {
  FUZZY_SIM_THRESHOLD,
  FUZZY_MISSING_TIME_PENALTY,
  FUZZY_MARGIN_MIN,
  FUZZY_MAX_DAY_DIFF,
  FUZZY_SUBSTRING_MIN_LEN,
  FUZZY_SUBSTRING_SCORE,
  FUZZY_THRESHOLDS,
  normalizeTitle,
  extractCoreTitle,
  computeTitleSimilarity,
  buildTitleIndex,
  normalizeStatusTitle,
  normalizeUrl,
  isManagementUrl,
  makeWorkKey,
  buildContentIndex,
  linkWorks,
  buildContentSummaryRows,
};
