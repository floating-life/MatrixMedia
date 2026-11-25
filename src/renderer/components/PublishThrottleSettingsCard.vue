<template>
  <el-card class="section-card throttle-settings" shadow="never">
    <div slot="header" class="card-header">
      <span>发布节流与默认创作声明</span>
      <div class="header-actions">
        <el-button size="mini" :disabled="saving || loading" @click="handleReset">
          恢复默认
        </el-button>
        <el-button
          type="primary"
          size="mini"
          :loading="saving"
          :disabled="loading"
          @click="handleSave"
        >
          保存设置
        </el-button>
      </div>
    </div>

    <p class="section-tip">
      GUI、CLI 与 HTTP API 共用本设置。开启节流后，超出同账号最小间隔、允许发布时段或每日上限的发布请求将自动转为定时任务（复用主进程定时调度器，重启不丢失）；可通过 HTTP
      <code>noThrottle: true</code>、CLI <code>--no-throttle</code> 或 GUI 排期预览弹窗临时绕过。
    </p>

    <el-form
      v-loading="loading"
      :model="form"
      label-width="140px"
      size="small"
      class="throttle-form"
    >
      <el-form-item label="发布节流总开关">
        <el-switch
          v-model="form.enabled"
          active-text="开启（默认）"
          inactive-text="关闭"
        />
        <span class="field-hint">关闭后不再自动顺延发布时间</span>
      </el-form-item>

      <el-form-item label="允许发布时段">
        <div class="window-row">
          <el-time-select
            v-model="form.allowedWindow.start"
            :picker-options="{ start: '00:00', step: '00:15', end: '23:45' }"
            placeholder="开始时间"
            style="width: 130px"
            :clearable="false"
          />
          <span class="window-sep">至</span>
          <el-time-select
            v-model="form.allowedWindow.end"
            :picker-options="{ start: '00:00', step: '00:15', end: '23:45' }"
            placeholder="结束时间"
            style="width: 130px"
            :clearable="false"
          />
          <span class="field-hint">UTC+8 本地时间（默认 06:00–23:30），时段外自动顺延到下个时段开始</span>
        </div>
      </el-form-item>

      <el-form-item label="默认创作声明">
        <el-select
          v-model="form.defaultCreativeStatement"
          placeholder="选择默认创作声明"
          style="width: 220px"
        >
          <el-option
            v-for="opt in statementOptions"
            :key="opt.value"
            :label="opt.label + ' (' + opt.value + ')'"
            :value="opt.value"
          />
        </el-select>
        <span class="field-hint">
          默认 AI生成（ai_generated），请求未传声明时套用，GUI 发布页初始选中该项；不支持的平台自动回退为无标注
        </span>
      </el-form-item>

      <el-form-item label="默认 AI 自动章节">
        <el-switch
          v-model="form.defaultAiChapters"
          active-text="开启（默认）"
          inactive-text="关闭"
        />
        <span class="field-hint">
          仅抖音 / 快手 / 小红书生效，账号发布设置或单条发布可覆盖；短视频不支持时告警继续，不中止发布
        </span>
      </el-form-item>

      <el-form-item label="默认原创声明">
        <el-switch
          v-model="form.defaultOriginalStatement"
          active-text="开启（默认）"
          inactive-text="关闭"
        />
        <span class="field-hint">
          仅小红书 / 视频号生效，与创作声明独立并存；无原创资格的账号可在对应账号的「发布设置」里单独关闭
        </span>
      </el-form-item>

      <el-form-item label="各平台节流与错峰">
        <el-table :data="platformRows" border size="mini" class="platform-table">
          <el-table-column prop="platform" label="平台" width="110">
            <template slot-scope="{ row }">
              <span>{{ row.platform }}</span>
            </template>
          </el-table-column>
          <el-table-column label="同账号最小间隔（小时）" min-width="180">
            <template slot-scope="{ row }">
              <el-input-number
                v-model="form.platforms[row.platform].minIntervalHours"
                :min="0"
                :max="168"
                :step="1"
                size="mini"
                controls-position="right"
              />
            </template>
          </el-table-column>
          <el-table-column label="同账号每日上限（0=不限）" min-width="185">
            <template slot-scope="{ row }">
              <el-input-number
                v-model="form.platforms[row.platform].dailyLimit"
                :min="0"
                :max="100"
                :step="1"
                :precision="0"
                size="mini"
                controls-position="right"
              />
            </template>
          </el-table-column>
          <el-table-column label="相对首发延迟（小时）" min-width="210">
            <template slot-scope="{ row }">
              <div class="delay-cell">
                <el-input-number
                  v-model="form.platforms[row.platform].delayFromFirstHours"
                  :min="0"
                  :max="168"
                  :step="1"
                  size="mini"
                  controls-position="right"
                />
                <span v-if="row.platform === '百家号'" class="delay-tip">
                  建议 10–12h
                </span>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </el-form-item>
    </el-form>
  </el-card>
