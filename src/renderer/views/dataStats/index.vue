<template>
  <div class="data-stats-page">
    <div class="page-head">
      <h2 class="page-title">所有账号</h2>
      <div class="head-actions">
        <span v-if="progressText" class="progress-text">{{ progressText }}</span>
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
  </div>
</template>

<script>
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

export default {
  name: "DataStatsAll",
  components: { StatsOverview, PlatformBarChart, GroupStatsTable, CollectLogDialog },
  data() {
    return {
      overview: { daily: {}, accounts: [] },
      syncing: false,
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
  created() {
    this.refresh();
    this._unsubProgress = onStatsProgress((p) => {
      this.progressText = `[${p.index + 1}/${p.total}] ${p.group} · ${p.platform} ${
        p.status === "running"
          ? "采集中…"
          : p.status === "success"
          ? "✓"
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
      this.autoCollect = updateAutoCollectSettings({
        enabled: this.autoCollect.enabled,
        time: this.autoCollect.time,
      });
    },
    async refresh() {
      this.overview = await getOverviewStats();
    },
    async openLogs() {
      this.logs = await getCollectLogs();
      this.logVisible = true;
    },
    async syncAll() {
      if (this.syncing) return;
      const accounts = buildCollectAccounts();
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
  gap: 12px;
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

.platform-card {
  margin-top: 12px;
  background: #ffffff;
  border: 1px solid $borderColor;
  border-radius: 8px;
  padding: 12px 14px;
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
</style>
