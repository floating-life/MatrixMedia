<template>
  <div id="app">
    <c-header></c-header>
    <div class="app-body">
      <transition name="fade" mode="out-in">
        <router-view></router-view>
      </transition>
    </div>
  </div>
</template>

<script setup>
import { getCurrentInstance, onMounted, onBeforeUnmount } from "vue";
import CHeader from "./components/title";
import statsScheduler, { isMainWindowLocation } from "@/utils/statsScheduler";

const instance = getCurrentInstance();
let schedulerStarted = false;

onMounted(() => {
  if (
    typeof window !== "undefined" &&
    !window.opener &&
    isMainWindowLocation(window.location)
  ) {
    schedulerStarted = true;
    try {
      const rawStored =
        typeof localStorage !== "undefined" && localStorage
          ? localStorage.getItem(statsScheduler.STORAGE_KEY)
          : null;
      if (rawStored && typeof statsScheduler.syncSettingsToMain === "function") {
        statsScheduler.syncSettingsToMain(statsScheduler.loadSettings(), { initOnly: true });
      }
    } catch (_) {}
    statsScheduler.start({
      notify: (options) => {
        if (
          instance &&
          instance.proxy &&
          typeof instance.proxy.$notify === "function"
        ) {
          instance.proxy.$notify(options);
        }
      },
    });
  }
});

onBeforeUnmount(() => {
  if (schedulerStarted) {
    schedulerStarted = false;
    statsScheduler.stop();
  }
});
</script>

<style>
#app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.app-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.app-body > * {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
