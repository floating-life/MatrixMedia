"use strict";

const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const { EventEmitter } = require("events");
const { build } = require("esbuild");
const compiler = require("vue-template-compiler");

const root = path.join(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const outDir = path.join(root, "test/.cache");
fs.mkdirSync(outDir, { recursive: true });

const forkBundle = path.join(outDir, "updateChecker-fork.cjs");
const upstreamBundle = path.join(outDir, "updateChecker-upstream.cjs");
const titleBundle = path.join(outDir, "title-component.cjs");

function createMockHttps(releasePayload) {
  let requestCount = 0;
  const mockHttps = {
    request(_options, cb) {
      requestCount += 1;
      const req = new EventEmitter();
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        process.nextTick(() => {
          cb(res);
          res.emit("data", JSON.stringify(releasePayload));
          res.emit("end");
        });
      };
      return req;
    },
  };
  return {
    mockHttps,
    getRequestCount: () => requestCount,
    resetRequestCount: () => {
      requestCount = 0;
    },
  };
}

function createMockElectron(ipcInvokeHandler) {
  return {
    app: {
      runningUnderARM64Translation: false,
      getPath: () => outDir,
    },
    dialog: {
      showErrorBox: () => {},
    },
    ipcRenderer: {
      invoke: ipcInvokeHandler || (async () => ({})),
      on: () => {},
      removeAllListeners: () => {},
      removeListener: () => {},
    },
  };
}

function createMockWin() {
  const downloadUrls = [];
  return {
    downloadUrls,
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      downloadURL: (url) => downloadUrls.push(url),
      session: {
        once: () => {},
      },
    },
  };
}

