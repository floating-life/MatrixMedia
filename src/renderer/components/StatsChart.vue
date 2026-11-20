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
    this._onWindowResize = () => this.resize();

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
    if (this._ro) {
      this._ro.disconnect();
      this._ro = null;
    }
    if (typeof window !== "undefined" && this._onWindowResize) {
      window.removeEventListener("resize", this._onWindowResize);
    }
    if (this._chart) {
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
    initOrUpdate() {
      if (this.isEmpty) {
        if (this._chart) this._chart.clear();
        return;
      }
      if (!this.hasVisibleSize()) return;
      if (!this._chart) {
        this._chart = echarts.init(this.$refs.canvas);
        this.syncLoading(this.loading);
      }
      const renderOpt = this.buildRenderOption();
      if (renderOpt) {
        this._chart.setOption(renderOpt, true);
      }
    },
    syncOption() {
      if (this.isEmpty) {
        if (this._chart) this._chart.clear();
        return;
      }
      if (!this._chart) {
        this.initOrUpdate();
        return;
      }
      if (!this.hasVisibleSize()) return;
      const renderOpt = this.buildRenderOption();
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
      if (this.isEmpty) return;
      if (!this.hasVisibleSize()) return;
      if (!this._chart) {
        this.initOrUpdate();
        return;
      }
      this._chart.resize();
    },
    getDataURL(opts = {}) {
      if (this.isEmpty) return "";
      if (!this._chart && this.hasVisibleSize()) {
        this.initOrUpdate();
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
