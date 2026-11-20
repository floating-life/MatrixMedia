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
          :picker-options="analysisDatePickerOptions"
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
      <div class="auto-collect-row">
        <div class="auto-collect-controls">
          <span class="auto-collect-label">自动采集</span>
          <el-switch
            v-model="autoCollect.enabled"
            @change="onAutoCollectChange"
          />
          <el-radio-group
            v-model="autoCollect.mode"
            size="mini"
            :disabled="!autoCollect.enabled"
            @change="onAutoCollectChange"
          >
            <el-radio-button label="daily">每日一次</el-radio-button>
            <el-radio-button label="interval">分时段循环</el-radio-button>
          </el-radio-group>
          <template v-if="autoCollect.mode !== 'interval'">
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
          </template>
          <template v-else>
            <el-time-select
              v-model="autoCollect.startTime"
              size="mini"
              class="auto-collect-time"
              :disabled="!autoCollect.enabled"
              :clearable="false"
              :editable="false"
              :picker-options="{ start: '00:00', step: '00:30', end: '23:30' }"
              placeholder="开始时间"
              @change="onAutoCollectChange"
            />
            <span class="auto-collect-sep">至</span>
            <el-time-select
              v-model="autoCollect.endTime"
              size="mini"
              class="auto-collect-time"
              :disabled="!autoCollect.enabled"
              :clearable="false"
              :editable="false"
              :picker-options="{ start: '00:00', step: '00:30', end: '23:30' }"
              placeholder="结束时间"
              @change="onAutoCollectChange"
            />
            <el-select
              v-model="autoCollect.intervalHours"
              size="mini"
              class="auto-collect-interval"
              :disabled="!autoCollect.enabled"
              @change="onAutoCollectChange"
            >
              <el-option
                v-for="h in intervalHoursOptions"
                :key="h"
                :label="`每 ${h} 小时`"
                :value="h"
              />
            </el-select>
          </template>
        </div>
        <span class="auto-collect-last">
          上次自动采集：{{ autoCollect.lastRunSlot || autoCollect.lastRunDate || "暂无" }}
        </span>
      </div>
      <div v-if="autoCollect.mode === 'interval'" class="auto-collect-warning">
        采集越频繁越容易触发平台风控；部分平台作品数据本身每天才更新，分时段曲线可能是平的
      </div>
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
            <el-table-column
              prop="lastCollectedAt"
              label="最近采集"
              width="116"
              sortable
              :sort-method="sortLastCollectedAt"
            >
              <template #default="{ row }">
                <span
                  class="num"
                  :class="{ muted: !row.lastCollectedAt }"
                  :title="formatUtc8FullDateTime(row.lastCollectedAt)"
                >
                  {{ formatUtc8ShortDateTime(row.lastCollectedAt) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="趋势" width="72" align="center">
              <template #default="{ row }">
                <el-button
                  type="text"
                  size="mini"
                  @click.stop="openContentTrend(row)"
                >
                  趋势
                </el-button>
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
            <el-table-column
              prop="lastCollectedAt"
              label="最近采集"
              width="116"
              sortable
              :sort-method="sortLastCollectedAt"
            >
              <template #default="{ row }">
                <span
                  class="num"
                  :class="{ muted: !row.lastCollectedAt }"
                  :title="formatUtc8FullDateTime(row.lastCollectedAt)"
                >
                  {{ formatUtc8ShortDateTime(row.lastCollectedAt) }}
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
            <el-table-column label="操作" width="200">
              <template #default="{ row }">
                <div class="work-row-actions">
                  <el-button
                    type="text"
                    size="mini"
                    @click="openContentTrend({ contentKey: 'unlinked:' + row.platform + ':' + row.workId, title: row.title })"
                  >
                    趋势
                  </el-button>
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
        <el-dialog
          :title="contentTrendDialogTitle"
          :visible.sync="contentTrendVisible"
          width="820px"
          append-to-body
          @opened="onContentTrendDialogOpened"
          @closed="resetContentTrendDialog"
        >
          <div class="trend-dialog-head">
            <div class="trend-dialog-controls">
              <el-radio-group
                v-model="contentTrendMode"
                size="mini"
                @change="onContentTrendModeChange"
              >
                <el-radio-button label="daily">按天</el-radio-button>
                <el-radio-button label="intraday">按时段</el-radio-button>
              </el-radio-group>
              <el-radio-group
                v-if="contentTrendMode === 'intraday'"
                v-model="contentIntradayDays"
                size="mini"
                @change="loadContentIntraday"
              >
                <el-radio-button :label="1">近1天</el-radio-button>
                <el-radio-button :label="3">近3天</el-radio-button>
                <el-radio-button :label="7">近7天</el-radio-button>
              </el-radio-group>
              <span class="trend-dialog-tip">
                <template v-if="activeContentTrendData && activeContentTrendData.from && activeContentTrendData.to">
                  区间：{{ activeContentTrendData.from }} ~ {{ activeContentTrendData.to }}
                </template>
                <template v-if="activeContentTrendData && activeContentTrendData.date">
                  · 截至 {{ activeContentTrendData.date }}
                </template>
                <template v-else-if="contentSummaryDate">
                  截至 {{ contentSummaryDate }}
                </template>
              </span>
            </div>
            <el-button
              type="text"
              size="mini"
              icon="el-icon-download"
              :disabled="loadingContentTrend || isChartOptionEmpty(contentTrendOption)"
              @click="saveChartImage('chartContentTrend', (contentTrendMode === 'intraday' ? '作品分时段-' : '作品趋势-') + (contentTrendRow && contentTrendRow.title ? contentTrendRow.title : '内容'), contentTrendChartDate)"
            >
              保存图片
            </el-button>
          </div>
          <stats-chart
            ref="chartContentTrend"
            :option="contentTrendOption"
            :loading="loadingContentTrend"
            height="360px"
          />
          <template #footer>
            <el-button size="small" @click="contentTrendVisible = false">关闭</el-button>
          </template>
        </el-dialog>
      </el-tab-pane>
      <el-tab-pane label="数据分析" name="analysis" lazy>
        <div v-loading="loadingAnalysis" class="analysis-panel">
          <div class="platform-card analysis-toolbar-card">
            <div class="analysis-toolbar">
              <div class="analysis-controls">
                <el-radio-group
                  v-model="analysisPeriod"
                  size="mini"
                  @change="loadAnalysis"
                >
                  <el-radio-button :label="7">近7天</el-radio-button>
                  <el-radio-button :label="30">近30天</el-radio-button>
                </el-radio-group>
                <el-date-picker
                  v-model="analysisTo"
                  type="date"
                  size="mini"
                  class="analysis-date-picker"
                  value-format="yyyy-MM-dd"
                  :picker-options="analysisDatePickerOptions"
                  clearable
                  :editable="false"
                  placeholder="默认最新快照日"
                  @change="loadAnalysis"
                />
                <span v-if="analysisData && analysisData.currentRange" class="card-tip">
                  周期：{{ analysisData.currentRange.from }} ~ {{ analysisData.to }} · 已积累
                  {{ analysisData.snapshotDays }} 天作品快照
                </span>
              </div>
              <div class="analysis-actions">
                <el-button
                  size="mini"
                  icon="el-icon-picture-outline"
                  :loading="exportingAllCharts"
                  :disabled="!analysisData || exportingAllCharts"
                  @click="exportAllCharts"
                >
                  {{ exportingAllCharts ? "导出中…" : "导出全部图表" }}
                </el-button>
                <el-button
                  size="mini"
                  icon="el-icon-document-copy"
                  :disabled="!analysisSummaryText"
                  @click="copyAnalysisSummary"
                >
                  复制小结
                </el-button>
              </div>
            </div>
          </div>

          <div v-if="analysisData" class="analysis-sections">
            <!-- 7. 文字小结（置顶） -->
            <div class="platform-card analysis-summary-card">
              <div class="card-head">
                <span class="card-title">分析小结</span>
                <span class="card-tip">纯规则计算 · 与 Excel「分析」sheet 同口径</span>
              </div>
              <ul class="analysis-summary-list">
                <li
                  v-for="(line, idx) in analysisSummaryLines"
                  :key="idx"
                  :class="{
                    'is-warning':
                      analysisData.summary &&
                      analysisData.summary.lowHistoryNotice &&
                      idx === analysisSummaryLines.length - 1,
                  }"
                >
                  {{ line }}
                </li>
              </ul>
            </div>

            <!-- 1. 总览 -->
            <div class="platform-card">
              <div class="card-head">
                <span class="card-title">1. 总览（周期对比与平台贡献）</span>
                <span v-if="analysisData.previousRange" class="card-tip">
                  对比上周期：{{ analysisData.previousRange.from }} ~
                  {{ analysisData.previousRange.to }}（已剔除疑似采集异常点）
                </span>
              </div>
              <div class="chart-grid-overview">
                <div class="chart-box">
                  <div class="chart-box-head">
                    <div class="chart-box-title-wrap">
                      <span class="chart-box-title">各平台日增趋势</span>
                      <div class="chart-inline-controls">
                        <el-radio-group v-model="overviewTrendMetric" size="mini">
                          <el-radio-button
                            v-for="m in overviewTrendMetricOptions"
                            :key="m.key"
                            :label="m.key"
                          >
                            {{ m.label }}
                          </el-radio-button>
                        </el-radio-group>
                        <el-checkbox v-model="overviewTrendStacked" size="mini">
                          堆叠面积
                        </el-checkbox>
                      </div>
                    </div>
                    <el-button
                      type="text"
                      size="mini"
                      icon="el-icon-download"
                      :disabled="isChartOptionEmpty(overviewTrendOption)"
                      @click="saveChartImage('chartOverviewTrend', '总览-日趋势-' + overviewTrendMetricLabel, analysisChartDate)"
                    >
                      保存图片
                    </el-button>
                  </div>
                  <stats-chart
                    ref="chartOverviewTrend"
                    :option="overviewTrendOption"
                    height="320px"
                  />
                </div>
                <div class="chart-box">
                  <div class="chart-box-head">
                    <span class="chart-box-title">平台播放日增占比</span>
                    <el-button
                      type="text"
                      size="mini"
                      icon="el-icon-download"
                      :disabled="isChartOptionEmpty(overviewPieOption)"
                      @click="saveChartImage('chartOverviewPie', '总览-平台占比', analysisChartDate)"
                    >
                      保存图片
                    </el-button>
                  </div>
                  <stats-chart
                    ref="chartOverviewPie"
                    :option="overviewPieOption"
                    height="320px"
                  />
                </div>
              </div>
              <el-table
                :data="analysisOverviewMetricRows"
                size="mini"
                border
                stripe
                class="analysis-table"
              >
                <el-table-column prop="label" label="指标" width="100" />
                <el-table-column label="本周期日增" align="right" min-width="120">
                  <template #default="{ row }">
                    <span class="num" :class="{ muted: row.current == null }">
                      {{ showNum(row.current) }}
                    </span>
                  </template>
                </el-table-column>
                <el-table-column label="上周期日增" align="right" min-width="120">
                  <template #default="{ row }">
                    <span class="num" :class="{ muted: row.previous == null }">
                      {{ showNum(row.previous) }}
                    </span>
                  </template>
                </el-table-column>
                <el-table-column label="环比" align="right" width="120">
                  <template #default="{ row }">
                    <span
                      v-if="row.momPct != null"
                      class="num"
                      :class="{ up: row.momPct > 0, down: row.momPct < 0 }"
                    >
                      {{ row.momPct > 0 ? "+" : "" }}{{ row.momPct }}%
                    </span>
                    <span v-else class="num muted">-</span>
                  </template>
                </el-table-column>
              </el-table>

              <div class="sub-block-title">各平台贡献占比（按播放日增）</div>
              <el-table
                :data="analysisPlatformContribution"
                size="mini"
                border
                stripe
                class="analysis-table"
              >
                <el-table-column prop="platform" label="平台" width="96" />
                <el-table-column label="播放日增" align="right" width="110">
                  <template #default="{ row }">
                    <span class="num" :class="{ muted: row.play == null }">
                      {{ showNum(row.play) }}
                    </span>
                  </template>
                </el-table-column>
                <el-table-column label="播放贡献占比" min-width="200">
                  <template #default="{ row }">
                    <div class="bar-cell">
                      <div class="css-bar-track">
                        <div
                          class="css-bar-fill primary"
                          :style="{ width: calcPercentWidth(row.sharePct, 100) }"
                        />
                      </div>
                      <span class="num bar-val" :class="{ muted: row.sharePct == null }">
                        {{ row.sharePct != null ? row.sharePct + "%" : "-" }}
                      </span>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column label="点赞日增" align="right" width="90">
                  <template #default="{ row }">
                    <span class="num" :class="{ muted: row.like == null }">{{ showNum(row.like) }}</span>
                  </template>
                </el-table-column>
                <el-table-column label="评论日增" align="right" width="90">
                  <template #default="{ row }">
                    <span class="num" :class="{ muted: row.comment == null }">{{ showNum(row.comment) }}</span>
                  </template>
                </el-table-column>
                <el-table-column label="分享日增" align="right" width="90">
                  <template #default="{ row }">
                    <span class="num" :class="{ muted: row.share == null }">{{ showNum(row.share) }}</span>
                  </template>
                </el-table-column>
                <el-table-column label="涨粉日增" align="right" width="90">
                  <template #default="{ row }">
                    <span class="num" :class="{ muted: row.fansDelta == null }">{{ showNum(row.fansDelta) }}</span>
                  </template>
                </el-table-column>
                <template #empty>
                  <span class="card-empty-inline">本周期暂无平台播放日增数据</span>
                </template>
              </el-table>
            </div>

            <!-- 2. 平台对比 -->
            <div class="platform-card">
              <div class="card-head">
                <span class="card-title">2. 平台对比（覆盖 ≥2 平台同款内容）</span>
                <span class="card-tip">
                  共
                  {{
                    analysisData.platformComparison
                      ? analysisData.platformComparison.multiPlatformContentCount
                      : 0
                  }}
                  条跨平台内容 · 互动率=(点赞+评论+分享)/播放
                </span>
              </div>
              <div v-if="analysisPlatformConclusions.length" class="conclusion-box">
                <div v-for="(line, idx) in analysisPlatformConclusions" :key="idx">
                  {{ line }}
                </div>
              </div>
              <div class="chart-box chart-box-block">
                <div class="chart-box-head">
                  <span class="chart-box-title">各平台平均播放与互动率对比</span>
                  <el-button
                    type="text"
                    size="mini"
                    icon="el-icon-download"
                    :disabled="isChartOptionEmpty(platformCompareOption)"
                    @click="saveChartImage('chartPlatformCompare', '平台对比', analysisChartDate)"
                  >
                    保存图片
                  </el-button>
                </div>
                <stats-chart
                  ref="chartPlatformCompare"
                  :option="platformCompareOption"
                  height="300px"
                />
              </div>
              <el-table
                :data="analysisPlatformCompareRows"
                size="mini"
                border
                stripe
                class="analysis-table"
              >
                <el-table-column prop="platform" label="平台" width="96" />
                <el-table-column label="样本数" width="120">
                  <template #default="{ row }">
                    <span class="num">{{ row.sampleCount }}</span>
                    <el-tag
                      v-if="row.lowSample"
                      type="warning"
                      size="mini"
                      class="inline-tag"
                    >
                      样本少
                    </el-tag>
                  </template>
                </el-table-column>
                <el-table-column label="平均播放" min-width="190">
                  <template #default="{ row }">
                    <div class="bar-cell">
                      <div class="css-bar-track">
                        <div
                          class="css-bar-fill primary"
                          :style="{ width: calcPercentWidth(row.avgPlay, analysisCompareMaxPlay) }"
                        />
                      </div>
                      <span class="num bar-val" :class="{ muted: row.avgPlay == null }">
                        {{ showNum(row.avgPlay) }}
                      </span>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column label="互动率" min-width="170">
                  <template #default="{ row }">
                    <div class="bar-cell">
                      <div class="css-bar-track">
                        <div
                          class="css-bar-fill success"
                          :style="{
                            width: calcPercentWidth(
                              row.engagementRatePct,
                              analysisCompareMaxEng
                            ),
                          }"
                        />
                      </div>
                      <span
                        class="num bar-val"
                        :class="{ muted: row.engagementRatePct == null }"
                      >
                        {{ row.engagementRatePct != null ? row.engagementRatePct + "%" : "-" }}
                      </span>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column label="平均涨粉" align="right" width="100">
                  <template #default="{ row }">
                    <span class="num" :class="{ muted: row.avgFansDelta == null }">
                      {{ showNum(row.avgFansDelta) }}
                    </span>
                  </template>
                </el-table-column>
                <template #empty>
                  <span class="card-empty-inline">暂无覆盖 2 个及以上平台的同款内容</span>
                </template>
              </el-table>
            </div>

            <!-- 3. 作品排行与平台偏科 -->
            <div class="platform-card">
              <div class="card-head">
                <span class="card-title">3. 作品排行与平台偏科</span>
                <span class="card-tip">
                  跨平台合并后截至 {{ analysisData.to }} · 互动率仅统计总播放 ≥ 100 的内容
                </span>
              </div>
              <div class="analysis-sub-controls">
                <el-radio-group v-model="analysisRankMetric" size="mini">
                  <el-radio-button label="play">总播放</el-radio-button>
                  <el-radio-button label="engagement">互动率</el-radio-button>
                  <el-radio-button label="fans">总涨粉</el-radio-button>
                </el-radio-group>
                <el-radio-group v-model="analysisRankOrder" size="mini">
                  <el-radio-button label="top">Top 10</el-radio-button>
                  <el-radio-button label="bottom">Bottom 10</el-radio-button>
                </el-radio-group>
              </div>
              <div class="chart-box chart-box-block">
                <div class="chart-box-head">
                  <span class="chart-box-title">{{ analysisRankOrderLabel }} 横向对比（按平台堆叠 · {{ analysisRankMetricShortLabel }}）</span>
                  <el-button
                    type="text"
                    size="mini"
                    icon="el-icon-download"
                    :disabled="isChartOptionEmpty(rankingTop10Option)"
                    @click="saveChartImage('chartRankingTop10', '作品排行' + analysisRankOrderShortLabel + '-' + analysisRankMetricShortLabel, analysisChartDate)"
                  >
                    保存图片
                  </el-button>
                </div>
                <stats-chart
                  ref="chartRankingTop10"
                  :option="rankingTop10Option"
                  height="360px"
                />
              </div>
              <el-table
                :data="analysisDisplayedRankRows"
                size="mini"
                border
                stripe
                class="analysis-table"
              >
                <el-table-column label="#" width="50" align="center">
                  <template #default="{ $index }">
                    <span class="num">{{ $index + 1 }}</span>
                  </template>
                </el-table-column>
                <el-table-column prop="title" label="内容标题" min-width="200" show-overflow-tooltip />
                <el-table-column prop="firstPublishDate" label="首发日期" width="102">
                  <template #default="{ row }">
                    <span class="num" :class="{ muted: !row.firstPublishDate }">
                      {{ row.firstPublishDate || "-" }}
                    </span>
                  </template>
                </el-table-column>
                <el-table-column prop="platformCount" label="平台数" width="68" align="right" />
                <el-table-column :label="analysisRankMetricLabel" min-width="190">
                  <template #default="{ row }">
                    <div class="bar-cell">
                      <div class="css-bar-track">
                        <div
                          class="css-bar-fill primary"
                          :style="{ width: calcRankBarWidth(row) }"
                        />
                      </div>
                      <span class="num bar-val">
                        {{ formatRankPrimaryValue(row) }}
                      </span>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column label="总播放" width="96" align="right">
                  <template #default="{ row }">
                    <span class="num" :class="{ muted: row.totalPlay == null }">
                      {{ showNum(row.totalPlay) }}
                    </span>
                  </template>
                </el-table-column>
                <el-table-column label="互动率" width="84" align="right">
                  <template #default="{ row }">
                    <span class="num" :class="{ muted: row.engagementRatePct == null }">
                      {{ row.engagementRatePct != null ? row.engagementRatePct + "%" : "-" }}
                    </span>
                  </template>
                </el-table-column>
                <el-table-column label="总涨粉" width="84" align="right">
                  <template #default="{ row }">
                    <span class="num" :class="{ muted: row.totalFansDelta == null }">
                      {{ showNum(row.totalFansDelta) }}
                    </span>
                  </template>
                </el-table-column>
                <template #empty>
                  <span class="card-empty-inline">暂无符合条件的作品排行数据</span>
                </template>
              </el-table>

              <div class="sub-block-title">
                平台偏科（某平台播放 ≥ 其它平台均值 3 倍且 ≥ 500，共
                {{ analysisPlatformSkewRows.length }} 条）
              </div>
              <el-table
                :data="analysisPlatformSkewRows"
                size="mini"
                border
                stripe
                class="analysis-table"
              >
                <el-table-column prop="title" label="内容标题" min-width="200" show-overflow-tooltip />
                <el-table-column prop="platform" label="突出平台" width="96" />
                <el-table-column label="该平台播放" width="110" align="right">
                  <template #default="{ row }">
                    <span class="num">{{ showNum(row.platformPlay) }}</span>
                  </template>
                </el-table-column>
                <el-table-column label="其它平台均播" width="110" align="right">
                  <template #default="{ row }">
                    <span class="num">{{ showNum(row.otherAvgPlay) }}</span>
                  </template>
                </el-table-column>
                <el-table-column label="倍数" width="90" align="right">
                  <template #default="{ row }">
                    <span class="num">
                      {{ row.ratio != null ? row.ratio + "x" : "极高(它端0)" }}
                    </span>
                  </template>
                </el-table-column>
                <template #empty>
                  <span class="card-empty-inline">暂未发现明显平台偏科内容</span>
                </template>
              </el-table>
            </div>

            <!-- 4. 新作品走势 -->
            <div class="platform-card">
              <div class="card-head">
                <span class="card-title">4. 新作品走势（本周期发布 D1 / D3 / D7）</span>
                <div class="category-tags">
                  <el-tag size="mini" type="success">
                    长尾型 {{ analysisNewWorkCounts.长尾型 }}
                  </el-tag>
                  <el-tag size="mini" type="info">
                    爆发后平稳 {{ analysisNewWorkCounts.爆发后平稳 }}
                  </el-tag>
                  <el-tag size="mini" type="primary">
                    其它 {{ analysisNewWorkCounts.其它 }}
                  </el-tag>
                  <el-tag size="mini" type="warning">
                    数据不足 {{ analysisNewWorkCounts.数据不足 }}
                  </el-tag>
                </div>
              </div>
              <div class="chart-grid-newworks">
                <div class="chart-box">
                  <div class="chart-box-head">
                    <span class="chart-box-title">新作品 D1 / D3 / D7 走势（按 D7 Top 10）</span>
                    <el-button
                      type="text"
                      size="mini"
                      icon="el-icon-download"
                      :disabled="isChartOptionEmpty(newWorksLineOption)"
                      @click="saveChartImage('chartNewWorksLine', '新作品走势-D1D3D7', analysisChartDate)"
                    >
                      保存图片
                    </el-button>
                  </div>
                  <stats-chart
                    ref="chartNewWorksLine"
                    :option="newWorksLineOption"
                    height="320px"
                  />
                </div>
                <div class="chart-box">
                  <div class="chart-box-head">
                    <span class="chart-box-title">走势分类占比</span>
                    <el-button
                      type="text"
                      size="mini"
                      icon="el-icon-download"
                      :disabled="isChartOptionEmpty(newWorksPieOption)"
                      @click="saveChartImage('chartNewWorksPie', '新作品走势-分类占比', analysisChartDate)"
                    >
                      保存图片
                    </el-button>
                  </div>
                  <stats-chart
                    ref="chartNewWorksPie"
                    :option="newWorksPieOption"
                    height="320px"
                  />
                </div>
              </div>
              <el-table
                :data="analysisNewWorkRows"
                row-key="contentKey"
                size="mini"
                border
                stripe
                class="analysis-table"
              >
                <el-table-column type="expand">
                  <template #default="{ row }">
                    <div class="expand-box">
                      <el-table
                        :data="row.platforms || []"
                        size="mini"
                        border
                        class="expand-table"
                      >
                        <el-table-column prop="platform" label="平台" width="90" />
                        <el-table-column prop="publishDate" label="发布日期" width="104" />
                        <el-table-column label="D1 播放" align="right" width="96">
                          <template #default="{ row: p }">
                            <span class="num" :class="{ muted: p.d1Play == null }">
                              {{ showNum(p.d1Play) }}
                            </span>
                          </template>
                        </el-table-column>
                        <el-table-column label="D3 播放" align="right" width="96">
                          <template #default="{ row: p }">
                            <span class="num" :class="{ muted: p.d3Play == null }">
                              {{ showNum(p.d3Play) }}
                            </span>
                          </template>
                        </el-table-column>
                        <el-table-column label="D7 播放" align="right" width="96">
                          <template #default="{ row: p }">
                            <span class="num" :class="{ muted: p.d7Play == null }">
                              {{ showNum(p.d7Play) }}
                            </span>
                          </template>
                        </el-table-column>
                        <el-table-column label="D3/D1" align="right" width="80">
                          <template #default="{ row: p }">
                            <span class="num" :class="{ muted: p.d3ToD1 == null }">
                              {{ p.d3ToD1 != null ? p.d3ToD1 + "x" : "-" }}
                            </span>
                          </template>
                        </el-table-column>
                        <el-table-column label="D7/D3" align="right" width="80">
                          <template #default="{ row: p }">
                            <span class="num" :class="{ muted: p.d7ToD3 == null }">
                              {{ p.d7ToD3 != null ? p.d7ToD3 + "x" : "-" }}
                            </span>
                          </template>
                        </el-table-column>
                        <el-table-column label="分类" width="102">
                          <template #default="{ row: p }">
                            <el-tag :type="trajectoryTagType(p.category)" size="mini">
                              {{ p.category }}
                            </el-tag>
                          </template>
                        </el-table-column>
                        <el-table-column label="分类依据" min-width="116" show-overflow-tooltip>
                          <template #default="{ row: p }">
                            <span :class="{ muted: !p.classificationBasis }">
                              {{ p.classificationBasis || "-" }}
                            </span>
                          </template>
                        </el-table-column>
                      </el-table>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column prop="title" label="内容标题" min-width="180" show-overflow-tooltip />
                <el-table-column prop="publishDate" label="首发日期" width="102" />
                <el-table-column label="D1 播放" align="right" width="90">
                  <template #default="{ row }">
                    <span class="num" :class="{ muted: row.d1Play == null }">
                      {{ showNum(row.d1Play) }}
                    </span>
                  </template>
                </el-table-column>
                <el-table-column label="D3 播放" align="right" width="90">
                  <template #default="{ row }">
                    <span class="num" :class="{ muted: row.d3Play == null }">
                      {{ showNum(row.d3Play) }}
                    </span>
                  </template>
                </el-table-column>
                <el-table-column label="D7 播放" align="right" width="90">
                  <template #default="{ row }">
                    <span class="num" :class="{ muted: row.d7Play == null }">
                      {{ showNum(row.d7Play) }}
                    </span>
                  </template>
                </el-table-column>
                <el-table-column label="D3/D1" align="right" width="74">
                  <template #default="{ row }">
                    <span class="num" :class="{ muted: row.d3ToD1 == null }">
                      {{ row.d3ToD1 != null ? row.d3ToD1 + "x" : "-" }}
                    </span>
                  </template>
                </el-table-column>
                <el-table-column label="D7/D3" align="right" width="74">
                  <template #default="{ row }">
                    <span class="num" :class="{ muted: row.d7ToD3 == null }">
                      {{ row.d7ToD3 != null ? row.d7ToD3 + "x" : "-" }}
                    </span>
                  </template>
                </el-table-column>
                <el-table-column label="分类" width="102">
                  <template #default="{ row }">
                    <el-tag :type="trajectoryTagType(row.category)" size="mini">
                      {{ row.category }}
                    </el-tag>
                  </template>
                </el-table-column>
                <el-table-column label="分类依据" min-width="120" show-overflow-tooltip>
                  <template #default="{ row }">
                    <span :class="{ muted: !row.classificationBasis }">
                      {{ row.classificationBasis || "-" }}
                    </span>
                  </template>
                </el-table-column>
                <template #empty>
                  <span class="card-empty-inline">本周期内暂无新发布的内容</span>
                </template>
              </el-table>
            </div>

            <!-- 4b. 新作品前 24 小时 -->
            <div class="platform-card">
              <div class="card-head">
                <span class="card-title">新作品前 24 小时（近 7 天发布 · 起量速度）</span>
                <div class="chart-inline-controls">
                  <el-select
                    v-model="newWorks24hPlatform"
                    size="mini"
                    class="newworks-24h-platform-select"
                  >
                    <el-option label="全部平台" value="all" />
                    <el-option
                      v-for="pt in analysisNewWorks24hPlatformOptions"
                      :key="pt"
                      :label="pt"
                      :value="pt"
                    />
                  </el-select>
                  <el-button
                    type="text"
                    size="mini"
                    icon="el-icon-download"
                    :disabled="isChartOptionEmpty(newWorksFirst24hOption)"
                    @click="saveChartImage('chartNewWorksFirst24h', '新作品前24小时', analysisChartDate)"
                  >
                    保存图片
                  </el-button>
                </div>
              </div>
              <stats-chart
                ref="chartNewWorksFirst24h"
                :option="newWorksFirst24hOption"
                height="320px"
              />
            </div>

            <!-- 5. 发布时间 -->
            <div class="platform-card">
              <div class="card-head">
                <span class="card-title">5. 发布时间分析（UTC+8 星期几 × 时段）</span>
                <span class="card-tip">
                  共
                  {{ analysisData.publishTime ? analysisData.publishTime.totalSamples : 0 }}
                  条有效内容样本 · 指标为平均 D7 播放
                </span>
              </div>
              <div class="chart-box chart-box-block">
                <div class="chart-box-head">
                  <span class="chart-box-title">星期 × 时段平均 D7 播放热力图（样本 &lt; 3 半透明）</span>
                  <el-button
                    type="text"
                    size="mini"
                    icon="el-icon-download"
                    :disabled="isChartOptionEmpty(publishTimeHeatmapOption)"
                    @click="saveChartImage('chartPublishTimeHeatmap', '发布时间热力图', analysisChartDate)"
                  >
                    保存图片
                  </el-button>
                </div>
                <stats-chart
                  ref="chartPublishTimeHeatmap"
                  :option="publishTimeHeatmapOption"
                  height="300px"
                />
              </div>
              <el-table
                :data="analysisPublishTimeRows"
                size="mini"
                border
                stripe
                class="analysis-table"
              >
                <el-table-column prop="weekdayLabel" label="星期" width="76" />
                <el-table-column prop="slot" label="时段(UTC+8)" width="106" />
                <el-table-column label="样本数" width="80" align="right">
                  <template #default="{ row }">
                    <span class="num">{{ row.sampleCount }}</span>
                  </template>
                </el-table-column>
                <el-table-column label="平均 D7 播放" min-width="200">
                  <template #default="{ row }">
                    <div class="bar-cell">
                      <div class="css-bar-track">
                        <div
                          class="css-bar-fill primary"
                          :style="{
                            width: calcPercentWidth(row.avgD7Play, analysisPublishTimeMaxPlay),
                          }"
                        />
                      </div>
                      <span class="num bar-val">{{ showNum(row.avgD7Play) }}</span>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column label="标注" min-width="180">
                  <template #default="{ row }">
                    <el-tag v-if="row.lowSample" type="warning" size="mini" class="inline-tag">
                      样本少
                    </el-tag>
                    <el-tag v-if="row.hasFallback" type="info" size="mini" class="inline-tag">
                      含不足7天最新累计（{{ row.fallbackCount }}）
                    </el-tag>
                    <span v-if="!row.lowSample && !row.hasFallback" class="num muted">-</span>
                  </template>
                </el-table-column>
                <template #empty>
                  <span class="card-empty-inline">暂无带发布时间与快照的内容样本</span>
                </template>
              </el-table>
            </div>

            <!-- 6. 粉丝趋势 -->
            <div class="platform-card">
              <div class="card-head">
                <span class="card-title">6. 粉丝趋势（各账号日快照）</span>
                <div class="chart-inline-controls">
                  <el-select
                    v-model="fansSelectedAccounts"
                    multiple
                    collapse-tags
                    clearable
                    size="mini"
                    class="fans-account-select"
                    placeholder="全部账号"
                  >
                    <el-option
                      v-for="acc in analysisFansAccountOptions"
                      :key="acc.accountKey"
                      :label="acc.label"
                      :value="acc.accountKey"
                    />
                  </el-select>
                  <el-button
                    type="text"
                    size="mini"
                    icon="el-icon-download"
                    :disabled="isChartOptionEmpty(fansTrendOption)"
                    @click="saveChartImage('chartFansTrend', '粉丝趋势', analysisChartDate)"
                  >
                    保存图片
                  </el-button>
                </div>
              </div>
              <stats-chart
                ref="chartFansTrend"
                :option="fansTrendOption"
                height="320px"
              />
            </div>

            <!-- 7. 异常提醒 -->
            <div class="platform-card">
              <div class="card-head">
                <span class="card-title">7. 异常提醒</span>
                <span class="card-tip">
                  点击展开查看异常作品与具体日期（疑似采集异常已在第 1–5 节剔除）
                </span>
              </div>
              <el-collapse v-model="analysisAnomalyPanels" class="anomaly-collapse">
                <el-collapse-item name="collection">
                  <template #title>
                    <span class="anomaly-panel-title">
                      疑似采集异常（掉 0 或缺失后回升）
                      <el-tag
                        :type="analysisCollectionAnomalies.length ? 'danger' : 'info'"
                        size="mini"
                        class="inline-tag"
                      >
                        {{ analysisCollectionAnomalies.length }} 条
                      </el-tag>
                    </span>
                  </template>
                  <el-table
                    ref="collectionAnomalyTable"
                    :data="analysisCollectionAnomalies"
                    size="mini"
                    border
                    stripe
                    class="analysis-table clickable-rows"
                    @row-click="toggleCollectionAnomalyRow"
                  >
                    <el-table-column type="expand">
                      <template #default="{ row }">
                        <div class="anomaly-detail-box">
                          <div>
                            <strong>作品：</strong>{{ row.title }}（{{ row.platform }} · ID:
                            {{ row.workId }}）
                          </div>
                          <div>
                            <strong>异常日期：</strong>{{ row.date }} · 指标「{{ row.metricLabel }}」异常值为
                            {{ row.value == null ? "空" : row.value }}（前有记录日
                            {{ row.prevDate }} 为 {{ showNum(row.prevValue) }}，后有记录日
                            {{ row.nextDate }} 为 {{ showNum(row.nextValue) }}）
                          </div>
                          <div v-if="row.url">
                            <strong>作品链接：</strong>
                            <el-link
                              v-if="parseSafeHttpUrl(row.url)"
                              type="primary"
                              :underline="false"
                              @click.stop.prevent="openWorkUrl(row.url)"
                            >
                              {{ row.url }}
                            </el-link>
                            <span v-else>{{ row.url }}</span>
                          </div>
                        </div>
                      </template>
                    </el-table-column>
                    <el-table-column prop="date" label="日期" width="104" />
                    <el-table-column prop="platform" label="平台" width="88" />
                    <el-table-column prop="title" label="作品标题" min-width="180" show-overflow-tooltip />
                    <el-table-column prop="metricLabel" label="指标" width="76" />
                    <el-table-column label="异常值" width="80" align="right">
                      <template #default="{ row }">
                        <span class="num down">{{ row.value == null ? "缺失" : row.value }}</span>
                      </template>
                    </el-table-column>
                    <el-table-column label="前后记录" min-width="190">
                      <template #default="{ row }">
                        <span class="num">
                          {{ row.prevDate }}({{ showNum(row.prevValue) }}) → {{ row.nextDate }}({{
                            showNum(row.nextValue)
                          }})
                        </span>
                      </template>
                    </el-table-column>
                    <template #empty>
                      <span class="card-empty-inline">本周期未发现疑似采集异常</span>
                    </template>
                  </el-table>
                </el-collapse-item>

                <el-collapse-item name="recommend">
                  <template #title>
                    <span class="anomaly-panel-title">
                      疑似上推荐（单日播放日增 ≥ 前 7 天日均 ×5 且 ≥ 1000）
                      <el-tag
                        :type="analysisRecommendSpikes.length ? 'success' : 'info'"
                        size="mini"
                        class="inline-tag"
                      >
                        {{ analysisRecommendSpikes.length }} 条
                      </el-tag>
                    </span>
                  </template>
                  <el-table
                    ref="recommendSpikeTable"
                    :data="analysisRecommendSpikes"
                    size="mini"
                    border
                    stripe
                    class="analysis-table clickable-rows"
                    @row-click="toggleRecommendSpikeRow"
                  >
                    <el-table-column type="expand">
                      <template #default="{ row }">
                        <div class="anomaly-detail-box">
                          <div>
                            <strong>作品：</strong>{{ row.title }}（{{ row.platform }} · ID:
                            {{ row.workId }}）
                          </div>
                          <div>
                            <strong>爆发日期：</strong>{{ row.date }} · 单日播放日增
                            {{ showNum(row.dailyPlayDelta) }}（前 {{ row.baselineDays }} 天日均
                            {{ showNum(row.baselineAvg) }}，倍数
                            {{ row.ratio != null ? row.ratio + "x" : "前7天日均为0" }}）
                          </div>
                          <div v-if="row.url">
                            <strong>作品链接：</strong>
                            <el-link
                              v-if="parseSafeHttpUrl(row.url)"
                              type="primary"
                              :underline="false"
                              @click.stop.prevent="openWorkUrl(row.url)"
                            >
                              {{ row.url }}
                            </el-link>
                            <span v-else>{{ row.url }}</span>
                          </div>
                        </div>
                      </template>
                    </el-table-column>
                    <el-table-column prop="date" label="日期" width="104" />
                    <el-table-column prop="platform" label="平台" width="88" />
                    <el-table-column prop="title" label="作品标题" min-width="180" show-overflow-tooltip />
                    <el-table-column label="单日播放日增" min-width="170">
                      <template #default="{ row }">
                        <div class="bar-cell">
                          <div class="css-bar-track">
                            <div
                              class="css-bar-fill success"
                              :style="{
                                width: calcPercentWidth(row.dailyPlayDelta, analysisMaxSpikeDelta),
                              }"
                            />
                          </div>
                          <span class="num bar-val up">+{{ showNum(row.dailyPlayDelta) }}</span>
                        </div>
                      </template>
                    </el-table-column>
                    <el-table-column label="前7天日均" width="100" align="right">
                      <template #default="{ row }">
                        <span class="num">{{ showNum(row.baselineAvg) }}</span>
                      </template>
                    </el-table-column>
                    <el-table-column label="倍数" width="90" align="right">
                      <template #default="{ row }">
                        <span class="num up">
                          {{ row.ratio != null ? row.ratio + "x" : "新爆发" }}
                        </span>
                      </template>
                    </el-table-column>
                    <template #empty>
                      <span class="card-empty-inline">本周期未发现疑似上推荐爆发</span>
                    </template>
                  </el-table>
                </el-collapse-item>
              </el-collapse>
            </div>
          </div>
          <div v-else-if="!loadingAnalysis" class="platform-card">
            <div class="card-empty">暂无数据分析结果，请先点击右上角「同步全部数据」</div>
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script>
import { ipcRenderer, shell, clipboard } from "electron";
import StatsOverview from "./components/StatsOverview.vue";
import PlatformBarChart from "./components/PlatformBarChart.vue";
import GroupStatsTable from "./components/GroupStatsTable.vue";
import CollectLogDialog from "./components/CollectLogDialog.vue";
import StatsChart from "@/components/StatsChart.vue";
import { dailyToRows } from "./statsUtils";
import {
  OVERVIEW_METRIC_OPTIONS,
  isEmptyChartOption,
  buildOverviewTrendOption,
  buildOverviewPieOption,
  buildPlatformComparisonOption,
  buildRankingTop10Option,
  buildNewWorksTrajectoryOption,
  buildNewWorksCategoryPieOption,
  buildNewWorksFirst24hOption,
  buildPublishTimeHeatmapOption,
  buildFansTrendOption,
  buildContentTrendOption,
  buildContentIntradayOption,
} from "../../utils/statsChartOptions";
import {
  buildCollectAccounts,
  collectAccounts,
  getCollectLogs,
  getOverviewStats,
  onStatsProgress,
} from "@/utils/statsApi";
import {
  VALID_INTERVAL_HOURS,
  loadSettings as loadAutoCollectSettings,
  subscribeRunComplete,
  subscribeSettings as subscribeAutoCollectSettings,
  updateSettings as updateAutoCollectSettings,
} from "@/utils/statsScheduler";