async function run() {
  assert.strictEqual(pkg.version, "0.15.0-fork.1");
  assert.match(pkg.version, /-fork\./);

  await build({
    entryPoints: [path.join(root, "src/main/services/updateChecker.js")],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron", "https"],
    outfile: forkBundle,
  });

  await build({
    entryPoints: [path.join(root, "src/main/services/updateChecker.js")],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron", "https"],
    outfile: upstreamBundle,
    plugins: [
      {
        name: "mock-non-fork-package-json",
        setup(b) {
          b.onLoad({ filter: /package\.json$/ }, () => ({
            contents: JSON.stringify({ version: "0.14.9" }),
            loader: "json",
          }));
        },
      },
    ],
  });

  const titleVuePath = path.join(root, "src/renderer/components/title/index.vue");
  const titleSfc = compiler.parseComponent(fs.readFileSync(titleVuePath, "utf8"));
  await build({
    stdin: {
      contents: titleSfc.script.content,
      resolveDir: path.dirname(titleVuePath),
      loader: "js",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    outfile: titleBundle,
    plugins: [
      {
        name: "stub-assets",
        setup(b) {
          b.onResolve({ filter: /^@\// }, (args) => ({
            path: args.path,
            namespace: "stub-asset",
          }));
          b.onLoad({ filter: /.*/, namespace: "stub-asset" }, () => ({
            contents: "module.exports = 'stub-asset';",
            loader: "js",
          }));
        },
      },
    ],
  });

  const releasePayload = {
    id: 1001,
    tag_name: "v0.15.0",
    name: "v0.15.0",
    body: "upstream release notes",
    assets: [
      {
        name: "MatrixMedia-0.15.0-win-x64.exe",
        browser_download_url:
          "https://gitee.com/example/MatrixMedia-0.15.0-win-x64.exe",
      },
      {
        name: "MatrixMedia-0.15.0-mac-x64.dmg",
        browser_download_url:
          "https://gitee.com/example/MatrixMedia-0.15.0-mac-x64.dmg",
      },
      {
        name: "MatrixMedia-0.15.0-mac-arm64.dmg",
        browser_download_url:
          "https://gitee.com/example/MatrixMedia-0.15.0-mac-arm64.dmg",
      },
    ],
  };

  const { mockHttps, getRequestCount, resetRequestCount } =
    createMockHttps(releasePayload);
  const mockElectron = createMockElectron(async (channel) => {
    if (channel === "check-for-updates") {
      return {
        hasUpdate: false,
        forkBuild: true,
        currentVersion: "0.15.0-fork.1",
      };
    }
    return undefined;
  });

  const origLoad = Module._load;
  const origPlatformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    "platform"
  );

  Module._load = function (request, ...rest) {
    if (request === "electron") return mockElectron;
    if (request === "https") return mockHttps;
    return origLoad.call(this, request, ...rest);
  };
  Object.defineProperty(process, "platform", {
    value: "win32",
    configurable: true,
  });

  try {
    delete require.cache[forkBundle];
    const forkChecker = require(forkBundle);

    // 1. compareSemver 兼容 -fork.N 后缀
    assert.strictEqual(forkChecker.compareSemver("0.14.9", "0.14.9-fork.1"), 0);
    assert.strictEqual(
      forkChecker.compareSemver("v0.14.9", "0.14.9-fork.1"),
      0
    );
    assert.strictEqual(
      forkChecker.compareSemver("0.14.10", "0.14.9-fork.1"),
      1
    );
    assert.strictEqual(
      forkChecker.compareSemver("0.14.8", "0.14.9-fork.1"),
      -1
    );
    assert.strictEqual(
      forkChecker.compareSemver("0.14.9-fork.2", "0.14.9-fork.1"),
      0
    );
    assert.strictEqual(forkChecker.compareSemver("0.9.10", "0.9.7"), 1);

    // 2. fork 版本下：FORK_BUILD 为 true，不发请求且拒绝下载
    assert.strictEqual(forkChecker.FORK_BUILD, true);
    assert.strictEqual(forkChecker.version, "0.15.0-fork.1");

    const forkCheckRes = await forkChecker.checkForUpdate();
    assert.deepStrictEqual(forkCheckRes, {
      hasUpdate: false,
      forkBuild: true,
      currentVersion: "0.15.0-fork.1",
    });
    assert.strictEqual(getRequestCount(), 0);

    const forkWin = createMockWin();
    const forkDownloadRes = await forkChecker.downloadLatestUpdate(forkWin);
    assert.deepStrictEqual(forkDownloadRes, {
      ok: false,
      message: "当前为 fork 自用版，已关闭自动升级；需要同步上游请联系维护者",
    });
    assert.strictEqual(getRequestCount(), 0);
    assert.strictEqual(forkWin.downloadUrls.length, 0);

    // 3. 注入非 fork 版本号：仍正常请求网络、比较版本与触发下载
    resetRequestCount();
    const injectedUpdate = await forkChecker.checkForUpdate({
      version: "0.14.9",
    });
    assert.strictEqual(getRequestCount(), 1);
    assert.deepStrictEqual(injectedUpdate, {
      hasUpdate: true,
      currentVersion: "0.14.9",
      latestVersion: "0.15.0",
      releaseName: "v0.15.0",
      releaseBody: "upstream release notes",
    });

    const injectedSame = await forkChecker.checkForUpdate({
      version: "0.15.0",
    });
    assert.strictEqual(injectedSame.hasUpdate, false);

    const injectedWin = createMockWin();
    const injectedDownload = await forkChecker.downloadLatestUpdate(
      injectedWin,
      { version: "0.14.9" }
    );
    assert.deepStrictEqual(injectedDownload, { ok: true });
    assert.deepStrictEqual(injectedWin.downloadUrls, [
      "https://gitee.com/example/MatrixMedia-0.15.0-win-x64.exe",
    ]);

    // 4. 独立加载非 fork package.json：FORK_BUILD 为 false，默认参数行为不变
    resetRequestCount();
    delete require.cache[upstreamBundle];
    const upstreamChecker = require(upstreamBundle);
    assert.strictEqual(upstreamChecker.FORK_BUILD, false);
    assert.strictEqual(upstreamChecker.version, "0.14.9");

    const upstreamCheckRes = await upstreamChecker.checkForUpdate();
    assert.strictEqual(getRequestCount(), 1);
    assert.deepStrictEqual(upstreamCheckRes, {
      hasUpdate: true,
      currentVersion: "0.14.9",
      latestVersion: "0.15.0",
      releaseName: "v0.15.0",
      releaseBody: "upstream release notes",
    });

    const upstreamWin = createMockWin();
    const upstreamDownloadRes =
      await upstreamChecker.downloadLatestUpdate(upstreamWin);
    assert.deepStrictEqual(upstreamDownloadRes, { ok: true });
    assert.deepStrictEqual(upstreamWin.downloadUrls, [
      "https://gitee.com/example/MatrixMedia-0.15.0-win-x64.exe",
    ]);

    // 5. 渲染层 title/index.vue：收到 forkBuild 时手动检查提示 fork 信息，自动检查保持静默
    delete require.cache[titleBundle];
    const titleComponent = require(titleBundle).default;
    const manualMessages = [];
    const manualCtx = {
      ...titleComponent.data(),
      $message: { info: (m) => manualMessages.push(m) },
    };
    const manualRes = await titleComponent.methods.checkForUpdates.call(
      manualCtx,
      { force: true }
    );
    assert.strictEqual(manualRes.forkBuild, true);
    assert.strictEqual(manualCtx.versionDialogVisible, false);
    assert.strictEqual(manualMessages.length, 1);
    assert.ok(manualMessages[0].includes("fork 自用版，已关闭自动升级"));
    assert.ok(!manualMessages[0].includes("已是最新版本"));

    const autoMessages = [];
    const autoCtx = {
      ...titleComponent.data(),
      $message: { info: (m) => autoMessages.push(m) },
    };
    const autoRes = await titleComponent.methods.checkForUpdates.call(autoCtx);
    assert.strictEqual(autoRes.forkBuild, true);
    assert.strictEqual(autoCtx.versionDialogVisible, false);
    assert.strictEqual(autoMessages.length, 0);

    console.log("test-fork-guard: all assertions passed");
  } finally {
    Module._load = origLoad;
    if (origPlatformDescriptor) {
      Object.defineProperty(process, "platform", origPlatformDescriptor);
    }
    fs.rmSync(forkBundle, { force: true });
    fs.rmSync(upstreamBundle, { force: true });
    fs.rmSync(titleBundle, { force: true });
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
