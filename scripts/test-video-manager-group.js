"use strict";

/**
 * 卡 S20：视频管理（本地发布记录）按新分组识别、合并与筛选回归测试。
 *
 * 覆盖：
 *   1. resolveRecordGroup / resolveRecordAccountName：
 *      - 当前账号命中取新分组名（含改名前旧记录、缺 partition/accountKey 历史记录）
 *      - 账号已删回退 group / phone "-" 前缀
 *      - 平台隔离与跨分组共享登录态保护
 *   2. 列表显示与合并（真实加载 src/renderer/views/videoManager/index.vue）：
 *      - 同日同视频同分组不同账号合一卡（如 百家号「人间善恶录」+ 视频号/抖音/快手「人间善恶录-赛博张师傅」）
 *      - 不同分组（「赛博老司机」）分开显示
 *      - 改名前旧记录归入新分组名且不修改原始记录
 *      - 同分组同平台多账号时子行显示账号名区分，单账号不加后缀
 *   3. 分组筛选：
 *      - 全部 + 当前分组列表按 accountGroupOrder 排序
 *      - 选择持久化到 localStorage 且异常安全（try/catch）
 *      - 分组改名后 localStorage 中失效的旧分组名自动回落「全部」
 *   4. 不改账号级身份：
 *      - findLocalPublishRecord / syncPublishProgress 在筛选态与合并卡下仍按 partition/accountKey 精确匹配
 *      - handleGetStatus 仍按账号级 partition 匹配，且不向 pushData 写入 displayGroup 等展示字段
 *      - handleRepublish 保留每条子记录原 partition/accountKey/id
 *      - handleDelete 在分组筛选态下按目标行对象精确删除，不误删其他分组行
 *      - exportHistory 导出保持子记录原始身份字段，并跟随当前筛选视图
 *   5. 回归：仅一个分组且无改名时显示与合并结果与改前一致
 *   6. Vue 2 模板编译校验（存在 vue-template-compiler 时）
 *
 * 运行：node scripts/test-video-manager-group.js
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const accountIdentity = require(path.join(root, "src/shared/accountIdentity.js"));
const accountGroupOrder = require(path.join(root, "src/shared/accountGroupOrder.js"));
const videoMetadata = require(path.join(root, "src/shared/videoMetadata.js"));
const publishHistoryCsv = require(path.join(root, "src/shared/publishHistoryCsv.js"));
const creativeStatement = require(path.join(root, "src/shared/creativeStatement.js"));
const publishExtras = require(path.join(root, "src/shared/publishExtras.js"));

const vueSource = fs.readFileSync(
  path.join(root, "src/renderer/views/videoManager/index.vue"),
  "utf8"
);

function plain(v) {
  return JSON.parse(JSON.stringify(v));
}

function createMemoryStorage(initial = {}, opts = {}) {
  const map = new Map(Object.entries(initial));
  return {
    _map: map,
    getItem(k) {
      if (opts.throwOnGet) throw new Error("storage read denied");
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (opts.throwOnSet) throw new Error("storage write denied");
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    },
  };
}

function loadVideoManager(extraGlobals = {}) {
  const scriptBlock = vueSource.match(/<script>([\s\S]*?)<\/script>/)[1];
  const importedNames = [
    ...scriptBlock.matchAll(/^import\s+([\s\S]*?)\s+from\s+["'][^"']+["'];/gm),
  ].flatMap((m) =>
    m[1]
      .replace(/[{}]/g, "")
      .split(",")
      .map((x) => x.trim().split(/\s+as\s+/).pop())
      .filter(Boolean)
  );
  const stubs = Object.fromEntries(importedNames.map((n) => [n, () => {}]));
  const context = vm.createContext({
    ...stubs,
    ...accountIdentity,
    ...accountGroupOrder,
    ...videoMetadata,
    ...publishHistoryCsv,
    ...creativeStatement,
    ...publishExtras,
    ptConfig: {
      抖音: { listIndex: "https://creator.douyin.com/list" },
      快手: { listIndex: "https://cp.kuaishou.com/list" },
      视频号: { listIndex: "https://channels.weixin.qq.com/list" },
      百家号: { listIndex: "https://baijiahao.baidu.com/list" },
      掘金: { listIndex: "https://juejin.cn/creator/content/article" },
    },
    console,
    Date,
    Set,
    Map,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Promise,
    ...extraGlobals,
  });
  const executable = scriptBlock
    .replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*$/gm, "")
    .replace("export default", "globalThis.component =");
  vm.runInContext(executable, context);
  const comp = context.component;

  const messages = [];
  const state = {
    ...comp.data(),
    $set(obj, key, val) {
      obj[key] = val;
    },
    $delete(obj, key) {
      delete obj[key];
    },
    $message: {
      info: (m) => messages.push(["info", m]),
      success: (m) => messages.push(["success", m]),
      warning: (m) => messages.push(["warning", m]),
      error: (m) => messages.push(["error", m]),
    },
    $notify: () => {},
    $confirm: async () => {
      throw "cancel";
    },
    $refs: {},
  };
  for (const [name, fn] of Object.entries(comp.methods || {})) {
    state[name] = fn.bind(state);
  }
  for (const [name, fn] of Object.entries(comp.computed || {})) {
    Object.defineProperty(state, name, {
      get: fn.bind(state),
      enumerable: true,
      configurable: true,
    });
  }
  return { comp, state, context, messages };
}

async function main() {
  /* ========================================================================
   * 1. Vue 2 模板编译与关键绑定校验
   * ====================================================================== */
  let compiler = null;
  try {
    compiler = require("vue-template-compiler");
  } catch (_) {}
  if (compiler) {
    const sfc = compiler.parseComponent(vueSource);
    assert.ok(sfc.template && sfc.template.content);
    const compiled = compiler.compile(sfc.template.content);
    assert.deepStrictEqual(
      compiled.errors,
      [],
      `videoManager/index.vue 模板编译错误: ${compiled.errors.join("; ")}`
    );
  }
  assert.ok(vueSource.includes("filteredDataList"), "列表应绑定 filteredDataList");
  assert.ok(vueSource.includes("groupFilterOptions"), "顶部应有分组筛选下拉选项");
  assert.ok(vueSource.includes("getRowDisplayGroup"), "发布分组列应使用解析后的分组名");
  assert.ok(vueSource.includes("getSubAccountLabel"), "子行应支持多账号名区分");

  /* ========================================================================
   * 2. 解析函数单测（命中新分组名 / 改名前旧记录 / 账号已删回退）
   * ====================================================================== */
  const renamedAccounts = [
    {
      id: "a1",
      pt: "视频号",
      group: "人间善恶录",
      phone: "人间善恶录-赛博张师傅",
      accountName: "赛博张师傅",
      accountKey: "赛博张师傅",
      groupOrder: 1,
    },
    {
      id: "a2",
      pt: "抖音",
      group: "人间善恶录",
      phone: "人间善恶录-赛博张师傅",
      accountName: "赛博张师傅",
      accountKey: "赛博张师傅",
      groupOrder: 1,
    },
    {
      id: "a3",
      pt: "快手",
      group: "人间善恶录",
      phone: "人间善恶录-赛博张师傅",
      accountName: "赛博张师傅",
      accountKey: "赛博张师傅",
      groupOrder: 1,
    },
    {
      id: "a4",
      pt: "百家号",
      group: "人间善恶录",
      phone: "人间善恶录",
      accountName: "人间善恶录",
      accountKey: "人间善恶录",
      groupOrder: 1,
    },
    {
      id: "a5",
      pt: "抖音",
      group: "赛博老司机",
      phone: "赛博老司机",
      accountName: "赛博老司机",
      accountKey: "赛博老司机",
      groupOrder: 0,
    },
  ];

  // 改名前旧记录：命中当前账号 → 新分组名「人间善恶录」
  assert.equal(
    accountIdentity.resolveRecordGroup(
      {
        pt: "抖音",
        phone: "赛博张师傅",
        group: "赛博张师傅",
        accountKey: "赛博张师傅",
        partition: "persist:赛博张师傅抖音",
      },
      renamedAccounts
    ),
    "人间善恶录"
  );
  // 改名前无 group / accountKey / partition 的历史记录 → 仍命中「人间善恶录」
  assert.equal(
    accountIdentity.resolveRecordGroup(
      { pt: "视频号", phone: "赛博张师傅" },
      renamedAccounts
    ),
    "人间善恶录"
  );
  // 账号已删 → 优先回退 group，再回退 phone "-" 前缀
  assert.equal(
    accountIdentity.resolveRecordGroup(
      {
        pt: "抖音",
        phone: "旧号-已删",
        group: "已删分组",
        accountKey: "已删",
        partition: "persist:已删抖音",
      },
      renamedAccounts
    ),
    "已删分组"
  );
  assert.equal(
    accountIdentity.resolveRecordGroup(
      {
        pt: "快手",
        phone: "已删前缀组-老账号",
        partition: "persist:老账号快手",
      },
      renamedAccounts
    ),
    "已删前缀组"
  );

  /* ========================================================================
   * 3. 合并与显示：真机场景复现 + 改名前旧记录 + 已删账号 + 原盘记录不变
   * ====================================================================== */
  const rawPushData = {
    "2026-11-26": [
      {
        id: "p1",
        date: "2026-11-26",
        textType: "local",
        textOtherName: "济公断箱子吞了养老钱",
        bt: "济公断箱子吞了养老钱",
        selectedFile: "jigong.mp4",
        filePath: "/videos/jigong.mp4",
        pt: "百家号",
        phone: "人间善恶录",
        group: "人间善恶录",
        accountName: "人间善恶录",
        accountKey: "人间善恶录",
        partition: "persist:人间善恶录百家号",
        publishStatus: "success",
        publishSuccessCount: 1,
      },
      {
        id: "p2",
        date: "2026-11-26",
        textType: "local",
        textOtherName: "济公断箱子吞了养老钱",
        bt: "济公断箱子吞了养老钱",
        selectedFile: "jigong.mp4",
        filePath: "/videos/jigong.mp4",
        pt: "视频号",
        phone: "人间善恶录-赛博张师傅",
        group: "人间善恶录",
        accountName: "赛博张师傅",
        accountKey: "赛博张师傅",
        partition: "persist:赛博张师傅视频号",
        publishStatus: "failed",
        publishFailCount: 1,
      },
      {
        id: "p3",
        date: "2026-11-26",
        textType: "local",
        textOtherName: "济公断箱子吞了养老钱",
        bt: "济公断箱子吞了养老钱",
        selectedFile: "jigong.mp4",
        filePath: "/videos/jigong.mp4",
        pt: "抖音",
        phone: "人间善恶录-赛博张师傅",
        group: "人间善恶录",
        accountName: "赛博张师傅",
        accountKey: "赛博张师傅",
        partition: "persist:赛博张师傅抖音",
        publishStatus: "publishing",
      },
      {
        id: "p4",
        date: "2026-11-26",
        textType: "local",
        textOtherName: "济公断箱子吞了养老钱",
        bt: "济公断箱子吞了养老钱",
        selectedFile: "jigong.mp4",
        filePath: "/videos/jigong.mp4",
        pt: "快手",
        phone: "人间善恶录-赛博张师傅",
        group: "人间善恶录",
        accountName: "赛博张师傅",
        accountKey: "赛博张师傅",
        partition: "persist:赛博张师傅快手",
        publishStatus: "success",
        publishSuccessCount: 1,
      },
      {
        id: "p5",
        date: "2026-11-26",
        textType: "local",
        textOtherName: "济公断箱子吞了养老钱",
        bt: "济公断箱子吞了养老钱",
        selectedFile: "jigong.mp4",
        filePath: "/videos/jigong.mp4",
        pt: "抖音",
        phone: "赛博老司机",
        group: "赛博老司机",
        accountName: "赛博老司机",
        accountKey: "赛博老司机",
        partition: "persist:赛博老司机抖音",
        publishStatus: "success",
        publishSuccessCount: 1,
      },
    ],
    "2026-11-20": [
      // 改名前旧记录（仍写着 赛博张师傅）
      {
        id: "old1",
        date: "2026-11-20",
        textType: "local",
        textOtherName: "改名前老视频",
        bt: "改名前老视频",
        selectedFile: "old.mp4",
        pt: "抖音",
        phone: "赛博张师傅",
        group: "赛博张师傅",
        accountKey: "赛博张师傅",
        partition: "persist:赛博张师傅抖音",
        publishStatus: "success",
        publishSuccessCount: 1,
      },
      {
        id: "old2",
        date: "2026-11-20",
        textType: "local",
        textOtherName: "改名前老视频",
        bt: "改名前老视频",
        selectedFile: "old.mp4",
        pt: "快手",
        phone: "赛博张师傅",
        publishStatus: "success",
        publishSuccessCount: 1,
      },
      // 已删账号记录
      {
        id: "del1",
        date: "2026-11-20",
        textType: "local",
        textOtherName: "历史已删号视频",
        bt: "历史已删号视频",
        selectedFile: "del.mp4",
        pt: "抖音",
        phone: "已删老组-小号",
        partition: "persist:小号抖音",
        publishStatus: "success",
        publishSuccessCount: 1,
      },
    ],
  };
  const diskSnapshotBefore = JSON.stringify(rawPushData);

  const storage = createMemoryStorage();
  const { state } = loadVideoManager({
    localStorage: storage,
    dataRequest: async (req) => {
      if (req.fileName === "pushData" && req.type === "get") {
        return { success: true, data: JSON.parse(JSON.stringify(rawPushData)) };
      }
      if (req.fileName === "account" && req.type === "get") {
        return { success: true, data: { "2026-11-01": renamedAccounts } };
      }
      return { success: true, data: {} };
    },
  });

  await state.loadRecords();

  // 磁盘源数据未被改写
  assert.equal(JSON.stringify(rawPushData), diskSnapshotBefore);

  // 2026-11-26：同一视频合并为 2 张卡（人间善恶录 4 平台合一，赛博老司机独立 1 卡）
  const day26 = state.dataList["2026-11-26"];
  assert.equal(day26.length, 2, "同日同视频不同分组应拆为 2 张卡");
  const rjselCard = day26.find((c) => state.getRowDisplayGroup(c) === "人间善恶录");
  const sblsjCard = day26.find((c) => state.getRowDisplayGroup(c) === "赛博老司机");
  assert.ok(rjselCard, "应有人间善恶录合并卡");
  assert.ok(sblsjCard, "应有赛博老司机独立卡");
  assert.deepStrictEqual(
    plain(rjselCard.showAlltype.map((s) => s.pt)),
    ["百家号", "视频号", "抖音", "快手"],
    "同分组不同 accountKey 的 4 条记录应合并进同一张卡"
  );
  assert.deepStrictEqual(
    plain(sblsjCard.showAlltype.map((s) => s.pt)),
    ["抖音"]
  );
  // 每个平台仅一个账号时，子行不额外展示账号名
  for (const sub of rjselCard.showAlltype) {
    assert.equal(state.getSubAccountLabel(rjselCard, sub), "");
    assert.equal(sub.displayGroup, undefined, "子记录不应写入展示字段");
  }
  // 原账号级身份字段原样保留
  assert.equal(rjselCard.showAlltype[0].phone, "人间善恶录");
  assert.equal(rjselCard.showAlltype[0].partition, "persist:人间善恶录百家号");
  assert.equal(rjselCard.showAlltype[2].phone, "人间善恶录-赛博张师傅");
  assert.equal(rjselCard.showAlltype[2].accountKey, "赛博张师傅");
  assert.equal(rjselCard.showAlltype[2].partition, "persist:赛博张师傅抖音");

  // 2026-11-20：改名前旧记录合并并显示新分组名「人间善恶录」，已删账号回退 phone 前缀「已删老组」
  const day20 = state.dataList["2026-11-20"];
  assert.equal(day20.length, 2);
  const oldMerged = day20.find((c) => c.textOtherName === "改名前老视频");
  const delCard = day20.find((c) => c.textOtherName === "历史已删号视频");
  assert.equal(state.getRowDisplayGroup(oldMerged), "人间善恶录");
  assert.deepStrictEqual(
    plain(oldMerged.showAlltype.map((s) => s.pt)),
    ["抖音", "快手"]
  );
  assert.equal(state.getRowDisplayGroup(delCard), "已删老组");

  /* ========================================================================
   * 4. 分组筛选 + accountGroupOrder 排序 + localStorage 持久化与异常兜底
   * ====================================================================== */
  // groupOrder: 赛博老司机=0, 人间善恶录=1 → 必须按 accountGroupOrder 排序
  assert.deepStrictEqual(plain(state.groupFilterOptions), ["赛博老司机", "人间善恶录"]);

  // 选择「人间善恶录」→ 持久化到 localStorage 且过滤掉「赛博老司机」和「已删老组」
  state.onGroupFilterChange("人间善恶录");
  assert.equal(storage.getItem("videoManager:selectedGroup"), "人间善恶录");
  assert.equal(state.filteredDataList["2026-11-26"].length, 1);
  assert.equal(
    state.getRowDisplayGroup(state.filteredDataList["2026-11-26"][0]),
    "人间善恶录"
  );
  assert.equal(state.filteredDataList["2026-11-20"].length, 1);
  assert.equal(state.filteredDataList["2026-11-20"][0].textOtherName, "改名前老视频");

  // 选择「赛博老司机」→ 无记录的 2026-11-20 日期卡不显示
  state.onGroupFilterChange("赛博老司机");
  assert.equal(storage.getItem("videoManager:selectedGroup"), "赛博老司机");
  assert.deepStrictEqual(plain(Object.keys(state.filteredDataList)), ["2026-11-26"]);
  assert.equal(state.filteredDataList["2026-11-26"].length, 1);
  assert.equal(
    state.getRowDisplayGroup(state.filteredDataList["2026-11-26"][0]),
    "赛博老司机"
  );

  // 切回「全部」
  state.onGroupFilterChange("all");
  assert.equal(state.filteredDataList["2026-11-26"].length, 2);
  assert.equal(state.filteredDataList["2026-11-20"].length, 2);

  // 重新实例化组件：恢复 localStorage 中已选分组
  storage.setItem("videoManager:selectedGroup", "人间善恶录");
  const { state: restoredVm } = loadVideoManager({
    localStorage: storage,
    dataRequest: async (req) => {
      if (req.fileName === "account") {
        return { success: true, data: { "2026-11-01": renamedAccounts } };
      }
      return { success: true, data: JSON.parse(JSON.stringify(rawPushData)) };
    },
  });
  assert.equal(restoredVm.selectedGroup, "人间善恶录");
  await restoredVm.loadRecords();
  assert.equal(restoredVm.selectedGroup, "人间善恶录", "有效分组名应保持选中");

  // 改名前遗留在 localStorage 的旧分组名「赛博张师傅」→ 自动回落「全部」避免空屏
  const staleStorage = createMemoryStorage({
    "videoManager:selectedGroup": "赛博张师傅",
  });
  const { state: staleVm } = loadVideoManager({
    localStorage: staleStorage,
    dataRequest: async (req) => {
      if (req.fileName === "account") {
        return { success: true, data: { "2026-11-01": renamedAccounts } };
      }
      return { success: true, data: JSON.parse(JSON.stringify(rawPushData)) };
    },
  });
  assert.equal(staleVm.selectedGroup, "赛博张师傅");
  await staleVm.loadRecords();
  assert.equal(staleVm.selectedGroup, "all", "失效旧分组名应自动回落为全部");
  assert.equal(staleStorage.getItem("videoManager:selectedGroup"), "all");

  // localStorage 抛错（try/catch）不应崩溃
  const brokenStorage = createMemoryStorage({}, { throwOnGet: true, throwOnSet: true });
  const { state: safeVm } = loadVideoManager({ localStorage: brokenStorage });
  assert.equal(safeVm.selectedGroup, "all");
  assert.doesNotThrow(() => safeVm.onGroupFilterChange("人间善恶录"));
  assert.equal(safeVm.selectedGroup, "人间善恶录");
  assert.deepStrictEqual(plain(safeVm.loadAccountsFromStorage()), {
    accounts: [],
    groupOrderMap: {},
  });

  /* ========================================================================
   * 5. 同分组同平台多账号：子行显示账号名区分
   * ====================================================================== */
  const multiAccounts = [
    ...renamedAccounts,
    {
      id: "a6",
      pt: "抖音",
      group: "人间善恶录",
      phone: "人间善恶录-张师傅二号",
      accountName: "张师傅二号",
      accountKey: "张师傅二号",
      groupOrder: 1,
    },
  ];
  const multiPushData = {
    "2026-11-26": [
      {
        id: "m1",
        date: "2026-11-26",
        textType: "local",
        textOtherName: "多号测试视频",
        bt: "多号测试视频",
        selectedFile: "multi.mp4",
        pt: "抖音",
        phone: "人间善恶录-赛博张师傅",
        group: "人间善恶录",
        accountName: "赛博张师傅",
        accountKey: "赛博张师傅",
        partition: "persist:赛博张师傅抖音",
        publishStatus: "success",
      },
      {
        id: "m2",
        date: "2026-11-26",
        textType: "local",
        textOtherName: "多号测试视频",
        bt: "多号测试视频",
        selectedFile: "multi.mp4",
        pt: "抖音",
        phone: "人间善恶录-张师傅二号",
        group: "人间善恶录",
        accountName: "张师傅二号",
        accountKey: "张师傅二号",
        partition: "persist:张师傅二号抖音",
        publishStatus: "failed",
      },
      {
        id: "m3",
        date: "2026-11-26",
        textType: "local",
        textOtherName: "多号测试视频",
        bt: "多号测试视频",
        selectedFile: "multi.mp4",
        pt: "百家号",
        phone: "人间善恶录",
        group: "人间善恶录",
        accountName: "人间善恶录",
        accountKey: "人间善恶录",
        partition: "persist:人间善恶录百家号",
        publishStatus: "success",
      },
      // 仅发给二号的单条视频（但同分组同平台当前有 2 个抖音号，也应标明账号名）
      {
        id: "m4",
        date: "2026-11-26",
        textType: "local",
        textOtherName: "仅发二号视频",
        bt: "仅发二号视频",
        selectedFile: "only2.mp4",
        pt: "抖音",
        phone: "人间善恶录-张师傅二号",
        group: "人间善恶录",
        accountName: "张师傅二号",
        accountKey: "张师傅二号",
        partition: "persist:张师傅二号抖音",
        publishStatus: "success",
      },
    ],
  };

  const { state: multiVm } = loadVideoManager({
    localStorage: createMemoryStorage(),
    dataRequest: async (req) => {
      if (req.fileName === "account") {
        return { success: true, data: { "2026-11-01": multiAccounts } };
      }
      return { success: true, data: JSON.parse(JSON.stringify(multiPushData)) };
    },
  });
  await multiVm.loadRecords();
  const multiCard = multiVm.dataList["2026-11-26"].find(
    (c) => c.textOtherName === "多号测试视频"
  );
  assert.equal(multiCard.showAlltype.length, 3, "同组多账号抖音 + 百家号应合并为 1 卡");
  assert.equal(multiVm.getSubAccountLabel(multiCard, multiCard.showAlltype[0]), "赛博张师傅");
  assert.equal(multiVm.getSubAccountLabel(multiCard, multiCard.showAlltype[1]), "张师傅二号");
  assert.equal(multiVm.getSubAccountLabel(multiCard, multiCard.showAlltype[2]), "", "百家号仅单账号不显示后缀");

  const only2Card = multiVm.dataList["2026-11-26"].find(
    (c) => c.textOtherName === "仅发二号视频"
  );
  assert.equal(
    multiVm.getSubAccountLabel(only2Card, only2Card.showAlltype[0]),
    "张师傅二号",
    "当前分组同平台存在多账号时，单条发布也应显示账号名区分"
  );

  // 即使后续删掉其中一个抖音账号，历史卡片里已有 2 个抖音子行时仍显示账号名区分
  multiVm.currentAccounts = renamedAccounts;
  assert.equal(multiVm.getSubAccountLabel(multiCard, multiCard.showAlltype[0]), "赛博张师傅");
  assert.equal(multiVm.getSubAccountLabel(multiCard, multiCard.showAlltype[1]), "张师傅二号");

  /* ========================================================================
   * 6. 不改账号级身份：进度回写 / 获取状态 / 重发 / 筛选态删除 / 导出
   * ====================================================================== */
  const updates = [];
  const deletes = [];
  const exported = [];
  const matchCalls = [];
  let republishPayload = null;

  const { state: opsVm } = loadVideoManager({
    localStorage: createMemoryStorage(),
    dataRequest: async (req) => {
      if (req.fileName === "pushData" && req.type === "get") {
        return { success: true, data: JSON.parse(JSON.stringify(rawPushData)) };
      }
      if (req.fileName === "account" && req.type === "get") {
        return { success: true, data: { "2026-11-01": renamedAccounts } };
      }
      if (req.fileName === "pushData" && req.type === "update") {
        updates.push(req.item);
        return { success: true };
      }
      if (req.fileName === "pushData" && req.type === "delete") {
        deletes.push(req.item);
        return { success: true };
      }
      return { success: true, data: {} };
    },
    ipcRenderer: {
      invoke: async (channel, arg) => {
        if (channel === "stats:match-works") {
          matchCalls.push(arg);
          return {
            matches: { 0: { found: true, url: "https://example.com/v/1" } },
            errors: [],
          };
        }
        if (channel === "fs:existsSync") return true;
        if (channel === "publish:export-history") {
          exported.push(arg.csv);
          return { ok: true };
        }
        return {};
      },
      on: () => {},
      removeListener: () => {},
    },
  });
  opsVm.$refs = {
    localPublishRef: {
      openRepublish(payload) {
        republishPayload = payload;
        return true;
      },
    },
  };

  await opsVm.loadRecords();

  // 6a. 筛选到「赛博老司机」时，syncPublishProgress 仍能命中「人间善恶录」合并卡里的抖音子记录
  opsVm.onGroupFilterChange("赛博老司机");
  const foundRec = opsVm.findLocalPublishRecord({
    textType: "local",
    textOtherName: "济公断箱子吞了养老钱",
    selectedFile: "jigong.mp4",
    pt: "抖音",
    partition: "persist:赛博张师傅抖音",
    accountKey: "赛博张师傅",
  });
  assert.ok(foundRec && foundRec.row && foundRec.row.id === "p3", "筛选态下回写匹配必须按账号级命中 p3");

  await opsVm.syncPublishProgress({
    textType: "local",
    textOtherName: "济公断箱子吞了养老钱",
    selectedFile: "jigong.mp4",
    pt: "抖音",
    partition: "persist:赛博张师傅抖音",
    accountKey: "赛博张师傅",
    status: true,
    message: "发布成功",
  });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, "p3");
  assert.equal(updates[0].publishStatus, "success");

  // 6b. handleGetStatus 按账号级 partition 匹配，且不把 displayGroup 落盘
  updates.length = 0;
  const mergedForStatus = opsVm.dataList["2026-11-26"].find(
    (c) => opsVm.getRowDisplayGroup(c) === "人间善恶录"
  );
  await opsVm.handleGetStatus(mergedForStatus);
  assert.equal(matchCalls.length, 1);
  // 只有未拿到 videoLink 的记录参与匹配，且每条带各自账号的 partition
  const partitionsSent = matchCalls[0].tasks.map((t) => t.partition);
  assert.ok(partitionsSent.includes("persist:人间善恶录百家号"));
  assert.ok(partitionsSent.includes("persist:赛博张师傅抖音"));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].displayGroup, undefined, "落盘更新不得污染 displayGroup");

  // 6c. handleRepublish 在合并卡上保留各自 partition/accountKey/id
  await opsVm.handleRepublish(mergedForStatus);
  assert.ok(republishPayload);
  assert.equal(republishPayload.records.length, 4);
  assert.deepStrictEqual(
    plain(
      republishPayload.failedTargets.map((t) => ({
        pt: t.pt,
        partition: t.partition,
        accountKey: t.accountKey,
      }))
    ),
    [
      {
        pt: "视频号",
        partition: "persist:赛博张师傅视频号",
        accountKey: "赛博张师傅",
      },
    ]
  );

  // 6d. 导出当前记录：筛选「赛博老司机」时只导出该组记录且 phone 字段原样保留
  opsVm.onGroupFilterChange("赛博老司机");
  await opsVm.exportHistory();
  assert.equal(exported.length, 1);
  assert.ok(exported[0].includes('"赛博老司机"'));
  assert.ok(!exported[0].includes('"人间善恶录"'));

  // 6e. 筛选态下删除：filteredDataList 中 index=0，但在 dataList 中可能是另一位置，不能误删其他分组
  // 注意 initDataFiltered 内 reverse() 后 dataList["2026-11-26"] 为 [赛博老司机, 人间善恶录]；
  // 筛选「人间善恶录」使 filtered 索引 0 != dataList 索引 1，专门测试错位删除场景！
  opsVm.onGroupFilterChange("人间善恶录");
  const filteredDay26 = opsVm.filteredDataList["2026-11-26"];
  assert.equal(filteredDay26.length, 1);
  const targetRow = filteredDay26[0];
  assert.equal(opsVm.getRowDisplayGroup(targetRow), "人间善恶录");
  assert.notEqual(
    opsVm.dataList["2026-11-26"].indexOf(targetRow),
    0,
    "应构造筛选索引(0)与原数组索引不同的场景"
  );
  opsVm.handleDelete(targetRow, "2026-11-26", 0);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(
    plain(deletes.map((d) => d.id)),
    ["p1", "p2", "p3", "p4"],
    "删除合并卡应按子记录 id 删除该卡全部 4 条账号记录"
  );
  assert.equal(opsVm.dataList["2026-11-26"].length, 1);
  assert.equal(
    opsVm.getRowDisplayGroup(opsVm.dataList["2026-11-26"][0]),
    "赛博老司机",
    "其他分组记录必须完好无损"
  );

  /* ========================================================================
   * 7. 回归：仅一个分组且无改名时，显示与合并结果与改前完全一致
   * ====================================================================== */
  const singleGroupAccounts = [
    { id: "s1", pt: "抖音", phone: "宠物", group: "宠物", accountName: "宠物", accountKey: "宠物" },
    { id: "s2", pt: "快手", phone: "宠物", group: "宠物", accountName: "宠物", accountKey: "宠物" },
    { id: "s3", pt: "视频号", phone: "宠物", group: "宠物", accountName: "宠物", accountKey: "宠物" },
  ];
  const singleGroupPush = {
    "2026-11-25": [
      {
        id: "r1",
        date: "2026-11-25",
        textType: "local",
        textOtherName: "猫咪日常1",
        bt: "猫咪日常1",
        selectedFile: "cat1.mp4",
        pt: "抖音",
        phone: "宠物",
        publishStatus: "success",
      },
      {
        id: "r2",
        date: "2026-11-25",
        textType: "local",
        textOtherName: "猫咪日常1",
        bt: "猫咪日常1",
        selectedFile: "cat1.mp4",
        pt: "快手",
        phone: "宠物",
        publishStatus: "success",
      },
      {
        id: "r3",
        date: "2026-11-25",
        textType: "local",
        textOtherName: "猫咪日常1",
        bt: "猫咪日常1",
        selectedFile: "cat1.mp4",
        pt: "视频号",
        phone: "宠物",
        publishStatus: "success",
      },
      {
        id: "r4",
        date: "2026-11-25",
        textType: "local",
        textOtherName: "猫咪日常2",
        bt: "猫咪日常2",
        selectedFile: "cat2.mp4",
        pt: "抖音",
        phone: "宠物",
        publishStatus: "success",
      },
    ],
  };

  const { state: regVm } = loadVideoManager({
    localStorage: createMemoryStorage(),
    dataRequest: async (req) => {
      if (req.fileName === "account") {
        return { success: true, data: { "2026-06-16": singleGroupAccounts } };
      }
      return { success: true, data: JSON.parse(JSON.stringify(singleGroupPush)) };
    },
  });
  await regVm.loadRecords();
  assert.deepStrictEqual(plain(regVm.groupFilterOptions), ["宠物"]);
  const regDay = regVm.filteredDataList["2026-11-25"];
  assert.equal(regDay.length, 2, "同日两个视频保持 2 张卡");
  // reverse() 顺序：猫咪日常2 在前，猫咪日常1 在后
  assert.equal(regDay[0].textOtherName, "猫咪日常2");
  assert.equal(regDay[1].textOtherName, "猫咪日常1");
  assert.equal(regVm.getRowDisplayGroup(regDay[0]), "宠物");
  assert.equal(regVm.getRowDisplayGroup(regDay[1]), "宠物");
  assert.deepStrictEqual(
    plain(regDay[1].showAlltype.map((s) => s.pt)),
    ["抖音", "快手", "视频号"]
  );
  for (const card of regDay) {
    for (const sub of card.showAlltype) {
      assert.equal(regVm.getSubAccountLabel(card, sub), "", "单分组单账号不显示账号名后缀");
    }
  }

  console.log("test-video-manager-group: 全部通过");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
