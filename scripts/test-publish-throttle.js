"use strict";

/**
 * S11 发布节流 / 平台错峰 / 默认 AI 创作声明 综合单测：
 * 1. 纯排期算法：间隔不足顺延（含 ≤1min 立即 vs >1min 定时边界、同平台多账号隔离、同账号顺序累积、失败/草稿不计数）
 * 2. 纯排期算法：跨允许时段顺延到次日 06:00（含 05:59:59 / 23:30:00 / 23:30:01 边界）
 * 3. 纯排期算法：同账号每日上限顺延到次日首个可用时刻（含连满两天顺延至第 3 天、0=不限）
 * 4. 纯排期算法：百家号相对首发延迟 +10h（含跨时段叠加与最小间隔取 max）
 * 5. 纯排期算法：显式 publishAt 过节流且只顺延不提前
 * 6. 纯排期算法与三端：noThrottle / --no-throttle / 总开关关闭绕过
 * 7. 主进程持久化设置与 IPC（读写、校验、重置、损坏回退、排期预览、定时创建去重）
 * 8. HTTP POST /publish & GET /creative-statements：多平台部分立即部分定时、与 S10 重复拦截叠加、默认声明套用与覆盖、不支持平台回退
 * 9. CLI publish：单文件节流自动转定时、--no-throttle 绕过、重复拦截先于排期、默认声明套用与覆盖
 * 10. 重启恢复：节流生成的定时任务落盘 pushData → 停调度器模拟退出 → 重新加载模块并启动调度器 → 定时任务仍在且重新挂上定时器
 * 11. GUI 模板编译与接线（PublishThrottleSettingsCard / LocalVideoPublish / videoManager / projectDetail）与文档校验
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const esbuild = require("esbuild");
const compiler = require("vue-template-compiler");

const root = path.resolve(__dirname, "..");

const {
  IMMEDIATE_THRESHOLD_MS,
  createDefaultPublishThrottleSettings,
  normalizePublishThrottleSettings,
  validatePublishThrottleSettings,
  formatUtc8DateTime,
  parseUtc8DateTimeMs,
  planPublishTimes,
  comparePlanForGuiDrift,
} = require("../src/shared/publishThrottle.js");

const throttleService = require("../src/main/services/publishThrottle.js");

function t8(isoWithoutTz) {
  return Date.parse(`${isoWithoutTz}+08:00`);
}

function testCase1_IntervalPostponeAndBoundaries() {
  const now = t8("2026-11-21T10:00:00");
  const settings = createDefaultPublishThrottleSettings();

  // 默认配置校验：总开关开、抖音 6h、其余 4h、日上限 3、相对延迟 0、允许时段 06:00-23:30、默认声明 ai_generated
  assert.strictEqual(settings.enabled, true);
  assert.strictEqual(settings.platforms["抖音"].minIntervalHours, 6);
  assert.strictEqual(settings.platforms["快手"].minIntervalHours, 4);
  assert.strictEqual(settings.platforms["百家号"].minIntervalHours, 4);
  assert.strictEqual(settings.platforms["百家号"].delayFromFirstHours, 0);
  assert.strictEqual(settings.platforms["抖音"].dailyLimit, 3);
  assert.deepStrictEqual(settings.allowedWindow, { start: "06:00", end: "23:30" });
  assert.strictEqual(settings.defaultCreativeStatement, "ai_generated");

  const records = [
    // 抖音 A组 1 小时前刚成功发过（间隔 6h → 15:00）
    {
      id: "r1",
      pt: "抖音",
      phone: "A组",
      partition: "persist:A组抖音",
      publishStatus: "success",
      lastPublishAt: t8("2026-11-21T09:00:00"),
    },
    // 快手 A组 失败记录与草稿记录不计入节流
    {
      id: "r2",
      pt: "快手",
      phone: "A组",
      partition: "persist:A组快手",
      publishStatus: "failed",
      lastPublishAt: t8("2026-11-21T09:50:00"),
    },
    {
      id: "r3",
      pt: "快手",
      phone: "A组",
      partition: "persist:A组快手",
      publishStatus: "draft",
      lastPublishAt: t8("2026-11-21T09:55:00"),
    },
    // 头条 A组 有进行中（publishing）记录（30 分钟前，间隔 4h → 13:30）
    {
      id: "r4",
      pt: "头条",
      phone: "A组",
      partition: "persist:A组头条",
      publishStatus: "publishing",
      lastPublishAt: t8("2026-11-21T09:30:00"),
    },
    // 视频号 A组 有待执行定时任务（12:00，间隔 4h → 16:00）
    {
      id: "r5",
      pt: "视频号",
      phone: "A组",
      partition: "persist:A组视频号",
      scheduledTask: true,
      publishStatus: "scheduled",
      scheduledPublishAt: t8("2026-11-21T12:00:00"),
    },
  ];

  // 1a. 同请求内：抖音 A组顺延至 15:00、抖音 B组互不影响立即发、快手 A组忽略失败/草稿立即发、头条 A组顺延至 13:30、视频号 A组顺延至 16:00
  const plan = planPublishTimes({
    targets: [
      { platform: "dy", phone: "A组" },
      { platform: "dy", phone: "B组" },
      { platform: "ks", phone: "A组" },
      { platform: "tt", phone: "A组" },
      { platform: "sph", phone: "A组" },
    ],
    now,
    records,
    settings,
  });

  assert.strictEqual(plan.items[0].immediate, false);
  assert.strictEqual(plan.items[0].scheduled, true);
  assert.strictEqual(plan.items[0].throttled, true);
  assert.strictEqual(plan.items[0].publishAt, "2026-11-21 15:00:00");
  assert.ok(plan.items[0].reason.includes("距上次抖音发布不足 6 小时"), plan.items[0].reason);

  // 同平台不同账号互不影响
  assert.strictEqual(plan.items[1].immediate, true);
  assert.strictEqual(plan.items[1].scheduled, false);
  assert.strictEqual(plan.items[1].publishAt, null);

  // 失败/草稿不计入节流
  assert.strictEqual(plan.items[2].immediate, true);
  assert.strictEqual(plan.items[2].scheduled, false);

  // 进行中记录计入节流
  assert.strictEqual(plan.items[3].scheduled, true);
  assert.strictEqual(plan.items[3].publishAt, "2026-11-21 13:30:00");

  // 待执行定时任务计入节流
  assert.strictEqual(plan.items[4].scheduled, true);
  assert.strictEqual(plan.items[4].publishAt, "2026-11-21 16:00:00");
  assert.ok(plan.items[4].reason.includes("待发任务不足 4 小时"), plan.items[4].reason);

  // 1b. 同账号多条请求按顺序累积（A组快手连发 3 条：10:00 立即 → 14:00 定时 → 18:00 定时）
  const seqPlan = planPublishTimes({
    targets: [
      { platform: "ks", phone: "A组" },
      { platform: "ks", phone: "A组" },
      { platform: "ks", phone: "A组" },
    ],
    now,
    records: [],
    settings,
  });
  assert.strictEqual(seqPlan.items[0].immediate, true);
  assert.strictEqual(seqPlan.items[1].publishAt, "2026-11-21 14:00:00");
  assert.strictEqual(seqPlan.items[2].publishAt, "2026-11-21 18:00:00");

  // 1c. ≤ 现在+1 分钟 边界：恰好差 60s → 立即发；差 61s → 建定时任务
  assert.strictEqual(IMMEDIATE_THRESHOLD_MS, 60000);
  const edgeRec60s = [
    {
      pt: "抖音",
      phone: "A组",
      publishStatus: "success",
      lastPublishAt: now - 6 * 3600000 + 60000, // last + 6h = now + 60s
    },
  ];
  const p60 = planPublishTimes({
    targets: [{ platform: "dy", phone: "A组" }],
    now,
    records: edgeRec60s,
    settings,
  });
  assert.strictEqual(p60.items[0].immediate, true, "计划时刻恰好等于 now+1 分钟应立即发");
  assert.strictEqual(p60.items[0].throttled, false);

  const edgeRec61s = [
    {
      pt: "抖音",
      phone: "A组",
      publishStatus: "success",
      lastPublishAt: now - 6 * 3600000 + 61000, // last + 6h = now + 61s
    },
  ];
  const p61 = planPublishTimes({
    targets: [{ platform: "dy", phone: "A组" }],
    now,
    records: edgeRec61s,
    settings,
  });
  assert.strictEqual(p61.items[0].scheduled, true, "计划时刻为 now+61 秒应建定时任务");
  assert.strictEqual(p61.items[0].publishAt, "2026-11-21 10:01:01");

  console.log("✓ 1. 间隔不足顺延、1 分钟边界、多账号隔离与同账号顺序累积验证通过");
}

function testCase2_AllowedWindowRollover() {
  const settings = createDefaultPublishThrottleSettings();

  // 2a. 23:30:00 恰好在允许时段末端点 → 立即发
  const at2330 = planPublishTimes({
    targets: [{ platform: "dy", phone: "A组" }],
    now: t8("2026-11-21T23:30:00"),
    records: [],
    settings,
  });
  assert.strictEqual(at2330.items[0].immediate, true, "23:30:00 在 06:00–23:30 内应立即发");

  // 2b. 23:30:01 超出允许时段 → 顺延到次日 06:00:00
  const at233001 = planPublishTimes({
    targets: [{ platform: "dy", phone: "A组" }],
    now: t8("2026-11-21T23:30:01"),
    records: [],
    settings,
  });
  assert.strictEqual(at233001.items[0].scheduled, true);
  assert.strictEqual(at233001.items[0].publishAt, "2026-11-22 06:00:00");
  assert.ok(at233001.items[0].reason.includes("06:00–23:30"));

  // 2c. 05:58:00 凌晨未到 06:00 → 顺延到当日 06:00:00
  const at0558 = planPublishTimes({
    targets: [{ platform: "dy", phone: "A组" }],
    now: t8("2026-11-21T05:58:00"),
    records: [],
    settings,
  });
  assert.strictEqual(at0558.items[0].scheduled, true);
  assert.strictEqual(at0558.items[0].publishAt, "2026-11-21 06:00:00");

  // 2d. 05:59:30 距 06:00 仅 30 秒（≤ 1 分钟阈值）→ 立即发
  const at055930 = planPublishTimes({
    targets: [{ platform: "dy", phone: "A组" }],
    now: t8("2026-11-21T05:59:30"),
    records: [],
    settings,
  });
  assert.strictEqual(at055930.items[0].immediate, true);

  // 2e. 间隔不足把时刻推到 23:31 之后（例如 18:30 发过抖音，6h 后 00:30 → 顺延至次日 06:00:00）
  const nightPush = planPublishTimes({
    targets: [{ platform: "dy", phone: "A组" }],
    now: t8("2026-11-21T20:00:00"),
    records: [
      {
        pt: "抖音",
        phone: "A组",
        publishStatus: "success",
        lastPublishAt: t8("2026-11-21T18:30:00"),
      },
    ],
    settings,
  });
  assert.strictEqual(nightPush.items[0].scheduled, true);
  assert.strictEqual(nightPush.items[0].publishAt, "2026-11-22 06:00:00");
  assert.ok(nightPush.items[0].reason.includes("不足 6 小时"));
  assert.ok(nightPush.items[0].reason.includes("允许发布时段"));

  console.log("✓ 2. 跨允许时段（06:00–23:30 UTC+8）与端点边界顺延至次日 06:00 验证通过");
}

function testCase3_DailyLimitRollover() {
  const settings = createDefaultPublishThrottleSettings();
  const now = t8("2026-11-21T19:00:00");

  // 3a. 快手当日已有 2 条（06:00, 10:00）< 上限 3，且距 10:00 超过 4h → 立即发
  const twoToday = [
    { pt: "快手", phone: "A组", publishStatus: "success", lastPublishAt: t8("2026-11-21T06:00:00") },
    { pt: "快手", phone: "A组", publishStatus: "success", lastPublishAt: t8("2026-11-21T10:00:00") },
  ];
  const p2 = planPublishTimes({
    targets: [{ platform: "ks", phone: "A组" }],
    now,
    records: twoToday,
    settings,
  });
  assert.strictEqual(p2.items[0].immediate, true);

  // 3b. 快手当日已有 3 条（06:00, 10:00, 14:00）= 上限 3，尽管距 14:00 已超 4h，仍顺延到次日 06:00:00
  const threeToday = [
    ...twoToday,
    { pt: "快手", phone: "A组", publishStatus: "success", lastPublishAt: t8("2026-11-21T14:00:00") },
  ];
  const p3 = planPublishTimes({
    targets: [{ platform: "ks", phone: "A组" }],
    now,
    records: threeToday,
    settings,
  });
  assert.strictEqual(p3.items[0].scheduled, true);
  assert.strictEqual(p3.items[0].publishAt, "2026-11-22 06:00:00");
  assert.ok(p3.items[0].reason.includes("上限（3 条/天）"), p3.items[0].reason);

  // 3c. 同批请求第 4、5 条：次日 06:00、10:00、14:00 满 3 条后，第 4 条跨到第 3 天 06:00:00
  const pMultiDays = planPublishTimes({
    targets: [
      { platform: "ks", phone: "A组" },
      { platform: "ks", phone: "A组" },
      { platform: "ks", phone: "A组" },
      { platform: "ks", phone: "A组" },
    ],
    now,
    records: threeToday,
    settings,
  });
  assert.deepStrictEqual(
    pMultiDays.items.map((it) => it.publishAt),
    [
      "2026-11-22 06:00:00",
      "2026-11-22 10:00:00",
      "2026-11-22 14:00:00",
      "2026-11-23 06:00:00",
    ]
  );

  // 3d. dailyLimit = 0 表示不限制日上限
  const unlimitedSettings = normalizePublishThrottleSettings({
    ...settings,
    platforms: { ...settings.platforms, 快手: { minIntervalHours: 4, dailyLimit: 0, delayFromFirstHours: 0 } },
  });
  const pUnlimited = planPublishTimes({
    targets: [{ platform: "ks", phone: "A组" }],
    now,
    records: threeToday,
    settings: unlimitedSettings,
  });
  assert.strictEqual(pUnlimited.items[0].immediate, true);

  console.log("✓ 3. 每日上限边界、跨多日顺延与 0=不限 验证通过");
}

function testCase4_BjhDelayPlus10h() {
  const settings = normalizePublishThrottleSettings({
    platforms: {
      bjh: { minIntervalHours: 4, dailyLimit: 3, delayFromFirstHours: 10 },
    },
  });

  // 4a. 10:00 发 → 百家号自动延迟 +10h 至 20:00:00，抖音立即发
  const pDay = planPublishTimes({
    targets: [
      { platform: "dy", phone: "A组" },
      { platform: "bjh", phone: "A组" },
    ],
    now: t8("2026-11-21T10:00:00"),
    records: [],
    settings,
  });
  assert.strictEqual(pDay.items[0].immediate, true);
  assert.strictEqual(pDay.items[1].scheduled, true);
  assert.strictEqual(pDay.items[1].publishAt, "2026-11-21 20:00:00");
  assert.ok(pDay.items[1].reason.includes("百家号相对首发延迟 10 小时"), pDay.items[1].reason);

  // 4b. 15:00 发 → +10h = 次日 01:00 → 超出 06:00–23:30 顺延至次日 06:00:00
  const pOvernight = planPublishTimes({
    targets: [{ platform: "bjh", phone: "A组" }],
    now: t8("2026-11-21T15:00:00"),
    records: [],
    settings,
  });
  assert.strictEqual(pOvernight.items[0].scheduled, true);
  assert.strictEqual(pOvernight.items[0].publishAt, "2026-11-22 06:00:00");
  assert.ok(pOvernight.items[0].reason.includes("延迟 10 小时"));
  assert.ok(pOvernight.items[0].reason.includes("允许发布时段"));

  // 4c. 已有待发任务在 18:00（minInterval 4h → 22:00）vs 请求 10:00 + 10h = 20:00 → max(20:00, 22:00) = 22:00
  const pMax = planPublishTimes({
    targets: [{ platform: "bjh", phone: "A组" }],
    now: t8("2026-11-21T10:00:00"),
    records: [
      {
        pt: "百家号",
        phone: "A组",
        scheduledTask: true,
        publishStatus: "scheduled",
        scheduledPublishAt: t8("2026-11-21T18:00:00"),
      },
    ],
    settings,
  });
  assert.strictEqual(pMax.items[0].publishAt, "2026-11-21 22:00:00");

  console.log("✓ 4. 百家号相对首发延迟 +10h（含跨时段与最小间隔取 max）验证通过");
}

function testCase5_ExplicitPublishAtOnlyPostpones() {
  const settings = createDefaultPublishThrottleSettings();
  const now = t8("2026-11-21T10:00:00");
  const records = [
    {
      pt: "抖音",
      phone: "A组",
      publishStatus: "success",
      lastPublishAt: t8("2026-11-21T09:00:00"), // +6h = 15:00
    },
  ];

  // 5a. 用户指定 12:00（< 15:00）→ 顺延至 15:00:00
  const pPostpone = planPublishTimes({
    targets: [{ platform: "dy", phone: "A组" }],
    now,
    publishAt: "2026-11-21 12:00:00",
    records,
    settings,
  });
  assert.strictEqual(pPostpone.items[0].scheduled, true);
  assert.strictEqual(pPostpone.items[0].throttled, true);
  assert.strictEqual(pPostpone.items[0].publishAt, "2026-11-21 15:00:00");
  assert.ok(pPostpone.items[0].reason.includes("距上次抖音发布不足 6 小时"));

  // 5b. 用户指定 18:00（> 15:00 且在允许时段内）→ 保持 18:00:00，绝不提前
  const pKeep = planPublishTimes({
    targets: [{ platform: "dy", phone: "A组" }],
    now,
    publishAt: "2026-11-21 18:00:00",
    records,
    settings,
  });
  assert.strictEqual(pKeep.items[0].scheduled, true);
  assert.strictEqual(pKeep.items[0].throttled, false);
  assert.strictEqual(pKeep.items[0].publishAt, "2026-11-21 18:00:00");
  assert.strictEqual(pKeep.items[0].reason, "");

  // 5c. 用户指定凌晨 02:00（在次日允许时段外）→ 顺延到 06:00:00
  const pNight = planPublishTimes({
    targets: [{ platform: "ks", phone: "A组" }],
    now,
    publishAt: "2026-11-22 02:00:00",
    records: [],
    settings,
  });
  assert.strictEqual(pNight.items[0].throttled, true);
  assert.strictEqual(pNight.items[0].publishAt, "2026-11-22 06:00:00");

  console.log("✓ 5. 显式 publishAt 过节流（只顺延不提前）验证通过");
}

function testCase6_NoThrottleBypass() {
  const settings = createDefaultPublishThrottleSettings();
  const now = t8("2026-11-21T10:00:00");
  const records = [
    {
      pt: "抖音",
      phone: "A组",
      publishStatus: "success",
      lastPublishAt: t8("2026-11-21T09:50:00"),
    },
  ];

  // 6a. 全局 noThrottle: true → 立即发
  const pBypass = planPublishTimes({
    targets: [{ platform: "dy", phone: "A组" }],
    now,
    records,
    settings,
    noThrottle: true,
  });
  assert.strictEqual(pBypass.items[0].immediate, true);
  assert.strictEqual(pBypass.items[0].throttled, false);
  assert.strictEqual(pBypass.items[0].bypassed, true);

  // 6b. 显式 publishAt + noThrottle: true → 保持原定时间不顺延
  const pBypassAt = planPublishTimes({
    targets: [{ platform: "dy", phone: "A组" }],
    now,
    publishAt: "2026-11-21 11:00:00",
    records,
    settings,
    noThrottle: true,
  });
  assert.strictEqual(pBypassAt.items[0].scheduled, true);
  assert.strictEqual(pBypassAt.items[0].throttled, false);
  assert.strictEqual(pBypassAt.items[0].publishAt, "2026-11-21 11:00:00");

  // 6c. 总开关 enabled: false → 绕过节流
  const pDisabled = planPublishTimes({
    targets: [{ platform: "dy", phone: "A组" }],
    now,
    records,
    settings: { ...settings, enabled: false },
  });
  assert.strictEqual(pDisabled.items[0].immediate, true);
  assert.strictEqual(pDisabled.items[0].throttled, false);

  console.log("✓ 6. noThrottle / 总开关关闭 绕过节流验证通过");
}

async function testCase7_SettingsPersistenceAndIpc() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s11-settings-"));
  const filePath = path.join(tmpDir, "publish-throttle-settings.json");

  try {
    // 7a. 未写文件前读出默认值
    const initial = throttleService.readPublishThrottleSettings({ filePath });
    assert.strictEqual(initial.enabled, true);
    assert.strictEqual(initial.defaultCreativeStatement, "ai_generated");
    assert.strictEqual(initial.platforms["抖音"].minIntervalHours, 6);

    // 7b. 校验非法配置被拒绝
    assert.strictEqual(
      validatePublishThrottleSettings({ allowedWindow: { start: "10:00", end: "10:00" } }).ok,
      false
    );
    assert.strictEqual(
      validatePublishThrottleSettings({ platforms: { 抖音: { dailyLimit: 1.5 } } }).ok,
      false
    );
    assert.strictEqual(
      throttleService.savePublishThrottleSettings(
        { allowedWindow: { start: "bad", end: "23:30" } },
        { filePath }
      ).ok,
      false
    );

    // 7c. 持久化写入并重新读回
    const saved = throttleService.savePublishThrottleSettings(
      {
        enabled: true,
        allowedWindow: { start: "07:00", end: "22:30" },
        defaultCreativeStatement: "none",
        platforms: {
          bjh: { minIntervalHours: 5, dailyLimit: 2, delayFromFirstHours: 10 },
        },
      },
      { filePath }
    );
    assert.strictEqual(saved.ok, true);
    const reloaded = throttleService.readPublishThrottleSettings({ filePath });
    assert.strictEqual(reloaded.allowedWindow.start, "07:00");
    assert.strictEqual(reloaded.allowedWindow.end, "22:30");
    assert.strictEqual(reloaded.defaultCreativeStatement, "none");
    assert.strictEqual(reloaded.platforms["百家号"].delayFromFirstHours, 10);
    assert.strictEqual(reloaded.platforms["百家号"].dailyLimit, 2);
    assert.strictEqual(reloaded.platforms["抖音"].minIntervalHours, 6);

    // 7d. 损坏 JSON 文件回退默认值不崩
    fs.writeFileSync(filePath, "{broken-json", "utf8");
    const fallback = throttleService.readPublishThrottleSettings({ filePath });
    assert.strictEqual(fallback.defaultCreativeStatement, "ai_generated");
    assert.strictEqual(fallback.platforms["抖音"].minIntervalHours, 6);

    // 7e. IPC 注册与调用（get / save / reset / plan）
    const handlers = new Map();
    const fakeIpcMain = {
      handle: (ch, fn) => handlers.set(ch, fn),
    };
    throttleService.registerPublishThrottleIpc(fakeIpcMain, {
      filePath,
      changeData: () => ({
        success: true,
        data: {
          "2026-11-21": [
            {
              id: "hist-1",
              pt: "抖音",
              phone: "A组",
              partition: "persist:A组抖音",
              publishStatus: "success",
              lastPublishAt: t8("2026-11-21T09:00:00"),
            },
          ],
        },
      }),
    });

    const saveRes = await handlers.get("publish-throttle:save-settings")(null, {
      enabled: true,
      allowedWindow: { start: "06:00", end: "23:30" },
      defaultCreativeStatement: "ai_generated",
      platforms: { 百家号: { minIntervalHours: 4, dailyLimit: 3, delayFromFirstHours: 10 } },
    });
    assert.strictEqual(saveRes.ok, true);

    const planRes = await handlers.get("publish-throttle:plan")(null, {
      now: t8("2026-11-21T10:00:00"),
      targets: [
        { platform: "dy", phone: "A组" },
        { platform: "bjh", phone: "A组" },
        { platform: "ks", phone: "A组" },
      ],
    });
    assert.strictEqual(planRes.ok, true);
    assert.strictEqual(planRes.items[0].publishAt, "2026-11-21 15:00:00");
    assert.strictEqual(planRes.items[1].publishAt, "2026-11-21 20:00:00");
    assert.strictEqual(planRes.items[2].immediate, true);

    const resetRes = await handlers.get("publish-throttle:reset-settings")(null);
    assert.strictEqual(resetRes.ok, true);
    assert.strictEqual(resetRes.settings.platforms["百家号"].delayFromFirstHours, 0);

    console.log("✓ 7. 主进程持久化设置读写/校验/损坏回退与 IPC 验证通过");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testCase8_HttpMultiPlatformAndDedupeAndDefaultStatement() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s11-http-"));
  const videoFile = path.join(tmpDir, "demo.mp4");
  fs.writeFileSync(videoFile, "fake-video");

  const routesBundle = path.join(tmpDir, "routes.cjs");
  const guardStub = path.join(tmpDir, "guardStub.js");
  const pupStub = path.join(tmpDir, "pupStub.js");
  const alertStub = path.join(tmpDir, "alertStub.js");

  global.__MM_S11_PUP_CALLS__ = [];
  fs.writeFileSync(guardStub, `module.exports = { isTrustedLocalRequest: () => true };`);
  fs.writeFileSync(
    pupStub,
    `export function registerPublishDedupeBypass() {}
     export function runPuppeteerTask(taskPayload, transport, done) {
       global.__MM_S11_PUP_CALLS__.push(taskPayload);
       setImmediate(() => {
         transport.reply("puppeteerFile-done", {
           taskId: taskPayload.taskId,
           status: true,
           message: "上传成功",
         });
         if (done) done();
       });
     }`
  );
  fs.writeFileSync(alertStub, `module.exports = { handleAccountCollectOutcome: () => ({ ok: true }) };`);

  await esbuild.build({
    entryPoints: [path.join(root, "src/main/server/routes/index.js")],
    outfile: routesBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron", "express"],
    plugins: [
      {
        name: "s11-http-stubs",
        setup(build) {
          build.onResolve({ filter: /^\.\.\/requestGuard$/ }, () => ({ path: guardStub }));
          build.onResolve({ filter: /puppeteerFile(\.js)?$/ }, () => ({ path: pupStub }));
          build.onResolve({ filter: /collectAlert\.js$/ }, () => ({ path: alertStub }));
        },
      },
    ],
  });

  const expressMod = require("express");
  const origLoad = Module._load;
  const utilsPath = path.resolve(root, "src/main/server/utils.js");
  delete require.cache[utilsPath];

  Module._load = function (request, parent, isMain) {
    if (request === "express") return expressMod;
    if (request === "electron") {
      return {
        app: { getPath: () => tmpDir, getVersion: () => "0.15.0-test" },
        ipcMain: { on: () => {}, handle: () => {} },
        BrowserWindow: function () {},
        dialog: {},
      };
    }
    if (request === "puppeteer-extra") {
      return { addExtra: () => ({ use: () => {}, connect: () => {} }) };
    }
    if (request === "puppeteer-extra-plugin-stealth") {
      return () => ({});
    }
    if (request.startsWith("puppeteer")) {
      return { use: () => {}, connect: () => {} };
    }
    return origLoad.apply(this, arguments);
  };

  try {
    const { changeData } = require(utilsPath);
    const router = require(routesBundle);
    const postPublish = router.stack.find(
      (l) => l.route && l.route.path === "/publish" && l.route.methods.post
    ).route.stack[0].handle;
    const getCsSpec = router.stack.find(
      (l) => l.route && l.route.path === "/creative-statements" && l.route.methods.get
    ).route.stack[0].handle;

    const invokePost = async (body) => {
      let statusCode = 200;
      let payload = null;
      await postPublish(
        { method: "POST", body, headers: { origin: "http://localhost:30088" } },
        {
          status(c) {
            statusCode = c;
            return this;
          },
          json(p) {
            payload = p;
            return this;
          },
        }
      );
      return { statusCode, payload };
    };

    const invokeGetCs = async () => {
      let payload = null;
      await getCsSpec(
        { method: "GET", headers: { origin: "http://localhost:30088" } },
        {
          status() {
            return this;
          },
          json(p) {
            payload = p;
            return this;
          },
        }
      );
      return payload;
    };

    // 8a. 写入持久化设置：百家号 +10h，默认声明 ai_generated；且设置全天允许窗口（避开 VPS UTC+8 凌晨时间不确定性）
    const settingsPath = path.join(tmpDir, "publish-throttle-settings.json");
    throttleService.savePublishThrottleSettings(
      {
        enabled: true,
        allowedWindow: { start: "00:00", end: "23:59" },
        defaultCreativeStatement: "ai_generated",
        platforms: {
          抖音: { minIntervalHours: 6, dailyLimit: 3, delayFromFirstHours: 0 },
          快手: { minIntervalHours: 4, dailyLimit: 3, delayFromFirstHours: 0 },
          百家号: { minIntervalHours: 4, dailyLimit: 3, delayFromFirstHours: 10 },
          头条: { minIntervalHours: 4, dailyLimit: 3, delayFromFirstHours: 0 },
        },
      },
      { filePath: settingsPath }
    );

    // GET /creative-statements 返回持久化默认声明 ai_generated
    const csSpec1 = await invokeGetCs();
    assert.strictEqual(csSpec1.default, "ai_generated");

    // 预置历史：
    // - 抖音 A组 1 小时前发过「重复作品」（触发 S10 重复拦截，不得进入节流排期）
    // - 头条 A组 1 小时前发过「旧头条作品」（不同标题 → 通过 S10，但触发 S11 间隔不足 4h 顺延为定时）
    const now = Date.now();
    const todayKey = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
    changeData({
      fileName: "pushData",
      type: "add",
      item: {
        pt: "抖音",
        phone: "A组",
        partition: "persist:A组抖音",
        textType: "local",
        textOtherName: "old-dy",
        selectedFile: "old-dy.mp4",
        bt: "重复作品",
        title: "重复作品",
        publishStatus: "success",
        publishSuccessCount: 1,
        lastPublishAt: now - 3600 * 1000,
        date: todayKey,
      },
    });
    changeData({
      fileName: "pushData",
      type: "add",
      item: {
        pt: "头条",
        phone: "A组",
        partition: "persist:A组头条",
        textType: "local",
        textOtherName: "old-tt",
        selectedFile: "old-tt.mp4",
        bt: "旧头条作品",
        title: "旧头条作品",
        publishStatus: "success",
        publishSuccessCount: 1,
        lastPublishAt: now - 3600 * 1000,
        date: todayKey,
      },
    });

    // 8b. 多平台请求：dy（重复拦截）+ ks（立即）+ tt（间隔不足 4h 定时）+ bjh（+10h 定时）+ fqsp（立即，不支持声明回退 none）
    // 请求不传 creativeStatement → 自动套用 ai_generated（fqsp 回退 none）
    const multiRes = await invokePost({
      phone: "A组",
      file: videoFile,
      title: "重复作品",
      platforms: ["dy", "ks", "tt", "bjh", "fqsp"],
    });
    assert.strictEqual(multiRes.statusCode, 200);
    assert.strictEqual(multiRes.payload.status, "partial_duplicate");
    assert.strictEqual(multiRes.payload.results.length, 5);

    const [rDy, rKs, rTt, rBjh, rFq] = multiRes.payload.results;
    // dy 被 S10 拦截，绝不建定时任务
    assert.strictEqual(rDy.platform, "抖音");
    assert.strictEqual(rDy.status, "duplicate");
    assert.strictEqual(rDy.exitCode, 6);
    assert.strictEqual(rDy.creativeStatement, "ai_generated");

    // ks 立即提交
    assert.strictEqual(rKs.platform, "快手");
    assert.strictEqual(rKs.status, "submitted");
    assert.strictEqual(rKs.scheduled, false);
    assert.strictEqual(rKs.creativeStatement, "ai_generated");

    // tt 因距上次头条发布不足 4 小时自动定时
    assert.strictEqual(rTt.platform, "头条");
    assert.strictEqual(rTt.status, "scheduled");
    assert.strictEqual(rTt.scheduled, true);
    assert.strictEqual(rTt.throttled, true);
    assert.ok(rTt.publishAt && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rTt.publishAt));
    assert.ok(rTt.throttleReason.includes("距上次头条发布不足 4 小时"), rTt.throttleReason);
    assert.strictEqual(rTt.creativeStatement, "ai_generated");

    // bjh 因 +10h 自动定时
    assert.strictEqual(rBjh.platform, "百家号");
    assert.strictEqual(rBjh.status, "scheduled");
    assert.strictEqual(rBjh.scheduled, true);
    assert.strictEqual(rBjh.throttled, true);
    assert.ok(rBjh.throttleReason.includes("百家号相对首发延迟 10 小时"), rBjh.throttleReason);
    assert.strictEqual(rBjh.creativeStatement, "ai_generated");

    // fqsp 立即提交，且不支持创作声明回退 none
    assert.strictEqual(rFq.platform, "番茄视频");
    assert.strictEqual(rFq.status, "submitted");
    assert.strictEqual(rFq.creativeStatement, "none");

    // 核实 pushData 里只写入了 tt 和 bjh 两条 scheduled 记录，dy 未进入排期
    const allRecs = require("../src/shared/publishDedupe.js").readPushDataRecords(changeData);
    const schedPts = allRecs.filter((r) => r.scheduledTask === true).map((r) => r.pt).sort();
    assert.deepStrictEqual(schedPts, ["头条", "百家号"]);

    // 8c. HTTP noThrottle: true 绕过节流 + 显式 creativeStatement: "none" 覆盖默认声明
    const prevPupCount = global.__MM_S11_PUP_CALLS__.length;
    const bypassRes = await invokePost({
      platform: "dy",
      phone: "A组",
      file: videoFile,
      title: "绕过节流新作品",
      noThrottle: true,
      creativeStatement: "none",
    });
    assert.strictEqual(bypassRes.statusCode, 200);
    assert.strictEqual(bypassRes.payload.success, true);
    assert.strictEqual(bypassRes.payload.scheduled, undefined);
    assert.strictEqual(bypassRes.payload.creativeStatement, "none");
    assert.strictEqual(global.__MM_S11_PUP_CALLS__.length, prevPupCount + 1);
    assert.strictEqual(
      global.__MM_S11_PUP_CALLS__[global.__MM_S11_PUP_CALLS__.length - 1].data.creativeStatement,
      "none"
    );

    // 8d. 更改持久化默认声明为 fiction，HTTP 不传 creativeStatement 时自动套用 fiction，且 creativeStatements 单平台覆盖优先
    throttleService.savePublishThrottleSettings(
      {
        enabled: true,
        allowedWindow: { start: "00:00", end: "23:59" },
        defaultCreativeStatement: "fiction",
      },
      { filePath: settingsPath }
    );
    const csSpec2 = await invokeGetCs();
    assert.strictEqual(csSpec2.default, "fiction");

    const overrideRes = await invokePost({
      phone: "B组",
      file: videoFile,
      title: "声明覆盖测试",
      noThrottle: true,
      creativeStatements: { ks: "none" },
      platforms: ["dy", "ks"],
    });
    assert.strictEqual(overrideRes.payload.results[0].creativeStatement, "fiction");
    assert.strictEqual(overrideRes.payload.results[1].creativeStatement, "none");

    // 给 setImmediate 异步回调留一点时间收尾，避免临时目录提前删除
    await new Promise((r) => setTimeout(r, 50));

    console.log("✓ 8. HTTP 多平台部分立即部分定时、S10+S11 叠加、noThrottle 与默认声明套用/覆盖验证通过");
  } finally {
    delete global.__MM_S11_PUP_CALLS__;
    Module._load = origLoad;
    delete require.cache[routesBundle];
    delete require.cache[utilsPath];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testCase9_CliThrottleAndDefaultStatement() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s11-cli-"));
  const videoFile = path.join(tmpDir, "cli-demo.mp4");
  fs.writeFileSync(videoFile, "fake-video");

  const cliBundle = path.join(tmpDir, "cli.cjs");
  const pupStub = path.join(tmpDir, "pupStub.js");
  global.__MM_S11_CLI_PUP__ = [];
  fs.writeFileSync(
    pupStub,
    `export function registerPublishDedupeBypass() {}
     export function runPuppeteerTask(taskPayload, transport, done) {
       global.__MM_S11_CLI_PUP__.push(taskPayload);
       setImmediate(() => {
         transport.reply("puppeteerFile-done", {
           taskId: taskPayload.taskId,
           status: true,
           message: "CLI上传成功",
         });
         if (done) done();
       });
     }`
  );

  await esbuild.build({
    entryPoints: [path.join(root, "src/main/cli/index.js")],
    outfile: cliBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: [
      "electron",
      "puppeteer-core",
      "puppeteer-extra",
      "puppeteer-extra-plugin-stealth",
      "puppeteer-in-electron",
      "xlsx",
    ],
    plugins: [
      {
        name: "s11-cli-stubs",
        setup(build) {
          build.onResolve({ filter: /puppeteerFile(\.js)?$/ }, () => ({ path: pupStub }));
        },
      },
    ],
  });

  const xlsxMod = require("xlsx");
  const origLoad = Module._load;
  const utilsPath = path.resolve(root, "src/main/server/utils.js");
  delete require.cache[utilsPath];

  Module._load = function (request, parent, isMain) {
    if (request === "xlsx") return xlsxMod;
    if (request === "electron") {
      return {
        app: {
          getPath: () => tmpDir,
          getVersion: () => "0.15.0-test",
          on: () => {},
          once: () => {},
          commandLine: { getSwitchValue: () => "" },
        },
        ipcMain: { on: () => {}, handle: () => {} },
        BrowserWindow: function () {},
        dialog: {},
      };
    }
    if (request === "puppeteer-extra") {
      return { addExtra: () => ({ use: () => {}, connect: () => {} }) };
    }
    if (request === "puppeteer-extra-plugin-stealth") {
      return () => ({});
    }
    if (request.startsWith("puppeteer")) {
      return { use: () => {}, connect: () => {} };
    }
    return origLoad.apply(this, arguments);
  };

  try {
    const { changeData } = require(utilsPath);
    const cliMod = require(cliBundle);

    const settingsPath = path.join(tmpDir, "publish-throttle-settings.json");
    throttleService.savePublishThrottleSettings(
      {
        enabled: true,
        allowedWindow: { start: "00:00", end: "23:59" },
        defaultCreativeStatement: "ai_generated",
      },
      { filePath: settingsPath }
    );

    const now = Date.now();
    const todayKey = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
    changeData({
      fileName: "pushData",
      type: "add",
      item: {
        pt: "抖音",
        phone: "A组",
        partition: "persist:A组抖音",
        textType: "local",
        textOtherName: "prev",
        selectedFile: "prev.mp4",
        bt: "历史已发作品",
        title: "历史已发作品",
        publishStatus: "success",
        publishSuccessCount: 1,
        lastPublishAt: now - 3600 * 1000,
        date: todayKey,
      },
    });

    const runCli = async (args) => {
      const out = [];
      const err = [];
      const origLog = console.log;
      const origErr = console.error;
      console.log = (...a) => out.push(a.join(" "));
      console.error = (...a) => err.push(a.join(" "));
      try {
        const code = await cliMod.runCliMain(["node", ".", "cli", ...args]);
        return { code, out, err };
      } finally {
        console.log = origLog;
        console.error = origErr;
      }
    };

    // 9a. 重复标题先被 S10 拦截（退出码 6），不进排期
    const dupRun = await runCli([
      "publish", "-p", "dy", "--phone", "A组", "-f", videoFile, "-t", "历史已发作品",
    ]);
    assert.strictEqual(dupRun.code, 6);
    const dupJson = JSON.parse(dupRun.out[dupRun.out.length - 1]);
    assert.strictEqual(dupJson.status, "duplicate");
    assert.strictEqual(dupJson.creativeStatement, "ai_generated");

    // 9b. 新标题因距上次抖音发布不足 6 小时自动转定时，status: "scheduled"，带 publishAt/reason/creativeStatement
    const schedRun = await runCli([
      "publish", "-p", "dy", "--phone", "A组", "-f", videoFile, "-t", "新节流测试视频",
    ]);
    assert.strictEqual(schedRun.code, 0, `CLI 节流转定时应退出 0，err=${schedRun.err.join(" ")}`);
    const schedJson = JSON.parse(schedRun.out[schedRun.out.length - 1]);
    assert.strictEqual(schedJson.status, "scheduled");
    assert.strictEqual(schedJson.scheduled, true);
    assert.strictEqual(schedJson.throttled, true);
    assert.ok(schedJson.publishAt && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(schedJson.publishAt));
    assert.ok(schedJson.throttleReason.includes("距上次抖音发布不足 6 小时"), schedJson.throttleReason);
    assert.strictEqual(schedJson.creativeStatement, "ai_generated");
    assert.strictEqual(global.__MM_S11_CLI_PUP__.length, 0, "节流转定时不得立即触发上传");

    // 9c. --no-throttle + --cs none → 绕过节流立即发，且声明覆盖为 none
    const bypassRun = await runCli([
      "publish", "-p", "dy", "--phone", "A组", "-f", videoFile, "-t", "紧急直发视频",
      "--no-throttle", "--cs", "none",
    ]);
    assert.strictEqual(bypassRun.code, 0);
    const bypassJson = JSON.parse(bypassRun.out[bypassRun.out.length - 1]);
    assert.strictEqual(bypassJson.status, true);
    assert.strictEqual(bypassJson.creativeStatement, "none");
    assert.strictEqual(global.__MM_S11_CLI_PUP__.length, 1);
    assert.strictEqual(global.__MM_S11_CLI_PUP__[0].data.creativeStatement, "none");

    // 9d. 显式 --publish-at 也会过节流且只顺延不提前（抖音 1h 前发过，--publish-at 设 5 分钟后 → 顺延到至少 5h 后）
    const soonMs = Date.now() + 5 * 60 * 1000;
    const explicitRun = await runCli([
      "publish", "-p", "dy", "--phone", "A组", "-f", videoFile, "-t", "显式定时顺延视频",
      "--publish-at", formatUtc8DateTime(soonMs),
    ]);
    assert.strictEqual(explicitRun.code, 0, `CLI 显式定时顺延应退出 0，err=${explicitRun.err.join(" ")}`);
    const explicitJson = JSON.parse(explicitRun.out[explicitRun.out.length - 1]);
    assert.strictEqual(explicitJson.status, "scheduled");
    assert.strictEqual(explicitJson.throttled, true);
    assert.ok(parseUtc8DateTimeMs(explicitJson.publishAt) > soonMs + 4 * 3600 * 1000, "显式 --publish-at 应被节流顺延");

    // 9e. --help 文档包含 --no-throttle
    assert.ok(cliMod.publishHelpText().includes("--no-throttle"));

    console.log("✓ 9. CLI 节流转定时、--no-throttle 绕过、S10 优先拦截与默认声明套用/覆盖验证通过");
  } finally {
    delete global.__MM_S11_CLI_PUP__;
    Module._load = origLoad;
    delete require.cache[cliBundle];
    delete require.cache[utilsPath];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testCase10_RestartPersistenceOfScheduledTasks() {
  // 真实写盘到 pushData/<date>.json → 停止调度器 + 卸载模块模拟应用重启 → 重新加载并启动调度器 → 定时任务仍在且定时器重新挂起
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s11-restart-"));
  const schedBundle = path.join(tmpDir, "scheduledPublish.cjs");
  const pupStub = path.join(tmpDir, "pupStub.js");
  fs.writeFileSync(pupStub, `export function runPuppeteerTask() {}`);

  await esbuild.build({
    entryPoints: [path.join(root, "src/main/services/scheduledPublish.js")],
    outfile: schedBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    plugins: [
      {
        name: "s11-restart-stub",
        setup(build) {
          build.onResolve({ filter: /puppeteerFile(\.js)?$/ }, () => ({ path: pupStub }));
        },
      },
    ],
  });

  const origLoad = Module._load;
  const utilsPath = path.resolve(root, "src/main/server/utils.js");
  delete require.cache[utilsPath];

  Module._load = function (request, parent, isMain) {
    if (request === "electron") {
      return {
        app: { getPath: () => tmpDir, getVersion: () => "0.15.0-test" },
        ipcMain: { on: () => {}, handle: () => {} },
      };
    }
    if (request === "puppeteer-extra") {
      return { addExtra: () => ({ use: () => {}, connect: () => {} }) };
    }
    if (request === "puppeteer-extra-plugin-stealth") {
      return () => ({});
    }
    if (request.startsWith("puppeteer")) {
      return { use: () => {}, connect: () => {} };
    }
    return origLoad.apply(this, arguments);
  };

  let schedMod1 = null;
  let schedMod2 = null;
  try {
    const { changeData } = require(utilsPath);
    schedMod1 = require(schedBundle);

    const now = Date.now();
    const plannedAtMs = now + 6 * 3600 * 1000;
    const plannedAtText = formatUtc8DateTime(plannedAtMs);
    const todayKey = new Date(now + 8 * 3600000).toISOString().slice(0, 10);

    // 模拟节流创建一条定时任务并落盘
    const record = schedMod1.createScheduledRecord(
      {
        bookName: "重启恢复测试",
        textOtherName: "restart-clip",
        textType: "local",
        pt: "抖音",
        selectedFile: "restart-clip.mp4",
        bt: "重启恢复测试",
        title: "重启恢复测试",
        creativeStatement: "ai_generated",
        filePath: "/tmp/restart-clip.mp4",
        phone: "A组",
        partition: "persist:A组抖音",
        date: todayKey,
      },
      plannedAtText,
      now,
      {
        scheduledPublishAtMs: plannedAtMs,
        throttleReason: "距上次抖音发布不足 6 小时",
      }
    );

    const addRes = changeData({ fileName: "pushData", type: "add", item: record });
    assert.strictEqual(addRes.success, true);

    schedMod1.startScheduledPublishScheduler();
    assert.strictEqual(schedMod1.getScheduledTimersSnapshot().length, 1, "首次启动应挂起 1 个定时器");

    // 模拟应用关闭退出：停调度器并清掉模块缓存
    schedMod1.stopScheduledPublishScheduler();
    assert.strictEqual(schedMod1.getScheduledTimersSnapshot().length, 0);
    delete require.cache[schedBundle];

    // 模拟应用重启：全新加载 scheduledPublish 模块并调用 startScheduledPublishScheduler()
    schedMod2 = require(schedBundle);
    const loadedRecords = schedMod2.listScheduledRecords();
    assert.strictEqual(loadedRecords.length, 1, "重启后应从磁盘读回 1 条待执行定时任务");
    assert.strictEqual(loadedRecords[0].scheduledPublishAt, plannedAtMs);
    assert.strictEqual(loadedRecords[0].scheduledPublishAtText, plannedAtText);
    assert.strictEqual(loadedRecords[0].throttleReason, "距上次抖音发布不足 6 小时");
    assert.strictEqual(loadedRecords[0].creativeStatement, "ai_generated");
    assert.ok(loadedRecords[0].lastPublishMessage.includes("距上次抖音发布不足 6 小时"));

    schedMod2.startScheduledPublishScheduler();
    assert.strictEqual(
      schedMod2.getScheduledTimersSnapshot().length,
      1,
      "重启后调度器应自动为磁盘任务重新挂起定时器"
    );

    console.log("✓ 10. 重启后定时任务落盘恢复与调度器重新挂起定时器验证通过");
  } finally {
    if (schedMod1) schedMod1.stopScheduledPublishScheduler();
    if (schedMod2) schedMod2.stopScheduledPublishScheduler();
    Module._load = origLoad;
    delete require.cache[schedBundle];
    delete require.cache[utilsPath];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testCase11_GuiTemplatesAndDocsCheck() {
  const vueFiles = [
    "src/renderer/components/PublishThrottleSettingsCard.vue",
    "src/renderer/components/LocalVideoPublish.vue",
    "src/renderer/views/videoManager/index.vue",
    "src/renderer/views/projectDetail/index.vue",
  ];
  for (const rel of vueFiles) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    const sfc = compiler.parseComponent(src);
    assert.ok(sfc.template && sfc.template.content, `${rel} 应含 <template>`);
    const compiled = compiler.compile(sfc.template.content);
    assert.strictEqual(
      compiled.errors.length,
      0,
      `${rel} 模板编译报错: ${compiled.errors.join("; ")}`
    );
  }

  const localPubSrc = fs.readFileSync(
    path.join(root, "src/renderer/components/LocalVideoPublish.vue"),
    "utf8"
  );
  assert.ok(localPubSrc.includes("publish-throttle:plan"), "LocalVideoPublish 应调用 publish-throttle:plan");
  assert.ok(localPubSrc.includes("publish-throttle:get-settings"), "LocalVideoPublish 应读取默认创作声明设置");
  assert.ok(localPubSrc.includes("发布排期预览"), "LocalVideoPublish 应含排期预览弹窗");
  assert.ok(localPubSrc.includes("改为不节流"), "LocalVideoPublish 排期预览应支持改为不节流");
  assert.ok(localPubSrc.includes("DEFAULT_PUBLISH_CREATIVE_STATEMENT"), "LocalVideoPublish 应使用默认创作声明常量");

  // 真跑 LocalVideoPublish.vue 方法：验证默认声明初始选中 ai_generated、不支持平台回退 none，以及排期预览表确认/不节流分支
  const vm = require("vm");
  const tmpGuiDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s11-gui-"));
  const csBundle = path.join(tmpGuiDir, "cs.cjs");
  try {
    esbuild.buildSync({
      entryPoints: [path.join(root, "src/shared/creativeStatement.js")],
      outfile: csBundle,
      bundle: true,
      platform: "node",
      format: "cjs",
    });
    const csMod = require(csBundle);
    const script = localPubSrc
      .match(/<script>([\s\S]*?)<\/script>/)[1]
      .replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*$/gm, "")
      .replace("export default", "globalThis.component =");
    const importedNames = [
      ...localPubSrc.matchAll(/^import\s+([\s\S]*?)\s+from\s+["'][^"']+["'];/gm),
    ].flatMap((m) =>
      m[1]
        .replace(/[{}]/g, "")
        .split(",")
        .map((x) => x.trim().split(/\s+as\s+/).pop())
        .filter(Boolean)
    );
    const stubs = Object.fromEntries(importedNames.map((n) => [n, () => {}]));
    const ipcCalls = [];
    const mockPlanItems = [
      {
        ok: true,
        platform: "抖音",
        phone: "A组",
        isDraft: false,
        immediate: false,
        scheduled: true,
        throttled: true,
        plannedAtMs: t8("2026-11-21T16:00:00"),
        publishAt: "2026-11-21 16:00:00",
        reason: "距上次抖音发布不足 6 小时",
      },
      {
        ok: true,
        platform: "快手",
        phone: "A组",
        isDraft: false,
        immediate: true,
        scheduled: false,
        throttled: false,
        plannedAtMs: t8("2026-11-21T10:00:00"),
        publishAt: null,
        reason: "",
      },
    ];
    const ctx = vm.createContext({
      ...stubs,
      ...csMod,
      parsePublishAtUtc8: require("../src/shared/publishThrottle.js").parsePublishAtUtc8,
      ipcRenderer: {
        invoke: async (ch, arg) => {
          ipcCalls.push({ ch, arg });
          if (ch === "publish-throttle:get-settings") {
            return { ok: true, settings: { defaultCreativeStatement: "ai_generated" } };
          }
          if (ch === "publish-throttle:plan") {
            return {
              ok: true,
              enabled: true,
              items: mockPlanItems,
            };
          }
          if (ch === "publish-throttle:commit-plan") {
            return {
              ok: true,
              changed: false,
              enabled: true,
              reservationIds: ["res-1", "res-2"],
              items: arg && arg.noThrottle
                ? mockPlanItems.map((it, idx) => ({
                    ...it,
                    immediate: true,
                    scheduled: false,
                    throttled: false,
                    publishAt: null,
                    reservationId: `res-nt-${idx}`,
                  }))
                : mockPlanItems.map((it, idx) => ({ ...it, reservationId: `res-${idx}` })),
            };
          }
          return { ok: true };
        },
      },
    });
    vm.runInContext(script, ctx);
    const state = {
      ...ctx.component.data(),
      $set: (o, k, v) => {
        o[k] = v;
      },
      getAllPlatformLeafNodes: () => [
        { id: "n-dy", pt: "抖音" },
        { id: "n-fq", pt: "番茄视频" },
      ],
    };
    for (const [k, fn] of Object.entries(ctx.component.methods)) {
      state[k] = fn.bind(state);
    }
    await state.loadPublishThrottleDefaults();
    state.resetPlatformStatementState();
    assert.strictEqual(state.batchCreativeStatement, "ai_generated", "GUI 批量声明应初始选中 ai_generated");
    state.initPlatformStatementsForLeaves([
      { id: "n-dy", pt: "抖音" },
      { id: "n-fq", pt: "番茄视频" },
    ]);
    assert.strictEqual(state.getPlatformStatement("n-dy", "抖音"), "ai_generated");
    assert.strictEqual(state.getPlatformStatement("n-fq", "番茄视频"), "none", "不支持创作声明的平台应回退 none");

    // 排期预览表：先打开弹窗检查预览行，再点确认按排期发布
    const entries = [
      { key: "k0", pt: "抖音", phone: "A组", partition: "persist:A组抖音", title: "测试视频", isDraft: false },
      { key: "k1", pt: "快手", phone: "A组", partition: "persist:A组快手", title: "测试视频", isDraft: false },
    ];
    const pConfirm = state.confirmThrottlePublishPlan(entries, {});
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(state.throttlePreviewVisible, true, "点发布前应弹出排期预览表");
    assert.strictEqual(state.throttlePreviewRows.length, 2);
    assert.strictEqual(state.throttlePreviewRows[0].plannedTimeText, "2026-11-21 16:00:00");
    assert.ok(state.throttlePreviewRows[0].reasonText.includes("不足 6 小时"));
    assert.strictEqual(state.throttlePreviewRows[1].plannedTimeText, "立即发布");
    state.resolveThrottlePreview("confirm");
    const confirmRes = await pConfirm;
    assert.strictEqual(confirmRes.proceed, true);
    assert.strictEqual(confirmRes.noThrottle, false);
    assert.strictEqual(confirmRes.itemsByKey.get("k0").publishAt, "2026-11-21 16:00:00");

    // 点「改为不节流」
    const pNoThrottle = state.confirmThrottlePublishPlan(entries, {});
    await new Promise((r) => setImmediate(r));
    state.resolveThrottlePreview("no_throttle");
    const noThrottleRes = await pNoThrottle;
    assert.strictEqual(noThrottleRes.proceed, true);
    assert.strictEqual(noThrottleRes.noThrottle, true);
  } finally {
    delete require.cache[csBundle];
    fs.rmSync(tmpGuiDir, { recursive: true, force: true });
  }

  const vmSrc = fs.readFileSync(
    path.join(root, "src/renderer/views/videoManager/index.vue"),
    "utf8"
  );
  assert.ok(vmSrc.includes("发布节流设置"), "视频管理页应有发布节流设置入口");

  const pdSrc = fs.readFileSync(
    path.join(root, "src/renderer/views/projectDetail/index.vue"),
    "utf8"
  );
  assert.ok(pdSrc.includes("PublishThrottleSettingsCard"), "项目详情页应接入发布节流设置卡片");

  const httpDoc = fs.readFileSync(path.join(root, "docs/http-api.md"), "utf8");
  const cliDoc = fs.readFileSync(path.join(root, "docs/cli.md"), "utf8");
  const planDoc = fs.readFileSync(path.join(root, "docs/fork/plan.md"), "utf8");
  assert.ok(httpDoc.includes("noThrottle") && httpDoc.includes("ai_generated") && httpDoc.includes("throttleReason"));
  assert.ok(cliDoc.includes("--no-throttle") && cliDoc.includes("ai_generated") && cliDoc.includes("scheduled"));
  assert.ok(planDoc.includes("## S11：发布节流 / 平台错峰 / 默认 AI 创作声明"));

  console.log("✓ 11. GUI 4 个 Vue 组件模板编译、默认声明/预览表真跑与文档校验通过");
}

/* ============================================================================
 * S11-fix 评审 13 条回归用例（每条按评审输入构造，修前失败、修后通过）
 * ============================================================================ */

