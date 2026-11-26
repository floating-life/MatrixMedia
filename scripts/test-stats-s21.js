#!/usr/bin/env node
"use strict";

/**
 * 卡 S21：分组·平台页（发布增长表）默认显示当前累计单测
 *
 * 覆盖：
 * 1. PublishGrowth.vue 与 group.vue 模板编译通过；顶部说明文案、新增「下条发布前播放」列与 tooltip 绑定正确
 * 2. 有 closedStats 时：播放/点赞/收藏/分享/评论/关注变化均取 row 当前累计值（不被 closedStats 覆盖）；
 *    「下条发布前播放」显示 closedStats.play，tooltip 显示封闭时间 closedAt 与封闭时点赞/评论
 * 3. 无 closedStats 时：各指标列取 row 当前累计值，「下条发布前播放」显示 "-"，无 tooltip
 * 4. 边界值：0 值（play=0 / closedStats.play=0 / fansDelta=0）、缺失/null/NaN 字段、千分位格式、负 fansDelta、空 row
 * 5. 排序/分页/同步按钮行为回归：pageRows 保持输入顺序、翻页与 indexOffset 正常、lastSyncText 与 @sync 保留
 * 6. 编译后的 Vue 模板实际执行各列 scoped slot（有/无 closedStats 渲染结果校验）
 * 7. 与 store.mergeWorks 联调（不改动 store 封闭逻辑）：封闭后再更新累计播放，表内显示最新累计值 + 封闭播放列
 *
 * 运行：node scripts/test-stats-s21.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { build } = require("esbuild");
const vueCompiler = require("vue-template-compiler");

function localFmt(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}`;
}

function mountCtx(comp, props = {}) {
  const emitted = [];
  const ctx = {
    works: [],
    syncing: false,
    lastCollectAt: 0,
    ...props,
    ...comp.data(),
    $emit: (ev, ...args) => emitted.push({ ev, args }),
  };
  for (const [k, fn] of Object.entries(comp.computed || {})) {
    Object.defineProperty(ctx, k, { get: () => fn.call(ctx), configurable: true });
  }
  for (const [k, fn] of Object.entries(comp.methods || {})) {
    ctx[k] = fn.bind(ctx);
  }
  ctx._emitted = emitted;
  return ctx;
}

/** 轻量 VNode 执行器：直接跑 vue-template-compiler 生成的 render 函数，检查各列 slot 输出 */
function renderTemplateVNode(compiled, ctx) {
  const staticFns = (compiled.staticRenderFns || []).map((code) => new Function(code));
  const proxy = Object.create(ctx);
  proxy._c = (tag, data, children) => ({
    tag,
    data: data || {},
    children: Array.isArray(children) ? children : children ? [children] : [],
  });
  proxy._v = (text) => ({ text: String(text) });
  proxy._s = (val) => (val == null ? "" : String(val));
  proxy._e = () => ({ empty: true });
  proxy._m = (idx) => staticFns[idx].call(proxy);
  proxy._u = (fns) => {
    const res = {};
    for (const item of fns) {
      if (item && item.key) res[item.key] = item.fn;
    }
    return res;
  };
  const renderFn = new Function(compiled.render);
  return renderFn.call(proxy);
}

function findAllNodes(node, predicate, acc = []) {
  if (!node || typeof node !== "object") return acc;
  if (predicate(node)) acc.push(node);
  if (Array.isArray(node.children)) {
    for (const ch of node.children) findAllNodes(ch, predicate, acc);
  }
  return acc;
}

function collectText(node) {
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  if (Array.isArray(node.children)) return node.children.map(collectText).join("");
  return "";
}

