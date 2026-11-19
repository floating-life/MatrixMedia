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
import statsScheduler from "@/utils/statsScheduler";

const instance = getCurrentInstance();

onMounted(() => {
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
});

onBeforeUnmount(() => {
  statsScheduler.stop();
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