const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");

async function createS11FixHarness(opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s11-fix-"));
  const mediaDir = path.join(tmpDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const clip1 = path.join(mediaDir, "clip.mp4");
  const clip2 = path.join(mediaDir, "second.mp4");
  const clip3 = path.join(mediaDir, "third.mp4");
  fs.writeFileSync(clip1, "fake-video-1");
  fs.writeFileSync(clip2, "fake-video-2");
  fs.writeFileSync(clip3, "fake-video-3");

  const coreBundle = path.join(tmpDir, "core.cjs");
  const guardStub = path.join(tmpDir, "guardStub.js");
  const pupStub = path.join(tmpDir, "pupStub.js");
  const alertStub = path.join(tmpDir, "alertStub.js");
  fs.writeFileSync(guardStub, `module.exports = { isTrustedLocalRequest: () => true };`);
  fs.writeFileSync(alertStub, `module.exports = { handleAccountCollectOutcome: () => ({ ok: true }) };`);
  fs.writeFileSync(
    pupStub,
    `export function registerPublishDedupeBypass() {}
     export function runPuppeteerTask(payload, transport, done) {
       return global.__S11_FIX_UPLOAD__(payload, transport, done);
     }`
  );

  await esbuild.build({
    stdin: {
      contents: [
        `export { default as router } from "./src/main/server/routes/index.js";`,
        `export * from "./src/main/cli/index.js";`,
        `export * from "./src/main/server/utils.js";`,
        `export * from "./src/main/services/scheduledPublish.js";`,
        `export * from "./src/main/services/publishThrottle.js";`,
        `export * from "./src/main/services/scheduledDedupe.js";`,
      ].join("\n"),
      resolveDir: root,
      sourcefile: "s11-fix-entry.js",
    },
    outfile: coreBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: [
      "electron",
      "express",
      "xlsx",
      "axios",
      "puppeteer-core",
      "puppeteer-extra",
      "puppeteer-extra-plugin-stealth",
      "puppeteer-in-electron",
    ],
    plugins: [
      {
        name: "s11-fix-stubs",
        setup(build) {
          build.onResolve({ filter: /^\.\.\/requestGuard$/ }, () => ({ path: guardStub }));
          build.onResolve({ filter: /puppeteerFile(\.js)?$/ }, () => ({ path: pupStub }));
          build.onResolve({ filter: /collectAlert\.js$/ }, () => ({ path: alertStub }));
        },
      },
    ],
  });

  const RealDate = Date;
  let fakeNow = t8(opts.initialTime || "2026-11-21T10:00:00");
  global.Date = class MockDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [fakeNow]));
    }
    static now() {
      return fakeNow;
    }
  };

  let denyPushData = false;
  let denyLedger = false;
  const origWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = function (filePath, ...rest) {
    const p = typeof filePath === "string" ? filePath : "";
    if (denyPushData && p.includes(`${path.sep}pushData${path.sep}`)) {
      const err = new Error("ENOSPC: no space left on device");
      err.code = "ENOSPC";
      throw err;
    }
    if (denyLedger && p.includes("publish-throttle-ledger.json")) {
      const err = new Error("ENOSPC: no space left on device");
      err.code = "ENOSPC";
      throw err;
    }
    return origWriteFileSync.call(this, filePath, ...rest);
  };

  const handlers = new Map();
  const listeners = new Map();
  const uploads = [];
  let axiosCalls = 0;
  let uploadHandler = (payload, transport, done) => {
    uploads.push(payload);
    setImmediate(() => {
      const isDraft =
        payload.publishToDraft === true || payload.publishMode === "draft";
      transport.reply("puppeteerFile-done", {
        taskId: payload.taskId,
        status: true,
        ...(isDraft
          ? { publishMode: "draft", publishToDraft: true, draftVerified: true, outcome: "draft_saved" }
          : {}),
        message: isDraft ? "草稿已保存" : "已发布",
      });
      if (done) done();
    });
  };
  global.__S11_FIX_UPLOAD__ = (payload, transport, done) =>
    uploadHandler(payload, transport, done);

  const expressMod = require("express");
  const xlsxMod = require("xlsx");
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "express") return expressMod;
    if (request === "xlsx") return xlsxMod;
    if (request === "axios") {
      return async () => {
        axiosCalls += 1;
        throw new Error("Request failed with status code 503");
      };
    }
    if (request === "electron") {
      return {
        app: {
          getPath: () => tmpDir,
          getVersion: () => "0.15.0-test",
          on: () => {},
          once: () => {},
          commandLine: { getSwitchValue: () => "" },
        },
        ipcMain: {
          handle: (ch, fn) => handlers.set(ch, fn),
          on: (ch, fn) => listeners.set(ch, fn),
        },
        BrowserWindow: function () {},
        dialog: {},
      };
    }
    if (request === "puppeteer-extra") {
      return { addExtra: () => ({ use: () => {}, connect: () => {} }) };
    }
    if (request === "puppeteer-extra-plugin-stealth") {
      return () => ({});
    }
    if (request.startsWith("puppeteer")) {
      return { use: () => {}, connect: () => {} };
    }
    return origLoad.apply(this, arguments);
  };

  const core = require(coreBundle);
  core.savePublishThrottleSettings(opts.settings || {});
  core.registerPublishThrottleIpc(
    { handle: (ch, fn) => handlers.set(ch, fn) },
    {
      changeData: core.changeData,
      createScheduledRecord: core.createScheduledRecord,
      notifyScheduledPublishChanged: core.notifyScheduledPublishChanged,
      findExistingScheduled: core.findExistingScheduled,
    }
  );
  const httpPublish = core.router.stack.find(
    (l) => l.route && l.route.path === "/publish" && l.route.methods.post
  ).route.stack[0].handle;

  const post = async (body) => {
    let statusCode = 200;
    let payload = null;
    await httpPublish(
      {
        body,
        method: "POST",
        headers: { origin: "http://localhost:30088" },
        ip: "127.0.0.1",
        socket: { remoteAddress: "127.0.0.1" },
      },
      {
        status(c) {
          statusCode = c;
          return this;
        },
        json(p) {
          payload = p;
          return this;
        },
      }
    );
    return { statusCode, ...payload };
  };

  const cli = async (args) => {
    const out = [];
    const err = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a) => out.push(a.join(" "));
    console.error = (...a) => err.push(a.join(" "));
    try {
      const code = await core.runCliMain(["electron", "cli", "publish", ...args]);
      const receipts = out
        .filter((s) => s.trim().startsWith("{"))
        .map((s) => JSON.parse(s));
      return { code, receipts, last: receipts[receipts.length - 1] || null, out, err };
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  };

  const addRecord = (patch) => {
    const res = core.changeData({
      fileName: "pushData",
      type: "add",
      item: {
        pt: "抖音",
        phone: "13800138000",
        partition: "persist:13800138000抖音",
        textType: "local",
        textOtherName: "history",
        title: "历史视频",
        selectedFile: "old.mp4",
        date: "2026-11-21",
        ...patch,
      },
    });
    assert.strictEqual(res.success, true, JSON.stringify(res));
    return res.data[res.data.length - 1];
  };

  const listAllRecords = () => {
    const res = core.changeData({
      fileName: "pushData",
      type: "get",
      item: { page: 1, pageSize: 1000 },
    });
    return Object.values(res.data || {}).flat();
  };

  return {
    tmpDir,
    mediaDir,
    clip1,
    clip2,
    clip3,
    core,
    handlers,
    uploads,
    getAxiosCalls: () => axiosCalls,
    setNow: (ms) => {
      fakeNow = ms;
    },
    getNow: () => fakeNow,
    setDenyPushData: (v) => {
      denyPushData = Boolean(v);
    },
    setDenyLedger: (v) => {
      denyLedger = Boolean(v);
    },
    setUploadHandler: (fn) => {
      uploadHandler = fn;
    },
    post,
    cli,
    addRecord,
    listAllRecords,
    cleanup: () => {
      core.stopScheduledPublishScheduler();
      fs.writeFileSync = origWriteFileSync;
      global.Date = RealDate;
      delete global.__S11_FIX_UPLOAD__;
      Module._load = origLoad;
      delete require.cache[coreBundle];
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function loadLocalVideoPublishVm({ ipcInvoke, ipcSend, dataRequestFn, messageCalls }) {
  const vm = require("vm");
  const localPubSrc = fs.readFileSync(
    path.join(root, "src/renderer/components/LocalVideoPublish.vue"),
    "utf8"
  );
  const tmpGuiDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s11-fix-gui-"));
  const csBundle = path.join(tmpGuiDir, "cs.cjs");
  const vmMetaBundle = path.join(tmpGuiDir, "vm.cjs");
  const acctIdBundle = path.join(tmpGuiDir, "aid.cjs");
  const acctModeBundle = path.join(tmpGuiDir, "amode.cjs");
  const xhsBundle = path.join(tmpGuiDir, "xhs.cjs");
  const vlinkBundle = path.join(tmpGuiDir, "vlink.cjs");
  esbuild.buildSync({
    entryPoints: [path.join(root, "src/shared/creativeStatement.js")],
    outfile: csBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  esbuild.buildSync({
    entryPoints: [path.join(root, "src/shared/videoMetadata.js")],
    outfile: vmMetaBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  esbuild.buildSync({
    entryPoints: [path.join(root, "src/shared/accountIdentity.js")],
    outfile: acctIdBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  esbuild.buildSync({
    entryPoints: [path.join(root, "src/shared/accountPublishSettings.js")],
    outfile: acctModeBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  esbuild.buildSync({
    entryPoints: [path.join(root, "src/shared/xhsPublishPolicy.js")],
    outfile: xhsBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  esbuild.buildSync({
    entryPoints: [path.join(root, "src/shared/videoLink.js")],
    outfile: vlinkBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  const script = localPubSrc
    .match(/<script>([\s\S]*?)<\/script>/)[1]
    .replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*$/gm, "")
    .replace("export default", "globalThis.component =");
  const importedNames = [
    ...localPubSrc.matchAll(/^import\s+([\s\S]*?)\s+from\s+["'][^"']+["'];/gm),
  ].flatMap((m) =>
    m[1]
      .replace(/[{}]/g, "")
      .split(",")
      .map((x) => x.trim().split(/\s+as\s+/).pop())
      .filter(Boolean)
  );
  const stubs = Object.fromEntries(importedNames.map((n) => [n, () => {}]));
  const ctx = vm.createContext({
    ...stubs,
    ...require(csBundle),
    ...require(vmMetaBundle),
    ...require(acctIdBundle),
    ...require(acctModeBundle),
    ...require(xhsBundle),
    ...require(vlinkBundle),
    ...require("../src/shared/textSanitize.js"),
    ...require("../src/shared/publishThrottle.js"),
    moment: require("moment"),
    require,
    Date,
    console,
    setTimeout,
    clearTimeout,
    dataRequest: dataRequestFn || (async () => ({ success: true, data: [] })),
    ipcRenderer: {
      invoke: ipcInvoke,
      send: ipcSend || (() => {}),
    },
  });
  vm.runInContext(script, ctx);
  const state = {
    ...ctx.component.data(),
    $set: (o, k, v) => {
      o[k] = v;
    },
    $emit: () => {},
    $message: {
      warning: (m) => messageCalls.push({ type: "warning", m }),
      error: (m) => messageCalls.push({ type: "error", m }),
      success: (m) => messageCalls.push({ type: "success", m }),
      info: (m) => messageCalls.push({ type: "info", m }),
    },
  };
  for (const [k, fn] of Object.entries(ctx.component.methods)) {
    state[k] = fn.bind(state);
  }
  return {
    state,
    cleanup: () => {
      [csBundle, vmMetaBundle, acctIdBundle, acctModeBundle, xhsBundle, vlinkBundle].forEach(
        (b) => delete require.cache[b]
      );
      fs.rmSync(tmpGuiDir, { recursive: true, force: true });
    },
  };
}

// #1 同一视频改标题复用同文件同时刻定时任务，不再节流顺延
async function testFix01_ReuseSameFileSameTimeScheduledWithNewTitle() {
  const h = await createS11FixHarness();
  try {
    const phone = "13800138000";
    const r1 = await h.post({
      platform: "dy",
      phone,
      file: h.clip1,
      title: "初版标题",
      publishAt: "2026-11-21 13:00:00",
    });
    assert.strictEqual(r1.success, true);
    assert.strictEqual(r1.scheduled, true);
    assert.strictEqual(r1.publishAt, "2026-11-21 13:00:00");
    assert.ok(r1.id);

    const r2 = await h.post({
      platform: "dy",
      phone,
      file: h.clip1,
      title: "改后标题",
      publishAt: "2026-11-21 13:00:00",
    });
    assert.strictEqual(r2.success, true);
    assert.strictEqual(r2.scheduled, true);
    assert.strictEqual(r2.duplicate, true, "同文件同时刻改标题应复用既有定时任务");
    assert.strictEqual(r2.id, r1.id, "应返回同一任务 ID，不得新建第二条");
    assert.strictEqual(r2.publishAt, "2026-11-21 13:00:00", "不得被节流顺延至 19:00");
    assert.strictEqual(h.core.listScheduledRecords().length, 1);
    assert.strictEqual(h.core.readPublishThrottleLedger().entries.length, 1);
    console.log("✓ Fix #1: 同文件同时刻改标题复用既有定时任务，不再顺延重复建任务");
  } finally {
    h.cleanup();
  }
}

// #2 新增定时任务刷新不得取消刚到点的任务；超过 10 分钟宽限期且应用未运行才标 expired
async function testFix02_NewScheduledTaskDoesNotExpireDueTask() {
  const h = await createS11FixHarness({ initialTime: "2026-11-21T10:00:00" });
  try {
    const phone = "13800138000";
    h.core.startScheduledPublishScheduler(h.getNow());

    const rA = await h.post({
      platform: "dy",
      phone,
      file: h.clip1,
      title: "任务A",
      publishAt: "2026-11-21 10:02:00",
    });
    assert.strictEqual(rA.scheduled, true);

    // 10:02 到点瞬间先处理 B 的定时创建触发刷新
    h.setNow(t8("2026-11-21T10:02:00"));
    const rB = await h.post({
      platform: "dy",
      phone,
      file: h.clip2,
      title: "任务B",
      publishAt: "2026-11-21 16:02:00",
    });
    assert.strictEqual(rB.scheduled, true);

    // 等待异步上传完成
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(h.uploads.length, 1, "刚到点的任务 A 必须照常执行上传，不得被标 expired");
    assert.strictEqual(h.uploads[0].data.title, "任务A");
    const recA = h.listAllRecords().find((r) => r.id === rA.id);
    assert.strictEqual(recA.publishStatus, "success");

    // 模拟停机后重启：超过 10 分钟宽限期标 expired 并释放账本；宽限期内（5 分钟）照常执行
    h.core.stopScheduledPublishScheduler();
    h.uploads.length = 0;
    const oldExpired = h.addRecord({
      id: "sched-old-expired",
      title: "关机错过超过10分钟",
      filePath: h.clip1,
      scheduledTask: true,
      publishStatus: "scheduled",
      scheduledPublishAt: t8("2026-11-21T09:40:00"),
      scheduledPublishAtText: "2026-11-21 09:40:00",
    });
    const withinGrace = h.addRecord({
      id: "sched-within-grace",
      title: "关机错过5分钟宽限期内",
      filePath: h.clip2,
      scheduledTask: true,
      publishStatus: "scheduled",
      scheduledPublishAt: t8("2026-11-21T09:55:00"),
      scheduledPublishAtText: "2026-11-21 09:55:00",
    });
    h.setNow(t8("2026-11-21T10:00:00"));
    h.core.startScheduledPublishScheduler(h.getNow());
    await new Promise((r) => setTimeout(r, 40));

    const afterExpired = h.listAllRecords().find((r) => r.id === oldExpired.id);
    const afterGrace = h.listAllRecords().find((r) => r.id === withinGrace.id);
    assert.strictEqual(afterExpired.publishStatus, "expired", "超过 10 分钟宽限期且应用未运行应标 expired");
    assert.strictEqual(afterGrace.publishStatus, "success", "10 分钟宽限期内应补执行");
    assert.strictEqual(h.uploads.length, 1);
    assert.strictEqual(h.uploads[0].data.title, "关机错过5分钟宽限期内");
    console.log("✓ Fix #2: 刷新不取消刚到点任务、10 分钟宽限期与离线过期判定验证通过");
  } finally {
    h.cleanup();
  }
}

// #3 定时任务落盘失败（pushData 或账本 ENOSPC）三端均返回失败，不得报 scheduled
async function testFix03_DiskWriteFailureNeverReportsScheduled() {
  const h = await createS11FixHarness({ initialTime: "2026-11-21T10:00:00" });
  try {
    const phone = "13800138000";
    h.addRecord({
      publishStatus: "success",
      publishSuccessCount: 1,
      lastPublishAt: t8("2026-11-21T09:00:00"),
    });

    // 3a. 模拟 pushData 写入 ENOSPC
    h.setDenyPushData(true);

    // HTTP
    const httpRes = await h.post({
      platform: "dy",
      phone,
      file: h.clip1,
      title: "ENOSPC-HTTP",
    });
    assert.strictEqual(httpRes.success, false, "HTTP pushData ENOSPC 必须返回 success:false");
    assert.notStrictEqual(httpRes.status, "scheduled", "不得报 scheduled");
    assert.strictEqual(httpRes.scheduled, false);

    // CLI 单文件
    const cliSingle = await h.cli([
      "-p", "dy", "--phone", phone, "-f", h.clip1, "-t", "ENOSPC-CLI单文件",
    ]);
    assert.notStrictEqual(cliSingle.code, 0, "CLI 单文件写盘失败必须返回非 0 退出码");

    // CLI 目录批量
    const xlsx = require("xlsx");
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(
      wb,
      xlsx.utils.json_to_sheet([{ 文件名: "clip.mp4", 标题: "ENOSPC-CLI目录" }]),
      "Sheet1"
    );
    const xlsxPath = path.join(h.mediaDir, "batch.xlsx");
    fs.writeFileSync(xlsxPath, xlsx.write(wb, { bookType: "xlsx", type: "buffer" }));
    const cliBatch = await h.cli([
      "-p", "dy", "--phone", phone, "--dir", h.mediaDir, "--config", xlsxPath,
    ]);
    assert.notStrictEqual(cliBatch.code, 0, "CLI 目录批量写盘失败必须返回非 0 退出码");
    assert.strictEqual(cliBatch.last.results[0].status, "failed");

    // GUI IPC create-scheduled
    const ipcRes = await h.handlers.get("publish-throttle:create-scheduled")(null, {
      item: {
        pt: "抖音",
        phone,
        partition: `persist:${phone}抖音`,
        textType: "local",
        textOtherName: "clip",
        selectedFile: "clip.mp4",
        title: "ENOSPC-GUI",
        filePath: h.clip1,
        date: "2026-11-21",
        scheduledPublishAt: t8("2026-11-21T15:00:00"),
        scheduledPublishAtText: "2026-11-21 15:00:00",
      },
    });
    assert.strictEqual(ipcRes.ok, false, "GUI IPC pushData ENOSPC 必须返回 ok:false");

    // 确认失败预留全部释放（账本仍只有导入的 09:00 一条）
    h.setDenyPushData(false);
    const ledgerAfterPushFail = h.core.readPublishThrottleLedger();
    assert.strictEqual(ledgerAfterPushFail.entries.length, 1, "写盘失败的预留必须释放");

    // 3b. 模拟账本写入 ENOSPC
    h.setDenyLedger(true);
    const httpLedgerFail = await h.post({
      platform: "dy",
      phone,
      file: h.clip1,
      title: "ENOSPC-账本-HTTP",
    });
    assert.strictEqual(httpLedgerFail.success, false);
    assert.notStrictEqual(httpLedgerFail.status, "scheduled");
    assert.strictEqual(h.core.listScheduledRecords().length, 0, "账本失败不得写入 pushData");

    const cliLedgerFail = await h.cli([
      "-p", "dy", "--phone", phone, "-f", h.clip1, "-t", "ENOSPC-账本-CLI",
    ]);
    assert.notStrictEqual(cliLedgerFail.code, 0);

    const guiCommitFail = await h.handlers.get("publish-throttle:commit-plan")(null, {
      targets: [{ platform: "dy", phone }],
      now: h.getNow(),
    });
    assert.strictEqual(guiCommitFail.ok, false);
    h.setDenyLedger(false);
    console.log("✓ Fix #3: pushData / 账本写盘失败三端均报错并释放预留，绝不误报 scheduled");
  } finally {
    h.cleanup();
  }
}

// #4 GUI 确认过期预览时拒绝提交且不走 dataRequest 备用写入路径
async function testFix04_GuiExpiredPreviewRejectedNoFallbackWrite() {
  const h = await createS11FixHarness({ initialTime: "2026-11-21T10:00:00" });
  const fallbackWrites = [];
  const messages = [];
  const gui = loadLocalVideoPublishVm({
    ipcInvoke: async (ch, arg) => {
      const fn = h.handlers.get(ch);
      assert.ok(fn, `missing IPC handler ${ch}`);
      return fn(null, arg);
    },
    dataRequestFn: async (req) => {
      fallbackWrites.push(req);
      return h.core.changeData(req);
    },
    messageCalls: messages,
  });
  try {
    const entries = [
      {
        key: "single:0:n1",
        pt: "抖音",
        phone: "13800138000",
        partition: "persist:13800138000抖音",
        filePath: h.clip1,
        textType: "local",
        title: "过期预览视频",
        isDraft: false,
      },
    ];
    // 10:00:00 打开显式定时 10:00:30 的预览
    const p = gui.state.confirmThrottlePublishPlan(entries, {
      publishAt: "2026-11-21 10:00:30",
      publishAtMs: t8("2026-11-21T10:00:30"),
    });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(gui.state.throttlePreviewVisible, true);

    // 等到 10:00:31 再点确认
    h.setNow(t8("2026-11-21T10:00:31"));
    gui.state.resolveThrottlePreview("confirm");
    const decision = await p;
    assert.strictEqual(decision.proceed, false, "过期预览确认必须被拒绝");
    assert.ok(
      messages.some((m) => m.type === "warning" && String(m.m).includes("未来")),
      `应提示时间已过让用户重选，实际=${JSON.stringify(messages)}`
    );
    assert.strictEqual(fallbackWrites.length, 0, "不得调用备用 dataRequest 写入");
    assert.strictEqual(h.listAllRecords().length, 0, "历史中不得出现过期任务");

    // 直接测 writeScheduledPublishRecord 遭遇 IPC 拒绝时绝不回退 dataRequest
    const directRes = await gui.state.writeScheduledPublishRecord({
      pt: "抖音",
      phone: "13800138000",
      partition: "persist:13800138000抖音",
      textType: "local",
      textOtherName: "clip",
      selectedFile: "clip.mp4",
      title: "过期直写",
      filePath: h.clip1,
      date: "2026-11-21",
      scheduledPublishAt: t8("2026-11-21T10:00:30"),
      scheduledPublishAtText: "2026-11-21 10:00:30",
    });
    assert.strictEqual(directRes.ok, false, "IPC 拒绝后 writeScheduledPublishRecord 必须返回 ok:false");
    assert.strictEqual(fallbackWrites.length, 0, "严禁回退 dataRequest 写入过期记录");
    assert.strictEqual(h.listAllRecords().length, 0);
    console.log("✓ Fix #4: GUI 过期预览确认被主进程拒绝并提示重选，且彻底移除备用写入回退");
  } finally {
    gui.cleanup();
    h.cleanup();
  }
}

// #5 S10 不让后排同标题任务拦掉先排任务；allowDuplicate 只影响带它的那条
async function testFix05_S10LaterScheduledDoesNotBlockEarlierTask() {
  const h = await createS11FixHarness({ initialTime: "2026-11-21T02:00:00" });
  const tmpPupDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s11-fix5-pup-"));
  const pupBundle = path.join(tmpPupDir, "pup.cjs");
  try {
    const phone = "13800138000";
    // 02:00 依次提交两个不同文件、同标题，第二条带 allowDuplicate: true → 分别排到 06:00 和 12:00
    const r1 = await h.post({
      platform: "dy",
      phone,
      file: h.clip1,
      title: "同标题双发测试",
    });
    assert.strictEqual(r1.scheduled, true);
    assert.strictEqual(r1.publishAt, "2026-11-21 06:00:00");

    const r2 = await h.post({
      platform: "dy",
      phone,
      file: h.clip2,
      title: "同标题双发测试",
      allowDuplicate: true,
    });
    assert.strictEqual(r2.scheduled, true);
    assert.strictEqual(r2.publishAt, "2026-11-21 12:00:00");

    // 第三条不带 allowDuplicate：仍应被 S10 拦截（证明 allowDuplicate 只影响 r2）
    const r3 = await h.post({
      platform: "dy",
      phone,
      file: h.clip3,
      title: "同标题双发测试",
    });
    assert.strictEqual(r3.status, "duplicate");
    assert.strictEqual(r3.exitCode, 6);

    // 纯函数校验：待发记录只拦截计划时刻更早或相同的同标题请求
    const dedupe = require("../src/shared/publishDedupe.js");
    const recs = h.listAllRecords();
    const rec1 = recs.find((r) => r.id === r1.id);
    const rec2 = recs.find((r) => r.id === r2.id);
    assert.strictEqual(
      dedupe.findRecentDuplicatePublish([rec2], {
        pt: "抖音",
        phone,
        title: "同标题双发测试",
      }, { now: t8("2026-11-21T06:00:00"), candidateScheduledAt: t8("2026-11-21T06:00:00") }),
      null,
      "12:00 的待发记录不得拦截 06:00 的请求"
    );
    assert.ok(
      dedupe.findRecentDuplicatePublish([rec1], {
        pt: "抖音",
        phone,
        title: "同标题双发测试",
      }, { now: t8("2026-11-21T06:00:00"), candidateScheduledAt: t8("2026-11-21T12:00:00") }),
      "06:00 的待发记录应拦截 12:00 的同标题请求"
    );

    // 用真实 puppeteerFile.checkPublishEntryDuplicate 验证 06:00 执行第一条、12:00 执行第二条均不被误拦
    await esbuild.build({
      entryPoints: [path.join(root, "src/main/services/puppeteerFile.js")],
      outfile: pupBundle,
      bundle: true,
      platform: "node",
      format: "cjs",
      external: [
        "electron",
        "puppeteer-core",
        "puppeteer-extra",
        "puppeteer-extra-plugin-stealth",
        "puppeteer-in-electron",
      ],
    });
    const pupMod = require(pupBundle);
    const payload1 = h.core.buildTaskPayloadFromRecord(rec1);
    const payload2 = h.core.buildTaskPayloadFromRecord(rec2);
    assert.strictEqual(payload1.scheduledPublishAt, t8("2026-11-21T06:00:00"));

    // 06:00 第一条开始发布（自身已变 publishing，第二条仍是 12:00 scheduled）
    const snapAt6 = recs.map((r) =>
      r.id === rec1.id ? { ...r, publishStatus: "publishing", lastPublishAt: t8("2026-11-21T06:00:00") } : r
    );
    assert.strictEqual(
      pupMod.checkPublishEntryDuplicate(payload1, snapAt6, {
        now: t8("2026-11-21T06:00:00"),
        skipBypass: true,
      }),
      null,
      "06:00 执行第一条时不得被 12:00 待发记录拦掉"
    );

    // 12:00 第二条开始发布（第一条已 success，第二条带 allowDuplicate: true）
    const snapAt12 = recs.map((r) =>
      r.id === rec1.id
        ? { ...r, publishStatus: "success", lastPublishAt: t8("2026-11-21T06:01:00") }
        : { ...r, publishStatus: "publishing", lastPublishAt: t8("2026-11-21T12:00:00") }
    );
    assert.strictEqual(
      pupMod.checkPublishEntryDuplicate(payload2, snapAt12, {
        now: t8("2026-11-21T12:00:00"),
        skipBypass: true,
      }),
      null,
      "12:00 第二条带 allowDuplicate 应放行"
    );
    console.log("✓ Fix #5: 后排定时任务不再拦掉先排任务，allowDuplicate 仅作用于自身");
  } finally {
    delete require.cache[pupBundle];
    fs.rmSync(tmpPupDir, { recursive: true, force: true });
    h.cleanup();
  }
}

// #6 并发 HTTP 请求串行排期 + GUI 过期预览检测偏移重确认
async function testFix06_ConcurrentRequestsAndStaleGuiPreviewSerialized() {
  const h = await createS11FixHarness({ initialTime: "2026-11-21T10:00:00" });
  try {
    const phone = "13800138000";
    // 6a. 同一时刻并发提交两条不同文件不同标题到同一抖音账号
    const [res1, res2] = await Promise.all([
      h.post({ platform: "dy", phone, file: h.clip1, title: "并发第一条" }),
      h.post({ platform: "dy", phone, file: h.clip2, title: "并发第二条" }),
    ]);
    await new Promise((r) => setTimeout(r, 30));

    const results = [res1, res2];
    const immediateOnes = results.filter((r) => r.success && !r.scheduled);
    const scheduledOnes = results.filter((r) => r.success && r.scheduled);
    assert.strictEqual(immediateOnes.length, 1, `应恰有 1 条立即发，实际=${JSON.stringify(results)}`);
    assert.strictEqual(scheduledOnes.length, 1, `应恰有 1 条顺延定时，实际=${JSON.stringify(results)}`);
    assert.strictEqual(scheduledOnes[0].publishAt, "2026-11-21 16:00:00");
    assert.strictEqual(h.uploads.length, 1, "同一时刻同账号只能有一条进入立即上传");
  } finally {
    h.cleanup();
  }

  // 6b. GUI 预览显示「立即发布」→ 期间 HTTP 发了一条 → GUI 点确认必须收到偏移后的新排期再确认
  const h2 = await createS11FixHarness({ initialTime: "2026-11-21T10:00:00" });
  const messages = [];
  const gui = loadLocalVideoPublishVm({
    ipcInvoke: async (ch, arg) => h2.handlers.get(ch)(null, arg),
    messageCalls: messages,
  });
  try {
    const phone = "13800138000";
    const entries = [
      {
        key: "single:0:n1",
        pt: "抖音",
        phone,
        partition: `persist:${phone}抖音`,
        filePath: h2.clip2,
        textType: "local",
        title: "GUI待确认视频",
        isDraft: false,
      },
    ];
    const p = gui.state.confirmThrottlePublishPlan(entries, {});
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(gui.state.throttlePreviewRows[0].plannedTimeText, "立即发布");

    // 预览期间 HTTP 抢先发了一条
    const httpRes = await h2.post({
      platform: "dy",
      phone,
      file: h2.clip1,
      title: "HTTP插队视频",
    });
    assert.strictEqual(httpRes.success, true);
    assert.ok(!httpRes.scheduled);

    // GUI 第一次点确认：主进程重算发现偏移 → 返回 changed: true → 刷新预览表要求再次确认
    gui.state.resolveThrottlePreview("confirm");
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(gui.state.throttlePreviewVisible, true, "排期偏移后预览窗应保持打开等待再确认");
    assert.strictEqual(
      gui.state.throttlePreviewRows[0].plannedTimeText,
      "2026-11-21 16:00:00",
      "预览表应刷新为最新 16:00 排期"
    );

    // 用户再次确认新排期 → 返回 16:00 定时计划并落账本预留
    gui.state.resolveThrottlePreview("confirm");
    const decision = await p;
    assert.strictEqual(decision.proceed, true);
    assert.strictEqual(decision.itemsByKey.get("single:0:n1").scheduled, true);
    assert.strictEqual(decision.itemsByKey.get("single:0:n1").publishAt, "2026-11-21 16:00:00");
    assert.ok(decision.itemsByKey.get("single:0:n1").reservationId);
    console.log("✓ Fix #6: 主进程串行锁防并发连发 + GUI 旧预览偏移强制刷新重确认验证通过");
  } finally {
    gui.cleanup();
    h2.cleanup();
  }
}

// #7 节流账本独立记录多账号与同文件多次发布，不再被 pushData 合并漏算；失败释放预留
async function testFix07_LedgerTracksMultiAccountAndMergedSameFileDailyLimit() {
  // 7a. 同文件发给两个抖音账号：各自保留历史 ID 与账本记录，11:00 给第一账号发新视频排到 16:00
  const h1 = await createS11FixHarness({ initialTime: "2026-11-21T10:00:00" });
  try {
    const rA = await h1.post({ platform: "dy", phone: "13800138001", file: h1.clip1, title: "双号同文件" });
    const rB = await h1.post({ platform: "dy", phone: "13800138002", file: h1.clip1, title: "双号同文件" });
    assert.strictEqual(rA.success, true);
    assert.strictEqual(rB.success, true);
    assert.notStrictEqual(rA.id, rB.id, "不同抖音账号不得共用同一 pushData 历史 ID");

    h1.setNow(t8("2026-11-21T11:00:00"));
    const rA2 = await h1.post({ platform: "dy", phone: "13800138001", file: h1.clip2, title: "账号1新视频" });
    assert.strictEqual(rA2.scheduled, true, "账号1在 10:00 发过，11:00 必须顺延");
    assert.strictEqual(rA2.publishAt, "2026-11-21 16:00:00");
  } finally {
    h1.cleanup();
  }

  // 7b. minInterval=0, dailyLimit=2：08:00 和 09:00 用不同标题发同一文件，10:00 第三条排到次日 06:00
  const h2 = await createS11FixHarness({
    initialTime: "2026-11-21T08:00:00",
    settings: {
      platforms: { dy: { minIntervalHours: 0, dailyLimit: 2, delayFromFirstHours: 0 } },
    },
  });
  try {
    const phone = "13800138000";
    const t1 = await h2.post({ platform: "dy", phone, file: h2.clip1, title: "同文件标题一" });
    assert.strictEqual(t1.success, true);
    assert.ok(!t1.scheduled);

    h2.setNow(t8("2026-11-21T09:00:00"));
    const t2 = await h2.post({ platform: "dy", phone, file: h2.clip1, title: "同文件标题二" });
    assert.strictEqual(t2.success, true);
    assert.ok(!t2.scheduled);

    // 即使 pushData 合并为 1 行，节流账本仍有 2 条记录
    assert.strictEqual(h2.core.readPublishThrottleLedger().entries.length, 2);

    h2.setNow(t8("2026-11-21T10:00:00"));
    const t3 = await h2.post({ platform: "dy", phone, file: h2.clip2, title: "当日第三条" });
    assert.strictEqual(t3.scheduled, true, "日上限 2 已满，第三条必须顺延到次日 06:00");
    assert.strictEqual(t3.publishAt, "2026-11-22 06:00:00");
  } finally {
    h2.cleanup();
  }

  // 7c. 上传失败释放账本预留，后续发布不被误拦
  const h3 = await createS11FixHarness({ initialTime: "2026-11-21T10:00:00" });
  try {
    h3.setUploadHandler((payload, transport, done) => {
      h3.uploads.push(payload);
      setImmediate(() => {
        transport.reply("puppeteerFile-done", {
          taskId: payload.taskId,
          status: false,
          message: "模拟上传失败",
        });
        if (done) done();
      });
    });
    const failed = await h3.post({ platform: "dy", phone: "13800138000", file: h3.clip1, title: "失败释放" });
    assert.strictEqual(failed.success, false);
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(h3.core.readPublishThrottleLedger().entries.length, 0, "上传失败应释放账本预留");
    console.log("✓ Fix #7: 节流账本隔离多账号与同文件多次日上限计数、失败自动释放验证通过");
  } finally {
    h3.cleanup();
  }
}

// #8 草稿（CLI --draft / HTTP draft / 账号默认草稿 / 定时草稿）一律不节流、不进账本、不计日上限
async function testFix08_DraftNeverThrottledOrPollutesLedger() {
  const h = await createS11FixHarness({ initialTime: "2026-11-21T10:00:00" });
  try {
    const phone = "13800138000";
    h.addRecord({
      publishStatus: "success",
      publishSuccessCount: 1,
      lastPublishAt: t8("2026-11-21T09:00:00"),
    });

    // 8a. CLI --draft 立即存草稿，不排到 15:00
    const cliDraft = await h.cli([
      "-p", "dy", "--phone", phone, "-f", h.clip1, "-t", "CLI草稿测试", "--draft",
    ]);
    assert.strictEqual(cliDraft.code, 0);
    assert.notStrictEqual(cliDraft.last.status, "scheduled", "CLI --draft 不得被节流排期");
    assert.strictEqual(cliDraft.last.publishMode, "draft");
    assert.strictEqual(h.uploads.length, 1);

    // 8b. HTTP 向开启「默认发布到草稿」的账号提交 → 立即存草稿，不排到 15:00
    const draftPhone = "13900139000";
    h.core.changeData({
      fileName: "account",
      type: "add",
      item: {
        pt: "抖音",
        phone: draftPhone,
        accountKey: draftPhone,
        partition: `persist:${draftPhone}抖音`,
        defaultPublishToDraft: true,
        date: "2026-11-21",
      },
    });
    h.addRecord({
      pt: "抖音",
      phone: draftPhone,
      partition: `persist:${draftPhone}抖音`,
      publishStatus: "success",
      publishSuccessCount: 1,
      lastPublishAt: t8("2026-11-21T09:00:00"),
    });
    const httpDefaultDraft = await h.post({
      platform: "dy",
      phone: draftPhone,
      file: h.clip2,
      title: "账号默认草稿测试",
    });
    assert.strictEqual(httpDefaultDraft.success, true);
    assert.ok(!httpDefaultDraft.scheduled, "账号默认草稿不得被节流排期");
    assert.strictEqual(httpDefaultDraft.publishMode, "draft");

    // 8c. 定时草稿保存后记为 draft（不是 success），不推迟后续正式发布
    const h2 = await createS11FixHarness({ initialTime: "2026-11-21T06:00:00" });
    try {
      const draftSched = h2.addRecord({
        id: "sched-draft-1",
        pt: "抖音",
        phone,
        partition: `persist:${phone}抖音`,
        title: "定时草稿任务",
        filePath: h2.clip1,
        publishMode: "draft",
        publishToDraft: true,
        scheduledTask: true,
        publishStatus: "scheduled",
        scheduledPublishAt: t8("2026-11-21T06:00:00"),
        scheduledPublishAtText: "2026-11-21 06:00:00",
      });
      h2.core.startScheduledPublishScheduler(h2.getNow());
      await new Promise((r) => setTimeout(r, 40));
      const afterDraft = h2.listAllRecords().find((r) => r.id === draftSched.id);
      assert.strictEqual(afterDraft.publishStatus, "draft", "定时草稿完成后应记为 draft 而非 success");

      h2.setNow(t8("2026-11-21T06:05:00"));
      const formal = await h2.post({
        platform: "dy",
        phone,
        file: h2.clip2,
        title: "草稿后的正式发布",
      });
      assert.strictEqual(formal.success, true);
      assert.ok(!formal.scheduled, "定时草稿不得推迟后续正式发布");
    } finally {
      h2.cleanup();
    }
    console.log("✓ Fix #8: CLI/HTTP/账号默认/定时草稿一律不节流、不进账本、回写 draft 状态验证通过");
  } finally {
    h.cleanup();
  }
}

// #9 混合发布远程 URL 下载失败时，立即平台失败，待排平台照常建任务（到点再下载）
async function testFix09_MixedRemoteDownloadFailureKeepsScheduledPlatform() {
  const h = await createS11FixHarness({
    initialTime: "2026-11-21T10:00:00",
    settings: {
      platforms: { bjh: { delayFromFirstHours: 10 } },
    },
  });
  try {
    const res = await h.post({
      phone: "13800138000",
      file: "https://media.example.invalid/clip.mp4",
      title: "远程混合发布测试",
      platforms: ["ks", "bjh"],
    });
    assert.strictEqual(res.results.length, 2);
    const [rKs, rBjh] = res.results;
    assert.strictEqual(rKs.platform, "快手");
    assert.strictEqual(rKs.success, false);
    assert.strictEqual(rKs.status, "failed");
    assert.ok(rKs.message.includes("下载视频失败"));

    assert.strictEqual(rBjh.platform, "百家号");
    assert.strictEqual(rBjh.success, true, "立即平台下载失败不得影响百家号待排平台");
    assert.strictEqual(rBjh.status, "scheduled");
    assert.strictEqual(rBjh.scheduled, true);
    assert.strictEqual(rBjh.publishAt, "2026-11-21 20:00:00");
    assert.strictEqual(h.core.listScheduledRecords().length, 1);

    // 快手下载失败的预留已释放，仅剩百家号 1 条
    const ledger = h.core.readPublishThrottleLedger();
    assert.strictEqual(ledger.entries.length, 1);
    assert.strictEqual(ledger.entries[0].platform, "百家号");
    console.log("✓ Fix #9: 混合平台远程下载失败仅失败立即平台，待排平台照常建 20:00 定时任务验证通过");
  } finally {
    h.cleanup();
  }
}

// #10 publishAt 在请求解析与回执格式化中统一 UTC+8，在 Asia/Tokyo 主机时区下也严格一致
async function testFix10_PublishAtUtc8TimezoneConsistentAcrossHosts() {
  const script = `
    const assert = require("assert");
    const path = require("path");
    const { parsePublishAtUtc8, parseLocalPublishAt, formatUtc8DateTime, planPublishTimes } = require("./src/shared/publishThrottle.js");
    const now = Date.parse("2026-11-21T02:00:00Z"); // 2026-11-21 10:00:00 UTC+8
    const expectedMs = Date.parse("2026-11-21T05:00:00Z"); // 2026-11-21 13:00:00 UTC+8
    // 1. 自动节流回执 13:00:00 (05:00Z)
    const p1 = planPublishTimes({
      targets: [{ platform: "dy", phone: "13800138000" }],
      now,
      records: [{ pt: "抖音", phone: "13800138000", publishStatus: "success", lastPublishAt: Date.parse("2026-11-20T23:00:00Z") }],
    });
    assert.strictEqual(p1.items[0].publishAt, "2026-11-21 13:00:00");
    assert.strictEqual(p1.items[0].plannedAtMs, expectedMs);

    // 2. 将回执文本原样作为显式 publishAt + noThrottle 提交 → 必须仍是 05:00Z，绝不提前成 04:00Z
    const parsed = parseLocalPublishAt(p1.items[0].publishAt, now);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.value, expectedMs, "Asia/Tokyo 主机下显式 publishAt 必须仍解析为 05:00Z");
    assert.strictEqual(parsed.text, "2026-11-21 13:00:00");

    const p2 = planPublishTimes({
      targets: [{ platform: "dy", phone: "13800138000", publishAt: parsed.text, publishAtMs: parsed.value }],
      now,
      records: [],
      noThrottle: true,
    });
    assert.strictEqual(p2.items[0].plannedAtMs, expectedMs);
    assert.strictEqual(p2.items[0].publishAt, "2026-11-21 13:00:00");
    assert.strictEqual(formatUtc8DateTime(parsed.value), "2026-11-21 13:00:00");
    assert.strictEqual(parsePublishAtUtc8("2026-11-21 13:00:00", now).value, expectedMs);
  `;
  for (const tz of ["Asia/Tokyo", "UTC", "America/New_York"]) {
    execFileSync(process.execPath, ["-e", script], {
      cwd: root,
      env: { ...process.env, TZ: tz },
      stdio: "pipe",
    });
  }
  console.log("✓ Fix #10: publishAt 在 Asia/Tokyo / UTC / America/New_York 下统一 UTC+8 解析与回执验证通过");
}

// #11 Excel 显式声明（含 none）GUI 与 CLI 一致优先于默认；复用既有定时任务声明冲突返回 needs_attention 且回执反映实际声明
async function testFix11_ExplicitCreativeStatementPriorityAndReuseConflict() {
  const h = await createS11FixHarness({ initialTime: "2026-11-21T10:00:00" });
  try {
    const phone = "13800138000";

    // 11a. CLI 目录批量 Excel 创作声明=none 优先于默认 ai_generated
    const xlsx = require("xlsx");
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(
      wb,
      xlsx.utils.json_to_sheet([
        { 文件名: "clip.mp4", 标题: "Excel显式无声明", 创作声明: "none" },
      ]),
      "Sheet1"
    );
    const xlsxPath = path.join(h.mediaDir, "cs-none.xlsx");
    fs.writeFileSync(xlsxPath, xlsx.write(wb, { bookType: "xlsx", type: "buffer" }));
    const cliBatch = await h.cli([
      "-p", "dy", "--phone", phone, "--dir", h.mediaDir, "--config", xlsxPath, "--no-throttle",
    ]);
    assert.strictEqual(cliBatch.code, 0);
    assert.strictEqual(h.uploads[0].data.creativeStatement, "none", "CLI Excel 创作声明=none 必须提交 none");

    // 11b. GUI 目录批量 Excel 创作声明=none 同样必须提交 none（不再被 ai_generated 覆盖）
    const sentPayloads = [];
    const messages = [];
    const gui = loadLocalVideoPublishVm({
      ipcInvoke: async (ch, arg) => {
        if (ch === "publish:check-duplicate") return { duplicates: [] };
        return h.handlers.get(ch)(null, arg);
      },
      ipcSend: (ch, payload) => {
        if (ch === "puppeteerFile") sentPayloads.push(payload);
      },
      dataRequestFn: async (req) => h.core.changeData(req),
      messageCalls: messages,
    });
    try {
      await gui.state.loadPublishThrottleDefaults();
      assert.strictEqual(gui.state.defaultCreativeStatement, "ai_generated");
      const dyNode = {
        id: "node-dy-1",
        pt: "抖音",
        phone,
        accountKey: phone,
        url: "https://creator.douyin.com/creator-micro/content/upload",
      };
      gui.state.ptConfig = {
        抖音: {
          useragent: "ua",
          listIndex: "https://creator.douyin.com/",
          upload: "https://creator.douyin.com/creator-micro/content/upload",
        },
      };
      gui.state.$refs = {
        tree: { getCheckedNodes: () => [dyNode] },
      };
      gui.state.initPlatformStatementsForLeaves([dyNode]);
      gui.state.dirPath = h.mediaDir;
      gui.state.dirBatchFiles = [
        {
          fileName: "second.mp4",
          resolvedPath: h.clip2,
          title: "GUI-Excel无声明",
          description: "",
          shortTitle: "",
          tags: "",
          coverResolved: "",
          creativeStatement: "none",
        },
      ];
      const submitP = gui.state.submitDirBatchPublish("publish");
      await new Promise((r) => setTimeout(r, 20));
      // 预览窗打开后点不节流立即提交
      if (gui.state.throttlePreviewVisible) {
        gui.state.resolveThrottlePreview("no_throttle");
      }
      await submitP;
      assert.strictEqual(sentPayloads.length, 1);
      assert.strictEqual(
        sentPayloads[0].data.creativeStatement,
        "none",
        "GUI Excel 创作声明=none 必须提交 none，不得被默认 ai_generated 覆盖"
      );
    } finally {
      gui.cleanup();
    }

    // 11c. HTTP / CLI 复用既有 AI 声明定时任务时传入 creativeStatement:"none" → 返回 needs_attention 且回执反映实际声明 ai_generated
    const orig = await h.post({
      platform: "dy",
      phone,
      file: h.clip3,
      title: "初版AI任务",
      publishAt: "2026-11-21 13:00:00",
      noThrottle: true,
    });
    assert.strictEqual(orig.scheduled, true);
    assert.strictEqual(orig.creativeStatement, "ai_generated");

    const conflictHttp = await h.post({
      platform: "dy",
      phone,
      file: h.clip3,
      title: "更改声明冲突",
      publishAt: "2026-11-21 13:00:00",
      noThrottle: true,
      creativeStatement: "none",
    });
    assert.strictEqual(conflictHttp.success, false);
    assert.strictEqual(conflictHttp.status, "needs_attention", "声明冲突必须返回 needs_attention 不静默");
    assert.strictEqual(conflictHttp.needsAttention, true);
    assert.strictEqual(conflictHttp.exitCode, 4);
    assert.strictEqual(conflictHttp.duplicate, true);
    assert.strictEqual(conflictHttp.id, orig.id);
    assert.strictEqual(
      conflictHttp.creativeStatement,
      "ai_generated",
      "回执必须反映任务实际声明 ai_generated，与上传参数一致"
    );
    assert.strictEqual(conflictHttp.requestedCreativeStatement, "none");

    const row = h.listAllRecords().find((r) => r.id === orig.id);
    assert.strictEqual(row.creativeStatement, "ai_generated");
    assert.strictEqual(h.core.buildTaskPayloadFromRecord(row).data.creativeStatement, "ai_generated");

    const conflictCli = await h.cli([
      "-p", "dy", "--phone", phone, "-f", h.clip3, "-t", "CLI更改声明冲突",
      "--publish-at", "2026-11-21 13:00:00", "--no-throttle", "--cs", "none",
    ]);
    assert.strictEqual(conflictCli.code, 4);
    assert.strictEqual(conflictCli.last.status, "needs_attention");
    assert.strictEqual(conflictCli.last.creativeStatement, "ai_generated");
    assert.strictEqual(conflictCli.last.requestedCreativeStatement, "none");
    console.log("✓ Fix #11: Excel none 声明 GUI/CLI 一致优先 + 复用任务声明冲突返回 needs_attention 验证通过");
  } finally {
    h.cleanup();
  }
}

// #12 MCP publish_video 透传 noThrottle，回执保留 creativeStatement 与结构化节流原因
async function testFix12_McpNoThrottleAndReceiptFields() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s11-fix12-mcp-"));
  const pubBundle = path.join(tmpDir, "publish.mjs");
  const argsLog = path.join(tmpDir, "args.json");
  const fakeBin = path.join(tmpDir, "fake-matrixmedia");
  const origBin = process.env.MATRIXMEDIA_BIN;
  try {
    await esbuild.build({
      entryPoints: [path.join(root, "mcp/src/tools/publish.ts")],
      outfile: pubBundle,
      bundle: true,
      platform: "node",
      format: "esm",
      external: ["@modelcontextprotocol/sdk"],
    });
    const { publishVideoTool, handlePublishVideo } = await import(
      pathToFileURL(pubBundle).href
    );
    assert.strictEqual(
      publishVideoTool.inputSchema.properties.noThrottle.type,
      "boolean",
      "MCP publish_video schema 必须声明 boolean noThrottle"
    );

    // 12a. noThrottle: true → 透传 --no-throttle 且保留 creativeStatement
    fs.writeFileSync(
      fakeBin,
      `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ channel: 'puppeteerFile-done', status: true, resultStatus: 'success', publishMode: 'publish', creativeStatement: 'ai_generated', message: '上传成功' }));
`,
      "utf8"
    );
    fs.chmodSync(fakeBin, 0o755);
    process.env.MATRIXMEDIA_BIN = fakeBin;

    const immediateOut = JSON.parse(
      await handlePublishVideo({
        platform: "dy",
        phone: "13800138000",
        file: "/tmp/v.mp4",
        title: "绕过节流",
        noThrottle: true,
      })
    );
    const argv = JSON.parse(fs.readFileSync(argsLog, "utf8"));
    assert.ok(argv.includes("--no-throttle"), `MCP 必须转发 --no-throttle，实际 argv=${JSON.stringify(argv)}`);
    assert.strictEqual(immediateOut.status, "success");
    assert.strictEqual(immediateOut.creativeStatement, "ai_generated");

    // 12b. 定时节流回执 → 保留 creativeStatement / throttled / throttleReason / reason / reasons / plannedAtMs
    fs.writeFileSync(
      fakeBin,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  success: true,
  status: 'scheduled',
  scheduled: true,
  id: 'sched-99',
  publishAt: '2026-11-21 15:00:00',
  plannedAtMs: 1795244400000,
  creativeStatement: 'ai_generated',
  throttled: true,
  throttleReason: '距上次抖音发布不足 6 小时',
  reason: '距上次抖音发布不足 6 小时',
  reasons: ['距上次抖音发布不足 6 小时'],
  message: '已按发布节流排期至 2026-11-21 15:00:00（距上次抖音发布不足 6 小时）'
}));
`,
      "utf8"
    );
    const schedOut = JSON.parse(
      await handlePublishVideo({
        platform: "dy",
        phone: "13800138000",
        file: "/tmp/v.mp4",
        title: "节流定时",
      })
    );
    assert.strictEqual(schedOut.status, "scheduled");
    assert.strictEqual(schedOut.scheduled, true);
    assert.strictEqual(schedOut.creativeStatement, "ai_generated");
    assert.strictEqual(schedOut.throttled, true);
    assert.strictEqual(schedOut.throttleReason, "距上次抖音发布不足 6 小时");
    assert.strictEqual(schedOut.reason, "距上次抖音发布不足 6 小时");
    assert.deepStrictEqual(schedOut.reasons, ["距上次抖音发布不足 6 小时"]);
    assert.strictEqual(schedOut.plannedAtMs, 1795244400000);
    console.log("✓ Fix #12: MCP publish_video 透传 noThrottle 且回执保留 creativeStatement 与结构化节流原因验证通过");
  } finally {
    if (origBin === undefined) delete process.env.MATRIXMEDIA_BIN;
    else process.env.MATRIXMEDIA_BIN = origBin;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// #13 排期搜索设 60 天上限，超出返回「排期已满」错误而不是突破日上限
async function testFix13_SearchLookaheadLimitReturnsFullError() {
  const { MAX_PLAN_LOOKAHEAD_DAYS, DAY_MS } = require("../src/shared/publishThrottle.js");
  assert.strictEqual(MAX_PLAN_LOOKAHEAD_DAYS, 60);
  const startNow = t8("2026-11-21T10:00:00");
  const settings = normalizePublishThrottleSettings({
    platforms: {
      dy: { minIntervalHours: 0, dailyLimit: 1, delayFromFirstHours: 0 },
    },
  });

  // 13a. 连续 60 天满额（Day 0..59）→ 第 60 天（Day 60）仍在上限内可排入
  const recs60 = [];
  for (let d = 0; d < 60; d++) {
    recs60.push({
      pt: "抖音",
      phone: "13800138000",
      scheduledTask: true,
      publishStatus: "scheduled",
      scheduledPublishAt: startNow + d * DAY_MS,
    });
  }
  const planOk = planPublishTimes({
    targets: [{ platform: "dy", phone: "13800138000" }],
    now: startNow,
    records: recs60,
    settings,
  });
  assert.strictEqual(planOk.ok, true);
  assert.strictEqual(planOk.items[0].ok, true);
  assert.strictEqual(planOk.items[0].publishAt, formatUtc8DateTime(t8("2027-01-20T06:00:00")));

  // 13b. 连续 367 天满额（原评审复现输入）→ 返回 ok:false「排期已满」，绝不突破日上限
  const recs367 = [];
  for (let d = 0; d < 367; d++) {
    recs367.push({
      pt: "抖音",
      phone: "13800138000",
      scheduledTask: true,
      publishStatus: "scheduled",
      scheduledPublishAt: startNow + d * DAY_MS,
    });
  }
  const planFull = planPublishTimes({
    targets: [{ platform: "dy", phone: "13800138000" }],
    now: startNow,
    records: recs367,
    settings,
  });
  assert.strictEqual(planFull.ok, false);
  assert.strictEqual(planFull.items[0].ok, false);
  assert.strictEqual(planFull.items[0].overflow, true);
  assert.strictEqual(planFull.items[0].scheduled, false);
  assert.strictEqual(planFull.items[0].publishAt, null);
  assert.ok(planFull.items[0].error.includes("排期已满"), planFull.items[0].error);

  // 13c. HTTP 与 CLI 端到端返回「排期已满」且不创建越限任务
  const h = await createS11FixHarness({
    initialTime: "2026-11-21T10:00:00",
    settings: {
      platforms: { dy: { minIntervalHours: 0, dailyLimit: 1, delayFromFirstHours: 0 } },
    },
  });
  try {
    for (let d = 0; d <= 60; d++) {
      h.addRecord({
        id: `full-${d}`,
        title: `满额-${d}`,
        scheduledTask: true,
        publishStatus: "scheduled",
        scheduledPublishAt: startNow + d * DAY_MS,
        scheduledPublishAtText: formatUtc8DateTime(startNow + d * DAY_MS),
      });
    }
    const httpFull = await h.post({
      platform: "dy",
      phone: "13800138000",
      file: h.clip1,
      title: "溢出测试HTTP",
    });
    assert.strictEqual(httpFull.success, false);
    assert.strictEqual(httpFull.status, "failed");
    assert.ok(httpFull.message.includes("排期已满"), httpFull.message);

    const cliFull = await h.cli([
      "-p", "dy", "--phone", "13800138000", "-f", h.clip1, "-t", "溢出测试CLI",
    ]);
    assert.notStrictEqual(cliFull.code, 0);
    assert.ok(cliFull.err.join(" ").includes("排期已满"));
    console.log("✓ Fix #13: 排期搜索 60 天上限超限返回「排期已满」错误，绝不突破日上限验证通过");
  } finally {
    h.cleanup();
  }
}

/* ============================================================================
 * S11-fix2 复审新发现 6 条阻断问题回归用例（每条按复审输入构造，修前失败、修后通过）
 * ============================================================================ */

// S11-fix2 #1: 定时任务防重复上传（派发前持久化标记到账本；写历史失败不清除标记；刷新补写历史不重复上传）
async function testFix2_01_ScheduledTaskNoDuplicateUploadAfterPushDataEnospc() {
  const h = await createS11FixHarness({ initialTime: "2026-11-21T10:00:00" });
  try {
    const phone = "13800138000";
    // 10:00 创建 10:02:00 的定时任务
    const created = await h.post({
      platform: "dy",
      phone,
      file: h.clip1,
      title: "防重传定时任务A",
      publishAt: "2026-11-21 10:02:00",
    });
    assert.strictEqual(created.success, true);
    assert.strictEqual(created.scheduled, true);
    assert.ok(created.id);

    h.core.startScheduledPublishScheduler(t8("2026-11-21T10:00:00"));

    // 10:02:00 到点，令 pushData 的开始和完成写入均返回 ENOSPC，模拟平台返回发布成功
    h.setNow(t8("2026-11-21T10:02:00"));
    h.setDenyPushData(true);
    h.core.refreshScheduledPublishScheduler(t8("2026-11-21T10:02:00"));
    await new Promise((r) => setTimeout(r, 40));

    assert.strictEqual(h.uploads.length, 1, "10:02 应执行上传 1 次");
    const recWhileFull = h.listAllRecords().find((r) => r.id === created.id);
    assert.strictEqual(
      recWhileFull.publishStatus,
      "scheduled",
      "pushData ENOSPC 时历史仍停留在 scheduled"
    );
    const dispatchState = h.core.getScheduledTaskDispatchStateSync(created.id);
    assert.strictEqual(dispatchState.dispatched, true, "账本必须持久化该任务 id 的派发标记");
    assert.strictEqual(dispatchState.status, "success", "账本应已记录成功结果");
    assert.strictEqual(dispatchState.historySynced, false, "写历史失败时 historySynced 应为 false");

    // 10:02:30 磁盘仍满时再次刷新：仍不得重传
    h.setNow(t8("2026-11-21T10:02:30"));
    h.core.refreshScheduledPublishScheduler(t8("2026-11-21T10:02:30"));
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(h.uploads.length, 1, "历史仍写失败时刷新绝不得二次上传");

    // 恢复 pushData 写入，10:03:00 刷新：不再上传，只补写历史为 success
    h.setDenyPushData(false);
    h.setNow(t8("2026-11-21T10:03:00"));
    h.core.refreshScheduledPublishScheduler(t8("2026-11-21T10:03:00"));
    await new Promise((r) => setTimeout(r, 40));

    assert.strictEqual(h.uploads.length, 1, "恢复写盘后 10:03 刷新绝不得再次上传同一任务 ID");
    const recAfterBackfill = h.listAllRecords().find((r) => r.id === created.id);
    assert.strictEqual(recAfterBackfill.publishStatus, "success", "刷新应把历史状态补写为 success");
    assert.strictEqual(recAfterBackfill.publishSuccessCount, 1);
    assert.strictEqual(h.core.listScheduledRecords().length, 0);

    // 1b. 模拟重启清空内存派发集合后刷新（账本已记成功但 pushData 仍是 scheduled）同样绝不二次上传
    h.setNow(t8("2026-11-21T11:00:00"));
    const created2 = await h.post({
      platform: "ks",
      phone,
      file: h.clip2,
      title: "重启后防重传任务B",
      publishAt: "2026-11-21 11:02:00",
    });
    assert.strictEqual(created2.scheduled, true);
    h.setNow(t8("2026-11-21T11:02:00"));
    h.setDenyPushData(true);
    h.core.refreshScheduledPublishScheduler(t8("2026-11-21T11:02:00"));
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(h.uploads.length, 2);

    // 模拟进程重启（stop 清空 dispatchedKeys），恢复磁盘后重启调度器
    h.core.stopScheduledPublishScheduler();
    h.setDenyPushData(false);
    h.setNow(t8("2026-11-21T11:03:00"));
    h.core.startScheduledPublishScheduler(t8("2026-11-21T11:03:00"));
    await new Promise((r) => setTimeout(r, 40));

    assert.strictEqual(h.uploads.length, 2, "重启清空内存后按账本持久化标记仍不得二次上传");
    const rec2 = h.listAllRecords().find((r) => r.id === created2.id);
    assert.strictEqual(rec2.publishStatus, "success", "重启后刷新应补写历史为 success");
    console.log("✓ Fix2 #1: 定时任务派发前持久化标记到账本，pushData ENOSPC 与重启刷新均防重传并补写历史通过");
  } finally {
    h.cleanup();
  }
}

// S11-fix2 #2: GUI 错峰预览确认以 previewBaseMs（≤10 分钟）为请求时刻，差异 ≤60s 且原因不变直接通过
async function testFix2_02_GuiStaggeredPreviewConfirmsWithoutInfiniteLoop() {
  const h = await createS11FixHarness({
    initialTime: "2026-11-21T10:00:00",
    settings: {
      platforms: {
        bjh: { minIntervalHours: 4, dailyLimit: 3, delayFromFirstHours: 10 },
      },
    },
  });
  const messages = [];
  const gui = loadLocalVideoPublishVm({
    ipcInvoke: async (ch, arg) => h.handlers.get(ch)(null, arg),
    messageCalls: messages,
  });
  try {
    const phone = "13800138000";
    const entries = [
      {
        key: "single:0:bjh1",
        pt: "百家号",
        phone,
        partition: `persist:${phone}百家号`,
        filePath: h.clip1,
        textType: "local",
        title: "百家号错峰预览一次确认",
        isDraft: false,
      },
    ];

    // 2a. 10:00:00 打开预览（20:00:00），2 秒后（10:00:02）点确认 → 必须一次通过，不再反复弹窗
    const p1 = gui.state.confirmThrottlePublishPlan(entries, {});
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(gui.state.throttlePreviewVisible, true);
    assert.strictEqual(gui.state.throttlePreviewRows[0].plannedTimeText, "2026-11-21 20:00:00");

    h.setNow(t8("2026-11-21T10:00:02"));
    gui.state.resolveThrottlePreview("confirm");
    const d1 = await p1;
    assert.strictEqual(d1.proceed, true, "2 秒后点确认必须一次通过，不得死循环要求重确认");
    assert.strictEqual(gui.state.throttlePreviewVisible, false);
    const bjhPlan = d1.itemsByKey.get("single:0:bjh1");
    assert.strictEqual(bjhPlan.scheduled, true);
    assert.strictEqual(bjhPlan.publishAt, "2026-11-21 20:00:00", "应保留预览基准 10:00 算出的 20:00:00");
    assert.ok(bjhPlan.reservationId);

    // 释放刚才的预留，继续测 >10 分钟失效预览基准
    await h.core.releaseThrottleReservation(bjhPlan.reservationId);

    // 2b. 10:00:00 打开预览，拖了 11 分钟到 10:11:00 再点确认 → 超过 10 分钟拒绝 previewBaseMs，重算差异 11 分钟 > 60 秒要求重确认
    h.setNow(t8("2026-11-21T10:00:00"));
    const p2 = gui.state.confirmThrottlePublishPlan(entries, {});
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(gui.state.throttlePreviewRows[0].plannedTimeText, "2026-11-21 20:00:00");

    h.setNow(t8("2026-11-21T10:11:00"));
    gui.state.resolveThrottlePreview("confirm");
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(gui.state.throttlePreviewVisible, true, "预览超过 10 分钟且计划时刻差 >60s 应要求重新确认");
    assert.strictEqual(gui.state.throttlePreviewRows[0].plannedTimeText, "2026-11-21 20:11:00");

    // 2 秒后（10:11:02）再次确认新预览 → 一次通过
    h.setNow(t8("2026-11-21T10:11:02"));
    gui.state.resolveThrottlePreview("confirm");
    const d2 = await p2;
    assert.strictEqual(d2.proceed, true);
    assert.strictEqual(d2.itemsByKey.get("single:0:bjh1").publishAt, "2026-11-21 20:11:00");

    // 2c. 纯函数边界：差异 =60s 且原因不变 → false；差异 =61s → true；时间相同但节流原因变化 → true
    assert.strictEqual(
      comparePlanForGuiDrift(
        [{ isDraft: false, scheduled: true, plannedAtMs: t8("2026-11-21T20:00:00"), reason: "百家号相对首发延迟 10 小时" }],
        [{ isDraft: false, scheduled: true, plannedAtMs: t8("2026-11-21T20:01:00"), reason: "百家号相对首发延迟 10 小时" }]
      ),
      false,
      "差异恰为 60 秒且原因未变不得要求重确认"
    );
    assert.strictEqual(
      comparePlanForGuiDrift(
        [{ isDraft: false, scheduled: true, plannedAtMs: t8("2026-11-21T20:00:00"), reason: "百家号相对首发延迟 10 小时" }],
        [{ isDraft: false, scheduled: true, plannedAtMs: t8("2026-11-21T20:01:01"), reason: "百家号相对首发延迟 10 小时" }]
      ),
      true,
      "差异 61 秒 (>60s) 必须要求重确认"
    );
    assert.strictEqual(
      comparePlanForGuiDrift(
        [{ isDraft: false, scheduled: true, plannedAtMs: t8("2026-11-21T20:00:00"), reason: "百家号相对首发延迟 10 小时" }],
        [{ isDraft: false, scheduled: true, plannedAtMs: t8("2026-11-21T20:00:00"), reason: "距上次百家号发布不足 4 小时" }]
      ),
      true,
      "节流原因变化即使时刻相同也必须要求重确认"
    );
    console.log("✓ Fix2 #2: GUI 错峰预览按 previewBaseMs（≤10 分钟）与 >60s/原因变化比较，不再反复要求确认通过");
  } finally {
    gui.cleanup();
    h.cleanup();
  }
}

// S11-fix2 #3: 多平台部分失败逐平台处理（有效平台照常执行，失败平台单报并释预留，整体 success 表示至少提交一个）
async function testFix2_03_MultiPlatformPartialOverflowExecutesValidPlatform() {
  // 3a. 抖音已有超过 60 天的远期任务 → 提交 platforms:["dy","ks"] → 抖音报排期已满，快手照常立即上传且无幽灵预留
  const h = await createS11FixHarness({ initialTime: "2026-11-21T10:00:00" });
  try {
    const phone = "13800138000";
    const farDy = await h.post({
      platform: "dy",
      phone,
      file: h.clip1,
      title: "抖音超60天远期任务",
      publishAt: "2027-02-05 10:00:00",
      noThrottle: true,
    });
    assert.strictEqual(farDy.success, true);
    assert.strictEqual(farDy.scheduled, true);

    const mixed = await h.post({
      phone,
      file: h.clip2,
      title: "混合请求测试",
      platforms: ["dy", "ks"],
    });
    assert.strictEqual(mixed.success, true, `至少提交了一个有效平台，整体 success 应为 true，实际=${JSON.stringify(mixed)}`);
    assert.strictEqual(mixed.status, "partial_failed");
    assert.strictEqual(mixed.total, 2);
    assert.strictEqual(mixed.succeeded, 1);
    assert.strictEqual(mixed.failed, 1);
    assert.strictEqual(mixed.results.length, 2);

    const [rDy, rKs] = mixed.results;
    assert.strictEqual(rDy.platform, "抖音");
    assert.strictEqual(rDy.success, false);
    assert.ok(rDy.message.includes("排期已满"), rDy.message);

    assert.strictEqual(rKs.platform, "快手");
    assert.strictEqual(rKs.success, true, "快手有效平台必须照常执行");
    assert.ok(rKs.id, "快手应写入历史 ID");
    assert.strictEqual(h.uploads.length, 1, "快手应真实触发 1 次立即上传");
    assert.strictEqual(h.uploads[0].pt, "快手");

    const ledger = h.core.readPublishThrottleLedger();
    const orphanRes = ledger.entries.filter((e) => e.status === "reserved" && !e.recordId);
    assert.strictEqual(orphanRes.length, 0, "账本不得留下无历史 ID 的快手幽灵预留");
  } finally {
    h.cleanup();
  }

  // 3b. 混合请求中有效平台本身上传失败 → 释放该平台预留，后续单发快手可立即上传不被误推迟 4 小时
  const h2 = await createS11FixHarness({ initialTime: "2026-11-21T10:00:00" });
  try {
    const phone = "13800138000";
    await h2.post({
      platform: "dy",
      phone,
      file: h2.clip1,
      title: "抖音超60天任务2",
      publishAt: "2027-02-05 10:00:00",
      noThrottle: true,
    });
    let failKsOnce = true;
    h2.setUploadHandler((payload, transport, done) => {
      h2.uploads.push(payload);
      const ok = !failKsOnce;
      failKsOnce = false;
      setImmediate(() => {
        transport.reply("puppeteerFile-done", {
          taskId: payload.taskId,
          status: ok,
          message: ok ? "已发布" : "快手上传失败",
        });
        if (done) done();
      });
    });

    const mixedFail = await h2.post({
      phone,
      file: h2.clip2,
      title: "混合全失败",
      platforms: ["dy", "ks"],
    });
    assert.strictEqual(mixedFail.success, false, "全部平台均未成功时整体 success 应为 false");
    assert.strictEqual(mixedFail.results.length, 2);
    assert.strictEqual(mixedFail.results[0].success, false);
    assert.strictEqual(mixedFail.results[1].success, false);

    // 紧接着单发快手应立即上传，绝不被误推迟到 14:00
    const nextKs = await h2.post({
      platform: "ks",
      phone,
      file: h2.clip3,
      title: "紧接着单发快手",
    });
    assert.strictEqual(nextKs.success, true);
    assert.ok(!nextKs.scheduled, `失败预留已释放，快手应立即发而非顺延，实际=${JSON.stringify(nextKs)}`);
    assert.strictEqual(h2.uploads.length, 2);
    console.log("✓ Fix2 #3: 多平台部分失败逐平台处理、有效项照常执行、失败预留立即释放且返回逐平台结果通过");
  } finally {
    h2.cleanup();
  }
}

// S11-fix2 #4: 预留严格按 reservationId 确认/释放；同文件同账号共享历史 ID 时一次失败绝不抹掉另一条成功预留
async function testFix2_04_FailureReleasesOnlyOwnReservationNotSharedRecordId() {
  const h = await createS11FixHarness({ initialTime: "2026-11-21T10:00:00" });
  try {
    const phone = "13800138000";
    const pendingUploads = [];
    h.setUploadHandler((payload, transport, done) => {
      h.uploads.push(payload);
      pendingUploads.push({ payload, transport, done });
    });

    // A 先提交（保持上传中）
    const pA = h.post({
      platform: "dy",
      phone,
      file: h.clip1,
      title: "同文件并发标题A",
    });
    for (let i = 0; i < 20 && pendingUploads.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.strictEqual(pendingUploads.length, 1);

    // A 尚在上传时用 noThrottle:true 提交同账号同文件不同标题 B（与 A 共用同一 pushData 历史 ID）
    const pB = h.post({
      platform: "dy",
      phone,
      file: h.clip1,
      title: "同文件并发标题B",
      noThrottle: true,
    });
    for (let i = 0; i < 20 && pendingUploads.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.strictEqual(pendingUploads.length, 2);

    const [uA, uB] = pendingUploads;
    assert.strictEqual(uA.payload.recordId, uB.payload.recordId, "复现前提：两次发布共用同一 pushData 历史 ID");
    assert.notStrictEqual(
      uA.payload.throttleReservationId,
      uB.payload.throttleReservationId,
      "两次发布必须拥有各自独立的 reservationId"
    );
    assert.strictEqual(h.core.readPublishThrottleLedger().entries.length, 2);

    // 按队列顺序先让 A 失败、再让 B 成功
    uA.transport.reply("puppeteerFile-done", {
      taskId: uA.payload.taskId,
      status: false,
      message: "模拟 A 上传失败",
    });
    if (uA.done) uA.done();
    const resA = await pA;
    assert.strictEqual(resA.success, false);

    // A 失败后，账本必须仍保留 B 的预留
    const midLedger = h.core.readPublishThrottleLedger();
    assert.strictEqual(midLedger.entries.length, 1, "A 失败只能释放 A 自己的预留，不得删掉 B");
    assert.strictEqual(midLedger.entries[0].id, uB.payload.throttleReservationId);

    uB.transport.reply("puppeteerFile-done", {
      taskId: uB.payload.taskId,
      status: true,
      message: "已发布",
    });
    if (uB.done) uB.done();
    const resB = await pB;
    assert.strictEqual(resB.success, true);

    const afterLedger = h.core.readPublishThrottleLedger();
    assert.strictEqual(afterLedger.entries.length, 1, "B 成功后账本必须保留 B 的 success 记录");
    assert.strictEqual(afterLedger.entries[0].status, "success");
    assert.strictEqual(afterLedger.entries[0].id, uB.payload.throttleReservationId);

    // 11:00 新视频必须按抖音默认 6 小时排到 16:00:00（而非直接上传）
    h.setNow(t8("2026-11-21T11:00:00"));
    h.setUploadHandler((payload, transport, done) => {
      h.uploads.push(payload);
      setImmediate(() => {
        transport.reply("puppeteerFile-done", { taskId: payload.taskId, status: true, message: "已发布" });
        if (done) done();
      });
    });
    const resC = await h.post({
      platform: "dy",
      phone,
      file: h.clip2,
      title: "11点新视频",
    });
    assert.strictEqual(resC.success, true);
    assert.strictEqual(resC.scheduled, true, "11:00 新视频必须受 10:00 成功发布的 B 节流");
    assert.strictEqual(resC.publishAt, "2026-11-21 16:00:00");
    assert.strictEqual(h.uploads.length, 2, "11:00 新视频不应立即上传");
    console.log("✓ Fix2 #4: 预留严格按 reservationId 确认/释放，A 失败不误删共享历史 ID 的 B 成功记录通过");
  } finally {
    h.cleanup();
  }
}

// S11-fix2 #5: 删除远期任务时账本更新失败自动重试并告警；账本读取与 pushData 对账自动清理失效 scheduled 占位
async function testFix2_05_DeleteTaskRetriesWarnsAndReconcilesOnRead() {
  // 5a. 删除时仅令账本写盘失败一次 → 自动重试在第 2 次成功，无残留占位
  const h1 = await createS11FixHarness({ initialTime: "2026-11-21T10:00:00" });
  const realWrite = fs.writeFileSync;
  try {
    const phone = "13800138000";
    const far = await h1.post({
      platform: "dy",
      phone,
      file: h1.clip1,
      title: "远期定时任务-单次写失败重试",
      publishAt: "2027-02-05 10:00:00",
      noThrottle: true,
    });
    assert.strictEqual(far.scheduled, true);
    const rec = h1.listAllRecords().find((r) => r.id === far.id);

    let failOnce = true;
    fs.writeFileSync = function (filePath, ...rest) {
      const p = typeof filePath === "string" ? filePath : "";
      if (failOnce && p.includes("publish-throttle-ledger.json")) {
        failOnce = false;
        const err = new Error("ENOSPC: transient write failure");
        err.code = "ENOSPC";
        throw err;
      }
      return realWrite.call(this, filePath, ...rest);
    };

    const delRes = h1.core.changeData({
      fileName: "pushData",
      type: "delete",
      item: { id: rec.id, date: rec.date },
    });
    fs.writeFileSync = realWrite;
    assert.strictEqual(delRes.success, true);
    assert.strictEqual(failOnce, false, "确实触发了 1 次写盘失败并重试");
    assert.ok(!delRes.ledgerSyncFailed, "单次失败后重试成功不应报错");
    assert.strictEqual(h1.core.readPublishThrottleLedger().entries.length, 0);

    const pubNow = await h1.post({
      platform: "dy",
      phone,
      file: h1.clip2,
      title: "删后当天立即发",
    });
    assert.strictEqual(pubNow.success, true);
    assert.ok(!pubNow.scheduled);
  } finally {
    fs.writeFileSync = realWrite;
    h1.cleanup();
  }

  // 5b. 删除时账本写盘持续失败 → 重试后返回明确告警（不得静默）；写盘恢复后读取对账自动清理幽灵 scheduled 占位
  const h2 = await createS11FixHarness({ initialTime: "2026-11-21T10:00:00" });
  try {
    const phone = "13800138000";
    const far = await h2.post({
      platform: "dy",
      phone,
      file: h2.clip1,
      title: "远期定时任务-持续失败对账",
      publishAt: "2027-02-05 10:00:00",
      noThrottle: true,
    });
    assert.strictEqual(far.scheduled, true);
    const rec = h2.listAllRecords().find((r) => r.id === far.id);

    h2.setDenyLedger(true);
    const delWarnRes = h2.core.changeData({
      fileName: "pushData",
      type: "delete",
      item: { id: rec.id, date: rec.date },
    });
    assert.strictEqual(delWarnRes.success, true);
    assert.strictEqual(delWarnRes.ledgerSyncFailed, true, "重试全部失败必须显式标记 ledgerSyncFailed");
    assert.ok(
      delWarnRes.warning && delWarnRes.warning.includes("节流账本同步失败"),
      `删除失败不得静默，必须返回告警，实际=${JSON.stringify(delWarnRes)}`
    );

    // 重启调度器：待发和计时器均为 0，而原始账本文件里仍残留 2027-02-05 占位
    h2.core.stopScheduledPublishScheduler();
    h2.core.startScheduledPublishScheduler(t8("2026-11-21T10:00:00"));
    assert.strictEqual(h2.core.listScheduledRecords().length, 0);
    assert.strictEqual(h2.core.getScheduledTimersSnapshot().length, 0);
    const rawDiskLedger = JSON.parse(
      fs.readFileSync(h2.core.getPublishThrottleLedgerPath(), "utf8")
    );
    assert.strictEqual(rawDiskLedger.entries.length, 1, "复现前提：磁盘账本残留远期 scheduled 条目");

    // 恢复写盘后：账本读取与 pushData 对账自动清理失效 scheduled 占位，当天与次日均可正常发布
    h2.setDenyLedger(false);
    const reconciledLedger = h2.core.readPublishThrottleLedger();
    assert.strictEqual(reconciledLedger.entries.length, 0, "读取对账必须清理已删除任务的 scheduled 占位");

    const pubDay1 = await h2.post({
      platform: "dy",
      phone,
      file: h2.clip2,
      title: "恢复后当天新视频",
    });
    assert.strictEqual(pubDay1.success, true, `当天新视频不得报排期已满，实际=${JSON.stringify(pubDay1)}`);
    assert.ok(!pubDay1.scheduled);

    h2.setNow(t8("2026-11-22T10:00:00"));
    const pubDay2 = await h2.post({
      platform: "dy",
      phone,
      file: h2.clip3,
      title: "恢复后次日新视频",
    });
    assert.strictEqual(pubDay2.success, true, `次日新视频不得报排期已满，实际=${JSON.stringify(pubDay2)}`);
    assert.ok(!pubDay2.scheduled);

    // 5c. 若任务在 pushData 中已非待发状态（如 cancelled），读取账本对账同样清理该 scheduled 占位
    const schedPath = h2.core.getPublishThrottleLedgerPath();
    const cancelledRec = h2.addRecord({
      scheduledTask: true,
      publishStatus: "cancelled",
      scheduledPublishAt: t8("2027-02-05T10:00:00"),
      scheduledPublishAtText: "2027-02-05 10:00:00",
      date: "2026-11-22",
      title: "已取消定时任务",
    });
    const curDisk = JSON.parse(fs.readFileSync(schedPath, "utf8"));
    curDisk.entries.push({
      id: "tl_stale_cancelled_sched",
      bucketKey: `抖音|persist:${phone}抖音`,
      platform: "抖音",
      partition: `persist:${phone}抖音`,
      phone,
      status: "scheduled",
      ts: t8("2027-02-05T10:00:00"),
      isScheduled: true,
      recordId: String(cancelledRec.id),
      createdAt: t8("2026-11-22T10:00:00"),
      updatedAt: t8("2026-11-22T10:00:00"),
    });
    fs.writeFileSync(schedPath, JSON.stringify(curDisk, null, 2), "utf8");
    const afterCancelledCheck = h2.core.readPublishThrottleLedger();
    assert.ok(
      !afterCancelledCheck.entries.some((e) => e.id === "tl_stale_cancelled_sched"),
      "pushData 中已非 scheduled 状态的任务对应的账本 scheduled 占位必须被对账清理"
    );
    console.log("✓ Fix2 #5: 删除失败重试与显式告警 + 账本读取与 pushData 对账清理失效 scheduled 占位验证通过");
  } finally {
    h2.cleanup();
  }
}

// S11-fix2 #6: 跨进程文件锁（同目录 .lock 独占创建、>30s 陈旧抢占、退避重试 10s 超时报错）串行化 HTTP 与 CLI
async function testFix2_06_CrossProcessFileLockSerializesHttpAndCli() {
  const vm = require("vm");
  const { createRequire } = require("module");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s11-fix2-lock-"));
  const clipA = path.join(tmpDir, "a.mp4");
  const clipB = path.join(tmpDir, "b.mp4");
  fs.writeFileSync(clipA, "video-a");
  fs.writeFileSync(clipB, "video-b");

  const ledgerPath = path.join(tmpDir, "publish-throttle-ledger.json");
  const lockPath = path.join(tmpDir, "publish-throttle-ledger.lock");
  const now = t8("2026-11-21T10:00:00");
  const uploads = [];
  let duringHttpLedgerReplace = null;

  // 共享同一真实临时目录，并在 HTTP renameSync 替换账本前切入 CLI 隔离环境（复现跨进程竞态）
  const sharedFs = new Proxy(fs, {
    get(target, key) {
      if (key !== "renameSync") {
        const v = target[key];
        return typeof v === "function" ? v.bind(target) : v;
      }
      return (from, to) => {
        if (to === ledgerPath && duringHttpLedgerReplace) {
          const run = duringHttpLedgerReplace;
          duringHttpLedgerReplace = null;
          run();
        }
        return target.renameSync(from, to);
      };
    },
  });

  try {
    const built = await esbuild.build({
      stdin: {
        contents: [
          `export { default as router } from "./src/main/server/routes/index.js";`,
          `export { runCliMain } from "./src/main/cli/index.js";`,
          `export * from "./src/main/services/publishThrottle.js";`,
        ].join("\n"),
        resolveDir: root,
        sourcefile: "s11-fix2-cross-entry.js",
      },
      bundle: true,
      write: false,
      format: "cjs",
      platform: "node",
      packages: "external",
      plugins: [
        {
          name: "s11-fix2-cross-mocks",
          setup(b) {
            b.onResolve({ filter: /puppeteerFile(?:\.js)?$/ }, () => ({
              path: "upload",
              namespace: "s11-fix2-mock",
            }));
            b.onResolve({ filter: /collectAlert\.js$/ }, () => ({
              path: "alert",
              namespace: "s11-fix2-mock",
            }));
            b.onLoad({ filter: /.*/, namespace: "s11-fix2-mock" }, ({ path: p }) => ({
              contents:
                p === "upload"
                  ? `export function registerPublishDedupeBypass(){} export function runPuppeteerTask(...args){return globalThis.fakeUpload(...args);}`
                  : `export function handleAccountCollectOutcome(){}`,
              loader: "js",
            }));
          },
        },
      ],
    });

    const bundleCode = built.outputFiles[0].text;
    const req = createRequire(path.join(root, "s11-fix2-cross-bundle.cjs"));
    const electronStub = {
      app: {
        getPath: () => tmpDir,
        getVersion: () => "0.15.0-test",
        on() {},
        once() {},
        commandLine: { getSwitchValue: () => "" },
      },
      ipcMain: { handle() {}, on() {} },
      BrowserWindow: function () {},
      dialog: {},
    };

    function createIsolatedProc(label, pid) {
      const logs = [];
      const errors = [];
      const proc = Object.create(process);
      Object.defineProperty(proc, "pid", { value: pid });
      const ctx = vm.createContext({
        module: { exports: {} },
        process: proc,
        console: {
          log: (...a) => logs.push(a.join(" ")),
          error: (...a) => errors.push(a.join(" ")),
          warn: (...a) => errors.push(a.join(" ")),
        },
        logs,
        errors,
        now,
        tmpDir,
        clipA,
        clipB,
        __dirname: root,
        Buffer,
        URL,
        URLSearchParams,
        setTimeout,
        clearTimeout,
        setImmediate,
        clearImmediate,
        setInterval,
        clearInterval,
        require(name) {
          if (name === "fs" || name === "node:fs") return sharedFs;
          if (name === "electron") return electronStub;
          if (name === "puppeteer-extra") return { addExtra: () => ({ use() {}, connect() {} }) };
          if (name === "puppeteer-extra-plugin-stealth") return () => ({});
          if (name.startsWith("puppeteer")) return {};
          return req(name);
        },
        fakeUpload(payload, transport, done) {
          uploads.push([label, payload.data.title]);
          transport.reply("puppeteerFile-done", {
            taskId: payload.taskId,
            status: true,
            message: "已发布",
          });
          if (done) done();
        },
      });
      ctx.global = ctx;
      vm.runInContext(
        `const NativeDate = Date; globalThis.Date = class extends NativeDate { constructor(...args){ super(...(args.length ? args : [now])); } static now(){ return now; } };`,
        ctx
      );
      vm.runInContext(bundleCode, ctx, { timeout: 5000 });
      return ctx;
    }

    // 6a. 两个独立运行环境（HTTP pid 7231 / CLI pid 7232）并发写同一账本，文件锁必须串行化
    const httpCtx = createIsolatedProc("HTTP", 7231);
    const cliCtx = createIsolatedProc("CLI", 7232);

    let cliPromiseStarted = false;
    duringHttpLedgerReplace = () => {
      // HTTP 正在持有 .lock 替换账本期间，拉起 CLI 进程请求同一账号
      assert.strictEqual(fs.existsSync(lockPath), true, "HTTP 替换账本时必须持有同目录 .lock 文件");
      cliPromiseStarted = true;
      vm.runInContext(
        `module.exports.runCliMain(["electron","cli","publish","-p","dy","--phone","13800138000","-f",clipB,"-t","CLI视频"]).then(r=>{globalThis.cliExit=r;},e=>{globalThis.cliFailure=String(e);});`,
        cliCtx,
        { timeout: 5000 }
      );
    };

    vm.runInContext(
      `const post = module.exports.router.stack.find(r=>r.route && r.route.path==="/publish").route.stack[0].handle;
       post(
         { body:{ platform:"dy", phone:"13800138000", file:clipA, title:"HTTP视频" }, method:"POST", headers:{ origin:"http://localhost:30088" }, ip:"127.0.0.1", socket:{ remoteAddress:"127.0.0.1" } },
         { status(c){ globalThis.httpCode=c; return this; }, json(r){ globalThis.httpReceipt=r; } }
       ).catch(e=>{ globalThis.httpFailure=String(e); });`,
      httpCtx,
      { timeout: 5000 }
    );

    const waitDeadline = Date.now() + 4000;
    while (
      Date.now() < waitDeadline &&
      (!httpCtx.httpReceipt || cliCtx.cliExit === undefined) &&
      !httpCtx.httpFailure &&
      !cliCtx.cliFailure
    ) {
      await new Promise((r) => setTimeout(r, 15));
    }

    assert.strictEqual(cliPromiseStarted, true, "确实在 HTTP 持有锁期间触发了 CLI 竞争");
    assert.strictEqual(httpCtx.httpFailure, undefined, httpCtx.httpFailure);
    assert.strictEqual(cliCtx.cliFailure, undefined, cliCtx.cliFailure);
    assert.strictEqual(httpCtx.httpReceipt && httpCtx.httpReceipt.status, "success");
    assert.strictEqual(cliCtx.cliExit, 0, JSON.stringify(cliCtx.errors));

    // HTTP 拿到锁立即发，CLI 等 HTTP 放锁后读到 HTTP 的 10:00 记录 → 自动顺延到 16:00，绝不双发、绝不覆盖账本
    assert.deepStrictEqual(
      uploads,
      [["HTTP", "HTTP视频"]],
      `跨进程文件锁应阻止双发，实际上传=${JSON.stringify(uploads)}`
    );
    const cliReceipts = cliCtx.logs
      .filter((s) => s.trim().startsWith("{"))
      .map((s) => JSON.parse(s));
    const cliLast = cliReceipts[cliReceipts.length - 1];
    assert.strictEqual(cliLast.status, "scheduled");
    assert.strictEqual(cliLast.publishAt, "2026-11-21 16:00:00");

    const persisted = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    assert.strictEqual(persisted.entries.length, 2, `账本不得互相覆盖，应留 2 条记录，实际=${JSON.stringify(persisted.entries)}`);
    assert.ok(persisted.entries.some((e) => e.status === "success"));
    assert.ok(persisted.entries.some((e) => e.status === "scheduled"));
    assert.strictEqual(fs.existsSync(lockPath), false, "全部完成后 .lock 文件必须清理干净");

    // 6b. 陈旧锁（持有 > 30 秒）自动抢占
    const throttleSvc = require("../src/main/services/publishThrottle.js");
    assert.strictEqual(throttleSvc.LEDGER_LOCK_STALE_MS, 30 * 1000);
    assert.strictEqual(throttleSvc.LEDGER_LOCK_TIMEOUT_MS, 10 * 1000);

    const staleLockDir = path.join(tmpDir, "stale-lock-test");
    fs.mkdirSync(staleLockDir, { recursive: true });
    const staleLockFile = throttleSvc.getPublishThrottleLedgerLockPath({ userDataDir: staleLockDir });
    fs.writeFileSync(
      staleLockFile,
      JSON.stringify({ pid: 99999, token: "dead-holder", acquiredAt: Date.now() - 31000 }),
      "utf8"
    );
    let ranAfterStale = false;
    await throttleSvc.withPublishThrottleLock(
      () => {
        ranAfterStale = true;
      },
      { userDataDir: staleLockDir }
    );
    assert.strictEqual(ranAfterStale, true, "持有超过 30 秒的陈旧 .lock 必须能被抢占");
    assert.strictEqual(fs.existsSync(staleLockFile), false, "抢占并执行完毕后应释放 .lock");

    // 6c. 活跃锁未释放时带退避重试，超时后报错且不误删活跃持有者的 .lock
    const busyLockDir = path.join(tmpDir, "busy-lock-test");
    fs.mkdirSync(busyLockDir, { recursive: true });
    const busyLockFile = throttleSvc.getPublishThrottleLedgerLockPath({ userDataDir: busyLockDir });
    const peerToken = "alive-peer-token";
    fs.writeFileSync(
      busyLockFile,
      JSON.stringify({ pid: 88888, token: peerToken, acquiredAt: Date.now() }),
      "utf8"
    );
    let lockErr = null;
    const t0 = Date.now();
    try {
      await throttleSvc.withPublishThrottleLock(
        () => {},
        { userDataDir: busyLockDir, lockTimeoutMs: 120 }
      );
    } catch (err) {
      lockErr = err;
    }
    const elapsed = Date.now() - t0;
    assert.ok(lockErr, "锁被占用超时后必须报错");
    assert.strictEqual(lockErr.code, "LEDGER_LOCK_TIMEOUT");
    assert.ok(elapsed >= 100, `应带退避等待到超时，实际耗时 ${elapsed}ms`);
    assert.strictEqual(fs.existsSync(busyLockFile), true, "超时不得删除活跃持有者的 .lock");
    assert.strictEqual(JSON.parse(fs.readFileSync(busyLockFile, "utf8")).token, peerToken);

    const planTimeoutRes = await throttleSvc.planAndReservePublishTimes(
      { targets: [{ platform: "dy", phone: "13800138000" }] },
      { userDataDir: busyLockDir, lockTimeoutMs: 100 }
    );
    assert.strictEqual(planTimeoutRes.ok, false);
    assert.strictEqual(planTimeoutRes.code, "LEDGER_LOCK_TIMEOUT");

    console.log("✓ Fix2 #6: 跨进程 .lock 独占文件锁串行化 HTTP/CLI、>30s 陈旧抢占与退避超时报错验证通过");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  testCase1_IntervalPostponeAndBoundaries();
  testCase2_AllowedWindowRollover();
  testCase3_DailyLimitRollover();
  testCase4_BjhDelayPlus10h();
  testCase5_ExplicitPublishAtOnlyPostpones();
  testCase6_NoThrottleBypass();
  await testCase7_SettingsPersistenceAndIpc();
  await testCase8_HttpMultiPlatformAndDedupeAndDefaultStatement();
  await testCase9_CliThrottleAndDefaultStatement();
  await testCase10_RestartPersistenceOfScheduledTasks();
  await testCase11_GuiTemplatesAndDocsCheck();
  await testFix01_ReuseSameFileSameTimeScheduledWithNewTitle();
  await testFix02_NewScheduledTaskDoesNotExpireDueTask();
  await testFix03_DiskWriteFailureNeverReportsScheduled();
  await testFix04_GuiExpiredPreviewRejectedNoFallbackWrite();
  await testFix05_S10LaterScheduledDoesNotBlockEarlierTask();
  await testFix06_ConcurrentRequestsAndStaleGuiPreviewSerialized();
  await testFix07_LedgerTracksMultiAccountAndMergedSameFileDailyLimit();
  await testFix08_DraftNeverThrottledOrPollutesLedger();
  await testFix09_MixedRemoteDownloadFailureKeepsScheduledPlatform();
  await testFix10_PublishAtUtc8TimezoneConsistentAcrossHosts();
  await testFix11_ExplicitCreativeStatementPriorityAndReuseConflict();
  await testFix12_McpNoThrottleAndReceiptFields();
  await testFix13_SearchLookaheadLimitReturnsFullError();
  await testFix2_01_ScheduledTaskNoDuplicateUploadAfterPushDataEnospc();
  await testFix2_02_GuiStaggeredPreviewConfirmsWithoutInfiniteLoop();
  await testFix2_03_MultiPlatformPartialOverflowExecutesValidPlatform();
  await testFix2_04_FailureReleasesOnlyOwnReservationNotSharedRecordId();
  await testFix2_05_DeleteTaskRetriesWarnsAndReconcilesOnRead();
  await testFix2_06_CrossProcessFileLockSerializesHttpAndCli();
  console.log("\ntest-publish-throttle: 全部断言通过");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
