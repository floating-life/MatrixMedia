<template>
  <div class="publish-growth">
    <div class="growth-toolbar">
      <el-button
        type="primary"
        size="medium"
        icon="el-icon-refresh"
        class="sync-btn"
        :loading="syncing"
        @click="$emit('sync')"
      >
        {{ syncing ? "同步中…" : "同步当前页发布数据" }}
      </el-button>
      <span v-if="lastSyncText" class="last-sync">上次同步：{{ lastSyncText }}</span>
    </div>
    <div class="growth-tip">
      数值为最新采集的累计值；『下条发布前播放』为下一条视频发布那一刻本条的播放量，用于比较两次发布之间的增长。
    </div>
    <el-table :data="pageRows" border stripe class="growth-table">
      <el-table-column type="index" label="#" width="56" :index="indexOffset" />
      <el-table-column label="视频标题" min-width="160">
        <template #default="{ row }">
          <span class="work-title" :title="row.title">{{ row.title }}</span>
        </template>
      </el-table-column>
      <el-table-column label="发布日期" width="150">
        <template #default="{ row }">{{ fmtTime(row.publishTime) }}</template>
      </el-table-column>
      <el-table-column label="播放" width="100" align="right">
        <template #default="{ row }">
          <span class="num">{{ showNum(displayOf(row).play) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="下条发布前播放" width="136" align="right">
        <template #default="{ row }">
          <el-tooltip
            v-if="hasClosedStats(row)"
            placement="top"
            :content="closedTooltipOf(row)"
          >
            <span
              class="num closed-play"
              :class="{ muted: closedPlayOf(row) === '-' }"
            >{{ closedPlayOf(row) }}</span>
          </el-tooltip>
          <span v-else class="num muted">-</span>
        </template>
      </el-table-column>
      <el-table-column label="点赞" width="100" align="right">
        <template #default="{ row }">
          <span class="num">{{ showNum(displayOf(row).like) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="收藏" width="100" align="right">
        <template #default="{ row }">
          <span class="num">{{ showNum(displayOf(row).favorite) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="分享" width="100" align="right">
        <template #default="{ row }">
          <span class="num">{{ showNum(displayOf(row).share) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="评论" width="100" align="right">
        <template #default="{ row }">
          <span class="num">{{ showNum(displayOf(row).comment) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="关注变化" width="100" align="right">
        <template #default="{ row }">
          <span
            v-if="displayOf(row).fansDelta != null"
            class="num"
            :class="{ down: displayOf(row).fansDelta < 0 }"
          >
            {{ displayOf(row).fansDelta > 0 ? "+" : "" }}{{ displayOf(row).fansDelta }}
          </span>
          <span v-else class="num muted">-</span>
        </template>
      </el-table-column>
      <template #empty>
        <span class="empty-text">暂无作品数据，点击上方「同步当前页发布数据」</span>
      </template>
    </el-table>
    <div class="growth-pager">
      <el-pagination
        background
        layout="total, prev, pager, next"
        :total="works.length"
        :page-size="pageSize"
        :current-page.sync="page"
      />
    </div>
  </div>
</template>

<script>
const PAGE_SIZE = 10;

export function formatTime(ms) {
  if (ms == null || ms === "" || ms === 0 || typeof ms === "boolean") return "-";
  const raw =
    typeof ms === "string" && /^\d+$/.test(ms.trim()) ? Number(ms.trim()) : ms;
  if (typeof raw === "number" && (!Number.isFinite(raw) || raw <= 0)) return "-";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "-";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}`;
}

export function formatNum(v) {
  if (v == null || v === "" || typeof v === "boolean") return "-";
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString("zh-CN");
}

function normalizeFansDelta(v) {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 指标列默认展示最新采集的当前累计值（row 自身字段，不被 closedStats 覆盖） */
export function currentStatsOf(row) {
  if (!row || typeof row !== "object") {
    return {
      play: null,
      like: null,
      favorite: null,
      share: null,
      comment: null,
      fansDelta: null,
    };
  }
  return {
    play: row.play != null ? row.play : null,
    like: row.like != null ? row.like : null,
    favorite: row.favorite != null ? row.favorite : null,
    share: row.share != null ? row.share : null,
    comment: row.comment != null ? row.comment : null,
    fansDelta: normalizeFansDelta(row.fansDelta),
  };
}

/** 是否存在封闭统计快照 */
export function hasClosedStats(row) {
  return Boolean(
    row &&
      row.closedStats &&
      typeof row.closedStats === "object" &&
      !Array.isArray(row.closedStats)
  );
}

/** 「下条发布前播放」单元格展示值：有 closedStats 显示 closedStats.play，否则显示 "-" */
export function closedPlayOf(row) {
  if (!hasClosedStats(row)) return "-";
  return formatNum(row.closedStats.play);
}

/** 「下条发布前播放」tooltip：显示封闭时间 closedAt 与封闭时的点赞/评论 */
export function closedTooltipOf(row) {
  if (!hasClosedStats(row)) return "";
  const cs = row.closedStats;
  const closedTime = formatTime(row.closedAt);
  const closedLike = formatNum(cs.like);
  const closedComment = formatNum(cs.comment);
  return `封闭时间：${closedTime}｜封闭时点赞：${closedLike}｜封闭时评论：${closedComment}`;
}

export default {
  name: "PublishGrowth",
  props: {
    works: { type: Array, default: () => [] },
    syncing: { type: Boolean, default: false },
    lastCollectAt: { type: Number, default: 0 },
  },
  data() {
    return {
      pageSize: PAGE_SIZE,
      page: 1,
    };
  },
  computed: {
    pageRows() {
      const start = (this.page - 1) * this.pageSize;
      return this.works.slice(start, start + this.pageSize);
    },
    lastSyncText() {
      if (!this.lastCollectAt) return "";
      const text = formatTime(this.lastCollectAt);
      return text === "-" ? "" : text;
    },
  },
  methods: {
    indexOffset(i) {
      return (this.page - 1) * this.pageSize + i + 1;
    },
    // 默认展示当前累计值（row 自身字段）
    displayOf(row) {
      return currentStatsOf(row);
    },
    hasClosedStats(row) {
      return hasClosedStats(row);
    },
    closedPlayOf(row) {
      return closedPlayOf(row);
    },
    closedTooltipOf(row) {
      return closedTooltipOf(row);
    },
    fmtTime(ms) {
      return formatTime(ms);
    },
    showNum(v) {
      return formatNum(v);
    },
  },
};
</script>

<style lang="scss" scoped>
@import "@/styles/variables.scss";

.publish-growth {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.growth-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
}

.sync-btn {
  min-width: 200px;
}

.last-sync {
  font-size: 12px;
  color: #909399;
}

.growth-tip {
  font-size: 12px;
  line-height: 1.7;
  color: #606266;
  background: #f4f4f5;
  border-radius: 4px;
  padding: 8px 12px;
}

.growth-table {
  width: 100%;
}

.work-title {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
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

.closed-play {
  cursor: help;
  border-bottom: 1px dashed #c0c4cc;
}

.growth-pager {
  display: flex;
  justify-content: flex-end;
}

.empty-text {
  font-size: 13px;
  color: #909399;
}
</style>
