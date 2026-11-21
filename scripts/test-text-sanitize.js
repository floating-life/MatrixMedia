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
  splitAndSanitizeTags,
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
      "标签1,标签2,标签3",
      "tags 字符串应清理 _x000d_ 并按换行拆分为无损逗号串"
    );
    assert.deepStrictEqual(
      sanitizeTags(["  #美食_x000d_\r\n", "_X000D_", "旅行\r日记"]),
      ["美食", "旅行", "日记"],
      "tags 数组应统一走共享拆分与清洗并过滤空项"
    );
    assert.deepStrictEqual(
      splitAndSanitizeTags("美食_x000d_\r\n旅行"),
      ["美食", "旅行"],
      "splitAndSanitizeTags 应将含 _x000d_ 与换行的标签拆成独立标签"
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

    // 3. S10-fix #1a：bt2 作为简介时保留换行，只有作为视频号短标题时才折行
    {
      const bt2Input = "第一行_x000d_\r\n第二行";

      // B 站 CLI --bt2
      const blblCliArgv = sanitizePublishCliArgs([
        "-p",
        "blbl",
        "--phone",
        "A组",
        "-f",
        cliVideoFile,
        "-t",
        "B站测试标题",
        "--bt2",
        bt2Input,
      ]);
      const blblCliParsed = parsePublish.parsePublishArgs(blblCliArgv);
      assert.strictEqual(blblCliParsed.ok, true, blblCliParsed.error);
      assert.strictEqual(
        blblCliParsed.value.description,
        "第一行\n第二行",
        "B 站 CLI --bt2 作为简介必须保留换行"
      );

      // B 站 HTTP bt2 vs description
      const blblHttpBt2 = parsePublish.parseMultiPublishRequest(
        sanitizePublishPayloadObject({
          platform: "blbl",
          phone: "A组",
          file: cliVideoFile,
          title: "B站测试标题",
          bt2: bt2Input,
        })
      );
      const blblHttpDesc = parsePublish.parseMultiPublishRequest(
        sanitizePublishPayloadObject({
          platform: "blbl",
          phone: "A组",
          file: cliVideoFile,
          title: "B站测试标题",
          description: bt2Input,
        })
      );
      assert.strictEqual(blblHttpBt2.ok, true);
      assert.strictEqual(blblHttpDesc.ok, true);
      assert.strictEqual(
        blblHttpBt2.value.description,
        "第一行\n第二行",
        "B 站 HTTP bt2 作为简介必须保留换行"
      );
      assert.strictEqual(
        blblHttpBt2.value.description,
        blblHttpDesc.value.description,
        "HTTP bt2 与 description 在 B 站结果必须一致"
      );

      // 视频号 CLI --bt2 与 HTTP bt2：作为短标题折行
      const sphCliArgv = sanitizePublishCliArgs([
        "--bt2",
        bt2Input,
        "-p",
        "sph",
        "--phone",
        "A组",
        "-f",
        cliVideoFile,
        "-t",
        "视频号测试标题",
      ]);
      const sphCliParsed = parsePublish.parsePublishArgs(sphCliArgv);
      assert.strictEqual(sphCliParsed.ok, true, sphCliParsed.error);
      assert.strictEqual(
        sphCliParsed.value.shortTitle,
        "第一行 第二行",
        "视频号 CLI --bt2 作为短标题应把换行折成空格"
      );

      const sphHttpBt2 = parsePublish.parseMultiPublishRequest(
        sanitizePublishPayloadObject({
          platform: "sph",
          phone: "A组",
          file: cliVideoFile,
          title: "视频号测试标题",
          bt2: bt2Input,
        })
      );
      assert.strictEqual(sphHttpBt2.ok, true, sphHttpBt2.error);
      assert.strictEqual(sphHttpBt2.value.shortTitle, "第一行 第二行");

      // 多平台 HTTP 共享顶层 bt2：B 站保留换行、视频号折行
      const multiBt2 = parsePublish.parseMultiPublishRequest(
        sanitizePublishPayloadObject({
          phone: "A组",
          file: cliVideoFile,
          title: "多平台bt2标题",
          bt2: bt2Input,
          platforms: ["blbl", "sph"],
        })
      );
      assert.strictEqual(multiBt2.ok, true, multiBt2.error);
      assert.strictEqual(multiBt2.value[0].description, "第一行\n第二行");
      assert.strictEqual(multiBt2.value[1].shortTitle, "第一行 第二行");
    }

    // 4. S10-fix #1b：B 站标签 `美食_x000d_\r\n旅行` 在 GUI / CLI / HTTP 三条链路结果完全一致
    {
      const rawTagCell = "美食_x000d_\r\n旅行";
      const tagXlsxPath = path.join(tmpDir, "blbl-tags.xlsx");
      const wbTag = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(
        wbTag,
        xlsx.utils.json_to_sheet([
          {
            "文件名": "demo.mp4",
            "标题": "B站标签一致性",
            "简介": "简介",
            "标签": rawTagCell,
          },
        ]),
        "Sheet1"
      );
      xlsx.writeFile(wbTag, tagXlsxPath);

      const tagRows = normalizeBatchXlsxRows(
        xlsx.utils.sheet_to_json(xlsx.readFile(tagXlsxPath).Sheets.Sheet1, { defval: "" })
      );
      // GUI 批量导入（与 LocalVideoPublish.vue 完全同路径：splitAndSanitizeTags -> normalizeVideoMetadata -> blbl normalizeVideoTags）
      const guiBatchTagList = splitAndSanitizeTags(tagRows[0].tags);
      const guiBatchMeta = videoMetadata.normalizeVideoMetadata(
        { title: tagRows[0].title, description: tagRows[0].description, tags: guiBatchTagList },
        "哔哩哔哩"
      );
      const guiBlblTags = videoMetadata.normalizeVideoTags(guiBatchMeta.tags);

      // GUI 单视频发布（数组形态传入含换行的脏项）
      const guiSingleMeta = videoMetadata.normalizeVideoMetadata(
        { title: "B站标签一致性", tags: splitAndSanitizeTags([rawTagCell]) },
        "哔哩哔哩"
      );
      const guiSingleBlblTags = videoMetadata.normalizeVideoTags(guiSingleMeta.tags);

      // CLI 批量导入 Excel
      const cliBatchTagList = splitAndSanitizeTags(tagRows[0].tags);
      const cliBatchMeta = videoMetadata.normalizeVideoMetadata(
        { title: tagRows[0].title, description: tagRows[0].description, tags: cliBatchTagList },
        "哔哩哔哩"
      );
      const cliBatchBlblTags = videoMetadata.normalizeVideoTags(cliBatchMeta.tags);

      // CLI 单文件 --tags
      const cliSingleParsed = parsePublish.parsePublishArgs(
        sanitizePublishCliArgs([
          "-p",
          "blbl",
          "--phone",
          "A组",
          "-f",
          cliVideoFile,
          "-t",
          "B站标签一致性",
          "--tags",
          rawTagCell,
        ])
      );
      assert.strictEqual(cliSingleParsed.ok, true, cliSingleParsed.error);
      const cliSingleBlblTags = videoMetadata.normalizeVideoTags(cliSingleParsed.value.bq);

      // HTTP /publish
      const httpParsedTags = parsePublish.parseMultiPublishRequest(
        sanitizePublishPayloadObject({
          platform: "blbl",
          phone: "A组",
          file: cliVideoFile,
          title: "B站标签一致性",
          tags: rawTagCell,
        })
      );
      assert.strictEqual(httpParsedTags.ok, true, httpParsedTags.error);
      const httpBlblTags = videoMetadata.normalizeVideoTags(httpParsedTags.value.bq);

      for (const [label, got] of [
        ["GUI 批量 Excel", guiBlblTags],
        ["GUI 单发", guiSingleBlblTags],
        ["CLI 批量 Excel", cliBatchBlblTags],
        ["CLI 单发", cliSingleBlblTags],
        ["HTTP /publish", httpBlblTags],
      ]) {
        assert.deepStrictEqual(
          got,
          ["美食", "旅行"],
          `${label} B 站标签应拆分为 ["美食", "旅行"]，实际=${JSON.stringify(got)}`
        );
      }
    }

    // 5. S10-fix2 #3：标签拆分只按逗号/中文逗号/顿号/换行/#分隔，不按空格拆（"FinalCutPro,剪辑" 保持完整，三条链路一致）
    {
      const spacedTagCell = "FinalCutPro,剪辑";
      const spacedXlsxPath = path.join(tmpDir, "blbl-spaced-tags.xlsx");
      const wbSpaced = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(
        wbSpaced,
        xlsx.utils.json_to_sheet([
          {
            "文件名": "demo.mp4",
            "标题": "B站含空格标签测试",
            "简介": "简介",
            "标签": spacedTagCell,
          },
        ]),
        "Sheet1"
      );
      xlsx.writeFile(wbSpaced, spacedXlsxPath);

      const spacedRows = normalizeBatchXlsxRows(
        xlsx.utils.sheet_to_json(xlsx.readFile(spacedXlsxPath).Sheets.Sheet1, { defval: "" })
      );
      // GUI 批量 Excel（LocalVideoPublish.vue:2462 同路径）
      const guiBatchTags = videoMetadata.normalizeVideoTags(
        videoMetadata.normalizeVideoMetadata(
          { title: spacedRows[0].title, description: spacedRows[0].description, tags: splitAndSanitizeTags(spacedRows[0].tags) },
          "哔哩哔哩"
        ).tags
      );
      // GUI 单视频发布
      const guiSingleTags = videoMetadata.normalizeVideoTags(
        videoMetadata.normalizeVideoMetadata(
          { title: "B站含空格标签测试", tags: splitAndSanitizeTags(["FinalCutPro", "剪辑"]) },
          "哔哩哔哩"
        ).tags
      );
      // CLI 批量 Excel
      const cliBatchTags = videoMetadata.normalizeVideoTags(
        videoMetadata.normalizeVideoMetadata(
          { title: spacedRows[0].title, description: spacedRows[0].description, tags: splitAndSanitizeTags(spacedRows[0].tags) },
          "哔哩哔哩"
        ).tags
      );
      // CLI 单文件 --tags
      const cliSingleParsedSpaced = parsePublish.parsePublishArgs(
        sanitizePublishCliArgs([
          "-p",
          "blbl",
          "--phone",
          "A组",
          "-f",
          cliVideoFile,
          "-t",
          "B站含空格标签测试",
          "--tags",
          spacedTagCell,
        ])
      );
      assert.strictEqual(cliSingleParsedSpaced.ok, true, cliSingleParsedSpaced.error);
      const cliSingleTagsFromTags = videoMetadata.normalizeVideoTags(cliSingleParsedSpaced.value.tags);
      const cliSingleTagsFromBq = videoMetadata.normalizeVideoTags(cliSingleParsedSpaced.value.bq);
      // HTTP /publish（字符串与数组形态）
      const httpStrParsed = parsePublish.parseMultiPublishRequest(
        sanitizePublishPayloadObject({
          platform: "blbl",
          phone: "A组",
          file: cliVideoFile,
          title: "B站含空格标签测试",
          tags: spacedTagCell,
        })
      );
      assert.strictEqual(httpStrParsed.ok, true, httpStrParsed.error);
      const httpStrTags = videoMetadata.normalizeVideoTags(httpStrParsed.value.bq);
      const httpArrParsed = parsePublish.parseMultiPublishRequest(
        sanitizePublishPayloadObject({
          platform: "blbl",
          phone: "A组",
          file: cliVideoFile,
          title: "B站含空格标签测试",
          tags: ["FinalCutPro", "剪辑"],
        })
      );
      assert.strictEqual(httpArrParsed.ok, true, httpArrParsed.error);
      const httpArrTags = videoMetadata.normalizeVideoTags(httpArrParsed.value.bq);

      for (const [label, got] of [
        ["GUI 批量 Excel", guiBatchTags],
        ["GUI 单发", guiSingleTags],
        ["CLI 批量 Excel", cliBatchTags],
        ["CLI 单发(tags)", cliSingleTagsFromTags],
        ["CLI 单发(bq)", cliSingleTagsFromBq],
        ["HTTP /publish(string)", httpStrTags],
        ["HTTP /publish(array)", httpArrTags],
      ]) {
        assert.deepStrictEqual(
          got,
          ["FinalCutPro", "剪辑"],
          `S10-fix2 #3 ${label} 应保留含空格标签 ["FinalCutPro", "剪辑"]，实际=${JSON.stringify(got)}`
        );
        assert.deepStrictEqual(splitAndSanitizeTags("减脂,健身 教程"), ["减脂", "健身", "教程"]);
      assert.deepStrictEqual(splitAndSanitizeTags(["Final Cut Pro", "剪辑"]), ["Final Cut Pro", "剪辑"]);
    }

      // 校验分隔符（逗号/中文逗号/顿号/换行/#/空格）
      assert.deepStrictEqual(
        splitAndSanitizeTags("FinalCutPro，剪辑、后期制作\n#DaVinciResolve #调色"),
        ["FinalCutPro", "剪辑", "后期制作", "DaVinciResolve", "调色"]
      );
      // 抖音等话题平台在加 # 后再拆分仍保持完整
      const dyParsedSpaced = parsePublish.parsePublishArgs(
        sanitizePublishCliArgs([
          "-p",
          "dy",
          "--phone",
          "A组",
          "-f",
          cliVideoFile,
          "-t",
          "抖音含空格标签测试",
          "--tags",
          spacedTagCell,
        ])
      );
      assert.strictEqual(dyParsedSpaced.ok, true, dyParsedSpaced.error);
      assert.strictEqual(dyParsedSpaced.value.bq, "#FinalCutPro #剪辑");
      assert.deepStrictEqual(
        videoMetadata.normalizeVideoTags(dyParsedSpaced.value.bq),
        ["FinalCutPro", "剪辑"]
      );
    }

    // 确认 ipcMain.js / cli/index.js / LocalVideoPublish.vue / routes/index.js 统一接入共享清洗与标签拆分
    const ipcSrc = fs.readFileSync(path.join(root, "src/main/services/ipcMain.js"), "utf8");
    const cliSrc = fs.readFileSync(path.join(root, "src/main/cli/index.js"), "utf8");
    const routeSrc = fs.readFileSync(path.join(root, "src/main/server/routes/index.js"), "utf8");
    const vueSrc = fs.readFileSync(
      path.join(root, "src/renderer/components/LocalVideoPublish.vue"),
      "utf8"
    );
    assert.ok(ipcSrc.includes("normalizeBatchXlsxRows"), "ipcMain.js 应调用共享 normalizeBatchXlsxRows");
    assert.ok(cliSrc.includes("normalizeBatchXlsxRows"), "cli/index.js 应调用共享 normalizeBatchXlsxRows");
    assert.ok(cliSrc.includes("sanitizePublishCliArgs"), "cli/index.js 应调用 sanitizePublishCliArgs");
    assert.ok(cliSrc.includes("splitAndSanitizeTags"), "cli/index.js 应调用共享 splitAndSanitizeTags");
    assert.ok(vueSrc.includes("splitAndSanitizeTags"), "LocalVideoPublish.vue 应调用共享 splitAndSanitizeTags");
    assert.ok(
      routeSrc.includes("sanitizePublishPayloadObject"),
      "server/routes/index.js 应调用 sanitizePublishPayloadObject"
    );

    console.log("✓ S10 #1 标题/文案共享清洗、bt2 简介换行与 GUI/CLI/HTTP 标签一致性验证通过");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
