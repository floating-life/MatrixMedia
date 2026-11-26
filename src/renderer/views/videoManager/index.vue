<template>
  <div
    class="page-shell video-manager-page"
    @dragover.prevent
    @drop.prevent="onDropVideoFile"
  >
    <div class="page-header">
      <h1 class="page-title">视频管理</h1>
      <p class="page-desc">
        选择视频或目录发布，也可直接把视频文件拖到本页发布；查看本地发布记录与审核状态
      </p>
    </div>

    <div class="toolbar section-card el-card is-never-shadow">
      <div class="toolbar-inner">
        <div class="toolbar-left">
          <span class="toolbar-label">发布操作</span>
          <el-button type="primary" @click="selectVideoFile"
            >选择视频发布</el-button
          >
          <el-button type="primary" plain @click="openDirectoryPublish"
            >目录发布</el-button
          >
          <el-button type="success" @click="openArticlePublish"
            >发布文章</el-button
          >
          <el-button plain @click="publishSettingsVisible = true"
            >发布节流设置</el-button
          >
        </div>
        <div class="toolbar-right">
          <el-button plain :loading="exportingHistory" @click="exportHistory"
            >导出当前记录</el-button
          >
          <span class="toolbar-label">帮助</span>
          <el-button type="warning" plain @click="openFeatureWall"
            >问题与新需求</el-button
          >
          <el-button type="warning" plain @click="openQQGroup"
            >加入作者QQ群</el-button
          >
          <el-button type="danger" plain @click="openGitHubStar"
            >⭐ GitHub Star</el-button
          >
        </div>
      </div>
      <div class="toolbar-filter">
        <span class="toolbar-label">分组筛选</span>
        <el-select
          v-model="selectedGroup"
          size="small"
          class="group-filter-select"
          placeholder="全部分组"
          @change="onGroupFilterChange"
        >
          <el-option label="全部" value="all" />
          <el-option
            v-for="group in groupFilterOptions"
            :key="group"
            :label="group"
            :value="group"
          />
        </el-select>
      </div>
    </div>

    <LocalVideoPublish ref="localPublishRef" @published="loadRecords" />
    <LocalArticlePublish ref="articlePublishRef" @published="loadRecords" />

    <div class="info-box">
      <div
        v-if="selectedGroup !== 'all' && !hasVisibleRecords"
        class="section-card el-card is-never-shadow empty-filter-card"
      >
        分组「{{ selectedGroup }}」暂无发布记录
      </div>
      <template v-for="(item, index) in filteredDataList">
        <el-card
          v-if="item && item.length"
          :key="index"
          class="section-card record-card"
          shadow="never"
        >
          <div slot="header" class="card-header">
            <span class="date-label">{{ index }}</span>
            <span class="card-sub">本地发布记录</span>
          </div>
          <el-table :data="item" border style="width: 100%">
            <el-table-column prop="bt" label="标题" min-width="180" />
            <el-table-column prop="displayGroup" label="发布分组" min-width="120">
              <template slot-scope="scope">
                <span>{{ getRowDisplayGroup(scope.row) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="发布进度" min-width="320">
              <template slot-scope="scope">
                <div
                  v-for="(sub, si) in scope.row.showAlltype"
                  :key="si"
                  class="progress-row"
                >
                  <span class="pt-name"
                    >{{ sub.pt
                    }}<span
                      v-if="getSubAccountLabel(scope.row, sub)"
                      class="pt-account-name"
                      >（{{ getSubAccountLabel(scope.row, sub) }}）</span
                    ></span
                  >
                  <div class="progress-detail">
                    <span class="progress-count"
                      >重发 {{ normalizeCount(sub.republishCount) }} 次</span
                    >
                    <span class="progress-count success"
                      >成功 {{ normalizeCount(sub.publishSuccessCount) }}</span
                    >
                    <span
                      class="progress-count fail"
                      :class="{ 'fail-clickable': hasFailScreenshot(sub) }"
                      :title="
                        hasFailScreenshot(sub)
                          ? '点击查看发布失败时的页面截图'
                          : ''
                      "
                      @click="hasFailScreenshot(sub) && openFailScreenshot(scope.row, sub)"
                      >失败 {{ normalizeCount(sub.publishFailCount) }}</span
                    >
                    <span
                      v-if="normalizeCount(sub.publishAbnormalCount) > 0"
                      class="progress-count fail"
                      :class="{ 'fail-clickable': hasFailScreenshot(sub) }"
                      :title="
                        hasFailScreenshot(sub)
                          ? '点击查看发布异常时的页面截图'
                          : ''
                      "
                      @click="hasFailScreenshot(sub) && openFailScreenshot(scope.row, sub)"
                      >异常
                      {{ normalizeCount(sub.publishAbnormalCount) }}</span
                    >
                    <el-tag
                      size="mini"
                      :type="publishStatusType(sub.publishStatus)"
                      :title="sub.throttleReason || sub.lastPublishMessage || ''"
                      >{{ publishStatusText(sub.publishStatus) }}</el-tag
                    >
                    <el-tag
                      v-if="hasCreativeStatementDisplay(sub)"
                      size="mini"
                      type="info"
                      effect="plain"
                      >创作声明：{{ formatCreativeStatementBadge(sub) }}</el-tag
                    >
                    <el-tag
                      v-for="extraTag in getHistoryExtrasTags(sub)"
                      :key="extraTag.key"
                      size="mini"
                      :type="extraTag.tone"
                      effect="plain"
                      >{{ extraTag.label }}：{{ extraTag.value }}</el-tag
                    >
                    <span
                      v-if="sub.publishStatus === 'scheduled' && sub.scheduledPublishAtText"
                      class="progress-count"
                      :title="sub.throttleReason || sub.lastPublishMessage || ''"
                      >计划 {{ sub.scheduledPublishAtText }}</span
                    >
                  </div>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="260">
              <template slot-scope="scope">
                <el-button
                  v-if="canGetStatus(scope.row)"
                  type="primary"
                  size="mini"
                  class="mb8"
                  :loading="isStatusLoading(scope.row)"
                  :disabled="isStatusLoading(scope.row)"
                  @click="handleGetStatus(scope.row)"
                >
                  获取状态
                </el-button>
                <el-popconfirm
                  confirm-button-text="删除"
                  cancel-button-text="取消"
                  icon="el-icon-info"
                  icon-color="red"
                  title="确定删除这条记录吗？"
                  @confirm="handleDelete(scope.row, index, scope.$index)"
                >
                  <el-button slot="reference" type="danger" size="mini"
                    >删除</el-button
                  >
                </el-popconfirm>
                <el-button
                  v-if="canRepublish(scope.row)"
                  type="warning"
                  size="mini"
                  class="mb8"
                  @click="handleRepublish(scope.row)"
                >
                  重新发布
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </template>
    </div>

    <!-- 发布节流与默认创作声明设置弹窗 -->
    <el-dialog
      title="发布节流设置"
      :visible.sync="publishSettingsVisible"
      width="860px"
      append-to-body
      :close-on-click-modal="false"
    >
      <PublishThrottleSettingsCard
        v-if="publishSettingsVisible"
        @saved="publishSettingsVisible = false"
      />
    </el-dialog>

    <!-- 发布失败截图：点记录里的「失败 / 异常」次数打开 -->
    <el-dialog
      title="发布失败截图"
      :visible.sync="screenshotDialogVisible"
      width="72%"
      top="6vh"
      append-to-body
    >
      <div v-loading="screenshotLoading" class="shot-body">
        <div v-if="screenshotPath" class="shot-path">{{
          failScreenshotName(screenshotPath)
        }}</div>
        <img
          v-if="screenshotDataUrl"
          :src="screenshotDataUrl"
          class="shot-img"
          alt="发布失败截图"
        />
        <el-alert
          v-else-if="screenshotError && !screenshotLoading"
          :title="screenshotError"
          type="warning"
          :closable="false"
          show-icon
        />
        <div
          v-else-if="!screenshotLoading"
          class="shot-empty"
        >
          暂无截图
        </div>
      </div>
      <div slot="footer">
        <el-button size="mini" @click="openFailScreenshotExternally"
          >用系统看图打开</el-button
        >
        <el-button type="primary" size="mini" @click="screenshotDialogVisible = false"
          >关闭</el-button
        >
      </div>
    </el-dialog>

    <!-- 旧的 <webview> 登录弹窗已迁移到主进程独立 BrowserWindow -->
  </div>
</template>

<script>
import { ipcRenderer } from "electron";
import dataRequest from "@/utils/dataRequest";
import copyToClipboard from "@/utils/copy";
import ptConfig from "@/utils/configUrl";
import openLoginWindow from "@/utils/openLoginWindow";
import LocalVideoPublish from "@/components/LocalVideoPublish.vue";
import LocalArticlePublish from "@/components/LocalArticlePublish.vue";
import PublishThrottleSettingsCard from "@/components/PublishThrottleSettingsCard.vue";
import { normalizeVideoRecordMetadata } from "../../../shared/videoMetadata.js";
import {
  buildAccountPartitionOf,
  recordAccountKeyOf,
  recordGroupOf,
  resolveRecordGroup,
  resolveRecordAccountName,
} from "../../../shared/accountIdentity.js";
import {
  buildGroupOrderMap,
  compareGroups,
  normalizeGroupOrder,
} from "../../../shared/accountGroupOrder.js";
import { buildPublishHistoryCsv } from "../../../shared/publishHistoryCsv.js";
import {
  getCreativeStatementShortLabel,
  isCreativeStatementNone,
} from "../../../shared/creativeStatement.js";
import {
  buildHistoryExtrasDisplay,
  readTaskAiChapters,
  readTaskOriginalStatement,
} from "../../../shared/publishExtras.js";

const VIDEO_MANAGER_GROUP_STORAGE_KEY = "videoManager:selectedGroup";

function readStoredSelectedGroup() {
  try {
    if (typeof localStorage === "undefined" || !localStorage) return "all";
    const raw = localStorage.getItem(VIDEO_MANAGER_GROUP_STORAGE_KEY);
    if (typeof raw !== "string") return "all";
    const trimmed = raw.trim();
    return trimmed || "all";
  } catch (_) {
    return "all";
  }
}

function writeStoredSelectedGroup(value) {
  try {
    if (typeof localStorage === "undefined" || !localStorage) return;
    localStorage.setItem(
      VIDEO_MANAGER_GROUP_STORAGE_KEY,
      String(value || "all")
    );
  } catch (_) {}
}

function subAccountIdentityKey(item) {
  if (!item || typeof item !== "object") return "";
  const pt = String(item.pt || "").trim();
  const partition = String(item.partition || "").trim();
  if (partition) return partition;
  if (pt) return buildAccountPartitionOf(item, pt);
  return recordAccountKeyOf(item) || String(item.phone || "").trim();
}

function readRecordDySyncToutiao(record) {
  if (!record || typeof record !== "object") return undefined;
  if (
    record.publishOptions &&
    typeof record.publishOptions.dySyncToutiao === "boolean"
  ) {
    return record.publishOptions.dySyncToutiao;
  }
  if (typeof record.dySyncToutiao === "boolean") {
    return record.dySyncToutiao;
  }
  if (record.data && typeof record.data.dySyncToutiao === "boolean") {
    return record.data.dySyncToutiao;
  }
  return undefined;
}

function republishRecordIdentityKey(target) {
  const pt = String((target && target.pt) || "").trim();
  if (target && target.partition) {
    return `p__${String(target.partition)}`;
  }
  const acctKey =
    (target && target.accountKey) ||
    (typeof recordAccountKeyOf === "function"
      ? recordAccountKeyOf(target || {})
      : "") ||
    (target && target.phone) ||
    "";
  return `k__${String(acctKey)}__${pt}`;
}

function resolveRepublishDySyncToutiao(records = [], failedTargets = []) {
  const list = Array.isArray(records) ? records.filter(Boolean) : [];
  if (list.length === 0) return false;
  const dyRecords = list.filter((r) =>
    String((r && r.pt) || "").includes("抖音")
  );
  let candidates = dyRecords.length > 0 ? dyRecords : list;
  if (
    dyRecords.length > 0 &&
    Array.isArray(failedTargets) &&
    failedTargets.length > 0
  ) {
    const failedKeySet = new Set(
      failedTargets.map((t) => republishRecordIdentityKey(t))
    );
    const failedDy = dyRecords.filter((r) =>
      failedKeySet.has(republishRecordIdentityKey(r))
    );
    if (failedDy.length > 0) {
      candidates = failedDy;
    }
  }
  // 合并行里若有记录未开启同步（含缺字段），保守按 false：宁可漏同步，不误同步到头条
  return candidates.every((rec) => readRecordDySyncToutiao(rec) === true);
}

export default {
  name: "VideoManager",
  components: {
    LocalVideoPublish,
    LocalArticlePublish,
    PublishThrottleSettingsCard,
  },
  data() {
    return {
      // 抖音获取发布状态的class名称
      statusCalss: ".video-card-zQ02ng",
      ptConfig,
      dataList: {},
      selectedGroup: readStoredSelectedGroup(),
      currentAccounts: [],
      groupOrderMap: {},
      accountsLoaded: false,
      exportingHistory: false,
      publishSettingsVisible: false,
      taskHandlers: new Map(),
      statusLoadingMap: {},
      loginData: {},
      showLoginDialog: false,
      // 发布失败截图弹窗
      screenshotDialogVisible: false,
      screenshotLoading: false,
      screenshotDataUrl: "",
      screenshotError: "",
      screenshotPath: "",
    };
  },
  computed: {
    groupFilterOptions() {
      return this.getGroupFilterOptions();
    },
    filteredDataList() {
      return this.getFilteredDataList();
    },
    hasVisibleRecords() {
      return Object.keys(this.filteredDataList).length > 0;
    },
  },
  mounted() {
    this._onPuppeteerDone = (event, data) => {
      const { taskId } = data;
      const handler = this.taskHandlers.get(taskId);
      if (handler) {
        handler(data);
        this.taskHandlers.delete(taskId);
      } else {
        this.syncPublishProgress(data);
      }
    };
    ipcRenderer.on("puppeteerFile-done", this._onPuppeteerDone);
  },
  beforeDestroy() {
    ipcRenderer.removeListener("puppeteerFile-done", this._onPuppeteerDone);
  },
  activated() {
    this.loadRecords();
  },
  methods: {
    async exportHistory() {
      if (this.exportingHistory) return;
      const exportSource =
        typeof this.getFilteredDataList === "function"
          ? this.getFilteredDataList()
          : this.dataList;
      const { csv, recordCount } = buildPublishHistoryCsv(exportSource);
      if (!recordCount) {
        this.$message.info("当前没有可导出的发布记录");
        return;
      }
      this.exportingHistory = true;
      try {
        const result = await ipcRenderer.invoke("publish:export-history", { csv });
        if (result && result.ok) {
          this.$message.success(`已导出 ${recordCount} 条平台发布记录`);
        } else if (!result || !result.canceled) {
          this.$message.error((result && result.message) || "导出失败");
        }
      } catch (error) {
        this.$message.error("导出失败：" + error.message);
      } finally {
        this.exportingHistory = false;
      }
    },
    copy: copyToClipboard,
    getStatusRowKey(row) {
      if (!row) return "";
      // 合并卡按解析后的分组名隔离加载态，无 displayGroup 时回退登录主键
      return [
        row.textOtherName || "",
        row.displayGroup || recordAccountKeyOf(row),
        row.selectedFile || "",
      ].join("-");
    },
    isStatusLoading(row) {
      const key = this.getStatusRowKey(row);
      return !!this.statusLoadingMap[key];
    },
    async handleGetStatus(row) {
      if (!this.canGetStatus(row) || this.isStatusLoading(row)) return;
      const isJuejinArticle = (item) =>
        item && item.textType === "article" && item.pt === "掘金";
      // 只处理「还没拿到作品链接」或「状态仍是发布中」的记录：
      // 拉取该平台作品列表，按标题匹配命中即发布成功（#71：已有链接但状态
      // 卡在「发布中」的记录允许再次核对，否则手动补救路径不存在）
      const targets = (row.showAlltype || []).filter(
        (item) =>
          item &&
          (!item.videoLink || item.publishStatus === "publishing") &&
          (item.textType !== "article" || isJuejinArticle(item))
      );
      if (!targets.length) {
        this.$message.info("没有需要获取状态的记录");
        return;
      }
      const key = this.getStatusRowKey(row);
      this.$set(this.statusLoadingMap, key, true);
      try {
        const tasks = targets.map((item, idx) => ({
          key: String(idx),
          group: recordGroupOf(item),
          platform: item.pt,
          partition: buildAccountPartitionOf(item, item.pt),
          title: item.title || item.bt || item.textOtherName || "",
        }));
        const res = await ipcRenderer.invoke("stats:match-works", { tasks });
        const matches = (res && res.matches) || {};
        let okCount = 0;
        for (const [idx, m] of Object.entries(matches)) {
          if (!m || !m.found) continue;
          const item = targets[Number(idx)];
          if (!item) continue;
          const payload = JSON.parse(JSON.stringify(item));
          delete payload.showAlltype;
          // 视频号等平台无法构造作品直链时，用作品管理页兜底（与掘金逻辑一致）
          const fallbackUrl =
            this.ptConfig[item.pt] && this.ptConfig[item.pt].listIndex
              ? this.ptConfig[item.pt].listIndex
              : "";
          await dataRequest({
            type: "update",
            fileName: "pushData",
            item: {
              ...payload,
              status: true,
              videoLink: m.url || fallbackUrl,
              // 命中即发布成功：与 syncPublishProgress 成功分支对齐，
              // 否则标签渲染取 publishStatus 永远停在「发布中」（#71）
              publishStatus:
                item.publishMode === "draft" ? "draft" : "success",
              publishSuccessCount:
                this.normalizeCount(item.publishSuccessCount) + 1,
              lastPublishMessage: "已通过作品列表确认发布",
              lastPublishAt: Date.now(),
            },
          });
          okCount++;
        }
        const failCount = targets.length - okCount;
        const errors = (res && res.errors) || [];
        if (okCount > 0 && failCount === 0) {
          this.$message.success(`全部 ${okCount} 条记录已确认发布成功`);
        } else if (okCount > 0) {
          this.$message.warning(
            `${okCount} 条已确认发布成功，${failCount} 条未在作品列表中找到`
          );
        } else if (errors.length) {
          this.$message.error(
            "获取失败：" +
              errors.map((e) => `${e.group}·${e.platform} ${e.error}`).join("；")
          );
        } else {
          this.$message.warning(
            "作品列表中未找到对应视频，可能尚未发布成功或被平台删除"
          );
        }
        // 刷新发布记录
        const r = await dataRequest({ type: "get", fileName: "pushData" });
        this.initDataFiltered(r.data || {});
      } catch (err) {
        this.$message.error(
          "获取状态失败：" + (err && err.message ? err.message : err)
        );
      } finally {
        this.$set(this.statusLoadingMap, key, false);
      }
    },
    canGetStatus(row) {
      if (!row) return false;
      if (row.textType !== "article") return true;
      return (row.showAlltype || [row]).some(
        (item) => item && item.textType === "article" && item.pt === "掘金"
      );
    },
    normalizeCount(v) {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    },
    // ── 发布失败截图 ────────────────────────────────────────────
    // 主进程在平台 handler 失败、或「发布会话疑似没发出去」时截图，
    // 文件名随 donePayload.failScreenshot 返回。这里只负责落库 + 展示。
    pickFailScreenshot(payload, row) {
      const shot = payload && payload.failScreenshot;
      if (shot) return String(shot);
      return String((row && row.failScreenshot) || "");
    },
    hasFailScreenshot(row) {
      return !!this.getFailScreenshot(row);
    },
    /** 详情里的截图路径可能是「本子记录」或某个平台子记录，取第一个存在的 */
    getFailScreenshot(row) {
      if (!row) return "";
      if (row.failScreenshot) return String(row.failScreenshot);
      const hit = (row.showAlltype || row.details || []).find(
        (item) => item && item.failScreenshot
      );
      return hit ? String(hit.failScreenshot) : "";
    },
    failScreenshotName(filePath) {
      const segments = String(filePath || "").split(/[\\/]/);
      return segments[segments.length - 1] || "";
    },
    async openFailScreenshot(row, sub) {
      const filePath = this.getFailScreenshot(sub || row);
      if (!filePath) return;
      this.screenshotLoading = true;
      this.screenshotDialogVisible = true;
      this.screenshotPath = filePath;
      this.screenshotDataUrl = "";
      this.screenshotError = "";
      try {
        const result = await ipcRenderer.invoke(
          "publish:readFailScreenshot",
          filePath
        );
        if (result && result.ok) {
          this.screenshotDataUrl = result.dataUrl;
        } else {
          this.screenshotError =
            (result && result.message) || "读取失败截图失败";
        }
      } catch (e) {
        this.screenshotError = (e && e.message) || "读取失败截图失败";
      } finally {
        this.screenshotLoading = false;
      }
    },
    async openFailScreenshotExternally() {
      if (!this.screenshotPath) return;
      try {
        const ok = await ipcRenderer.invoke(
          "publish:openFailScreenshot",
          this.screenshotPath
        );
        if (!ok) this.$message.warning("截图文件不存在或已被自动清理");
      } catch (e) {
        this.$message.error("打开截图失败：" + ((e && e.message) || e));
      }
    },
    publishStatusType(status) {
      if (status === "success") return "success";
      if (
        status === "fail" ||
        status === "failed" ||
        status === "expired" ||
        status === "abnormal"
      )
        return "danger";
      if (status === "scheduled" || status === "skipped") return "info";
      if (status === "draft") return "info";
      // 登录失效要人工扫码才能恢复，用 danger 让它在列表里显眼（文案见 publishStatusText）
      if (status === "login_required") return "danger";
      return "warning";
    },
    publishStatusText(status) {
      if (status === "success") return "成功";
      if (status === "fail" || status === "failed") return "失败";
      if (status === "abnormal") return "发布异常";
      if (status === "scheduled") return "等待定时发布";
      if (status === "skipped") return "已跳过";
      if (status === "expired") return "任务过期";
      if (status === "draft") return "已保存草稿";
      if (status === "drafting") return "保存草稿中";
      if (status === "login_required") return "需重新登录";
      return "发布中";
    },
    hasCreativeStatementDisplay(sub) {
      return Boolean(sub && !isCreativeStatementNone(sub.creativeStatement));
    },
    formatCreativeStatementBadge(sub) {
      if (!sub) return "";
      return getCreativeStatementShortLabel(sub.creativeStatement, sub.pt);
    },
    getHistoryExtrasTags(sub) {
      return buildHistoryExtrasDisplay(sub);
    },
    isPublishFailed(row) {
      if (!row) return false;
      if (
        ["fail", "failed", "expired", "abnormal", "login_required"].includes(
          String(row.publishStatus || "")
        )
      )
        return true;
      if (
        Number(row.publishFailCount) > 0 &&
        Number(row.publishSuccessCount) === 0
      )
        return true;
      if (String(row.lastPublishMessage || "").includes("失败")) return true;
      if (String(row.lastPublishMessage || "").includes("过期")) return true;
      return false;
    },
    canRepublish(row) {
      return row && (row.textType === "local" || row.textType === "article");
    },
    async handleRepublish(row) {
      const details = (row && row.showAlltype) || [];
      if (!details.length) {
        this.$message.warning("当前记录没有可重发的平台");
        return;
      }
      if (row.textType === "article") {
        const sample = details[0] || {};
        // 新分组模型：重发目标按 partition / accountKey 标识（同分组同平台
        // 多账号时 phone 前缀不再唯一）
        const failedTargets = details.filter(this.isPublishFailed).map((v) => ({
          pt: v.pt,
          phone: v.phone,
          partition: v.partition,
          accountKey: recordAccountKeyOf(v),
        }));
        const ok = this.$refs.articlePublishRef.openRepublish({
          sample,
          records: details.map((v) => ({
            id: v.id,
            date: v.date,
            pt: v.pt,
            phone: v.phone,
            partition: v.partition,
            accountKey: recordAccountKeyOf(v),
            publishAttemptCount: Number(v.publishAttemptCount) || 1,
            republishCount: Number(v.republishCount),
          })),
          failedTargets,
        });
        if (!ok) return;
        if (failedTargets.length === 0) {
          this.$message.info(
            "未检测到失败平台，已打开发布弹窗，请手动勾选需要重发的平台。"
          );
        }
        return;
      }
      let filePath = details.map((v) => v && v.filePath).find(Boolean);
      const remoteFileUrl = details
        .map((v) => v && v.remoteFileUrl)
        .find(Boolean);
      const localFileExists =
        filePath && (await ipcRenderer.invoke("fs:existsSync", filePath));
      if (!filePath || (!localFileExists && !remoteFileUrl)) {
        if (!localFileExists && filePath) {
          this.$message.info("本地视频文件已不存在，请重新选择视频文件。");
        } else {
          this.$message.info("历史记录缺少视频路径，请先重新选择视频文件。");
        }
        filePath = await ipcRenderer.invoke("dialog:openVideoFile");
        if (!filePath) {
          this.$message.warning("未选择视频文件，已取消重发。");
          return;
        }
      } else if (!localFileExists && remoteFileUrl) {
        // 本地文件已删除但有远程 URL，先下载到本地再重发
        try {
          await this.$confirm(
            "本地视频文件已清理，是否从远程地址重新下载？",
            "重新发布",
            {
              confirmButtonText: "重新下载",
              cancelButtonText: "手动选择文件",
              distinguishCancelAndClose: true,
              type: "warning",
            }
          );
          const loading = this.$loading({
            lock: true,
            text: "正在下载远程视频…",
            background: "rgba(0, 0, 0, 0.7)",
          });
          try {
            filePath = await ipcRenderer.invoke(
              "publish:downloadRemoteFile",
              remoteFileUrl
            );
            this.$message.success("远程视频下载完成");
          } catch (dlErr) {
            this.$message.error(
              "远程视频下载失败: " + (dlErr.message || dlErr)
            );
            return;
          } finally {
            loading.close();
          }
        } catch (action) {
          if (action === "close") {
            this.$message.info("已取消重发。");
            return;
          }
          // 用户选择手动选择文件
          filePath = await ipcRenderer.invoke("dialog:openVideoFile");
          if (!filePath) {
            this.$message.warning("未选择视频文件，已取消重发。");
            return;
          }
        }
      } else {
        let shouldChooseNewVideo = false;
        try {
          await this.$confirm("是否重新选择视频文件后再重发？", "重新发布", {
            confirmButtonText: "重新选择视频",
            cancelButtonText: "沿用原视频",
            distinguishCancelAndClose: true,
            type: "warning",
          });
          shouldChooseNewVideo = true;
        } catch (action) {
          if (action === "close") {
            this.$message.info("已取消重发。");
            return;
          }
        }
        if (shouldChooseNewVideo) {
          const selectedPath = await ipcRenderer.invoke("dialog:openVideoFile");
          if (!selectedPath) {
            this.$message.warning("未选择视频文件，已取消重发。");
            return;
          }
          filePath = selectedPath;
        }
      }

      const sample = details[0] || {};
      const normalizedDetails = details.map((record) => ({
        record,
        metadata: normalizeVideoRecordMetadata(record),
      }));
      const description =
        normalizedDetails
          .map((item) => item.metadata.description)
          .find(Boolean) || "";
      const shortTitle =
        normalizedDetails
          .filter((item) => item.record.pt === "视频号")
          .map((item) => item.metadata.shortTitle)
          .find(Boolean) || "";
      const failedTargets = details.filter(this.isPublishFailed).map((v) => ({
        pt: v.pt,
        phone: v.phone,
        partition: v.partition,
        accountKey: recordAccountKeyOf(v),
      }));
      const dySyncToutiao = resolveRepublishDySyncToutiao(
        details,
        failedTargets
      );

      const ok = this.$refs.localPublishRef.openRepublish({
        filePath,
        textOtherName: sample.textOtherName || "",
        form: {
          title: sample.bookName || sample.textOtherName || "",
          bt1: sample.bt || "",
          description,
          shortTitle,
          tags: sample.tags || sample.bq || "",
          bq: sample.bq || "",
          creativeStatement: sample.creativeStatement,
          coverPath: sample.coverPath || "",
          noDownload: sample.noDownload === true,
          dySyncToutiao,
        },
        records: normalizedDetails.map(({ record, metadata }) => ({
          id: record.id,
          date: record.date,
          pt: record.pt,
          phone: record.phone,
          partition: record.partition,
          accountKey: recordAccountKeyOf(record),
          description: metadata.description,
          shortTitle: metadata.shortTitle,
          tags: metadata.tags,
          // 只透传同步头条 / AI章节 / 原创声明开关，不复制整份 publishOptions（避免重发时回填旧商品/合集）
          ...(typeof readRecordDySyncToutiao(record) === "boolean"
            ? { dySyncToutiao: readRecordDySyncToutiao(record) }
            : {}),
          ...(typeof readTaskAiChapters(record) === "boolean"
            ? { aiChapters: readTaskAiChapters(record) }
            : {}),
          ...(typeof readTaskOriginalStatement(record) === "boolean"
            ? { originalStatement: readTaskOriginalStatement(record) }
            : {}),
          // 透传分平台标题/简介覆盖，避免重发时百家号作品描述被「标题，简介」重拼
          ...(record.titleByPlatform && typeof record.titleByPlatform === "object"
            ? { titleByPlatform: record.titleByPlatform }
            : {}),
          ...(record.descByPlatform && typeof record.descByPlatform === "object"
            ? { descByPlatform: record.descByPlatform }
            : {}),
          ...(record.descOverrideApplied === true
            ? { descOverrideApplied: true }
            : {}),
          ...(record.platformRulesApplied &&
          typeof record.platformRulesApplied === "object"
            ? { platformRulesApplied: record.platformRulesApplied }
            : {}),
          publishAttemptCount: Number(record.publishAttemptCount) || 1,
          republishCount: Number(record.republishCount),
        })),
        failedTargets,
      });
      if (!ok) return;
      if (failedTargets.length === 0) {
        this.$message.info(
          "未检测到失败平台，已打开发布弹窗，请手动勾选需要重发的平台。"
        );
      }
    },
    getFileName(filePath) {
      if (!filePath) return "";
      const s = String(filePath).replace(/\\/g, "/");
      const arr = s.split("/");
      return arr[arr.length - 1] || "";
    },
    fillPublishStats(row) {
      const copyRow = { ...row };
      const attemptCount = Number(copyRow.publishAttemptCount) || 1;
      copyRow.publishAttemptCount = attemptCount;
      copyRow.republishCount = Number(copyRow.republishCount);
      if (
        !Number.isFinite(copyRow.republishCount) ||
        copyRow.republishCount < 0
      ) {
        copyRow.republishCount = Math.max(0, attemptCount - 1);
      }
      copyRow.publishSuccessCount = this.normalizeCount(
        copyRow.publishSuccessCount
      );
      copyRow.publishFailCount = this.normalizeCount(copyRow.publishFailCount);
      copyRow.publishAbnormalCount = this.normalizeCount(
        copyRow.publishAbnormalCount
      );
      copyRow.publishStatus = copyRow.publishStatus || "publishing";
      // 「发布中」超过 10 分钟未收敛的记录标记为待核对，不能无限挂着（#71）；
      // 只改展示层数据，底层记录仍可被「获取状态」重新确认
      if (
        copyRow.publishStatus === "publishing" &&
        copyRow.lastPublishAt &&
        Date.now() - Number(copyRow.lastPublishAt) > 10 * 60 * 1000
      ) {
        copyRow.publishStatus = "abnormal";
        copyRow.lastPublishMessage =
          copyRow.lastPublishMessage ||
          "发布状态超过 10 分钟未确认，请点「获取状态」人工核对";
      }
      return copyRow;
    },
    recordValue(value) {
      return String(value || "");
    },
    getRecordPhone(row) {
      // 记录身份键：accountKey（回退历史 phone "-" 前缀）
      return recordAccountKeyOf(row);
    },
    getArticleField(row, key) {
      if (!row) return "";
      if (row[key] !== undefined && row[key] !== null)
        return this.recordValue(row[key]);
      const data = row.data || {};
      return this.recordValue(data[key]);
    },
    getArticleTags(row) {
      if (!row) return "";
      const data = row.data || {};
      return this.recordValue(row.bq || row.tags || data.bq || data.tags);
    },
    buildArticleMergeKey(row) {
      return [
        this.recordValue(row && row.textOtherName),
        this.recordValue(row && row.textType),
        this.getRecordPhone(row),
        this.recordValue(row && row.partition),
        this.recordValue(row && row.selectedFile),
        this.getArticleField(row, "content"),
        this.getArticleField(row, "articleFilePath"),
        this.getArticleField(row, "coverPath"),
        this.getArticleField(row, "category"),
        this.getArticleTags(row),
        this.getArticleField(row, "summary"),
      ].join("\u0001");
    },
    isSameArticlePublishRecord(record, target) {
      return (
        this.buildArticleMergeKey(record) === this.buildArticleMergeKey(target)
      );
    },
    findLocalPublishRecord(donePayload) {
      const textType = donePayload.textType || "local";
      const textOtherName =
        donePayload.textOtherName ||
        (donePayload.data && donePayload.data.textOtherName) ||
        "";
      const selectedFile =
        donePayload.selectedFile || this.getFileName(donePayload.filePath);
      const pt = donePayload.pt;
      // 账号身份：partition 优先，回退 accountKey（再回退历史 phone 前缀）
      const payloadPartition = String(donePayload.partition || "");
      const payloadKey = recordAccountKeyOf(donePayload);
      const sameAccount = (sub) => {
        if (
          payloadPartition &&
          String(sub.partition || "") &&
          String(sub.partition) === payloadPartition
        ) {
          return true;
        }
        return recordAccountKeyOf(sub) === payloadKey;
      };
      const dateKeys = Object.keys(this.dataList || {});
      for (const dateKey of dateKeys) {
        const dayRows = this.dataList[dateKey] || [];
        for (const row of dayRows) {
          const details = row.showAlltype || [];
          for (const sub of details) {
            const subPhone = sameAccount(sub);
            if (textType === "article") {
              if (
                sub.textType === "article" &&
                sub.pt === pt &&
                this.isSameArticlePublishRecord(sub, donePayload)
              ) {
                return { date: dateKey, row: sub };
              }
              continue;
            }
            if (
              sub.textType === textType &&
              sub.pt === pt &&
              sub.textOtherName === textOtherName &&
              sub.selectedFile === selectedFile &&
              subPhone
            ) {
              return { date: dateKey, row: sub };
            }
          }
        }
      }
      return null;
    },
    async syncPublishProgress(donePayload) {
      if (!donePayload || !["local", "article"].includes(donePayload.textType))
        return;
      if (donePayload.interrupted) return;
      if (
        !donePayload.pt ||
        String(donePayload.pt).includes("状态") ||
        String(donePayload.pt).includes("登录")
      )
        return;
      const target = this.findLocalPublishRecord(donePayload);
      if (!target || !target.row || !target.row.id) {
        // 静默丢弃会导致记录永久停在「发布中」且无法排查（#71），打日志留痕
        console.warn(
          "[videoManager] 发布回执未匹配到本地记录，请核对标题/文件名/账号是否被改动:",
          JSON.stringify({
            pt: donePayload.pt,
            textType: donePayload.textType,
            textOtherName: donePayload.textOtherName,
            selectedFile:
              donePayload.selectedFile || this.getFileName(donePayload.filePath),
            partition: donePayload.partition,
            accountKey: recordAccountKeyOf(donePayload),
          })
        );
        return;
      }
      const row = this.fillPublishStats(target.row);
      if (donePayload.skipped) {
        await dataRequest({
          type: "update",
          fileName: "pushData",
          item: {
            id: row.id,
            date: target.date,
            publishStatus: "skipped",
            lastPublishMessage:
              donePayload.message || "用户关闭窗口，已跳过发布",
            lastPublishAt: Date.now(),
          },
        });
        this.loadRecords();
        return;
      }
      const success = !!donePayload.status;
      const isDraftMode =
        donePayload.publishMode === "draft" ||
        donePayload.publishToDraft === true;
      // 发布成功后平台会自动跳成功页；5 秒后地址没变说明疑似没发出去，
      // 主进程用 publishAbnormal 标记，这里单独记为「发布异常」而不是成功。
      const abnormal = success && donePayload.publishAbnormal === true;
      // 主进程在失败/异常瞬间截了发布页的图，这里存进记录，之后可以直接回看
      const failScreenshot = this.pickFailScreenshot(donePayload, row);
      const extrasStatusPatch = {
        ...(typeof donePayload.aiChaptersStatus === "string" &&
        donePayload.aiChaptersStatus
          ? { aiChaptersStatus: donePayload.aiChaptersStatus }
          : {}),
        ...(typeof donePayload.originalStatementStatus === "string" &&
        donePayload.originalStatementStatus
          ? { originalStatementStatus: donePayload.originalStatementStatus }
          : {}),
      };
      if (abnormal) {
        await dataRequest({
          type: "update",
          fileName: "pushData",
          item: {
            id: row.id,
            date: target.date,
            publishAbnormalCount:
              this.normalizeCount(row.publishAbnormalCount) + 1,
            publishStatus: "abnormal",
            ...extrasStatusPatch,
            ...(failScreenshot ? { failScreenshot } : {}),
            lastPublishMessage:
              donePayload.message ||
              "发布异常：点击发布后 5 秒页面地址未变化，请到平台确认",
            lastPublishAt: Date.now(),
          },
        });
        this.$notify({
          title: "发布异常",
          message:
            donePayload.message ||
            `${donePayload.pt || ""} 发布后页面未跳转，请到平台确认是否已发布`,
          type: "error",
          duration: 0,
        });
        this.loadRecords();
        return;
      }
      await dataRequest({
        type: "update",
        fileName: "pushData",
        item: {
          id: row.id,
          date: target.date,
          publishSuccessCount: success
            ? row.publishSuccessCount + 1
            : row.publishSuccessCount,
          publishFailCount: success
            ? row.publishFailCount
            : row.publishFailCount + 1,
          publishMode: isDraftMode ? "draft" : row.publishMode || "publish",
          publishStatus: success
            ? isDraftMode
              ? "draft"
              : "success"
            : "failed",
          ...extrasStatusPatch,
          // 成功/存草稿时清掉旧截图，避免把上一次失败的画面留在成功记录上
          failScreenshot: success ? "" : failScreenshot,
          lastPublishMessage:
            donePayload.message ||
            (success
              ? isDraftMode
                ? "保存草稿成功"
                : "发布成功"
              : "发布失败"),
          lastPublishAt: Date.now(),
        },
      });
      if (donePayload.needsAttention) {
        this.$notify({
          title: "发布任务需要处理",
          message: donePayload.message || "任务已转为草稿，请前往平台检查",
          type: "warning",
          duration: 0,
        });
      }
      this.loadRecords();
    },
    openFeatureWall() {
      window.open(
        "https://hanliang97.github.io/MatrixMedia/feature-wall",
        "_blank"
      );
    },
    openQQGroup() {
      window.open(
        "https://qm.qq.com/cgi-bin/qm/qr?k=NLsaKNd7gqbOeW_JXNg7bRreFtcLKXmp&jump_from=webapi&authKey=Nd/DrSrJWaH+Nip9gEIGse4LdHWpLkp8bVfcKwinOk4hI8XfNTDvGf/smQgZvWHT",
        "_blank"
      );
    },
    openGitHubStar() {
      window.open("https://github.com/hanliang97/MatrixMedia", "_blank");
    },
    selectVideoFile() {
      // 直接弹发布弹窗，弹窗内拖入区/点击选择视频；不再先弹系统文件框
      this.$refs.localPublishRef.open();
    },
    onDropVideoFile(e) {
      // 拖拽视频文件到页面即可进入发布流程（#72），与「选择视频发布」同入口
      const file =
        (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) ||
        null;
      if (!file) return;
      const path = file.path || "";
      const ext = path.split(".").pop().toLowerCase();
      if (!["mp4", "mov", "mkv", "avi", "webm", "m4v"].includes(ext)) {
        this.$message.warning("请拖入视频文件（支持 mp4/mov/mkv/avi/webm/m4v）");
        return;
      }
      this.$refs.localPublishRef.open(path);
    },
    async openDirectoryPublish() {
      this.$refs.localPublishRef.openDirectory();
    },
    openArticlePublish() {
      this.$refs.articlePublishRef.open();
    },

    loadAccountsFromStorage() {
      try {
        if (typeof localStorage === "undefined" || !localStorage) {
          return { accounts: [], groupOrderMap: {} };
        }
        const raw = localStorage.getItem("accountTree");
        if (!raw) return { accounts: [], groupOrderMap: {} };
        const tree = JSON.parse(raw);
        if (!tree || typeof tree !== "object" || Array.isArray(tree)) {
          return { accounts: [], groupOrderMap: {} };
        }
        const accounts = [];
        const groupOrderMap = {};
        for (const [groupKey, node] of Object.entries(tree)) {
          const g = String(groupKey || "").trim();
          if (g && groupOrderMap[g] === undefined) {
            const rawOrder = node && node.meta ? node.meta.groupOrder : null;
            groupOrderMap[g] = normalizeGroupOrder(rawOrder);
          }
          const children =
            node && Array.isArray(node.children) ? node.children : [];
          for (const child of children) {
            if (!child || typeof child !== "object") continue;
            const meta =
              child.meta && typeof child.meta === "object" ? child.meta : child;
            const group = recordGroupOf(meta) || g;
            accounts.push(group && !meta.group ? { ...meta, group } : meta);
          }
        }
        return { accounts, groupOrderMap };
      } catch (_) {
        return { accounts: [], groupOrderMap: {} };
      }
    },

    extractAccountsFromRaw(rawAccountData) {
      const accounts = [];
      if (
        !rawAccountData ||
        typeof rawAccountData !== "object" ||
        Array.isArray(rawAccountData)
      ) {
        return { accounts, groupOrderMap: {} };
      }
      const groupOrderMap = buildGroupOrderMap(rawAccountData);
      for (const dateKey of Object.keys(rawAccountData)) {
        const list = rawAccountData[dateKey];
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          if (!item || typeof item !== "object") continue;
          if (!item.phone && !item.group && !item.accountKey) continue;
          accounts.push(item);
        }
      }
      return { accounts, groupOrderMap };
    },

    getEffectiveAccounts() {
      if (this.accountsLoaded) {
        return Array.isArray(this.currentAccounts) ? this.currentAccounts : [];
      }
      if (Array.isArray(this.currentAccounts) && this.currentAccounts.length > 0) {
        return this.currentAccounts;
      }
      return this.loadAccountsFromStorage().accounts;
    },

    getEffectiveGroupOrderMap() {
      if (this.accountsLoaded) {
        return this.groupOrderMap && typeof this.groupOrderMap === "object"
          ? this.groupOrderMap
          : {};
      }
      if (
        this.groupOrderMap &&
        typeof this.groupOrderMap === "object" &&
        Object.keys(this.groupOrderMap).length > 0
      ) {
        return this.groupOrderMap;
      }
      return this.loadAccountsFromStorage().groupOrderMap;
    },

    getRowDisplayGroup(row) {
      if (!row || typeof row !== "object") return "";
      return String(row.displayGroup || recordGroupOf(row) || row.phone || "");
    },

    getGroupFilterOptions() {
      const accounts = this.getEffectiveAccounts();
      const orderMap = this.getEffectiveGroupOrderMap();
      const set = new Set();
      for (const acc of accounts) {
        const g = recordGroupOf(acc);
        if (g) set.add(g);
      }
      if (set.size === 0) {
        const all = this.dataList || {};
        for (const rows of Object.values(all)) {
          if (!Array.isArray(rows)) continue;
          for (const row of rows) {
            const g = this.getRowDisplayGroup(row);
            if (g) set.add(g);
          }
        }
      }
      return [...set].sort((a, b) =>
        compareGroups(a, orderMap[a], b, orderMap[b])
      );
    },

    getFilteredDataList() {
      const all = this.dataList || {};
      const selected = String(this.selectedGroup || "all").trim();
      if (!selected || selected === "all") return all;
      const result = {};
      for (const dateKey of Object.keys(all)) {
        const rows = Array.isArray(all[dateKey]) ? all[dateKey] : [];
        const matched = rows.filter(
          (row) => this.getRowDisplayGroup(row) === selected
        );
        if (matched.length > 0) {
          result[dateKey] = matched;
        }
      }
      return result;
    },

    onGroupFilterChange(value) {
      const next = String(value || "all").trim() || "all";
      this.selectedGroup = next;
      writeStoredSelectedGroup(next);
    },

    reconcileSelectedGroup() {
      const cur = String(this.selectedGroup || "all").trim();
      if (!cur || cur === "all") return;
      const options = this.getGroupFilterOptions();
      if ((this.accountsLoaded || options.length > 0) && !options.includes(cur)) {
        this.selectedGroup = "all";
        writeStoredSelectedGroup("all");
      }
    },

    hasMultiAccountForSub(row, sub) {
      if (!sub || !sub.pt) return false;
      const pt = String(sub.pt).trim();
      const details = (row && Array.isArray(row.showAlltype) && row.showAlltype) || [];
      const rowAccountSet = new Set();
      for (const item of details) {
        if (!item || String(item.pt || "").trim() !== pt) continue;
        const idKey = subAccountIdentityKey(item);
        if (idKey) rowAccountSet.add(idKey);
      }
      if (rowAccountSet.size > 1) return true;

      const rowGroup = this.getRowDisplayGroup(row);
      if (!rowGroup) return false;
      const accounts = this.getEffectiveAccounts();
      const groupAccountSet = new Set();
      for (const acc of accounts) {
        if (!acc || String(acc.pt || "").trim() !== pt) continue;
        if (recordGroupOf(acc) !== rowGroup) continue;
        const idKey = subAccountIdentityKey(acc);
        if (idKey) groupAccountSet.add(idKey);
      }
      return groupAccountSet.size > 1;
    },

    getSubAccountLabel(row, sub) {
      if (!this.hasMultiAccountForSub(row, sub)) return "";
      return (
        resolveRecordAccountName(sub, this.getEffectiveAccounts()) ||
        recordAccountKeyOf(sub) ||
        ""
      );
    },

    buildLocalCardMergeKey(row, resolvedGroup) {
      return [
        this.recordValue(row && row.textOtherName),
        this.recordValue(row && row.textType),
        this.recordValue(resolvedGroup),
        this.recordValue(row && row.selectedFile),
      ].join("\u0001");
    },

    buildArticleCardMergeKey(row, resolvedGroup) {
      return [
        this.recordValue(row && row.textOtherName),
        this.recordValue(row && row.textType),
        this.recordValue(resolvedGroup),
        this.recordValue(row && row.selectedFile),
        this.getArticleField(row, "content"),
        this.getArticleField(row, "articleFilePath"),
        this.getArticleField(row, "coverPath"),
        this.getArticleField(row, "category"),
        this.getArticleTags(row),
        this.getArticleField(row, "summary"),
      ].join("\u0001");
    },

    async loadRecords() {
      const seq = (this._loadSeq || 0) + 1;
      this._loadSeq = seq;
      const [pushRes, accRes] = await Promise.all([
        dataRequest({
          type: "get",
          fileName: "pushData",
        }).catch(() => ({ data: {} })),
        dataRequest({
          type: "get",
          fileName: "account",
          item: { page: 1, pageSize: 10000 },
        }).catch(() => null),
      ]);
      if (seq !== this._loadSeq) return;
      if (
        accRes &&
        accRes.success !== false &&
        accRes.data &&
        typeof accRes.data === "object" &&
        !Array.isArray(accRes.data)
      ) {
        const { accounts, groupOrderMap } = this.extractAccountsFromRaw(
          accRes.data
        );
        this.currentAccounts = accounts;
        this.groupOrderMap = groupOrderMap;
        this.accountsLoaded = true;
      } else {
        const fallback = this.loadAccountsFromStorage();
        this.currentAccounts = fallback.accounts;
        this.groupOrderMap = fallback.groupOrderMap;
        this.accountsLoaded = fallback.accounts.length > 0;
      }
      this.initDataFiltered((pushRes && pushRes.data) || {});
      this.reconcileSelectedGroup();
    },

    initDataFiltered(data, accountsOverride) {
      const accounts =
        accountsOverride !== undefined
          ? accountsOverride
          : this.getEffectiveAccounts();
      const tempObj = {};
      this.dataList = {};
      for (const key in data) {
        const tempData = {};
        const list = data[key] || [];
        list.forEach((row) => {
          if (!["local", "article"].includes(row.textType)) return;
          const resolvedGroup = resolveRecordGroup(row, accounts);
          const mergeKey =
            row.textType === "article"
              ? this.buildArticleCardMergeKey(row, resolvedGroup)
              : this.buildLocalCardMergeKey(row, resolvedGroup);
          if (!tempData[mergeKey]) {
            const copyRow = this.fillPublishStats(
              JSON.parse(JSON.stringify(row))
            );
            copyRow.displayGroup = resolvedGroup;
            copyRow.showAlltype = [
              this.fillPublishStats(JSON.parse(JSON.stringify(row))),
            ];
            tempData[mergeKey] = copyRow;
          } else {
            tempData[mergeKey].showAlltype.push(
              this.fillPublishStats(JSON.parse(JSON.stringify(row)))
            );
          }
        });
        if (Object.keys(tempData).length) {
          tempObj[key] = tempData;
        }
      }
      for (const key in tempObj) {
        const v = Object.values(tempObj[key]).reverse();
        this.$set(this.dataList, key, v);
      }
    },

    async opPt(item) {
      try {
        const result = await openLoginWindow(item);
        if (result && result.ok === false) {
          this.$message.error(result.message || "打开登录窗口失败");
        } else if (result && result.reused) {
          this.$message.info("已切换到已打开的登录窗口");
        }
      } catch (e) {
        this.$message.error(
          "打开登录窗口失败：" + (e && e.message ? e.message : e)
        );
      }
    },

    handleDelete(item, dateKey, idx) {
      const promises = item.showAlltype.map((v) =>
        dataRequest({
          type: "delete",
          fileName: "pushData",
          item: {
            id: v.id,
            date: dateKey,
          },
        })
      );
      Promise.all(promises).then((results) => {
        const warnings = (results || [])
          .map((r) => r && r.warning)
          .filter(Boolean);
        if (warnings.length > 0 && this.$message) {
          this.$message.warning(warnings.join("；"));
        }
        const dayRows = this.dataList[dateKey];
        if (!Array.isArray(dayRows)) return;
        let realIdx = dayRows.indexOf(item);
        if (realIdx < 0 && idx >= 0 && idx < dayRows.length && dayRows[idx] === item) {
          realIdx = idx;
        }
        if (realIdx < 0) {
          const deletedIds = new Set(
            (item.showAlltype || []).map((v) => v && v.id).filter(Boolean)
          );
          if (deletedIds.size > 0) {
            realIdx = dayRows.findIndex((row) =>
              (row.showAlltype || []).some((v) => v && deletedIds.has(v.id))
            );
          }
        }
        if (realIdx >= 0) {
          dayRows.splice(realIdx, 1);
        }
        if (dayRows.length === 0) {
          this.$delete(this.dataList, dateKey);
        }
      });
    },
  },
};
</script>

<style lang="scss" scoped>
@import "@/styles/variables.scss";

.toolbar {
  margin-bottom: 16px;
  padding: 16px 20px;
  background: $cardBg;
  border: 1px solid $borderColor;
  border-radius: 4px;
}

.toolbar-inner {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}

.toolbar-left,
.toolbar-right {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.toolbar-label {
  font-size: 13px;
  color: #909399;
  margin-right: 4px;
}

.toolbar-filter {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid $borderColor;
}

.group-filter-select {
  width: 200px;
}

.empty-filter-card {
  padding: 28px 20px;
  text-align: center;
  font-size: 13px;
  color: #909399;
  background: $cardBg;
  border: 1px solid $borderColor;
  border-radius: 4px;
}

.info-box {
  min-height: 120px;
}

.record-card {
  ::v-deep .el-card__body {
    padding-top: 0;
  }
}

.mb8 {
  margin-bottom: 8px;
}

.date-label {
  color: #303133;
  font-weight: 600;
}

.status-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.progress-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.progress-detail {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 300px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.progress-count {
  font-size: 12px;
  color: #666;
}

.progress-count.success {
  color: #2e8b57;
}

.progress-count.fail {
  cursor: default;
}

/* 有失败截图的记录：次数可点，提示用户能回看当时的页面 */
.progress-count.fail-clickable {
  cursor: pointer;
  text-decoration: underline dotted;
  text-underline-offset: 3px;
}

.progress-count.fail-clickable:hover {
  color: #f56c6c;
}

.shot-body {
  min-height: 200px;
  max-height: 68vh;
  overflow: auto;
  text-align: center;
}

.shot-path {
  margin-bottom: 8px;
  font-size: 12px;
  color: #909399;
  word-break: break-all;
}

.shot-img {
  max-width: 100%;
  border: 1px solid $borderColor;
  border-radius: 4px;
}

.shot-empty {
  padding: 40px 0;
  color: #909399;
  font-size: 13px;
}

.pt-name {
  cursor: pointer;
  width: 60%;
  word-break: break-all;
}

.pt-account-name {
  font-size: 12px;
  color: #606266;
}

.fail {
  color: #c00;
  cursor: pointer;
}
</style>
