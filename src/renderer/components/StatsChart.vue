<template>
  <div
    ref="root"
    v-loading="loading"
    class="stats-chart-root"
    :style="containerStyle"
  >
    <div v-show="hasData" ref="canvas" class="stats-chart-canvas" />
    <div v-show="showEmpty" class="stats-chart-empty">
      {{ emptyMessage }}
    </div>
  </div>
</template>

<script>
import * as echarts from "echarts/core";
import { LineChart, BarChart, PieChart, HeatmapChart } from "echarts/charts";
import {
  TitleComponent,
  TooltipComponent,
  GridComponent,
  LegendComponent,
  MarkPointComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import {
  PLATFORM_COLORS,
  getPlatformColor,
  isEmptyChartOption,
  buildStackedMarkPointPatch,
} from "../utils/statsChartOptions";

echarts.use([
  LineChart,
  BarChart,
  PieChart,
  HeatmapChart,
  TitleComponent,
  TooltipComponent,
  GridComponent,
  LegendComponent,
  MarkPointComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

const LEGEND_SELECT_EVENTS = [
  "legendselectchanged",
  "legendselected",
  "legendunselected",
  "legendselectall",
  "legendinverseselect",
];

export { PLATFORM_COLORS, getPlatformColor };

export default {
  name: "StatsChart",
  props: {
    option: {
      type: Object,
      default: null,
    },
    height: {
      type: [String, Number],
      default: "320px",
    },
    loading: {
      type: Boolean,
      default: false,
    },
    emptyText: {
      type: String,
      default: "暂无数据",
    },
  },
  computed: {
    isEmpty() {
      return isEmptyChartOption(this.option);
    },
    hasData() {
      return !this.isEmpty;
    },
    showEmpty() {
      return this.isEmpty && !this.loading;
    },
    emptyMessage() {
      if (this.option && typeof this.option.emptyText === "string" && this.option.emptyText) {
        return this.option.emptyText;
      }
      return this.emptyText || "暂无数据";
    },
    containerStyle() {
      const h =
        typeof this.height === "number" ? `${this.height}px` : this.height || "320px";
      return { height: h };
    },
  },
  watch: {
    option: {
      deep: true,
      handler() {
        this.$nextTick(() => this.syncOption());
      },
    },
    loading(val) {
      this.syncLoading(val);
    },
    height() {
      this.$nextTick(() => this.resize());
    },
  },
  mounted() {
    this._chart = null;
    this._ro = null;
    this._pendingOption = null;
    this._hasPendingOption = false;
    this._onWindowResize = () => this.resize();
    this._onLegendSelectChanged = (params) => this.handleLegendSelectChanged(params);

    if (typeof ResizeObserver !== "undefined" && this.$refs.root) {
      this._ro = new ResizeObserver(() => {
        this.resize();
      });
      this._ro.observe(this.$refs.root);
    } else if (typeof window !== "undefined") {
      window.addEventListener("resize", this._onWindowResize);
    }

    this.$nextTick(() => {
      this.initOrUpdate();
    });
  },
  beforeDestroy() {
    this._pendingOption = null;
    this._hasPendingOption = false;
    if (this._ro) {
      this._ro.disconnect();
      this._ro = null;
    }
    if (typeof window !== "undefined" && this._onWindowResize) {
      window.removeEventListener("resize", this._onWindowResize);
    }
    if (this._chart) {
      if (typeof this._chart.off === "function" && this._onLegendSelectChanged) {
        for (const ev of LEGEND_SELECT_EVENTS) {
          this._chart.off(ev, this._onLegendSelectChanged);
        }
      }
      this._chart.dispose();
      this._chart = null;
    }
  },
  methods: {
    buildRenderOption() {
      const opt = this.option;
      if (!opt || typeof opt !== "object") return null;
      const clean = { ...opt };
      delete clean.__empty;
      delete clean.emptyText;
      return clean;
    },
    hasVisibleSize() {
      const el = this.$refs.canvas;
      return Boolean(el && el.clientWidth > 0 && el.clientHeight > 0);
    },
    bindChartEvents() {
      if (!this._chart || typeof this._chart.on !== "function") return;
      for (const ev of LEGEND_SELECT_EVENTS) {
        if (typeof this._chart.off === "function") {
          this._chart.off(ev, this._onLegendSelectChanged);
        }
        this._chart.on(ev, this._onLegendSelectChanged);
      }
    },
    handleLegendSelectChanged(params) {
      if (!this._chart || this.isEmpty) return;
      const selected = params && params.selected;
      if (!selected || typeof selected !== "object") return;
      const renderOpt = this.buildRenderOption();
      if (!renderOpt) return;
      const patch = buildStackedMarkPointPatch(renderOpt, selected);
      if (patch) {
        this._chart.setOption(patch, false);
      }
    },
    initOrUpdate() {
      if (this.isEmpty) {
        this._pendingOption = null;
        this._hasPendingOption = false;
        if (this._chart) this._chart.clear();
        return;
      }
      const renderOpt = this._hasPendingOption
        ? this._pendingOption || this.buildRenderOption()
        : this.buildRenderOption();
      if (!this.hasVisibleSize()) {
        this._pendingOption = renderOpt;
        this._hasPendingOption = Boolean(renderOpt);
        return;
      }
      if (!this._chart) {
        this._chart = echarts.init(this.$refs.canvas);
        this.syncLoading(this.loading);
        this.bindChartEvents();
      }
      this._pendingOption = null;
      this._hasPendingOption = false;
      if (renderOpt) {
        this._chart.setOption(renderOpt, true);
      }
    },
    syncOption() {
      if (this.isEmpty) {
        this._pendingOption = null;
        this._hasPendingOption = false;
        if (this._chart) this._chart.clear();
        return;
      }
      const renderOpt = this.buildRenderOption();
      if (!this.hasVisibleSize()) {
        this._pendingOption = renderOpt;
        this._hasPendingOption = Boolean(renderOpt);
        return;
      }
      if (!this._chart) {
        this.initOrUpdate();
        return;
      }
      this._pendingOption = null;
      this._hasPendingOption = false;
      if (renderOpt) {
        this._chart.setOption(renderOpt, true);
        this._chart.resize();
      }
    },
    syncLoading(val) {
      if (!this._chart) return;
      if (val) {
        this._chart.showLoading("default", {
          text: "加载中…",
          color: "#409eff",
          textColor: "#606266",
          maskColor: "rgba(255, 255, 255, 0.72)",
        });
      } else {
        this._chart.hideLoading();
      }
    },
    resize() {
      if (this.isEmpty) {
        this._pendingOption = null;
        this._hasPendingOption = false;
        return;
      }
      if (!this.hasVisibleSize()) return;
      if (!this._chart) {
        this.initOrUpdate();
        return;
      }
      if (this._hasPendingOption) {
        const pending = this._pendingOption || this.buildRenderOption();
        this._pendingOption = null;
        this._hasPendingOption = false;
        if (pending) {
          this._chart.setOption(pending, true);
        }
      }
      this._chart.resize();
    },
    getDataURL(opts = {}) {
      if (this.isEmpty) return "";
      if (this.hasVisibleSize()) {
        if (!this._chart) {
          this.initOrUpdate();
        } else if (this._hasPendingOption) {
          this.resize();
        }
      }
      if (!this._chart) return "";
      return this._chart.getDataURL({
        type: "png",
        pixelRatio: 2,
        backgroundColor: "#ffffff",
        ...opts,
      });
    },
  },
};
</script>

<style lang="scss" scoped>
.stats-chart-root {
  position: relative;
  width: 100%;
  min-height: 120px;
}

.stats-chart-canvas {
  width: 100%;
  height: 100%;
}

.stats-chart-empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: #909399;
  background: #fafafa;
  border: 1px dashed #e4e7ed;
  border-radius: 6px;
}
</style>