</template>

<script>
import { ipcRenderer } from "electron";
import { CREATIVE_STATEMENT_OPTIONS } from "../../shared/creativeStatement.js";
import {
  THROTTLE_PLATFORMS,
  createDefaultPublishThrottleSettings,
  normalizePublishThrottleSettings,
} from "../../shared/publishThrottle.js";

export default {
  name: "PublishThrottleSettingsCard",
  data() {
    return {
      loading: false,
      saving: false,
      statementOptions: CREATIVE_STATEMENT_OPTIONS,
      platformRows: THROTTLE_PLATFORMS.map((platform) => ({ platform })),
      form: createDefaultPublishThrottleSettings(),
    };
  },
  mounted() {
    this.loadSettings();
  },
  methods: {
    async loadSettings() {
      this.loading = true;
      try {
        const res = await ipcRenderer.invoke("publish-throttle:get-settings");
        if (res && res.settings) {
          this.form = normalizePublishThrottleSettings(res.settings);
        } else {
          this.form = createDefaultPublishThrottleSettings();
        }
      } catch (e) {
        this.$message.error(
          "读取发布节流设置失败：" + ((e && e.message) || e)
        );
      } finally {
        this.loading = false;
      }
    },
    async handleSave() {
      this.saving = true;
      try {
        const payload = JSON.parse(JSON.stringify(this.form));
        const res = await ipcRenderer.invoke(
          "publish-throttle:save-settings",
          payload
        );
        if (!res || res.ok !== true) {
          this.$message.error(
            (res && res.message) || "保存发布节流设置失败"
          );
          return;
        }
        this.form = normalizePublishThrottleSettings(res.settings);
        this.$message.success("发布节流设置已保存（GUI / CLI / HTTP 即时生效）");
        this.$emit("saved", this.form);
      } catch (e) {
        this.$message.error(
          "保存发布节流设置失败：" + ((e && e.message) || e)
        );
      } finally {
        this.saving = false;
      }
    },
    async handleReset() {
      try {
        await this.$confirm(
          "确定恢复发布节流与默认创作声明为出厂默认值吗？",
          "恢复默认",
          {
            confirmButtonText: "恢复默认",
            cancelButtonText: "取消",
            type: "warning",
          }
        );
      } catch (_) {
        return;
      }
      this.saving = true;
      try {
        const res = await ipcRenderer.invoke("publish-throttle:reset-settings");
        if (!res || res.ok !== true) {
          this.$message.error((res && res.message) || "恢复默认失败");
          return;
        }
        this.form = normalizePublishThrottleSettings(res.settings);
        this.$message.success("已恢复为默认设置");
        this.$emit("saved", this.form);
      } catch (e) {
        this.$message.error("恢复默认失败：" + ((e && e.message) || e));
      } finally {
        this.saving = false;
      }
    },
  },
};
</script>

<style lang="scss" scoped>
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.header-actions {
  display: flex;
  gap: 8px;
}
.section-tip {
  margin: 0 0 16px;
  font-size: 13px;
  color: #606266;
  line-height: 1.6;
}
.throttle-form {
  margin-top: 4px;
}
.window-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.window-sep {
  color: #606266;
}
.field-hint {
  margin-left: 10px;
  font-size: 12px;
  color: #909399;
}
.platform-table {
  width: 100%;
}
.delay-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}
.delay-tip {
  font-size: 12px;
  color: #e6a23c;
  white-space: nowrap;
}
code {
  padding: 1px 5px;
  background-color: #f0f2f5;
  border-radius: 3px;
  font-size: 12px;
  color: #c7254e;
}
</style>
