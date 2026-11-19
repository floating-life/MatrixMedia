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
          start-placeholder="默认近30天"
          end-placeholder="默认最新日"
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
              共 {{ contentSummaryRows.length }} 条内容<template v-if="contentSummaryDate"> · 截至 {{ contentSummaryDate }}</template> · 点击行左侧箭头展开各平台明细与矫正操作
            </span>
          </div>
          <div class="works-filter-bar">
            <el-radio-group v-model="summaryFilter" size="mini">
              <el-radio-button label="all">
                全部（{{ contentSummaryRows.length }}）
              </el-radio-button>
              <el-radio-button label="fuzzy">
                仅模糊匹配（待确认）（{{ fuzzySummaryRows.length }}）
              </el-radio-button>
              <el-radio-button label="unlinked">
                未关联作品（{{ unlinkedWorkRows.length }}）
              </el-radio-button>
            </el-radio-group>
            <div v-if="summaryFilter === 'unlinked'" class="unlinked-actions">
              <el-button
                type="primary"
                size="mini"
                :loading="mutatingLink"
                :disabled="selectedUnlinkedWorks.length < 2 || mutatingLink"
                @click="mergeSelectedUnlinked"
              >
                合并为同一视频（已选 {{ selectedUnlinkedWorks.length }} 条）
              </el-button>
            </div>
          </div>
          <el-table
            v-if="summaryFilter !== 'unlinked'"
            v-loading="loadingSummary"
            :data="displayedSummaryRows"
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
                    v-if="perPlatformWorkList(row).length"
                    :data="perPlatformWorkList(row)"
                    size="mini"
                    border
                    class="expand-table"
                  >
                    <el-table-column prop="platform" label="平台" width="84" />
                    <el-table-column prop="group" label="分组" width="96" show-overflow-tooltip />
                    <el-table-column prop="title" label="作品标题" min-width="150" show-overflow-tooltip />
                    <el-table-column label="匹配方式" width="98">
                      <template #default="{ row: p }">
                        <el-tag
                          v-if="workMatchTagInfo(p)"
                          :type="workMatchTagInfo(p).type"
                          size="mini"
                        >
                          {{ workMatchTagInfo(p).label }}
                        </el-tag>
                        <span v-else class="num muted">-</span>
                      </template>
                    </el-table-column>
                    <el-table-column label="播放" width="88" align="right">
                      <template #default="{ row: p }">
                        <span class="num" :class="{ muted: p.play == null }">{{ showNum(p.play) }}</span>
                      </template>
                    </el-table-column>
                    <el-table-column label="点赞" width="80" align="right">
                      <template #default="{ row: p }">
                        <span class="num" :class="{ muted: p.like == null }">{{ showNum(p.like) }}</span>
                      </template>
                    </el-table-column>
                    <el-table-column label="评论" width="80" align="right">
                      <template #default="{ row: p }">
                        <span class="num" :class="{ muted: p.comment == null }">{{ showNum(p.comment) }}</span>
                      </template>
                    </el-table-column>
                    <el-table-column label="分享" width="80" align="right">
                      <template #default="{ row: p }">
                        <span class="num" :class="{ muted: p.share == null }">{{ showNum(p.share) }}</span>
                      </template>
                    </el-table-column>
                    <el-table-column label="收藏" width="80" align="right">
                      <template #default="{ row: p }">
                        <span class="num" :class="{ muted: p.favorite == null }">{{ showNum(p.favorite) }}</span>
                      </template>
                    </el-table-column>
                    <el-table-column label="涨粉" width="80" align="right">
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
                    <el-table-column label="作品链接" min-width="180">
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
                    <el-table-column label="操作" width="215">
                      <template #default="{ row: p }">
                        <div v-if="p.workKey" class="work-row-actions">
                          <template v-if="!isRowUnlinked(row)">
                            <el-button
                              v-if="canConfirmWork(row, p)"
                              type="text"
                              size="mini"
                              :disabled="mutatingLink"
                              @click="confirmSingleWork(p, row.contentKey, row)"
                            >
                              确认
                            </el-button>
                            <el-button
                              type="text"
                              size="mini"
                              :disabled="mutatingLink"
                              @click="detachWork(p)"
                            >
                              拆出
                            </el-button>
                            <el-button
                              type="text"
                              size="mini"
                              :disabled="mutatingLink"
                              @click="openReassignDialog(p, row.contentKey)"
                            >
                              改合并到…
                            </el-button>
                            <el-button
                              v-if="p.matchedBy === 'manual' || p.hasOverride"
                              type="text"
                              size="mini"
                              :disabled="mutatingLink"
                              @click="clearWorkOverride(p)"
                            >
                              恢复自动
                            </el-button>
                          </template>
                          <template v-else>
                            <el-button
                              type="text"
                              size="mini"
                              :disabled="mutatingLink"
                              @click="openReassignDialog(p, null)"
                            >
                              合并到…
                            </el-button>
                            <el-button
                              v-if="p.matchedBy === 'manual-detach' || p.hasOverride"
                              type="text"
                              size="mini"
                              :disabled="mutatingLink"
                              @click="clearWorkOverride(p)"
                            >
                              恢复自动
                            </el-button>
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
              width="86"
              align="right"
              sortable
            >
              <template #default="{ row }">
                <span class="num">{{ row.platformCount }}</span>
              </template>
            </el-table-column>
            <el-table-column label="匹配方式" width="150">
              <template #default="{ row }">
                <div class="match-cell">
                  <el-tag
                    v-if="rowMatchTagInfo(row)"
                    :type="rowMatchTagInfo(row).type"
                    size="mini"
                  >
                    {{ rowMatchTagInfo(row).label }}
                  </el-tag>
                  <span v-else class="num muted">-</span>
                  <el-button
                    v-if="canConfirmRow(row)"
                    type="text"
                    size="mini"
                    class="inline-confirm-btn"
                    :disabled="mutatingLink"
                    @click.stop="confirmFuzzyRow(row)"
                  >
                    确认
                  </el-button>
                </div>
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
                {{ summaryFilter === 'fuzzy' ? '暂无待确认的模糊匹配内容' : '暂无作品汇总数据，请先点击右上角「同步全部数据」采集作品日快照' }}
              </span>
            </template>
          </el-table>
          <el-table
            v-else
            ref="unlinkedTable"
            v-loading="loadingSummary"
            :data="unlinkedWorkRows"
            row-key="workKey"
            border
            stripe
            class="works-summary-table"
            @selection-change="onUnlinkedSelectionChange"
          >
            <el-table-column type="selection" width="46" />
            <el-table-column prop="platform" label="平台" width="88" sortable />
            <el-table-column prop="group" label="分组" width="104" show-overflow-tooltip sortable />
            <el-table-column prop="title" label="标题" min-width="220" show-overflow-tooltip sortable />
            <el-table-column prop="publishDate" label="发布日期" width="110" sortable>
              <template #default="{ row }">
                <span class="num" :class="{ muted: !row.publishDate }">
                  {{ row.publishDate || "-" }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag
                  v-if="row.matchedBy === 'manual-detach'"
                  type="warning"
                  size="mini"
                >
                  已拆出
                </el-tag>
                <el-tag v-else type="info" size="mini">未关联</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="播放" width="96" align="right" prop="play" sortable>
              <template #default="{ row }">
                <span class="num" :class="{ muted: row.play == null }">
                  {{ showNum(row.play) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="点赞" width="86" align="right" prop="like" sortable>
              <template #default="{ row }">
                <span class="num" :class="{ muted: row.like == null }">
                  {{ showNum(row.like) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="作品链接" min-width="180">
              <template #default="{ row }">
                <el-link
                  v-if="parseSafeHttpUrl(row.url)"
                  type="primary"
                  :underline="false"
                  class="work-link"
                  :title="row.url"
                  @click.prevent="openWorkUrl(row.url)"
                >
                  {{ row.url }}
                </el-link>
                <span v-else-if="row.url" class="work-link-text">{{ row.url }}</span>
                <span v-else class="num muted">-</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="160">
              <template #default="{ row }">
                <div class="work-row-actions">
                  <el-button
                    type="text"
                    size="mini"
                    :disabled="mutatingLink"
                    @click="openReassignDialog(row, null)"
                  >
                    合并到…
                  </el-button>
                  <el-button
                    v-if="row.matchedBy === 'manual-detach' || row.hasOverride"
                    type="text"
                    size="mini"
                    :disabled="mutatingLink"
                    @click="clearWorkOverride(row)"
                  >
                    恢复自动
                  </el-button>
                </div>
              </template>
            </el-table-column>
            <template #empty>
              <span class="card-empty-inline">
                暂无未关联作品
              </span>
            </template>
          </el-table>
        </div>
        <el-dialog
          :title="reassignCurrentKey ? '改合并到已有内容' : '合并到已有内容'"
          :visible.sync="reassignVisible"
          width="700px"
          append-to-body
          @closed="resetReassignDialog"
        >
          <div v-if="reassignSource" class="reassign-source">
            当前作品：<strong>{{ reassignSource.platform }}</strong>
            <span v-if="reassignSource.group"> · {{ reassignSource.group }}</span>
            · {{ reassignSource.title }}
          </div>
          <el-input
            v-model="reassignKeyword"
            size="small"
            clearable
            prefix-icon="el-icon-search"
            placeholder="按内容标题、素材文件或内容 ID 搜索"
            class="reassign-search"
          />
          <el-table
            ref="reassignTable"
            :data="reassignTargetRows"
            size="mini"
            border
            highlight-current-row
            max-height="320"
            row-key="contentKey"
            @current-change="onSelectReassignTarget"
            @row-click="onClickReassignTarget"
          >
            <el-table-column prop="title" label="内容标题" min-width="220" show-overflow-tooltip />
            <el-table-column prop="firstPublishDate" label="首发日期" width="106">
              <template #default="{ row }">
                <span class="num" :class="{ muted: !row.firstPublishDate }">
                  {{ row.firstPublishDate || "-" }}
                </span>
              </template>
            </el-table-column>
            <el-table-column prop="platformCount" label="平台数" width="70" align="right" />
            <el-table-column label="匹配方式" width="96">
              <template #default="{ row }">
                <el-tag
                  v-if="rowMatchTagInfo(row)"
                  :type="rowMatchTagInfo(row).type"
                  size="mini"
                >
                  {{ rowMatchTagInfo(row).label }}
                </el-tag>
                <span v-else class="num muted">-</span>
              </template>
            </el-table-column>
            <el-table-column label="总播放" width="96" align="right">
              <template #default="{ row }">
                <span class="num" :class="{ muted: row.totalPlay == null }">
                  {{ showNum(row.totalPlay) }}
                </span>
              </template>
            </el-table-column>
            <template #empty>
              <span class="card-empty-inline">未找到匹配的目标内容</span>
            </template>
          </el-table>
          <template #footer>
            <el-button size="small" @click="reassignVisible = false">取消</el-button>
            <el-button
              type="primary"
              size="small"
              :loading="mutatingLink"
              :disabled="!reassignTargetKey || mutatingLink"
              @click="submitReassign"
            >
              确定合并
            </el-button>
          </template>
        </el-dialog>
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

const UNSTABLE_RECORD_KEY_RE = /^record:(?:.*:)?pos:\d+$/;
const PLATFORM_ORDER = [
  "抖音",
  "视频号",
  "快手",
  "哔哩哔哩",
  "小红书",
  "百家号",
  "头条",
];

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
      // 未手动调整导出区间时保持为空，由后端共享默认截止日（作品快照最新日）与近 30 天口径决定
      exportRange: null,
      contentSummaryRows: [],
      contentSummaryDate: "",
      loadingSummary: false,
      summaryFilter: "all",
      selectedUnlinkedWorks: [],
      mutatingLink: false,
      reassignVisible: false,
      reassignSource: null,
      reassignCurrentKey: null,
      reassignKeyword: "",
      reassignTargetKey: "",
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
    fuzzySummaryRows() {
      return this.contentSummaryRows.filter((r) => this.canConfirmRow(r));
    },
    displayedSummaryRows() {
      if (this.summaryFilter === "fuzzy") return this.fuzzySummaryRows;
      return this.contentSummaryRows;
    },
    unlinkedWorkRows() {
      const out = [];
      for (const row of this.contentSummaryRows) {
        if (!this.isRowUnlinked(row)) continue;
        const works = this.perPlatformWorkList(row);
        for (const w of works) {
          if (!w.workKey) continue;
          out.push({
            ...w,
            title: w.title || row.title || "(无标题)",
            publishDate: w.publishDate || row.firstPublishDate || "",
            url: w.url || (Array.isArray(w.urls) && w.urls[0]) || "",
          });
        }
      }
      return out;
    },
    reassignTargetRows() {
      const kw = String(this.reassignKeyword || "").trim().toLowerCase();
      return this.contentSummaryRows.filter((r) => {
        if (!this.isRowAssignableTarget(r)) return false;
        if (this.reassignCurrentKey && r.contentKey === this.reassignCurrentKey) {
          return false;
        }
        if (!kw) return true;
        const title = String(r.title || "").toLowerCase();
        const file = String(r.file || "").toLowerCase();
        const ck = String(r.contentKey || "").toLowerCase();
        return title.includes(kw) || file.includes(kw) || ck.includes(kw);
      });
    },
  },
  watch: {
    activeTab(val) {
      if (val === "works") {
        this.loadContentSummary();
      }
    },
    summaryFilter() {
      this.selectedUnlinkedWorks = [];
    },
    reassignKeyword() {
      this.reassignTargetKey = "";
      this.clearReassignTableCurrentRow();
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
        this.selectedUnlinkedWorks = [];
        if (this.$refs.unlinkedTable && typeof this.$refs.unlinkedTable.clearSelection === "function") {
          this.$refs.unlinkedTable.clearSelection();
        }
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
    isRowUnlinked(row) {
      if (!row) return false;
      if (typeof row.isUnlinked === "boolean") return row.isUnlinked;
      return typeof row.contentKey === "string" && row.contentKey.startsWith("unlinked:");
    },
    formatScorePct(score) {
      if (typeof score !== "number" || !Number.isFinite(score)) return "";
      return `${Math.round(score * 100)}%`;
    },
    rowMatchTagInfo(row) {
      if (!row) return null;
      if (this.isRowUnlinked(row)) {
        if (row.isManualDetach) return { label: "已拆出", type: "warning" };
        return { label: "未关联", type: "info" };
      }
      if (row.matchMethod === "link") return { label: "链接", type: "success" };
      if (row.matchMethod === "title") return { label: "标题", type: "info" };
      if (row.matchMethod === "fuzzy") {
        const pct = this.formatScorePct(row.matchScore);
        return { label: pct ? `模糊 ${pct}` : "模糊", type: "warning" };
      }
      if (row.matchMethod === "manual") return { label: "手动", type: "primary" };
      return null;
    },
    workMatchTagInfo(item) {
      if (!item) return null;
      if (item.matchedBy === "link") return { label: "链接", type: "success" };
      if (item.matchedBy === "title") return { label: "标题", type: "info" };
      if (item.matchedBy === "fuzzy") {
        const pct = this.formatScorePct(item.score);
        return { label: pct ? `模糊 ${pct}` : "模糊", type: "warning" };
      }
      if (item.matchedBy === "manual") return { label: "手动", type: "primary" };
      if (item.matchedBy === "manual-detach") return { label: "已拆出", type: "warning" };
      return null;
    },
    isRowAssignableTarget(row) {
      if (!row || this.isRowUnlinked(row)) return false;
      if (row.canAssignTarget === false) return false;
      return !UNSTABLE_RECORD_KEY_RE.test(String(row.contentKey || ""));
    },
    canConfirmRow(row) {
      if (!this.isRowAssignableTarget(row)) return false;
      return row.matchMethod === "fuzzy" || Boolean(row.hasFuzzy);
    },
    canConfirmWork(row, workItem) {
      if (!workItem || workItem.matchedBy !== "fuzzy") return false;
      return this.isRowAssignableTarget(row);
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
    perPlatformWorkList(row) {
      const cells = this.perPlatformList(row);
      const out = [];
      for (const cell of cells) {
        if (Array.isArray(cell.works) && cell.works.length) {
          for (const w of cell.works) {
            out.push({
              ...w,
              platform: w.platform || cell.platform,
              group: w.group != null ? w.group : cell.group,
              urls: w.url ? [w.url] : [],
            });
          }
        } else {
          const fallbackId = Array.isArray(cell.workIds) && cell.workIds[0] ? cell.workIds[0] : "";
          out.push({
            ...cell,
            workId: fallbackId,
            workKey: fallbackId ? `${cell.platform}|${fallbackId}` : "",
            title: (row && row.title) || "(无标题)",
            url: Array.isArray(cell.urls) && cell.urls[0] ? cell.urls[0] : "",
            matchedBy: null,
            score: null,
            hasOverride: false,
          });
        }
      }
      return out;
    },
    onUnlinkedSelectionChange(selection) {
      this.selectedUnlinkedWorks = Array.isArray(selection) ? selection : [];
    },
    clearReassignTableCurrentRow() {
      if (
        this.$refs &&
        this.$refs.reassignTable &&
        typeof this.$refs.reassignTable.setCurrentRow === "function"
      ) {
        this.$refs.reassignTable.setCurrentRow();
      }
    },
    openReassignDialog(workItem, currentContentKey) {
      if (!workItem || !workItem.workKey) return;
      this.reassignSource = {
        workKey: workItem.workKey,
        platform: workItem.platform || "",
        group: workItem.group || "",
        title: workItem.title || "(无标题)",
      };
      this.reassignCurrentKey = currentContentKey || null;
      this.reassignKeyword = "";
      this.reassignTargetKey = "";
      this.clearReassignTableCurrentRow();
      this.reassignVisible = true;
      if (typeof this.$nextTick === "function") {
        this.$nextTick(() => this.clearReassignTableCurrentRow());
      }
    },
    onSelectReassignTarget(row) {
      this.reassignTargetKey = row && row.contentKey ? row.contentKey : "";
    },
    onClickReassignTarget(row) {
      this.reassignTargetKey = row && row.contentKey ? row.contentKey : "";
      if (
        row &&
        this.$refs &&
        this.$refs.reassignTable &&
        typeof this.$refs.reassignTable.setCurrentRow === "function"
      ) {
        this.$refs.reassignTable.setCurrentRow(row);
      }
    },
    resetReassignDialog() {
      this.reassignSource = null;
      this.reassignCurrentKey = null;
      this.reassignKeyword = "";
      this.reassignTargetKey = "";
      this.clearReassignTableCurrentRow();
    },
    async submitReassign() {
      if (this.mutatingLink || !this.reassignSource || !this.reassignTargetKey) return;
      this.mutatingLink = true;
      try {
        const res = await ipcRenderer.invoke("stats:set-link-override", {
          workKey: this.reassignSource.workKey,
          action: "assign",
          contentKey: this.reassignTargetKey,
        });
        if (!res || !res.ok) {
          this.$message.error((res && res.error) || "合并失败");
          return;
        }
        this.reassignVisible = false;
        this.$message.success("已更新作品归属");
        await this.loadContentSummary();
      } catch (err) {
        this.$message.error(`合并失败：${(err && err.message) || err}`);
      } finally {
        this.mutatingLink = false;
      }
    },
    async detachWork(workItem) {
      if (this.mutatingLink || !workItem || !workItem.workKey) return;
      this.mutatingLink = true;
      try {
        const res = await ipcRenderer.invoke("stats:set-link-override", {
          workKey: workItem.workKey,
          action: "detach",
        });
        if (!res || !res.ok) {
          this.$message.error((res && res.error) || "拆出作品失败");
          return;
        }
        this.$message.success("已拆出为未关联作品");
        await this.loadContentSummary();
      } catch (err) {
        this.$message.error(`拆出作品失败：${(err && err.message) || err}`);
      } finally {
        this.mutatingLink = false;
      }
    },
    async clearWorkOverride(workItem) {
      if (this.mutatingLink || !workItem || !workItem.workKey) return;
      this.mutatingLink = true;
      try {
        const res = await ipcRenderer.invoke("stats:clear-link-override", {
          workKey: workItem.workKey,
        });
        if (!res || !res.ok) {
          this.$message.error((res && res.error) || "恢复自动关联失败");
          return;
        }
        this.$message.success("已恢复自动关联");
        await this.loadContentSummary();
      } catch (err) {
        this.$message.error(`恢复自动关联失败：${(err && err.message) || err}`);
      } finally {
        this.mutatingLink = false;
      }
    },
    async confirmSingleWork(workItem, contentKey, row) {
      if (this.mutatingLink || !workItem || !workItem.workKey || !contentKey) return;
      if (row && !this.isRowAssignableTarget(row)) return;
      if (UNSTABLE_RECORD_KEY_RE.test(String(contentKey))) return;
      this.mutatingLink = true;
      try {
        const res = await ipcRenderer.invoke("stats:set-link-override", {
          workKey: workItem.workKey,
          action: "assign",
          contentKey,
        });
        if (!res || !res.ok) {
          this.$message.error((res && res.error) || "确认关联失败");
          return;
        }
        this.$message.success("已确认为手动关联");
        await this.loadContentSummary();
      } catch (err) {
        this.$message.error(`确认关联失败：${(err && err.message) || err}`);
      } finally {
        this.mutatingLink = false;
      }
    },
    async confirmFuzzyRow(row) {
      if (this.mutatingLink || !row || !row.contentKey || !this.isRowAssignableTarget(row)) return;
      const works = this.perPlatformWorkList(row);
      const isAutoCluster =
        typeof row.contentKey === "string" && row.contentKey.startsWith("auto:");
      const targets = works.filter((w) => {
        if (!w.workKey) return false;
        if (isAutoCluster) return w.matchedBy !== "manual";
        return w.matchedBy === "fuzzy";
      });
      if (!targets.length) return;
      const ops = targets.map((w) => ({
        action: "assign",
        workKey: w.workKey,
        contentKey: row.contentKey,
      }));
      this.mutatingLink = true;
      try {
        const res = await ipcRenderer.invoke("stats:apply-link-overrides", { ops });
        if (!res || !res.ok) {
          this.$message.error((res && res.error) || "确认关联失败");
          await this.loadContentSummary();
          return;
        }
        this.$message.success("已确认为手动关联");
        await this.loadContentSummary();
      } catch (err) {
        this.$message.error(`确认关联失败：${(err && err.message) || err}`);
        await this.loadContentSummary();
      } finally {
        this.mutatingLink = false;
      }
    },
    async mergeSelectedUnlinked() {
      if (this.mutatingLink) return;
      const workKeys = this.selectedUnlinkedWorks
        .map((w) => w && w.workKey)
        .filter(Boolean);
      if (workKeys.length < 2) {
        this.$message.warning("请至少选择 2 条未关联作品");
        return;
      }
      this.mutatingLink = true;
      try {
        const res = await ipcRenderer.invoke("stats:apply-link-overrides", {
          ops: [{ action: "merge", workKeys }],
        });
        if (!res || !res.ok) {
          this.$message.error((res && res.error) || "合并作品失败");
          return;
        }
        this.$message.success(`已将 ${workKeys.length} 条作品合并为同一视频`);
        await this.loadContentSummary();
      } catch (err) {
        this.$message.error(`合并作品失败：${(err && err.message) || err}`);
      } finally {
        this.mutatingLink = false;
      }
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

.works-filter-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}

.unlinked-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.match-cell {
  display: flex;
  align-items: center;
  gap: 6px;
}

.inline-confirm-btn {
  padding: 0 4px;
}

.work-row-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.reassign-source {
  margin-bottom: 10px;
  font-size: 13px;
  color: #606266;
  line-height: 1.5;
  word-break: break-all;
}

.reassign-search {
  margin-bottom: 10px;
}
</style>
