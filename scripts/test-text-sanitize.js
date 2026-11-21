"use strict";

/**
 * S10 #1 标题/文案清洗单测（修前失败、修后通过）：
 * 1. _x000d_（大小写不敏感、连续多个）与 \r / \r\n 清洗
 * 2. 标题类（title / shortTitle / bt1）把换行折成空格并 trim；description 保留 \n
 * 3. GUI 批量导入（xlsx）、CLI publish / xlsx、HTTP /publish 三条链路清洗结果完全一致
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const xlsx = require("xlsx");
const esbuild = require("esbuild");

const {
  stripExcelEscapesAndCR,
  sanitizeTitle,
  sanitizeDescription,
  sanitizeTags,
  normalizeBatchXlsxRows,
  sanitizePublishPayloadObject,
  sanitizePublishCliArgs,
} = require("../src/shared/textSanitize.js");

const root = path.resolve(__dirname, "..");

function bundleEsm(relPath, outDir, outName) {
  const outFile = path.join(outDir, outName);
  esbuild.buildSync({
    entryPoints: [path.join(root, relPath)],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron", "xlsx"],
  });
  return require(outFile);
}

function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-text-sanitize-"));
  try {
    // 1. 基础清洗与边界用例
    assert.strictEqual(
      stripExcelEscapesAndCR("第一行_x000d_\n第二行_X000D__x000d_\r\n第三行\r第四行"),
      "第一行\n第二行\n第三行\n第四行",
      "应删除大小写混合与连续多个 _x000d_ 并将 \\r\\n 与 \\r 统一为 \\n"
    );
    assert.strictEqual(
      sanitizeTitle("  主标题_x000d_\n副标题_X000D__x000d_\r\n结尾\r  "),
      "主标题 副标题 结尾",
      "标题类字段应把换行折成空格并 trim"
    );
    assert.strictEqual(
      sanitizeTitle("短标题_x000d_一二三"),
      "短标题一二三",
      "无换行的 _x000d_ 应直接删除"
    );
    assert.strictEqual(
      sanitizeDescription("  第一段_x000d_\n第二段_X000D_\r\n第三段\r第四段  "),
      "第一段\n第二段\n第三段\n第四段",
      "description 应保留 \\n 并删除 _x000d_ 与 \\r"
    );
    assert.strictEqual(
      sanitizeTags("  标签1_x000d_\n标签2_X000D_\r标签3  "),
      "标签1 标签2 标签3",
      "tags 字符串应清理 _x000d_ 并折叠换行"
    );
    assert.deepStrictEqual(
      sanitizeTags(["  #美食_x000d_\r\n", "_X000D_", "旅行\r日记"]),
      ["#美食", "旅行 日记"],
      "tags 数组应逐项清洗并过滤空项"
    );

    // 2. 真实 Excel 读写 + GUI / CLI / HTTP 三条链路一致性校验
    const videoMetadata = bundleEsm("src/shared/videoMetadata.js", tmpDir, "videoMetadata.cjs");
    const parsePublish = bundleEsm("src/main/cli/parsePublishArgs.js", tmpDir, "parsePublishArgs.cjs");

    const dirtyTitle = "AI效率神器_x000d_\n实测分享_X000D__x000d_\r";
    const dirtyDesc = "第一点：自动汇总_x000d_\n第二点：多端同步_X000D_\r\n第三点：省时省力\r";
    const dirtyShortTitle = "效率神器实测_x000d_\r分享";
    const dirtyTags = "效率_x000d_, 自动化\r\n工具";

    const xlsxPath = path.join(tmpDir, "batch.xlsx");
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet([
      {
        "文件名": "demo.mp4",
        "标题": dirtyTitle,
        "简介": dirtyDesc,
        "视频号短标题": dirtyShortTitle,
        "标签": dirtyTags,
      },
    ]);
    xlsx.utils.book_append_sheet(wb, ws, "Sheet1");
    xlsx.writeFile(wb, xlsxPath);

    // 链路 A：GUI 批量导入（ipcMain.js dialog:openBatchXlsx 同款解析 + videoMetadata）
    const readWb = xlsx.readFile(xlsxPath);
    const rawRows = xlsx.utils.sheet_to_json(readWb.Sheets[readWb.SheetNames[0]], { defval: "" });
    const guiRow = normalizeBatchXlsxRows(rawRows)[0];
    const guiMeta = videoMetadata.normalizeVideoMetadata(
      {
        title: guiRow.title,
        description: guiRow.description,
        shortTitle: guiRow.shortTitle,
        tags: guiRow.tags,
      },
      "视频号"
    );

    // 链路 B：CLI publish（sanitizePublishCliArgs → parsePublishArgs → normalizeVideoMetadata）
    const cliVideoFile = path.join(tmpDir, "demo.mp4");
    fs.writeFileSync(cliVideoFile, "stub");
    const cliArgv = sanitizePublishCliArgs([
      "-p",
      "sph",
      "--phone",
      "A组",
      "-f",
      cliVideoFile,
      "-t",
      dirtyTitle,
      "--description",
      dirtyDesc,
      "--short-title",
      dirtyShortTitle,
      "--tags",
      dirtyTags,
    ]);
    const cliParsed = parsePublish.parsePublishArgs(cliArgv);
    assert.strictEqual(cliParsed.ok, true, `CLI 参数清洗后应通过视频号短标题校验: ${cliParsed.error}`);
    const cliMeta = videoMetadata.normalizeVideoMetadata(
      {
        title: cliParsed.value.title,
        description: cliParsed.value.description,
        shortTitle: cliParsed.value.shortTitle,
        tags: cliParsed.value.bq,
      },
      "视频号"
    );

    // 链路 C：HTTP /publish（sanitizePublishPayloadObject → parseMultiPublishRequest → normalizeVideoMetadata）
    const httpBody = sanitizePublishPayloadObject({
      platform: "sph",
      phone: "A组",
      file: cliVideoFile,
      title: dirtyTitle,
      description: dirtyDesc,
      shortTitle: dirtyShortTitle,
      tags: dirtyTags,
    });
    const httpParsed = parsePublish.parseMultiPublishRequest(httpBody);
    assert.strictEqual(httpParsed.ok, true, `HTTP 参数清洗后应通过校验: ${httpParsed.error}`);
    const httpMeta = videoMetadata.normalizeVideoMetadata(
      {
        title: httpParsed.value.title,
        description: httpParsed.value.description,
        shortTitle: httpParsed.value.shortTitle,
        tags: httpParsed.value.bq,
      },
      "视频号"
    );

    const expected = {
      title: "AI效率神器 实测分享",
      description: "第一点：自动汇总\n第二点：多端同步\n第三点：省时省力",
      shortTitle: "效率神器实测 分享",
      tags: ["效率", "自动化", "工具"],
    };

    for (const [label, meta] of [
      ["GUI 批量导入", guiMeta],
      ["CLI publish", cliMeta],
      ["HTTP /publish", httpMeta],
    ]) {
      assert.strictEqual(meta.title, expected.title, `${label} title 不一致`);
      assert.strictEqual(meta.description, expected.description, `${label} description 不一致`);
      assert.strictEqual(meta.shortTitle, expected.shortTitle, `${label} shortTitle 不一致`);
      assert.deepStrictEqual(meta.tags, expected.tags, `${label} tags 不一致`);
      assert.strictEqual(meta.legacy.bt1, expected.title, `${label} bt1 应与 title 一致`);
      assert.ok(!meta.title.includes("_x000d_") && !meta.title.includes("\r"));
      assert.ok(!meta.description.includes("_x000d_") && !meta.description.includes("\r"));
      assert.ok(meta.description.includes("\n"), `${label} description 必须保留 \\n`);
    }

    // 多平台 HTTP body 内子项也必须清洗
    const multiBody = sanitizePublishPayloadObject({
      file: cliVideoFile,
      phone: "A组",
      title: "主标题_x000d_\nA",
      description: "第一行_x000d_\r\n第二行",
      platforms: [
        { platform: "dy", title: "抖音专属_X000D_\r\n标题" },
        { platform: "sph", shortTitle: "短标题_x000d_一二三" },
      ],
    });
    assert.strictEqual(multiBody.title, "主标题 A");
    assert.strictEqual(multiBody.description, "第一行\n第二行");
    assert.strictEqual(multiBody.platforms[0].title, "抖音专属 标题");
    assert.strictEqual(multiBody.platforms[1].shortTitle, "短标题一二三");

    // 确认 ipcMain.js 与 cli/index.js 源码都已统一接入 normalizeBatchXlsxRows
    const ipcSrc = fs.readFileSync(path.join(root, "src/main/services/ipcMain.js"), "utf8");
    const cliSrc = fs.readFileSync(path.join(root, "src/main/cli/index.js"), "utf8");
    const routeSrc = fs.readFileSync(path.join(root, "src/main/server/routes/index.js"), "utf8");
    assert.ok(ipcSrc.includes("normalizeBatchXlsxRows"), "ipcMain.js 应调用共享 normalizeBatchXlsxRows");
    assert.ok(cliSrc.includes("normalizeBatchXlsxRows"), "cli/index.js 应调用共享 normalizeBatchXlsxRows");
    assert.ok(cliSrc.includes("sanitizePublishCliArgs"), "cli/index.js 应调用 sanitizePublishCliArgs");
    assert.ok(
      routeSrc.includes("sanitizePublishPayloadObject"),
      "server/routes/index.js 应调用 sanitizePublishPayloadObject"
    );

    console.log("✓ S10 #1 标题/文案共享清洗与 GUI/CLI/HTTP 三链路一致性验证通过");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
