"use strict";

/**
 * 账号身份（新分组模型）纯函数回归：
 *   - 老数据（phone 字符串 / 缺新字段的记录）分区与登录 flag 名必须与历史规则逐字节一致
 *   - 新字段（group / accountName / accountKey）取值与清洗规则
 *   - 迁移补字段幂等，且不改变存量 partition
 *   - 分组排序键按 group 聚合（同一分组多账号归同一键）
 * 运行：node scripts/test-account-identity.js
 */

const assert = require("assert");
const {
  legacyPhoneGroup,
  sanitizeAccountKey,
  deriveAccountKeyFromName,
  recordGroupOf,
  recordAccountNameOf,
  recordAccountKeyOf,
  buildAccountPartitionOf,
  accountLoginFlagNameOf,
  buildCompatPhone,
  normalizeAccountRecordFields,
  resolveRecordGroup,
  resolveRecordAccountName,
} = require("../src/shared/accountIdentity.js");
const {
  buildGroupOrderMap,
} = require("../src/shared/accountGroupOrder.js");

/* ── 老数据兼容：分区必须与历史规则一致 ── */
assert.strictEqual(buildAccountPartitionOf("宠物", "抖音"), "persist:宠物抖音");
assert.strictEqual(
  buildAccountPartitionOf({ phone: "主号组-皇汉科技AI" }, "抖音"),
  "persist:主号组抖音"
);
assert.strictEqual(
  accountLoginFlagNameOf({ phone: "主号组-皇汉科技AI" }, "视频号"),
  "主号组视频号登录"
);
assert.strictEqual(accountLoginFlagNameOf("宠物", "哔哩哔哩"), "宠物哔哩哔哩登录");

/* ── 新字段取值 ── */
const rec = {
  phone: "宠物-旺财",
  group: "宠物",
  accountName: "旺财",
  accountKey: "旺财",
};
assert.strictEqual(recordGroupOf(rec), "宠物");
assert.strictEqual(recordAccountNameOf(rec), "旺财");
assert.strictEqual(recordAccountKeyOf(rec), "旺财");
assert.strictEqual(buildAccountPartitionOf(rec, "抖音"), "persist:旺财抖音");
assert.strictEqual(buildCompatPhone(rec), "宠物-旺财");
// 账号名与分组同名时 phone 不带后缀（与历史形态一致）
assert.strictEqual(
  buildCompatPhone({ group: "宠物", accountName: "宠物" }),
  "宠物"
);

/* ── 键清洗：partition 键不允许出现 "-" 与空白 ── */
assert.strictEqual(sanitizeAccountKey("旺 财-B"), "旺财B");
assert.strictEqual(deriveAccountKeyFromName("a-b c"), "abc");
assert.strictEqual(sanitizeAccountKey(""), "");

/* ── 迁移：补齐新字段，partition 不变，幂等 ── */
const legacyRow = { phone: "主号组-皇汉科技AI", pt: "抖音", id: "1" };
assert.strictEqual(normalizeAccountRecordFields(legacyRow), true);
assert.deepStrictEqual(
  {
    group: legacyRow.group,
    accountName: legacyRow.accountName,
    accountKey: legacyRow.accountKey,
  },
  { group: "主号组", accountName: "皇汉科技AI", accountKey: "主号组" }
);
// 关键约束：迁移后分区与迁移前历史规则完全一致（登录态不迁移）
assert.strictEqual(
  buildAccountPartitionOf(legacyRow, "抖音"),
  "persist:主号组抖音"
);
const before = JSON.stringify(legacyRow);
assert.strictEqual(normalizeAccountRecordFields(legacyRow), false);
assert.strictEqual(JSON.stringify(legacyRow), before);

const plainRow = { phone: "宠物", pt: "视频号", id: "2" };
normalizeAccountRecordFields(plainRow);
assert.strictEqual(plainRow.group, "宠物");
assert.strictEqual(plainRow.accountName, "宠物");
assert.strictEqual(plainRow.accountKey, "宠物");
assert.strictEqual(
  buildAccountPartitionOf(plainRow, "视频号"),
  "persist:宠物视频号"
);

/* ── 分组排序键：同一分组的所有账号（含同平台多账号）归同一键 ── */
const rawAccountData = {
  "2026-06-16": [
    { phone: "宠物-旺财", group: "宠物", accountKey: "旺财", groupOrder: 0 },
    { phone: "宠物-旺财2", group: "宠物", accountKey: "旺财2", groupOrder: 0 },
    { phone: "喵呼", group: "喵呼", accountKey: "喵呼", groupOrder: 1 },
  ],
};
const orderMap = buildGroupOrderMap(rawAccountData);
assert.deepStrictEqual(orderMap, { 宠物: 0, 喵呼: 1 });

/* ── 缺 phone 的记录安全返回空 ── */
assert.strictEqual(recordGroupOf(null), "");
assert.strictEqual(recordAccountKeyOf(undefined), "");
assert.strictEqual(buildAccountPartitionOf({}, "抖音"), "persist:抖音");

/* ── resolveRecordGroup / resolveRecordAccountName（S20） ── */
const currentAccounts = [
  {
    id: "acc-dy",
    pt: "抖音",
    group: "人间善恶录",
    phone: "人间善恶录-赛博张师傅",
    accountName: "赛博张师傅",
    accountKey: "赛博张师傅",
  },
  {
    id: "acc-ks",
    pt: "快手",
    group: "人间善恶录",
    phone: "人间善恶录-赛博张师傅",
    accountName: "赛博张师傅",
    accountKey: "赛博张师傅",
  },
  {
    id: "acc-bjh",
    pt: "百家号",
    group: "人间善恶录",
    phone: "人间善恶录",
    accountName: "人间善恶录",
    accountKey: "人间善恶录",
  },
  {
    id: "acc-sblsj",
    pt: "抖音",
    group: "赛博老司机",
    phone: "赛博老司机",
    accountName: "赛博老司机",
    accountKey: "赛博老司机",
  },
];