const UNSTABLE_RECORD_KEY_RE = /^record:(?:.*:)?pos:\d+$/;
const INTERVAL_HOURS_FALLBACK = [1, 2, 3, 4, 6];
const PLATFORM_ORDER = [
  "抖音",
  "视频号",
  "快手",
  "哔哩哔哩",
  "小红书",
  "百家号",
  "头条",
];

function normalizeAutoCollectView(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  return {
    ...s,
    enabled: Boolean(s.enabled),
    mode: s.mode === "interval" ? "interval" : "daily",
    time: typeof s.time === "string" && s.time ? s.time : "10:00",
    startTime: typeof s.startTime === "string" && s.startTime ? s.startTime : "08:00",
    endTime: typeof s.endTime === "string" && s.endTime ? s.endTime : "22:00",
    intervalHours:
      typeof s.intervalHours === "number" && INTERVAL_HOURS_FALLBACK.includes(s.intervalHours)
        ? s.intervalHours
        : 2,
    lastRunDate: typeof s.lastRunDate === "string" ? s.lastRunDate : "",
    lastRunSlot: typeof s.lastRunSlot === "string" ? s.lastRunSlot : "",
  };
}

function formatLocalYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getUtc8TodayYmd(now = Date.now()) {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  const safeMs = Number.isFinite(ms) ? ms : Date.now();
  return new Date(safeMs + 8 * 3600e3).toISOString().slice(0, 10);
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
  components: { StatsOverview, PlatformBarChart, GroupStatsTable, CollectLogDialog, StatsChart },
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
      contentTrendVisible: false,
      contentTrendRow: null,
      contentTrendMode: "daily",
      contentIntradayDays: 3,
      contentTrendData: null,
      contentIntradayData: null,
      loadingContentTrend: false,
      analysisPeriod: 30,
      analysisTo: "",
      analysisDatePickerOptions: {
        disabledDate(time) {
          if (!(time instanceof Date) || !Number.isFinite(time.getTime())) return false;
          return formatLocalYmd(time) > getUtc8TodayYmd();
        },
      },
      analysisData: null,
      loadingAnalysis: false,
      overviewTrendMetric: "play",
      overviewTrendStacked: false,
      newWorks24hPlatform: "all",
      fansSelectedAccounts: [],
      exportingAllCharts: false,
      analysisRankMetric: "play",
      analysisRankOrder: "top",
      analysisAnomalyPanels: ["collection", "recommend"],
      progressText: "",
      logVisible: false,
      logs: [],
      autoCollect: normalizeAutoCollectView(loadAutoCollectSettings()),
    };
  },
  computed: {
    intervalHoursOptions() {
      return Array.isArray(VALID_INTERVAL_HOURS) && VALID_INTERVAL_HOURS.length
        ? VALID_INTERVAL_HOURS
        : INTERVAL_HOURS_FALLBACK;
    },
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
    analysisSummaryLines() {
      const s = this.analysisData && this.analysisData.summary;
      return s && Array.isArray(s.lines) ? s.lines : [];
    },
    analysisSummaryText() {
      const s = this.analysisData && this.analysisData.summary;
      return s && typeof s.text === "string" ? s.text : this.analysisSummaryLines.join("\n");
    },
    analysisOverviewMetricRows() {
      const m =
        this.analysisData && this.analysisData.overview && this.analysisData.overview.metrics;
      if (!m) return [];
      return ["play", "like", "comment", "share", "favorite", "fansDelta"]
        .map((k) => m[k])
        .filter(Boolean);
    },
    analysisPlatformContribution() {
      const ov = this.analysisData && this.analysisData.overview;
      return ov && Array.isArray(ov.platformContribution) ? ov.platformContribution : [];
    },
    analysisPlatformCompareRows() {
      const pc = this.analysisData && this.analysisData.platformComparison;
      return pc && Array.isArray(pc.platforms) ? pc.platforms : [];
    },
    analysisPlatformConclusions() {
      const pc = this.analysisData && this.analysisData.platformComparison;
      return pc && Array.isArray(pc.conclusions) ? pc.conclusions : [];
    },
    analysisCompareMaxPlay() {
      let max = 0;
      for (const r of this.analysisPlatformCompareRows) {
        if (typeof r.avgPlay === "number" && r.avgPlay > max) max = r.avgPlay;
      }
      return max;
    },
    analysisCompareMaxEng() {
      let max = 0;
      for (const r of this.analysisPlatformCompareRows) {
        if (typeof r.engagementRatePct === "number" && r.engagementRatePct > max) {
          max = r.engagementRatePct;
        }
      }
      return max;
    },
    analysisDisplayedRankRows() {
      const rk = this.analysisData && this.analysisData.rankings;
      if (!rk) return [];
      const bucket =
        this.analysisRankMetric === "engagement"
          ? rk.byEngagement
          : this.analysisRankMetric === "fans"
          ? rk.byFans
          : rk.byPlay;
      if (!bucket) return [];
      const list = this.analysisRankOrder === "bottom" ? bucket.bottom : bucket.top;
      return Array.isArray(list) ? list : [];
    },
    analysisRankMetricLabel() {
      if (this.analysisRankMetric === "engagement") return "互动率（条形）";
      if (this.analysisRankMetric === "fans") return "总涨粉（条形）";
      return "总播放（条形）";
    },
    analysisRankMaxVal() {
      let max = 0;
      for (const r of this.analysisDisplayedRankRows) {
        const v = this.getRankPrimaryNumber(r);
        if (typeof v === "number" && Math.abs(v) > max) max = Math.abs(v);
      }
      return max;
    },
    analysisPlatformSkewRows() {
      const rk = this.analysisData && this.analysisData.rankings;
      return rk && Array.isArray(rk.platformSkew) ? rk.platformSkew : [];
    },
    analysisNewWorkRows() {
      const nw = this.analysisData && this.analysisData.newWorks;
      return nw && Array.isArray(nw.items) ? nw.items : [];
    },
    analysisNewWorkCounts() {
      const cc =
        this.analysisData && this.analysisData.newWorks && this.analysisData.newWorks.categoryCounts;
      return {
        长尾型: (cc && cc.长尾型) || 0,
        爆发后平稳: (cc && cc.爆发后平稳) || 0,
        其它: (cc && cc.其它) || 0,
        数据不足: (cc && cc.数据不足) || 0,
      };
    },
    analysisPublishTimeRows() {
      const pt = this.analysisData && this.analysisData.publishTime;
      return pt && Array.isArray(pt.groups) ? pt.groups : [];
    },
    analysisPublishTimeMaxPlay() {
      let max = 0;
      for (const g of this.analysisPublishTimeRows) {
        if (typeof g.avgD7Play === "number" && g.avgD7Play > max) max = g.avgD7Play;
      }
      return max;
    },
    analysisCollectionAnomalies() {
      const an = this.analysisData && this.analysisData.anomalies;
      return an && Array.isArray(an.collectionAnomalies) ? an.collectionAnomalies : [];
    },
    analysisRecommendSpikes() {
      const an = this.analysisData && this.analysisData.anomalies;
      return an && Array.isArray(an.recommendSpikes) ? an.recommendSpikes : [];
    },
    analysisMaxSpikeDelta() {
      let max = 0;
      for (const r of this.analysisRecommendSpikes) {
        if (typeof r.dailyPlayDelta === "number" && r.dailyPlayDelta > max) {
          max = r.dailyPlayDelta;
        }
      }
      return max;
    },
    overviewTrendMetricOptions() {
      return OVERVIEW_METRIC_OPTIONS;
    },
    overviewTrendMetricLabel() {
      const found = OVERVIEW_METRIC_OPTIONS.find((m) => m.key === this.overviewTrendMetric);
      return found ? found.label : "播放";
    },
    analysisRankMetricShortLabel() {
      if (this.analysisRankMetric === "engagement") return "互动率";
      if (this.analysisRankMetric === "fans") return "涨粉";
      return "播放";
    },
    analysisRankOrderLabel() {
      return this.analysisRankOrder === "bottom" ? "Bottom 10" : "Top 10";
    },
    analysisRankOrderShortLabel() {
      return this.analysisRankOrder === "bottom" ? "Bottom10" : "Top10";
    },
    analysisChartDate() {
      return (this.analysisData && this.analysisData.to) || "";
    },
    activeContentTrendData() {
      return this.contentTrendMode === "intraday"
        ? this.contentIntradayData
        : this.contentTrendData;
    },
    contentTrendChartDate() {
      const cur = this.activeContentTrendData;
      return (
        (cur && (cur.date || cur.to)) ||
        this.contentSummaryDate ||
        ""
      );
    },
    analysisNewWorks24hPlatformOptions() {
      const sec = this.analysisData && this.analysisData.newWorksFirst24h;
      const items = sec && Array.isArray(sec.items) ? sec.items : [];
      const set = new Set();
      for (const it of items) {
        if (!it || !Array.isArray(it.platforms)) continue;
        for (const p of it.platforms) {
          if (p && p.platform) set.add(p.platform);
        }
      }
      return [...set].sort((a, b) => {
        const ia = PLATFORM_ORDER.indexOf(a);
        const ib = PLATFORM_ORDER.indexOf(b);
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        return a < b ? -1 : a > b ? 1 : 0;
      });
    },
    analysisFansAccountOptions() {
      const ft = this.analysisData && this.analysisData.fansTrend;
      return ft && Array.isArray(ft.accounts) ? ft.accounts : [];
    },
    overviewTrendOption() {
      return buildOverviewTrendOption(this.analysisData, {
        metric: this.overviewTrendMetric,
        stacked: this.overviewTrendStacked,
      });
    },
    overviewPieOption() {
      return buildOverviewPieOption(this.analysisData);
    },
    platformCompareOption() {
      return buildPlatformComparisonOption(this.analysisData);
    },
    rankingTop10Option() {
      return buildRankingTop10Option(this.analysisData, {
        metric: this.analysisRankMetric,
        order: this.analysisRankOrder,
        items: this.analysisDisplayedRankRows,
      });
    },
    newWorksLineOption() {
      return buildNewWorksTrajectoryOption(this.analysisData);
    },
    newWorksPieOption() {
      return buildNewWorksCategoryPieOption(this.analysisData);
    },
    newWorksFirst24hOption() {
      return buildNewWorksFirst24hOption(this.analysisData, {
        platform: this.newWorks24hPlatform === "all" ? "" : this.newWorks24hPlatform,
      });
    },
    publishTimeHeatmapOption() {
      return buildPublishTimeHeatmapOption(this.analysisData);
    },
    fansTrendOption() {
      return buildFansTrendOption(this.analysisData, {
        selectedAccounts: this.fansSelectedAccounts,
      });
    },
    contentTrendOption() {
      if (this.contentTrendMode === "intraday") {
        return buildContentIntradayOption(this.contentIntradayData);
      }
      return buildContentTrendOption(this.contentTrendData);
    },
    contentTrendDialogTitle() {
      const cur = this.activeContentTrendData;
      const title =
        (cur && cur.title) ||
        (this.contentTrendRow && this.contentTrendRow.title) ||
        "作品播放趋势";
      return `播放趋势 · ${title}`;
    },
  },
  watch: {
    activeTab(val) {
      if (val === "works") {
        this.loadContentSummary();
      } else if (val === "analysis") {
        this.loadAnalysis();
        if (typeof this.$nextTick === "function") {
          this.$nextTick(() => this.resizeAnalysisCharts());
        }
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
      this.autoCollect = normalizeAutoCollectView(next);
    });
    this._unsubAutoRunComplete = subscribeRunComplete(() => {
      if (!this.syncing) {
        this.progressText = "";
        this.refresh();
      }
    });
  },
  activated() {
    this.autoCollect = normalizeAutoCollectView(loadAutoCollectSettings());
    if (this.activeTab === "analysis" && typeof this.$nextTick === "function") {
      this.$nextTick(() => this.resizeAnalysisCharts());
    }
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
        mode: this.autoCollect.mode,
        time: this.autoCollect.time,
        startTime: this.autoCollect.startTime,
        endTime: this.autoCollect.endTime,
        intervalHours: this.autoCollect.intervalHours,
        retentionDays: this.autoCollect.retentionDays,
      });
      this.autoCollect = normalizeAutoCollectView(res.settings);
      if (!res.ok) {
        this.$message.error(
          `保存自动采集设置失败${res.error ? "：" + res.error : ""}`
        );
        return;
      }
      if (ipcRenderer && typeof ipcRenderer.invoke === "function") {
        Promise.resolve(
          ipcRenderer.invoke("stats:save-auto-settings", {
            enabled: this.autoCollect.enabled,
            mode: this.autoCollect.mode,
            time: this.autoCollect.time,
            startTime: this.autoCollect.startTime,
            endTime: this.autoCollect.endTime,
            intervalHours: this.autoCollect.intervalHours,
            retentionDays: this.autoCollect.retentionDays,
          })
        ).catch(() => {});
      }
    },
    async refresh() {
      this.overview = await getOverviewStats();
      if (this.activeTab === "works") {
        await this.loadContentSummary();
      } else if (this.activeTab === "analysis") {
        await this.loadAnalysis();
      }
    },
    async loadAnalysis() {
      const reqId = (this._analysisReqId = (this._analysisReqId || 0) + 1);
      this.loadingAnalysis = true;
      try {
        const payload = { period: this.analysisPeriod };
        if (this.analysisTo) payload.to = this.analysisTo;
        const res = await ipcRenderer.invoke("stats:get-analysis", payload);
        if (reqId !== this._analysisReqId) return;
        if (!res || res.ok === false || res.error) {
          this.$message.warning((res && res.error) || "读取数据分析失败");
          this.analysisData = null;
          return;
        }
        this.analysisData = res;
        if (this.analysisTo && res.to && this.analysisTo > res.to) {
          this.analysisTo = res.to;
        }
        if (Array.isArray(this.fansSelectedAccounts) && this.fansSelectedAccounts.length) {
          const validKeys = new Set(
            ((res.fansTrend && res.fansTrend.accounts) || []).map((a) => a.accountKey)
          );
          this.fansSelectedAccounts = this.fansSelectedAccounts.filter((k) => validKeys.has(k));
        }
        if (
          this.newWorks24hPlatform !== "all" &&
          !this.analysisNewWorks24hPlatformOptions.includes(this.newWorks24hPlatform)
        ) {
          this.newWorks24hPlatform = "all";
        }
        if (typeof this.$nextTick === "function") {
          this.$nextTick(() => this.resizeAnalysisCharts());
        }
      } catch (err) {
        if (reqId !== this._analysisReqId) return;
        this.$message.error(`读取数据分析失败：${(err && err.message) || err}`);
      } finally {
        if (reqId === this._analysisReqId) {
          this.loadingAnalysis = false;
        }
      }
    },
    isChartOptionEmpty(opt) {
      return isEmptyChartOption(opt);
    },
    getAnalysisChartSpecs() {
      return [
        { ref: "chartOverviewTrend", name: `1-总览-日趋势-${this.overviewTrendMetricLabel}` },
        { ref: "chartOverviewPie", name: "1-总览-平台占比" },
        { ref: "chartPlatformCompare", name: "2-平台对比" },
        {
          ref: "chartRankingTop10",
          name: `3-作品排行${this.analysisRankOrderShortLabel}-${this.analysisRankMetricShortLabel}`,
        },
        { ref: "chartNewWorksLine", name: "4-新作品走势-D1D3D7" },
        { ref: "chartNewWorksPie", name: "4-新作品走势-分类占比" },
        { ref: "chartNewWorksFirst24h", name: "4b-新作品前24小时" },
        { ref: "chartPublishTimeHeatmap", name: "5-发布时间热力图" },
        { ref: "chartFansTrend", name: "6-粉丝趋势" },
      ];
    },
    resizeAnalysisCharts() {
      if (!this.$refs) return;
      for (const spec of this.getAnalysisChartSpecs()) {
        const comp = this.$refs[spec.ref];
        if (comp && typeof comp.resize === "function") {
          comp.resize();
        }
      }
    },
    async saveChartImage(refName, chartName, explicitDate) {
      const comp = this.$refs && this.$refs[refName];
      if (!comp || typeof comp.getDataURL !== "function") {
        this.$message.warning("图表尚未就绪");
        return;
      }
      const dataUrl = comp.getDataURL();
      if (!dataUrl) {
        this.$message.warning("当前图表暂无可保存的数据");
        return;
      }
      try {
        const payload = {
          dataUrl,
          name: chartName || "图表",
        };
        const fallbackDate =
          refName === "chartContentTrend"
            ? (this.contentTrendData && (this.contentTrendData.date || this.contentTrendData.to)) ||
              this.contentSummaryDate ||
              ""
            : (this.analysisData && this.analysisData.to) || "";
        const chartDate =
          typeof explicitDate === "string" && explicitDate.trim()
            ? explicitDate.trim()
            : fallbackDate;
        if (chartDate) payload.date = chartDate;
        const res = await ipcRenderer.invoke("stats:save-chart-image", payload);
        if (res && res.ok) {
          this.$message.success(`已保存图片：${res.filePath}`);
        } else if (res && res.canceled) {
          // 用户取消保存
        } else {
          this.$message.error((res && (res.message || res.error)) || "保存图片失败");
        }
      } catch (err) {
        this.$message.error(`保存图片失败：${(err && err.message) || err}`);
      }
    },
    async exportAllCharts() {
      if (this.exportingAllCharts) return;
      this.resizeAnalysisCharts();
      const items = [];
      for (const spec of this.getAnalysisChartSpecs()) {
        const comp = this.$refs && this.$refs[spec.ref];
        if (!comp || typeof comp.getDataURL !== "function") continue;
        const dataUrl = comp.getDataURL();
        if (dataUrl) {
          items.push({ name: spec.name, dataUrl });
        }
      }
      if (!items.length) {
        this.$message.warning("当前没有可导出的图表");
        return;
      }
      this.exportingAllCharts = true;
      try {
        const payload = { items };
        if (this.analysisData && this.analysisData.to) {
          payload.date = this.analysisData.to;
        }
        const period =
          (this.analysisData && this.analysisData.period) || this.analysisPeriod;
        if (period) {
          payload.period = period;
        }
        const res = await ipcRenderer.invoke("stats:save-chart-images-batch", payload);
        if (res && res.ok) {
          this.$message.success(`已导出 ${res.count} 张图表到：${res.dir}`);
        } else if (res && res.canceled) {
          // 用户取消目录选择
        } else {
          this.$message.error((res && (res.message || res.error)) || "导出全部图表失败");
        }
      } catch (err) {
        this.$message.error(`导出全部图表失败：${(err && err.message) || err}`);
      } finally {
        this.exportingAllCharts = false;
      }
    },
    async openContentTrend(row) {
      if (!row || !row.contentKey) return;
      this.contentTrendRow = {
        contentKey: row.contentKey,
        title: row.title || "(无标题)",
      };
      this.contentTrendMode = "daily";
      this.contentTrendData = null;
      this.contentIntradayData = null;
      this.contentTrendVisible = true;
      await this.loadContentDailyTrend();
    },
    async loadContentDailyTrend() {
      const row = this.contentTrendRow;
      if (!row || !row.contentKey) return;
      const reqId = (this._contentTrendReqId = (this._contentTrendReqId || 0) + 1);
      this.loadingContentTrend = true;
      try {
        const payload = { contentKey: row.contentKey };
        if (this.contentSummaryDate) payload.to = this.contentSummaryDate;
        const res = await ipcRenderer.invoke("stats:get-content-trend", payload);
        if (reqId !== this._contentTrendReqId) return;
        if (!res || res.ok === false || res.error) {
          this.$message.warning((res && res.error) || "读取作品趋势失败");
          this.contentTrendData = null;
          return;
        }
        this.contentTrendData = res;
        if (typeof this.$nextTick === "function") {
          this.$nextTick(() => {
            const comp = this.$refs && this.$refs.chartContentTrend;
            if (comp && typeof comp.resize === "function") comp.resize();
          });
        }
      } catch (err) {
        if (reqId !== this._contentTrendReqId) return;
        this.$message.error(`读取作品趋势失败：${(err && err.message) || err}`);
      } finally {
        if (reqId === this._contentTrendReqId) {
          this.loadingContentTrend = false;
        }
      }
    },
    async loadContentIntraday() {
      const row = this.contentTrendRow;
      if (!row || !row.contentKey) return;
      const reqId = (this._contentTrendReqId = (this._contentTrendReqId || 0) + 1);
      this.loadingContentTrend = true;
      try {
        const payload = {
          contentKey: row.contentKey,
          days: this.contentIntradayDays,
        };
        if (this.contentSummaryDate) payload.to = this.contentSummaryDate;
        const res = await ipcRenderer.invoke("stats:get-content-intraday", payload);
        if (reqId !== this._contentTrendReqId) return;
        if (!res || res.ok === false || res.error) {
          this.$message.warning((res && res.error) || "读取作品分时段趋势失败");
          this.contentIntradayData = null;
          return;
        }
        this.contentIntradayData = res;
        if (typeof this.$nextTick === "function") {
          this.$nextTick(() => {
            const comp = this.$refs && this.$refs.chartContentTrend;
            if (comp && typeof comp.resize === "function") comp.resize();
          });
        }
      } catch (err) {
        if (reqId !== this._contentTrendReqId) return;
        this.$message.error(`读取作品分时段趋势失败：${(err && err.message) || err}`);
      } finally {
        if (reqId === this._contentTrendReqId) {
          this.loadingContentTrend = false;
        }
      }
    },
    onContentTrendModeChange(mode) {
      if (mode === "intraday") {
        this.loadContentIntraday();
      } else if (!this.contentTrendData) {
        this.loadContentDailyTrend();
      } else if (typeof this.$nextTick === "function") {
        this.$nextTick(() => {
          const comp = this.$refs && this.$refs.chartContentTrend;
          if (comp && typeof comp.resize === "function") comp.resize();
        });
      }
    },
    onContentTrendDialogOpened() {
      if (typeof this.$nextTick === "function") {
        this.$nextTick(() => {
          const comp = this.$refs && this.$refs.chartContentTrend;
          if (comp && typeof comp.resize === "function") comp.resize();
        });
      }
    },
    resetContentTrendDialog() {
      this._contentTrendReqId = (this._contentTrendReqId || 0) + 1;
      this.contentTrendRow = null;
      this.contentTrendMode = "daily";
      this.contentIntradayDays = 3;
      this.contentTrendData = null;
      this.contentIntradayData = null;
      this.loadingContentTrend = false;
    },
    async copyAnalysisSummary() {
      const text = this.analysisSummaryText;
      if (!text) return;
      try {
        if (clipboard && typeof clipboard.writeText === "function") {
          clipboard.writeText(text);
          this.$message.success("已复制分析小结到剪贴板");
          return;
        }
        if (
          typeof navigator !== "undefined" &&
          navigator.clipboard &&
          typeof navigator.clipboard.writeText === "function"
        ) {
          await navigator.clipboard.writeText(text);
          this.$message.success("已复制分析小结到剪贴板");
          return;
        }
        if (typeof document !== "undefined") {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          this.$message.success("已复制分析小结到剪贴板");
          return;
        }
        this.$message.warning("当前环境不支持剪贴板写入");
      } catch (err) {
        this.$message.error(`复制小结失败：${(err && err.message) || err}`);
      }
    },
    calcPercentWidth(val, max) {
      if (typeof val !== "number" || !Number.isFinite(val) || val <= 0) return "0%";
      if (typeof max !== "number" || !Number.isFinite(max) || max <= 0) return "0%";
      const pct = Math.max(2, Math.min(100, Math.round((val / max) * 100)));
      return `${pct}%`;
    },
    getRankPrimaryNumber(row) {
      if (!row) return null;
      if (this.analysisRankMetric === "engagement") return row.engagementRatePct;
      if (this.analysisRankMetric === "fans") return row.totalFansDelta;
      return row.totalPlay;
    },
    calcRankBarWidth(row) {
      const v = this.getRankPrimaryNumber(row);
      if (typeof v !== "number" || !Number.isFinite(v)) return "0%";
      return this.calcPercentWidth(Math.abs(v), this.analysisRankMaxVal);
    },
    formatRankPrimaryValue(row) {
      const v = this.getRankPrimaryNumber(row);
      if (v == null) return "-";
      if (this.analysisRankMetric === "engagement") return `${v}%`;
      return this.showNum(v);
    },
    trajectoryTagType(category) {
      if (category === "长尾型") return "success";
      if (category === "爆发后平稳") return "info";
      if (category === "数据不足") return "warning";
      return "primary";
    },
    toggleCollectionAnomalyRow(row) {
      const tbl = this.$refs && this.$refs.collectionAnomalyTable;
      if (tbl && typeof tbl.toggleRowExpansion === "function") {
        tbl.toggleRowExpansion(row);
      }
    },
    toggleRecommendSpikeRow(row) {
      const tbl = this.$refs && this.$refs.recommendSpikeTable;
      if (tbl && typeof tbl.toggleRowExpansion === "function") {
        tbl.toggleRowExpansion(row);
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
    sortLastCollectedAt(a, b) {
      return compareNullableMetric(a, b, "lastCollectedAt");
    },
    formatUtc8FullDateTime(ts) {
      if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "";
      return new Date(ts + 8 * 3600e3).toISOString().slice(0, 19).replace("T", " ");
    },
    formatUtc8ShortDateTime(ts) {
      if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "-";
      return new Date(ts + 8 * 3600e3).toISOString().slice(5, 16).replace("T", " ");
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
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
  padding: 8px 14px;
  background: #ffffff;
  border: 1px solid $borderColor;
  border-radius: 8px;
}

.auto-collect-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}

.auto-collect-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.auto-collect-label {
  font-size: 13px;
  font-weight: 500;
  color: #303133;
}

.auto-collect-time {
  width: 104px;
}

.auto-collect-sep {
  font-size: 12px;
  color: #606266;
}

.auto-collect-interval {
  width: 104px;
}

.auto-collect-warning {
  font-size: 12px;
  color: #e6a23c;
  line-height: 1.4;
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

  &.up {
    color: #67c23a;
  }

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

.analysis-toolbar-card {
  margin-top: 4px;
}

.analysis-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
}

.analysis-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.analysis-date-picker {
  width: 160px;
}

.analysis-summary-card {
  border-left: 3px solid #409eff;
}

.analysis-summary-list {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.75;
  color: #303133;

  li.is-warning {
    color: #e6a23c;
    font-weight: 500;
  }
}

.analysis-table {
  width: 100%;
}

.sub-block-title {
  margin: 12px 0 6px;
  font-size: 13px;
  font-weight: 500;
  color: #606266;
}

.conclusion-box {
  margin-bottom: 10px;
  padding: 8px 12px;
  background: #f5f7fa;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.6;
  color: #303133;
}

.analysis-sub-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 10px;
}

