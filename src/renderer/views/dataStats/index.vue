<template>
  <div class="data-stats-page">
    <div class="page-head">
      <h2 class="page-title">所有账号</h2>
      <div class="head-actions">
        <span v-if="progressText" class="progress-text">{{ progressText }}</span>
        <el-date-picker
          v-model="exportRange"
          type="daterange"
          size="small"
          class="export-date-picker"
          value-format="yyyy-MM-dd"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          :editable="false"
        />
        <el-button
          size="small"
          icon="el-icon-download"
          :loading="exporting"
          @click="exportXlsx"
        >
          {{ exporting ? "导出中…" : "导出 Excel" }}
        </el-button>
        <el-button size="small" icon="el-icon-document" @click="openLogs">
          拉取记录
        </el-button>
        <el-button
          type="primary"
          size="small"
          icon="el-icon-refresh"
          :loading="syncing"
          @click="syncAll"
        >
          {{ syncing ? "同步中…" : "同步全部数据" }}
        </el-button>
      </div>
      <collect-log-dialog :visible.sync="logVisible" :logs="logs" />
    </div>
    <div class="auto-collect-bar">
      <div class="auto-collect-controls">
        <span class="auto-collect-label">每日自动采集</span>
        <el-switch
          v-model="autoCollect.enabled"
          @change="onAutoCollectChange"
        />
        <el-time-select
          v-model="autoCollect.time"
          size="mini"
          class="auto-collect-time"
          :disabled="!autoCollect.enabled"
          :clearable="false"
          :editable="false"
          :picker-options="{ start: '00:00', step: '00:30', end: '23:30' }"
          placeholder="选择时间"
          @change="onAutoCollectChange"
        />
      </div>
      <span class="auto-collect-last">
        上次自动采集：{{ autoCollect.lastRunDate || "暂无" }}
      </span>
    </div>
    <el-tabs v-model="activeTab" class="stats-tabs">
      <el-tab-pane label="账号总览" name="overview">
        <stats-overview :rows="rows" />
        <div class="platform-card">
          <div class="card-head">
            <span class="card-title">平台数据分布</span>
            <span class="card-tip">番茄视频、掘金不参与统计</span>
          </div>
          <platform-bar-chart v-if="platformRows.length" :rows="platformRows" />
          <div v-else class="card-empty">暂无数据，点击右上角「同步全部数据」</div>
        </div>
        <div class="platform-card">
          <div class="card-head">
            <span class="card-title">分组统计</span>
            <span class="card-tip">点击行进入对应账号统计页</span>
          </div>
          <group-stats-table :accounts="accounts" />
        </div>
      </el-tab-pane>
      <el-tab-pane label="作品汇总" name="works" lazy>
        <div class="platform-card works-summary-card">
          <div class="card-head">
            <span class="card-title">作品跨平台汇总</span>
            <span class="card-tip">
              共 {{ contentSummaryRows.length }} 条内容<template v-if="contentSummaryDate"> · 截至 {{ contentSummaryDate }}</template> · 点击行左侧箭头展开各平台明细与链接
            </span>
          </div>
          <el-table
            v-loading="loadingSummary"
            :data="contentSummaryRows"
            row-key="contentKey"
            border
            stripe
            class="works-summary-table"
          >
            <el-table-column type="expand">
              <template #default="{ row }">
                <div class="expand-box">
                  <div v-if="row.file" class="expand-file" :title="row.file">
                    素材文件：{{ row.file }}
                  </div>
                  <el-table
                    v-if="perPlatformList(row).length"
                    :data="perPlatformList(row)"
                    size="mini"
                    border
                    class="expand-table"
                  >
                    <el-table-column prop="platform" label="平台" width="90" />
                    <el-table-column prop="group" label="分组" width="110" show-overflow-tooltip />
                    <el-table-column label="播放" width="90" align="right">
                      <template #default="{ row: p }">
                        <span class="num" :class="{ muted: p.play == null }">{{ showNum(p.play) }}</span>
                      </template>
                    </el-table-column>
                    <el-table-column label="点赞" width="84" align="right">
                      <template #default="{ row: p }">
                        <span class="num" :class="{ muted: p.like == null }">{{ showNum(p.like) }}</span>
                      </template>
                    </el-table-column>
                    <el-table-column label="评论" width="84" align="right">
                      <template #default="{ row: p }">
                        <span class="num" :class="{ muted: p.comment == null }">{{ showNum(p.comment) }}</span>
                      </template>
                    </el-table-column>
                    <el-table-column label="分享" width="84" align="right">
                      <template #default="{ row: p }">
                        <span class="num" :class="{ muted: p.share == null }">{{ showNum(p.share) }}</span>
                      </template>
                    </el-table-column>
                    <el-table-column label="收藏" width="84" align="right">
                      <template #default="{ row: p }">
                        <span class="num" :class="{ muted: p.favorite == null }">{{ showNum(p.favorite) }}</span>
                      </template>
                    </el-table-column>
                    <el-table-column label="涨粉" width="84" align="right">
                      <template #default="{ row: p }">
                        <span
                          v-if="p.fansDelta != null"
                          class="num"
                          :class="{ down: p.fansDelta < 0 }"
                        >
                          {{ p.fansDelta > 0 ? "+" : "" }}{{ showNum(p.fansDelta) }}
                        </span>
                        <span v-else class="num muted">-</span>
                      </template>
                    </el-table-column>
                    <el-table-column label="作品链接" min-width="220">
                      <template #default="{ row: p }">
                        <div v-if="p.urls && p.urls.length" class="work-links">
                          <template v-for="(u, idx) in p.urls">
                            <el-link
                              v-if="parseSafeHttpUrl(u)"
                              :key="idx"
                              type="primary"
                              :underline="false"
                              class="work-link"
                              :title="u"
                              @click.prevent="openWorkUrl(u)"
                            >
                              {{ u }}
                            </el-link>
                            <span v-else :key="'t-' + idx" class="work-link-text">{{ u }}</span>
                          </template>
                        </div>
                        <span v-else class="num muted">-</span>
                      </template>
                    </el-table-column>
                  </el-table>
                  <div v-else class="expand-empty">
                    暂无平台采集明细（该内容尚未匹配到作品日快照）
                  </div>
                </div>
              </template>
            </el-table-column>
            <el-table-column
              prop="title"
              label="标题"
              min-width="200"
              sortable
              show-overflow-tooltip
            />
            <el-table-column prop="firstPublishDate" label="首发日期" width="114" sortable>
              <template #default="{ row }">
                <span class="num" :class="{ muted: !row.firstPublishDate }">
                  {{ row.firstPublishDate || "-" }}
                </span>
              </template>
            </el-table-column>
            <el-table-column
              prop="platformCount"
              label="平台数"
              width="90"
              align="right"
              sortable
            >
              <template #default="{ row }">
                <span class="num">{{ row.platformCount }}</span>
              </template>
            </el-table-column>
            <el-table-column
              prop="totalPlay"
              label="总播放"
              width="104"
              align="right"
              sortable
              :sort-method="sortTotalPlay"
            >
              <template #default="{ row }">
                <span class="num" :class="{ muted: row.totalPlay == null }">
                  {{ showNum(row.totalPlay) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column
              prop="totalLike"
              label="总点赞"
              width="98"
              align="right"
              sortable
              :sort-method="sortTotalLike"
            >
              <template #default="{ row }">
                <span class="num" :class="{ muted: row.totalLike == null }">
                  {{ showNum(row.totalLike) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column
              prop="totalComment"
              label="总评论"
              width="98"
              align="right"
              sortable
              :sort-method="sortTotalComment"
            >
              <template #default="{ row }">
                <span class="num" :class="{ muted: row.totalComment == null }">
                  {{ showNum(row.totalComment) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column
              prop="totalShare"
              label="总分享"
              width="98"
              align="right"
              sortable
              :sort-method="sortTotalShare"
            >
              <template #default="{ row }">
                <span class="num" :class="{ muted: row.totalShare == null }">
                  {{ showNum(row.totalShare) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column
              prop="totalFavorite"
              label="总收藏"
              width="98"
              align="right"
              sortable
              :sort-method="sortTotalFavorite"
            >
              <template #default="{ row }">
                <span class="num" :class="{ muted: row.totalFavorite == null }">
                  {{ showNum(row.totalFavorite) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column
              prop="totalFansDelta"
              label="总涨粉"
              width="98"
              align="right"
              sortable
              :sort-method="sortTotalFansDelta"
            >
              <template #default="{ row }">
                <span
                  v-if="row.totalFansDelta != null"
                  class="num"
                  :class="{ down: row.totalFansDelta < 0 }"
                >
                  {{ row.totalFansDelta > 0 ? "+" : "" }}{{ showNum(row.totalFansDelta) }}
                </span>
                <span v-else class="num muted">-</span>
              </template>
            </el-table-column>
            <template #empty>
              <span class="card-empty-inline">
                暂无作品汇总数据，请先点击右上角「同步全部数据」采集作品日快照
              </span>
            </template>
          </el-table>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script>
import { ipcRenderer, shell } from "electron";
import StatsOverview from "./components/StatsOverview.vue";
import PlatformBarChart from "./components/PlatformBarChart.vue";
import GroupStatsTable from "./components/GroupStatsTable.vue";
import CollectLogDialog from "./components/CollectLogDialog.vue";
import { dailyToRows } from "./statsUtils";
import {
  buildCollectAccounts,
  collectAccounts,
  getCollectLogs,
  getOverviewStats,
  onStatsProgress,
} from "@/utils/statsApi";
import {
  loadSettings as loadAutoCollectSettings,
  subscribeRunComplete,
  subscribeSettings as subscribeAutoCollectSettings,
  updateSettings as updateAutoCollectSettings,
} from "@/utils/statsScheduler";

const DAY_MS = 86400000;
const PLATFORM_ORDER = [
  "抖音",
  "视频号",
  "快手",
  "哔哩哔哩",
  "小红书",
  "百家号",
  "头条",
];

function formatLocalYmd(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function defaultExportRange(now = Date.now()) {
  return [formatLocalYmd(now - 29 * DAY_MS), formatLocalYmd(now)];
}

function compareNullableMetric(a, b, key) {
  const av = a && a[key];
  const bv = b && b[key];
  if (av == null && bv == null) return 0;
  if (av == null) return -1;
  if (bv == null) return 1;
  return Number(av) - Number(bv);
}

export default {
  name: "DataStatsAll",
  components: { StatsOverview, PlatformBarChart, GroupStatsTable, CollectLogDialog },
  data() {
    return {
      activeTab: "overview",
      overview: { daily: {}, accounts: [] },
      syncing: false,
      exporting: false,
      exportRange: defaultExportRange(),
      contentSummaryRows: [],
      contentSummaryDate: "",
      loadingSummary: false,
      progressText: "",
      logVisible: false,
      logs: [],
      autoCollect: loadAutoCollectSettings(),
    };
  },
  computed: {
    rows() {
      return dailyToRows(this.overview.daily);
    },
    accounts() {
      return this.overview.accounts || [];
    },
    // 平台分布：各平台下所有分组账号的最新快照求和
    platformRows() {
      const byPt = new Map();
      for (const acc of this.accounts) {
        if (!acc.latest) continue;
        const cur =
          byPt.get(acc.platform) ||
          { platform: acc.platform, fans: 0, likes: 0, comments: 0, favorites: 0 };
        for (const k of ["fans", "likes", "comments", "favorites"]) {
          cur[k] += Number(acc.latest[k]) || 0;
        }
        byPt.set(acc.platform, cur);
      }
      return [...byPt.values()];
    },
  },
  watch: {
    activeTab(val) {
      if (val === "works") {
        this.loadContentSummary();
      }
    },
  },
  created() {
    this.refresh();
    this._unsubProgress = onStatsProgress((p) => {
      this.progressText = `[${p.index + 1}/${p.total}] ${p.group} · ${p.platform} ${
        p.status === "running"
          ? "采集中…"
          : p.status === "success"
          ? "✓"
          : p.status === "skipped"
          ? "已跳过"
          : "✗ " + (p.error || "")
      }`;
    });
    this._unsubAutoCollect = subscribeAutoCollectSettings((next) => {
      this.autoCollect = next;
    });
    this._unsubAutoRunComplete = subscribeRunComplete(() => {
      if (!this.syncing) {
        this.progressText = "";
        this.refresh();
      }
    });
  },
  activated() {
    this.autoCollect = loadAutoCollectSettings();
  },
  beforeDestroy() {
    if (this._unsubProgress) this._unsubProgress();
    if (this._unsubAutoCollect) this._unsubAutoCollect();
    if (this._unsubAutoRunComplete) this._unsubAutoRunComplete();
  },
  methods: {
    onAutoCollectChange() {
      const res = updateAutoCollectSettings({
        enabled: this.autoCollect.enabled,
        time: this.autoCollect.time,
      });
      this.autoCollect = res.settings;
      if (!res.ok) {
        this.$message.error(
          `保存自动采集设置失败${res.error ? "：" + res.error : ""}`
        );
      }
    },
    async refresh() {
      this.overview = await getOverviewStats();
      if (this.activeTab === "works") {
        await this.loadContentSummary();
      }
    },
    async loadContentSummary() {
      const reqId = (this._summaryReqId = (this._summaryReqId || 0) + 1);
      this.loadingSummary = true;
      try {
        const res = await ipcRenderer.invoke("stats:get-content-summary", {});
        if (reqId !== this._summaryReqId) return;
        if (res && res.error) {
          this.$message.warning(res.error);
          this.contentSummaryRows = [];
          this.contentSummaryDate = "";
          return;
        }
        this.contentSummaryRows = Array.isArray(res && res.rows) ? res.rows : [];
        this.contentSummaryDate = (res && res.date) || "";
      } catch (err) {
        if (reqId !== this._summaryReqId) return;
        this.$message.error(`读取作品汇总失败：${(err && err.message) || err}`);
      } finally {
        if (reqId === this._summaryReqId) {
          this.loadingSummary = false;
        }
      }
    },
    async exportXlsx() {
      if (this.exporting) return;
      const payload = {};
      if (Array.isArray(this.exportRange) && this.exportRange.length === 2) {
        if (this.exportRange[0]) payload.from = this.exportRange[0];
        if (this.exportRange[1]) payload.to = this.exportRange[1];
      }
      this.exporting = true;
      try {
        const res = await ipcRenderer.invoke("stats:export-xlsx", payload);
        if (res && res.ok) {
          this.$message.success(`导出成功：${res.filePath}`);
        } else if (res && res.canceled) {
          // 用户取消保存对话框
        } else {
          this.$message.error((res && res.message) || "导出 Excel 失败");
        }
      } catch (err) {
        this.$message.error(`导出 Excel 失败：${(err && err.message) || err}`);
      } finally {
        this.exporting = false;
      }
    },
    perPlatformList(row) {
      const map = (row && row.perPlatform) || {};
      return Object.entries(map)
        .map(([pgKey, cell]) => {
          const sep = pgKey.indexOf("|");
          const platform = sep === -1 ? pgKey : pgKey.slice(0, sep);
          const group = sep === -1 ? "" : pgKey.slice(sep + 1);
          return {
            pgKey,
            platform,
            group,
            ...(cell || {}),
          };
        })
        .sort((a, b) => {
          const ia = PLATFORM_ORDER.indexOf(a.platform);
          const ib = PLATFORM_ORDER.indexOf(b.platform);
          if (ia !== -1 && ib !== -1 && ia !== ib) return ia - ib;
          if (ia !== -1 && ib === -1) return -1;
          if (ia === -1 && ib !== -1) return 1;
          if (a.platform !== b.platform) return a.platform < b.platform ? -1 : 1;
          return a.group < b.group ? -1 : a.group > b.group ? 1 : 0;
        });
    },
    showNum(v) {
      return v == null ? "-" : Number(v).toLocaleString("zh-CN");
    },
    parseSafeHttpUrl(raw) {
      if (typeof raw !== "string") return "";
      const trimmed = raw.trim();
      if (!trimmed) return "";
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          return parsed.href;
        }
      } catch (_) {}
      return "";
    },
    openWorkUrl(raw) {
      const safeUrl = this.parseSafeHttpUrl(raw);
      if (!safeUrl) return;
      if (shell && typeof shell.openExternal === "function") {
        Promise.resolve(shell.openExternal(safeUrl)).catch((err) => {
          this.$message.error(`打开链接失败：${(err && err.message) || err}`);
        });
        return;
      }
      window.open(safeUrl, "_blank");
    },
    sortTotalPlay(a, b) {
      return compareNullableMetric(a, b, "totalPlay");
    },
    sortTotalLike(a, b) {
      return compareNullableMetric(a, b, "totalLike");
    },
    sortTotalComment(a, b) {
      return compareNullableMetric(a, b, "totalComment");
    },
    sortTotalShare(a, b) {
      return compareNullableMetric(a, b, "totalShare");
    },
    sortTotalFavorite(a, b) {
      return compareNullableMetric(a, b, "totalFavorite");
    },
    sortTotalFansDelta(a, b) {
      return compareNullableMetric(a, b, "totalFansDelta");
    },
    async openLogs() {
      this.logs = await getCollectLogs();
      this.logVisible = true;
    },
    async syncAll() {
      if (this.syncing) return;
      const accounts = buildCollectAccounts() || [];
      if (!accounts.length) {
        this.$message.warning("没有可统计的账号，请先在「媒体平台管理」添加并登录");
        return;
      }
      this.syncing = true;
      try {
        const res = await collectAccounts(accounts);
        const failed = (res.results || []).filter((r) => !r.success);
        if (res.error) {
          this.$message.warning(res.error);
        } else if (failed.length) {
          this.$message.warning(
            `完成，${failed.length} 个账号失败：${failed
              .map((f) => `${f.group}·${f.platform}`)
              .join("、")}`
          );
        } else {
          this.$message.success("全部账号数据已同步");
        }
      } finally {
        this.syncing = false;
        this.progressText = "";
        await this.refresh();
      }
    },
  },
};
</script>

<style lang="scss" scoped>
@import "@/styles/variables.scss";

.data-stats-page {
  padding: 14px 20px 20px;
}

.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 10px;
}

.page-title {
  margin: 0;
  font-size: 18px;
  color: #303133;
}

.head-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.export-date-picker {
  width: 240px;
}

.progress-text {
  font-size: 12px;
  color: #909399;
}

.auto-collect-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
  padding: 8px 14px;
  background: #ffffff;
  border: 1px solid $borderColor;
  border-radius: 8px;
}

.auto-collect-controls {
  display: flex;
  align-items: center;
  gap: 10px;
}

.auto-collect-label {
  font-size: 13px;
  font-weight: 500;
  color: #303133;
}

.auto-collect-time {
  width: 110px;
}

.auto-collect-last {
  font-size: 12px;
  color: #909399;
}

.stats-tabs {
  margin-top: 4px;
}

.platform-card {
  margin-top: 12px;
  background: #ffffff;
  border: 1px solid $borderColor;
  border-radius: 8px;
  padding: 12px 14px;
}

.works-summary-card {
  margin-top: 4px;
}

.works-summary-table {
  width: 100%;
}

.expand-box {
  padding: 8px 12px;
}

.expand-file {
  margin-bottom: 8px;
  font-size: 12px;
  color: #606266;
  word-break: break-all;
}

.expand-table {
  width: 100%;
}

.expand-empty {
  padding: 12px 0;
  font-size: 12px;
  color: #909399;
}

.work-links {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.work-link {
  justify-content: flex-start;
  font-size: 12px;
  word-break: break-all;
}

.work-link-text {
  font-size: 12px;
  color: #606266;
  word-break: break-all;
}

.num {
  font-variant-numeric: tabular-nums;

  &.down {
    color: #f56c6c;
  }

  &.muted {
    color: #c0c4cc;
  }
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.card-title {
  font-size: 14px;
  font-weight: 600;
  color: #303133;
}

.card-tip {
  font-size: 12px;
  color: #909399;
}

.card-empty {
  padding: 40px 0;
  text-align: center;
  font-size: 13px;
  color: #909399;
}

.card-empty-inline {
  font-size: 13px;
  color: #909399;
}
</style>