// 1. 改名前旧记录（仍记录旧分组名赛博张师傅）命中当前账号 → 返回新分组名
assert.strictEqual(
  resolveRecordGroup(
    {
      pt: "抖音",
      phone: "赛博张师傅",
      group: "赛博张师傅",
      accountKey: "赛博张师傅",
      partition: "persist:赛博张师傅抖音",
    },
    currentAccounts
  ),
  "人间善恶录"
);
// 极早期旧记录（缺 group / accountKey / partition，仅 phone + pt）→ 仍命中新分组名
assert.strictEqual(
  resolveRecordGroup({ pt: "快手", phone: "赛博张师傅" }, currentAccounts),
  "人间善恶录"
);
// 缺 partition / pt 时按 accountKey 兜底命中当前账号
assert.strictEqual(
  resolveRecordGroup(
    { phone: "赛博张师傅", accountKey: "赛博张师傅" },
    currentAccounts
  ),
  "人间善恶录"
);
// 改名后记录与同组不同 accountKey 的百家号均解析到同一分组名
assert.strictEqual(
  resolveRecordGroup(
    {
      pt: "抖音",
      phone: "人间善恶录-赛博张师傅",
      group: "人间善恶录",
      accountKey: "赛博张师傅",
      partition: "persist:赛博张师傅抖音",
    },
    currentAccounts
  ),
  "人间善恶录"
);
assert.strictEqual(
  resolveRecordGroup(
    {
      pt: "百家号",
      phone: "人间善恶录",
      group: "人间善恶录",
      accountKey: "人间善恶录",
      partition: "persist:人间善恶录百家号",
    },
    currentAccounts
  ),
  "人间善恶录"
);

// 2. 账号已删 → 回退 recordGroupOf（group 优先，再回退 phone "-" 前缀）
assert.strictEqual(
  resolveRecordGroup(
    {
      pt: "抖音",
      phone: "老分组-已删号",
      group: "历史分组",
      accountKey: "已删号",
      partition: "persist:已删号抖音",
    },
    currentAccounts
  ),
  "历史分组"
);
assert.strictEqual(
  resolveRecordGroup(
    {
      pt: "抖音",
      phone: "已删组-小号",
      partition: "persist:已删组抖音",
    },
    currentAccounts
  ),
  "已删组"
);
assert.strictEqual(
  resolveRecordGroup({ pt: "抖音", phone: "纯旧组" }, currentAccounts),
  "纯旧组"
);
// 已删账号带明确 partition，即使 phone 前缀与现存其他账号撞名也不误命中
assert.strictEqual(
  resolveRecordGroup(
    {
      pt: "抖音",
      phone: "赛博老司机-已删二号",
      partition: "persist:已删二号抖音",
    },
    currentAccounts
  ),
  "赛博老司机"
);
assert.strictEqual(
  resolveRecordGroup(
    {
      pt: "抖音",
      phone: "赛博张师傅-已删分身",
      partition: "persist:已删分身抖音",
    },
    currentAccounts
  ),
  "赛博张师傅"
);
// 平台不匹配不误命中（当前列表无该 accountKey 的哔哩哔哩账号）
assert.strictEqual(
  resolveRecordGroup(
    {
      pt: "哔哩哔哩",
      phone: "旧组",
      group: "旧组",
      accountKey: "赛博张师傅",
      partition: "persist:赛博张师傅哔哩哔哩",
    },
    currentAccounts
  ),
  "旧组"
);

// 3. 跨分组共享登录态账号：保留记录原本所属的有效分组
const sharedAccounts = [
  { pt: "抖音", group: "A组", phone: "A组-旺财", accountName: "旺财", accountKey: "旺财" },
  { pt: "抖音", group: "B组", phone: "B组-旺财", accountName: "旺财", accountKey: "旺财" },
];
assert.strictEqual(
  resolveRecordGroup(
    { pt: "抖音", group: "B组", phone: "B组-旺财", accountKey: "旺财", partition: "persist:旺财抖音" },
    sharedAccounts
  ),
  "B组"
);

// 4. 容忍 accountTree 结构与空/字符串入参
assert.strictEqual(
  resolveRecordGroup(
    { pt: "抖音", phone: "赛博张师傅", partition: "persist:赛博张师傅抖音" },
    {
      人间善恶录: {
        children: [{ meta: currentAccounts[0] }],
      },
    }
  ),
  "人间善恶录"
);
assert.strictEqual(resolveRecordGroup(null, currentAccounts), "");
assert.strictEqual(resolveRecordGroup("旧组-备注", currentAccounts), "旧组");

// 5. resolveRecordAccountName
assert.strictEqual(
  resolveRecordAccountName(
    { pt: "抖音", phone: "赛博张师傅", partition: "persist:赛博张师傅抖音" },
    currentAccounts
  ),
  "赛博张师傅"
);
assert.strictEqual(
  resolveRecordAccountName(
    { pt: "抖音", phone: "已删组-老号", partition: "persist:老号抖音" },
    currentAccounts
  ),
  "老号"
);

console.log("test-account-identity: 全部通过");