async function runTests() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mm-stats-s21-"));
  try {
    const publishGrowthPath = path.resolve(
      __dirname,
      "../src/renderer/views/dataStats/components/PublishGrowth.vue"
    );
    const groupVuePath = path.resolve(
      __dirname,
      "../src/renderer/views/dataStats/group.vue"
    );

    /* ---------- 1. 模板编译与文案/结构校验 ---------- */
    const pgSfc = vueCompiler.parseComponent(fs.readFileSync(publishGrowthPath, "utf8"));
    const pgCompiled = vueCompiler.compile(pgSfc.template.content);
    assert.strictEqual(
      pgCompiled.errors.length,
      0,
      `PublishGrowth.vue 模板编译失败: ${pgCompiled.errors.join("; ")}`
    );

    const expectedTip =
      "数值为最新采集的累计值；『下条发布前播放』为下一条视频发布那一刻本条的播放量，用于比较两次发布之间的增长。";
    assert.ok(
      pgSfc.template.content.includes(expectedTip),
      "顶部说明文案与需求不一致"
    );
    assert.ok(
      !pgSfc.template.content.includes("封闭统计"),
      "旧版「封闭统计」说明文案应已替换"
    );
    assert.ok(
      pgSfc.template.content.includes('label="下条发布前播放"'),
      "应新增「下条发布前播放」列"
    );
    assert.ok(
      pgSfc.template.content.includes("<el-tooltip"),
      "「下条发布前播放」列应使用 el-tooltip 展示封闭详情"
    );

    const groupSfc = vueCompiler.parseComponent(fs.readFileSync(groupVuePath, "utf8"));
    const groupCompiled = vueCompiler.compile(groupSfc.template.content);
    assert.strictEqual(
      groupCompiled.errors.length,
      0,
      `group.vue 模板编译失败: ${groupCompiled.errors.join("; ")}`
    );
    assert.ok(groupSfc.template.content.includes("<publish-growth"), "group.vue 仍挂载 publish-growth");
    assert.ok(groupSfc.template.content.includes(':works="works"'), "group.vue 透传 works");
    assert.ok(groupSfc.template.content.includes('@sync="syncThis"'), "group.vue 保持同步事件");
    console.log("✓ 1. PublishGrowth.vue & group.vue 模板编译与文案校验通过");

    /* ---------- 2. 打包脚本并加载导出纯函数与组件定义 ---------- */
    const bundlePath = path.join(tmpRoot, "PublishGrowth.cjs");
    await build({
      stdin: {
        contents: pgSfc.script.content,
        resolveDir: path.dirname(publishGrowthPath),
        loader: "js",
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: bundlePath,
    });
    const mod = require(bundlePath);
    const comp = mod.default;
    const {
      currentStatsOf,
      hasClosedStats,
      closedPlayOf,
      closedTooltipOf,
      formatNum,
      formatTime,
    } = mod;

    /* ---------- 3. 真机现象复现：有 closedStats 时各指标列显示当前累计值 + 封闭播放列 ---------- */
    {
      const closedTs = Date.parse("2026-11-25T19:07:00+08:00");
      const pubTs = Date.parse("2026-11-24T12:00:00+08:00");
      const ksRow = {
        workId: "ks_ai_brain",
        title: "AI不是电子大脑",
        publishTime: pubTs,
        play: 2964,
        like: 85,
        favorite: 23,
        share: 11,
        comment: 14,
        fansDelta: 6,
        closedStats: {
          play: 4,
          like: 1,
          favorite: 0,
          share: 0,
          comment: 0,
          fansDelta: 0,
        },
        closedAt: closedTs,
      };

      const cur = currentStatsOf(ksRow);
      assert.strictEqual(cur.play, 2964, "播放列必须取当前累计值 2964 而非封闭值 4");
      assert.strictEqual(cur.like, 85, "点赞列必须取当前累计值");
      assert.strictEqual(cur.favorite, 23, "收藏列必须取当前累计值");
      assert.strictEqual(cur.share, 11, "分享列必须取当前累计值");
      assert.strictEqual(cur.comment, 14, "评论列必须取当前累计值");
      assert.strictEqual(cur.fansDelta, 6, "关注变化列必须取当前累计值");
      assert.strictEqual(formatNum(cur.play), "2,964");

      assert.strictEqual(hasClosedStats(ksRow), true);
      assert.strictEqual(closedPlayOf(ksRow), "4", "下条发布前播放应显示 closedStats.play");
      const tip = closedTooltipOf(ksRow);
      assert.strictEqual(
        tip,
        `封闭时间：${localFmt(closedTs)}｜封闭时点赞：1｜封闭时评论：0`,
        "tooltip 应显示封闭时间 closedAt 与封闭时的点赞/评论"
      );

      // 大数千分位格式化
      const bigClosed = {
        play: 15000,
        like: 1200,
        closedStats: { play: 12345, like: 1005, comment: 2345 },
        closedAt: closedTs,
      };
      assert.strictEqual(closedPlayOf(bigClosed), "12,345");
      assert.strictEqual(
        closedTooltipOf(bigClosed),
        `封闭时间：${localFmt(closedTs)}｜封闭时点赞：1,005｜封闭时评论：2,345`
      );
      console.log("✓ 2. 有 closedStats 时各指标列显示当前累计值，新增列显示封闭播放与 tooltip");
    }

    /* ---------- 4. 无 closedStats 时各列取值 ---------- */
    {
      const latestRow = {
        workId: "ks_latest",
        title: "最新一条作品",
        publishTime: Date.parse("2026-11-25T19:07:00+08:00"),
        play: 120,
        like: 9,
        favorite: 3,
        share: 2,
        comment: 1,
        fansDelta: -2,
        closedStats: null,
        closedAt: null,
      };

      const cur = currentStatsOf(latestRow);
      assert.deepStrictEqual(cur, {
        play: 120,
        like: 9,
        favorite: 3,
        share: 2,
        comment: 1,
        fansDelta: -2,
      });
      assert.strictEqual(hasClosedStats(latestRow), false);
      assert.strictEqual(closedPlayOf(latestRow), "-", "无 closedStats 时下条发布前播放显示 -");
      assert.strictEqual(closedTooltipOf(latestRow), "", "无 closedStats 时 tooltip 为空");

      // closedStats 省略（undefined）
      const omittedRow = { workId: "x", play: 50, like: 2 };
      assert.strictEqual(hasClosedStats(omittedRow), false);
      assert.strictEqual(closedPlayOf(omittedRow), "-");
      assert.strictEqual(closedTooltipOf(omittedRow), "");
      console.log("✓ 3. 无 closedStats 时各列取当前值，下条发布前播放显示 -");
    }

    /* ---------- 5. 边界值：0 值、缺失字段、不回退 closedStats、非法值 ---------- */
    {
      const closedTs = Date.parse("2026-11-25T19:07:00+08:00");

      // 当前值为 0 或 null 时，绝不回退取 closedStats
      const zeroAndNullRow = {
        play: 0,
        like: null,
        favorite: undefined,
        share: 0,
        comment: null,
        fansDelta: 0,
        closedStats: { play: 0, like: 0, favorite: 5, share: 3, comment: 0, fansDelta: 9 },
        closedAt: closedTs,
      };
      const cur = currentStatsOf(zeroAndNullRow);
      assert.strictEqual(cur.play, 0);
      assert.strictEqual(formatNum(cur.play), "0");
      assert.strictEqual(cur.like, null);
      assert.strictEqual(formatNum(cur.like), "-");
      assert.strictEqual(cur.favorite, null);
      assert.strictEqual(cur.share, 0);
      assert.strictEqual(cur.comment, null);
      assert.strictEqual(cur.fansDelta, 0);
      assert.strictEqual(hasClosedStats(zeroAndNullRow), true);
      assert.strictEqual(closedPlayOf(zeroAndNullRow), "0", "closedStats.play=0 必须显示 0 而非 -");
      assert.strictEqual(
        closedTooltipOf(zeroAndNullRow),
        `封闭时间：${localFmt(closedTs)}｜封闭时点赞：0｜封闭时评论：0`
      );

      // row.play 为 null、closedStats.play 有值时，播放列仍显示 -（不混用封闭值）
      const nullPlayRow = {
        play: null,
        closedStats: { play: 99, like: null, comment: undefined },
        closedAt: null,
      };
      assert.strictEqual(formatNum(currentStatsOf(nullPlayRow).play), "-");
      assert.strictEqual(closedPlayOf(nullPlayRow), "99");
      assert.strictEqual(
        closedTooltipOf(nullPlayRow),
        "封闭时间：-｜封闭时点赞：-｜封闭时评论：-"
      );

      // closedStats 存在但 play 缺失
      const missingClosedPlay = {
        play: 500,
        closedStats: { play: null, like: 3, comment: 1 },
        closedAt: closedTs,
      };
      assert.strictEqual(hasClosedStats(missingClosedPlay), true);
      assert.strictEqual(closedPlayOf(missingClosedPlay), "-");
      assert.strictEqual(
        closedTooltipOf(missingClosedPlay),
        `封闭时间：${localFmt(closedTs)}｜封闭时点赞：3｜封闭时评论：1`
      );

      // 空 row / 非法类型不抛错
      assert.deepStrictEqual(currentStatsOf(null), {
        play: null,
        like: null,
        favorite: null,
        share: null,
        comment: null,
        fansDelta: null,
      });
      assert.strictEqual(hasClosedStats(null), false);
      assert.strictEqual(hasClosedStats({ closedStats: [] }), false);
      assert.strictEqual(closedPlayOf(undefined), "-");
      assert.strictEqual(closedTooltipOf(undefined), "");
      assert.strictEqual(formatNum(""), "-");
      assert.strictEqual(formatNum(NaN), "-");
      assert.strictEqual(formatNum(false), "-");
      assert.strictEqual(formatTime(0), "-");
      assert.strictEqual(formatTime("not-a-date"), "-");
      console.log("✓ 4. 边界值（0值/null/缺失字段/不回退 closedStats/非法输入）校验通过");
    }

    /* ---------- 6. 组件实例：排序顺序、分页、同步按钮与实际模板 slot 渲染 ---------- */
    {
      const closedTs = Date.parse("2026-11-25T19:07:00+08:00");
      const lastCollectAt = Date.parse("2026-11-26T10:30:00+08:00");
      const works = Array.from({ length: 12 }, (_, idx) => ({
        workId: `w_${idx + 1}`,
        title: `作品 ${idx + 1}`,
        publishTime: Date.parse("2026-11-26T00:00:00+08:00") - idx * 3600e3,
        play: (idx + 1) * 1000,
        like: (idx + 1) * 10,
        favorite: idx + 1,
        share: idx,
        comment: idx * 2,
        fansDelta: idx === 0 ? null : idx % 2 === 0 ? -idx : idx,
        closedStats:
          idx === 0
            ? null
            : { play: idx * 5, like: idx, comment: Math.floor(idx / 2) },
        closedAt: idx === 0 ? null : closedTs,
      }));

      const ctx = mountCtx(comp, { works, syncing: false, lastCollectAt });
      assert.strictEqual(ctx.pageSize, 10);
      assert.strictEqual(ctx.page, 1);
      assert.strictEqual(ctx.pageRows.length, 10);
      assert.deepStrictEqual(
        ctx.pageRows.map((w) => w.workId),
        works.slice(0, 10).map((w) => w.workId),
        "第 1 页应保持 works 原排序"
      );
      assert.strictEqual(ctx.indexOffset(0), 1);
      assert.strictEqual(ctx.indexOffset(9), 10);
      assert.strictEqual(ctx.lastSyncText, localFmt(lastCollectAt));

      // 翻到第 2 页
      ctx.page = 2;
      assert.strictEqual(ctx.pageRows.length, 2);
      assert.deepStrictEqual(
        ctx.pageRows.map((w) => w.workId),
        ["w_11", "w_12"],
        "第 2 页切片正确"
      );
      assert.strictEqual(ctx.indexOffset(0), 11);
      assert.strictEqual(ctx.indexOffset(1), 12);

      // 无 lastCollectAt 时 lastSyncText 为空
      const ctxEmptySync = mountCtx(comp, { works: [], syncing: true, lastCollectAt: 0 });
      assert.strictEqual(ctxEmptySync.lastSyncText, "");

      // 执行编译后的模板 render，校验每列 scoped slot 输出
      ctx.page = 1;
      const vnode = renderTemplateVNode(pgCompiled, ctx);
      const syncBtn = findAllNodes(vnode, (n) => n.tag === "el-button")[0];
      assert.ok(syncBtn, "应存在同步按钮");
      syncBtn.data.on.click();
      assert.strictEqual(ctx._emitted.length, 1);
      assert.strictEqual(ctx._emitted[0].ev, "sync", "点击同步按钮应触发 sync 事件");

      const cols = findAllNodes(vnode, (n) => n.tag === "el-table-column");
      const colByLabel = new Map(cols.map((c) => [c.data.attrs && c.data.attrs.label, c]));
      assert.deepStrictEqual(
        cols.map((c) => c.data.attrs && c.data.attrs.label),
        ["#", "视频标题", "发布日期", "播放", "下条发布前播放", "点赞", "收藏", "分享", "评论", "关注变化"],
        "列清单与顺序符合预期"
      );

      // 校验有 closedStats 的行（works[1]: play=2000, closedStats.play=5）
      const closedRow = works[1];
      const playSlotClosed = colByLabel.get("播放").data.scopedSlots.default({ row: closedRow });
      assert.strictEqual(collectText({ children: playSlotClosed }).trim(), "2,000");

      const prePlayNodes = colByLabel.get("下条发布前播放").data.scopedSlots.default({ row: closedRow });
      const tooltipNode = findAllNodes({ children: prePlayNodes }, (n) => n.tag === "el-tooltip")[0];
      assert.ok(tooltipNode, "有 closedStats 的行应渲染 el-tooltip");
      assert.strictEqual(
        tooltipNode.data.attrs.content,
        `封闭时间：${localFmt(closedTs)}｜封闭时点赞：1｜封闭时评论：0`
      );
      assert.strictEqual(collectText(tooltipNode).trim(), "5");

      // 校验无 closedStats 的行（works[0]: play=1000, closedStats=null）
      const openRow = works[0];
      const playSlotOpen = colByLabel.get("播放").data.scopedSlots.default({ row: openRow });
      assert.strictEqual(collectText({ children: playSlotOpen }).trim(), "1,000");

      const prePlayOpenNodes = colByLabel.get("下条发布前播放").data.scopedSlots.default({ row: openRow });
      const tooltipOpen = findAllNodes({ children: prePlayOpenNodes }, (n) => n.tag === "el-tooltip");
      assert.strictEqual(tooltipOpen.length, 0, "无 closedStats 的行不应渲染 el-tooltip");
      assert.strictEqual(collectText({ children: prePlayOpenNodes }).trim(), "-");

      // 校验关注变化列（正/负/null）
      const fansSlotPos = colByLabel.get("关注变化").data.scopedSlots.default({ row: works[1] });
      assert.strictEqual(collectText({ children: fansSlotPos }).trim(), "+1");
      const fansSlotNeg = colByLabel.get("关注变化").data.scopedSlots.default({ row: works[2] });
      assert.strictEqual(collectText({ children: fansSlotNeg }).trim(), "-2");
      const fansSlotNull = colByLabel.get("关注变化").data.scopedSlots.default({ row: works[0] });
      assert.strictEqual(collectText({ children: fansSlotNull }).trim(), "-");

      console.log("✓ 5. 组件分页/排序/同步事件与模板各列渲染校验通过");
    }

    /* ---------- 7. 与 store.mergeWorks 联调：不改封闭逻辑，展示层读当前累计 + 封闭快照 ---------- */
    {
      const storeTmp = path.join(tmpRoot, "store-userdata");
      fs.mkdirSync(storeTmp, { recursive: true });
      const prevElectron = require.cache[require.resolve("electron")];
      const storePath = require.resolve("../src/main/services/dataStats/store.js");
      delete require.cache[storePath];
      require.cache[require.resolve("electron")] = {
        id: "electron",
        filename: "electron",
        loaded: true,
        exports: { app: { getPath: () => storeTmp } },
      };
      try {
        const store = require(storePath);
        const t1 = Date.parse("2026-11-25T18:00:00+08:00");
        const t2 = Date.parse("2026-11-25T19:07:00+08:00");
        const t3 = Date.parse("2026-11-26T09:00:00+08:00");

        // 首次采集：《AI不是电子大脑》刚发，play=4
        store.mergeWorks(
          "赛博老司机",
          "快手",
          [
            {
              workId: "W1",
              title: "AI不是电子大脑",
              publishTime: Date.parse("2026-11-25T17:50:00+08:00"),
              play: 4,
              like: 1,
              comment: 0,
              share: 0,
              favorite: 0,
              fansDelta: 0,
            },
          ],
          t1
        );

        // 第二次采集：新作品 W2 发布 → W1 在 t2 时刻被封闭（closedStats.play=4）
        store.mergeWorks(
          "赛博老司机",
          "快手",
          [
            {
              workId: "W1",
              title: "AI不是电子大脑",
              publishTime: Date.parse("2026-11-25T17:50:00+08:00"),
              play: 4,
              like: 1,
              comment: 0,
              share: 0,
              favorite: 0,
              fansDelta: 0,
            },
            {
              workId: "W2",
              title: "下一条新视频",
              publishTime: t2,
              play: 12,
              like: 2,
              comment: 1,
              share: 0,
              favorite: 0,
              fansDelta: 1,
            },
          ],
          t2
        );

        // 第三次采集：W1 爆量涨到 2964，closedStats.play 仍保留封闭时的 4
        store.mergeWorks(
          "赛博老司机",
          "快手",
          [
            {
              workId: "W1",
              title: "AI不是电子大脑",
              publishTime: Date.parse("2026-11-25T17:50:00+08:00"),
              play: 2964,
              like: 90,
              comment: 15,
              share: 8,
              favorite: 20,
              fansDelta: 5,
            },
            {
              workId: "W2",
              title: "下一条新视频",
              publishTime: t2,
              play: 350,
              like: 18,
              comment: 4,
              share: 2,
              favorite: 6,
              fansDelta: 2,
            },
          ],
          t3
        );

        const works = store.readAccount("赛博老司机", "快手").works;
        assert.deepStrictEqual(works.map((w) => w.workId), ["W2", "W1"], "倒序排列保持不变");

        const w1 = works.find((w) => w.workId === "W1");
        const w2 = works.find((w) => w.workId === "W2");

        // store 封闭数据未被改动
        assert.strictEqual(w1.closedStats.play, 4);
        assert.strictEqual(w1.closedAt, t2);
        assert.strictEqual(w2.closedStats, null);

        // PublishGrowth 展示逻辑
        assert.strictEqual(formatNum(currentStatsOf(w1).play), "2,964");
        assert.strictEqual(formatNum(currentStatsOf(w1).like), "90");
        assert.strictEqual(formatNum(currentStatsOf(w1).comment), "15");
        assert.strictEqual(closedPlayOf(w1), "4");
        assert.strictEqual(
          closedTooltipOf(w1),
          `封闭时间：${localFmt(t2)}｜封闭时点赞：1｜封闭时评论：0`
        );

        assert.strictEqual(formatNum(currentStatsOf(w2).play), "350");
        assert.strictEqual(hasClosedStats(w2), false);
        assert.strictEqual(closedPlayOf(w2), "-");
        assert.strictEqual(closedTooltipOf(w2), "");
      } finally {
        delete require.cache[storePath];
        if (prevElectron) require.cache[require.resolve("electron")] = prevElectron;
        else delete require.cache[require.resolve("electron")];
      }
      console.log("✓ 6. store.mergeWorks 联调（封闭逻辑未变 + PublishGrowth 展示当前累计与封闭播放）通过");
    }

    console.log("\nALL S21 TESTS PASSED");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