.bar-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.css-bar-track {
  flex: 1;
  height: 8px;
  background: #ebeef5;
  border-radius: 4px;
  overflow: hidden;
  min-width: 60px;
}

.css-bar-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.2s ease;

  &.primary {
    background: #409eff;
  }

  &.success {
    background: #67c23a;
  }
}

.bar-val {
  min-width: 64px;
  text-align: right;
  font-size: 12px;
}

.inline-tag {
  margin-left: 6px;
}

.category-tags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.anomaly-collapse {
  border-top: none;
  border-bottom: none;
}

.anomaly-panel-title {
  font-size: 13px;
  font-weight: 500;
  color: #303133;
}

.anomaly-detail-box {
  padding: 6px 12px;
  font-size: 12px;
  line-height: 1.7;
  color: #606266;
}

.clickable-rows {
  cursor: pointer;
}

.analysis-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.chart-grid-overview,
.chart-grid-newworks {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: 12px;
  margin-bottom: 12px;
}

@media (max-width: 1080px) {
  .chart-grid-overview,
  .chart-grid-newworks {
    grid-template-columns: minmax(0, 1fr);
  }
}

.chart-box {
  border: 1px solid #ebeef5;
  border-radius: 6px;
  padding: 10px 12px 8px;
  background: #ffffff;
}

.chart-box-block {
  margin-bottom: 12px;
}

.chart-box-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 6px;
}

.chart-box-title-wrap {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.chart-box-title {
  font-size: 13px;
  font-weight: 500;
  color: #303133;
}

.chart-inline-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.fans-account-select {
  width: 240px;
}

.newworks-24h-platform-select {
  width: 130px;
}

.trend-dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 8px;
}

.trend-dialog-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.trend-dialog-tip {
  font-size: 12px;
  color: #909399;
}
</style>
