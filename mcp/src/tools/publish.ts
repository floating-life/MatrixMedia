import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { runCli } from "../runner.js";

export const VIDEO_PLATFORMS = ["dy", "ks", "blbl", "bjh", "tt", "sph", "xhs", "fqsp"] as const;

export const publishVideoTool: Tool = {
  name: "publish_video",
  description:
    "Publish a video to a target platform via MatrixMedia. Requires a logged-in account " +
    "identified by phone number. Partition is derived automatically. Long-running -- emits " +
    "progress notifications when a progressToken is supplied by the client.",
  inputSchema: {
    type: "object",
    properties: {
      platform: {
        type: "string",
        enum: [...VIDEO_PLATFORMS],
        description:
          "Target platform. dy=抖音 ks=快手 blbl=哔哩哔哩 bjh=百家号 tt=头条 sph=视频号 xhs=小红书 fqsp=番茄视频",
      },
      file: {
        type: "string",
        description: "Absolute path to the video file to upload.",
      },
      title: {
        type: "string",
        description: "Video title.",
      },
      titleByPlatform: {
        type: "object",
        additionalProperties: { type: "string" },
        description:
          'Optional per-platform title overrides keyed by platform code or Chinese name (e.g. {"dy":"抖音标题","bjh":"百家号标题"}). Takes priority over title; still truncated to platform limit if overlength.',
      },
      description: {
        type: "string",
        description:
          "Optional video description or body. Douyin/Kuaishou/Shipinhao append tags after this text; Xiaohongshu uses it as body; Bilibili uses it as the introduction field.",
      },
      descByPlatform: {
        type: "object",
        additionalProperties: { type: "string" },
        description:
          'Optional per-platform description overrides keyed by platform code or Chinese name (e.g. {"ks":"快手简介"}). Takes priority over description; tags are preserved first when truncating.',
      },
      shortTitle: {
        type: "string",
        description:
          "Optional Shipinhao-only short title, recommended 6-16 characters. Ignored by other platforms.",
      },
      phone: {
        type: "string",
        description:
          "Phone number of the account to publish with. Used to derive the session partition automatically.",
      },
      bt2: {
        type: "string",
        description:
          "Legacy compatibility: Shipinhao short title, or description on other platforms. Prefer description / shortTitle.",
      },
      tags: {
        type: "string",
        description: "Optional tags string.",
      },
      address: {
        type: "string",
        description: "Optional location / 地址.",
      },
      publishAt: {
        type: "string",
        description:
          'Optional one-time scheduled publish time, format "YYYY-MM-DD HH:mm:ss". Must be in the future; MatrixMedia must be running at that time.',
      },
      show: {
        type: "boolean",
        description: "If true, show the underlying browser window.",
      },
      draft: {
        type: "boolean",
        description:
          "If true, save the video to the platform draft box instead of publishing it.",
      },
      allowDuplicate: {
        type: "boolean",
        description:
          "If true, bypass the 7-day same-platform/same-account/same-title duplicate publish guard (forwards --allow-duplicate to CLI).",
      },
      noThrottle: {
        type: "boolean",
        description:
          "If true, bypass publish throttling / platform stagger scheduling (forwards --no-throttle to CLI; publishes immediately or keeps explicit publishAt without postponing).",
      },
      noDownload: {
        type: "boolean",
        description:
          "Kuaishou (ks) only: uncheck 允许下载此作品 (disallow downloads for this work) and verify the final checkbox state before submitting; the publish aborts if it cannot be confirmed. Ignored on other platforms.",
      },
      dySyncToutiao: {
        type: "boolean",
        description:
          "Douyin (dy) only: enable 同步到今日头条 (sync publish to Toutiao) on the Douyin publish page and verify readback before submitting (forwards --dy-sync-toutiao to CLI). Effective for Douyin (dy) only; mutually exclusive with publishing to a Toutiao (tt) account.",
      },
      creativeStatement: {
        type: "string",
        description:
          "Optional creative statement / mark tag. For Shipinhao supports values like none, ai_generated, fiction, or Chinese labels such as 含AI生成内容.",
      },
      cover: {
        type: "string",
        description:
          "Optional absolute path to a custom vertical (3:4) cover image. Effective for Douyin (dy), Kuaishou (ks) and Shipinhao (sph) single-file publish; normalized to 1080x1440 JPEG. When coverPathH is omitted, Douyin and Shipinhao auto-generate a 1440x1080 (4:3) horizontal cover from this portrait cover. Shipinhao accepts jpg/png only.",
      },
      coverPathH: {
        type: "string",
        description:
          "Optional absolute path to a custom horizontal (4:3) cover image. Effective for Douyin (dy) and Shipinhao (sph); normalized to 1440x1080 JPEG (center crop without stretching). Shipinhao accepts jpg/png only.",
      },
      collection: {
        type: "string",
        description:
          "Optional collection / album name to attach the video to (effective for Douyin/dy, Kuaishou/ks and Shipinhao/sph; exact match after stripping whitespace; leave empty to skip; ignored on other platforms). Forwards --collection to CLI.",
      },
      sphProductId: {
        type: "string",
        description:
          "Shipinhao product ID for attaching a shop product. Ignored for other platforms. Prefer this over sphLink for product-only use.",
      },
      sphDramaId: {
        type: "string",
        description:
          "Shipinhao mini-drama NAME (not an ID) for attaching a mini-drama (小程序短剧), e.g. 泳陷错恋. The publish page searches by name. Ignored for other platforms. Prefer this over sphLink for drama-only use.",
      },
      sphSeriesId: {
        type: "string",
        description:
          "Shipinhao drama-series NAME (not an ID) for attaching a native 视频号剧集 (distinct from mini-drama 小程序短剧). The publish page searches by name. Ignored for other platforms. Prefer this over sphLink for series-only use.",
      },
      sphLink: {
        type: "object",
        description:
          "Optional Shipinhao-only link configuration. Ignored for other platforms. If sphProductId, sphDramaId or sphSeriesId is also set, the shortcut field wins.",
        properties: {
          type: {
            type: "string",
            enum: ["none", "product", "mini_drama", "sph_series"],
            description:
              "Shipinhao link type. product selects a shop product by ID; mini_drama attaches a mini-drama by name; sph_series attaches a native drama series by name.",
          },
          value: {
            type: "string",
            description:
              "Shipinhao product ID, or mini-drama / drama-series NAME. Required when type=product, type=mini_drama or type=sph_series.",
          },
        },
        required: ["type"],
      },
    },
    required: ["platform", "file", "title", "phone"],
  },
};

export async function handlePublishVideo(
  args: Record<string, unknown>,
  onProgress?: (elapsed: number) => void
): Promise<string> {
  const platform = args.platform;
  const file = args.file;
  const title = args.title;
  const description = args.description;
  const shortTitle = args.shortTitle;
  const phone = args.phone;
  const bt2 = args.bt2;
  const tags = args.tags;
  const address = args.address;
  const publishAt = args.publishAt;
  const show = args.show;
  const draft = args.draft;
  const allowDuplicate = args.allowDuplicate === true;
  const noThrottle = args.noThrottle === true;
  const noDownload = args.noDownload === true;
  const dySyncToutiao = args.dySyncToutiao === true;
  const creativeStatement =
    args.creativeStatement == null ? "" : String(args.creativeStatement).trim();
  const cover = args.cover == null ? "" : String(args.cover).trim();
  const rawCoverH =
    args.coverPathH !== undefined ? args.coverPathH : args.coverH;
  const coverPathH = rawCoverH == null ? "" : String(rawCoverH).trim();
  const titleByPlatform =
    args.titleByPlatform &&
    typeof args.titleByPlatform === "object" &&
    !Array.isArray(args.titleByPlatform)
      ? (args.titleByPlatform as Record<string, unknown>)
      : null;
  const descByPlatform =
    args.descByPlatform &&
    typeof args.descByPlatform === "object" &&
    !Array.isArray(args.descByPlatform)
      ? (args.descByPlatform as Record<string, unknown>)
      : null;
  const collection =
    args.collection == null ? "" : String(args.collection).trim();
  const sphProductId =
    args.sphProductId == null ? "" : String(args.sphProductId).trim();
  const sphDramaId =
    args.sphDramaId == null ? "" : String(args.sphDramaId).trim();
  const sphSeriesId =
    args.sphSeriesId == null ? "" : String(args.sphSeriesId).trim();
  const sphLink = args.sphLink;

  if (typeof phone !== "string" || phone.length === 0) {
    throw new Error("phone must be non-empty string");
  }

  if (typeof file !== "string" || file.length === 0) {
    throw new Error("file must be non-empty string");
  }

  if (!VIDEO_PLATFORMS.includes(String(platform) as (typeof VIDEO_PLATFORMS)[number])) {
    throw new Error("platform must be one of: " + VIDEO_PLATFORMS.join(", "));
  }

  let sphLinkArgs: string[] = [];
  if (String(platform) === "sph") {
    if (sphProductId) {
      sphLinkArgs = ["--sph-product-id", sphProductId];
    } else if (sphDramaId) {
      sphLinkArgs = ["--sph-drama-id", sphDramaId];
    } else if (sphSeriesId) {
      sphLinkArgs = ["--sph-series-id", sphSeriesId];
    } else if (sphLink && typeof sphLink === "object") {
      const link = sphLink as Record<string, unknown>;
      const type = String(link.type || "");
      const value = link.value == null ? "" : String(link.value).trim();
      if (type === "product") {
        if (!value) {
          throw new Error(
            "sphLink.value is required when sphLink.type=product"
          );
        }
        sphLinkArgs = ["--sph-product-id", value];
      } else if (type === "mini_drama" || type === "drama") {
        if (!value) {
          throw new Error(
            "sphLink.value is required when sphLink.type=mini_drama"
          );
        }
        sphLinkArgs = ["--sph-drama-id", value];
      } else if (type === "sph_series" || type === "series") {
        if (!value) {
          throw new Error(
            "sphLink.value is required when sphLink.type=sph_series"
          );
        }
        sphLinkArgs = ["--sph-series-id", value];
      } else if (value) {
        // 兼容旧行为：未指定类型但给了编号时按商品处理
        sphLinkArgs = ["--sph-product-id", value];
      } else if (type) {
        sphLinkArgs = ["--sph-link-type", type];
      }
    }
  }

  const cliArgs: string[] = [
    "publish",
    "-p",
    String(platform),
    "-f",
    file,
    "-t",
    String(title),
    // The CLI derives persist:<phone><平台中文名> itself, keeping every platform alias in sync.
    "--phone",
    phone,
    ...(description ? ["--description", String(description)] : []),
    ...(shortTitle ? ["--short-title", String(shortTitle)] : []),
    ...(bt2 ? ["--bt2", String(bt2)] : []),
    ...(tags ? ["--tags", String(tags)] : []),
    ...(address ? ["--address", String(address)] : []),
    ...(publishAt ? ["--publish-at", String(publishAt)] : []),
    ...(show ? ["--show"] : []),
    ...(draft ? ["--draft"] : []),
    ...(allowDuplicate ? ["--allow-duplicate"] : []),
    ...(noThrottle ? ["--no-throttle"] : []),
    ...(noDownload ? ["--no-download"] : []),
    ...(dySyncToutiao ? ["--dy-sync-toutiao"] : []),
    ...(creativeStatement ? ["--creative-statement", creativeStatement] : []),
    ...(cover ? ["--cover", cover] : []),
    ...(coverPathH ? ["--cover-h", coverPathH] : []),
    ...(titleByPlatform && Object.keys(titleByPlatform).length > 0
      ? ["--title-by-platform", JSON.stringify(titleByPlatform)]
      : []),
    ...(descByPlatform && Object.keys(descByPlatform).length > 0
      ? ["--desc-by-platform", JSON.stringify(descByPlatform)]
      : []),
    ...(collection ? ["--collection", collection] : []),
    ...sphLinkArgs,
  ];

  const result = await runCli(cliArgs, { onProgress });

  if (result.exitCode === 0) {
    const lastJson =
      result.lastJson !== null && typeof result.lastJson === "object"
        ? (result.lastJson as Record<string, unknown>)
        : null;
    if (lastJson && lastJson.scheduled === true) {
      const throttleReason =
        typeof lastJson.throttleReason === "string"
          ? lastJson.throttleReason
          : typeof lastJson.reason === "string"
          ? lastJson.reason
          : "";
      const reasons = Array.isArray(lastJson.reasons)
        ? lastJson.reasons
        : throttleReason
        ? [throttleReason]
        : [];
      return JSON.stringify({
        status: "scheduled",
        scheduled: true,
        id: lastJson.id,
        publishAt: lastJson.publishAt,
        ...(lastJson.plannedAtMs !== undefined
          ? { plannedAtMs: lastJson.plannedAtMs }
          : {}),
        ...(lastJson.creativeStatement !== undefined
          ? { creativeStatement: lastJson.creativeStatement }
          : {}),
        ...(lastJson.ruleAdjustments !== undefined
          ? { ruleAdjustments: lastJson.ruleAdjustments }
          : {}),
        ...(lastJson.ruleAdjustmentsSummary !== undefined
          ? { ruleAdjustmentsSummary: lastJson.ruleAdjustmentsSummary }
          : {}),
        ...(lastJson.throttled !== undefined
          ? { throttled: Boolean(lastJson.throttled) }
          : {}),
        ...(throttleReason
          ? { throttleReason, reason: throttleReason }
          : {}),
        ...(reasons.length > 0 ? { reasons } : {}),
        ...(lastJson.duplicate !== undefined
          ? { duplicate: Boolean(lastJson.duplicate) }
          : {}),
        message: lastJson.message,
      });
    }
    return JSON.stringify({
      status: lastJson?.resultStatus ?? "success",
      publishMode: lastJson?.publishMode,
      ...(lastJson?.creativeStatement !== undefined
        ? { creativeStatement: lastJson.creativeStatement }
        : {}),
      ...(lastJson?.ruleAdjustments !== undefined
        ? { ruleAdjustments: lastJson.ruleAdjustments }
        : {}),
      ...(lastJson?.ruleAdjustmentsSummary !== undefined
        ? { ruleAdjustmentsSummary: lastJson.ruleAdjustmentsSummary }
        : {}),
      ...(lastJson?.draftVerified !== undefined
        ? { draftVerified: lastJson.draftVerified }
        : {}),
      ...(lastJson?.draftUrlUnchanged !== undefined
        ? { draftUrlUnchanged: lastJson.draftUrlUnchanged }
        : {}),
      message: lastJson?.message ?? "上传成功",
    });
  }

  if (result.exitCode === 4) {
    const lastJson =
      result.lastJson !== null && typeof result.lastJson === "object"
        ? (result.lastJson as Record<string, unknown>)
        : {};
    if (lastJson.duplicate === true) {
      return JSON.stringify({
        status: (lastJson.status as string) ?? "needs_attention",
        needsAttention: true,
        duplicate: true,
        ...(lastJson.id !== undefined ? { id: lastJson.id } : {}),
        ...(lastJson.publishAt !== undefined
          ? { publishAt: lastJson.publishAt }
          : {}),
        ...(lastJson.plannedAtMs !== undefined
          ? { plannedAtMs: lastJson.plannedAtMs }
          : {}),
        ...(lastJson.creativeStatement !== undefined
          ? { creativeStatement: lastJson.creativeStatement }
          : {}),
        ...(lastJson.requestedCreativeStatement !== undefined
          ? { requestedCreativeStatement: lastJson.requestedCreativeStatement }
          : {}),
        ...(lastJson.collection !== undefined
          ? { collection: lastJson.collection }
          : {}),
        ...(lastJson.requestedCollection !== undefined
          ? { requestedCollection: lastJson.requestedCollection }
          : {}),
        ...(lastJson.dySyncToutiao !== undefined
          ? { dySyncToutiao: lastJson.dySyncToutiao }
          : {}),
        ...(lastJson.requestedDySyncToutiao !== undefined
          ? { requestedDySyncToutiao: lastJson.requestedDySyncToutiao }
          : {}),
        message:
          (lastJson.message as string) ??
          "同一视频在该时间点的定时任务已存在，但创作声明不一致",
      });
    }
    return JSON.stringify({
      status: "needs_attention",
      publishMode: (lastJson.publishMode as string) ?? "draft",
      outcome: (lastJson.outcome as string) ?? "draft_saved",
      ...(lastJson.creativeStatement !== undefined
        ? { creativeStatement: lastJson.creativeStatement }
        : {}),
      needsAttention: true,
      message:
        (lastJson.message as string) ?? "已转存草稿，请检查视频号链接",
    });
  }

  if (result.exitCode === 6) {
    const lastJson =
      result.lastJson !== null && typeof result.lastJson === "object"
        ? (result.lastJson as Record<string, unknown>)
        : {};
    return JSON.stringify({
      ...lastJson,
      status: (lastJson.status as string) ?? "duplicate",
      exitCode: 6,
      duplicate: true,
      ...(lastJson.lastPublishAt !== undefined
        ? { lastPublishAt: lastJson.lastPublishAt }
        : {}),
      ...(lastJson.lastPublishAtText !== undefined
        ? { lastPublishAtText: lastJson.lastPublishAtText }
        : {}),
      message:
        (lastJson.message as string) ??
        (result.stderr.trim() || "近 7 天内已有相同标题发布记录，已拦截重复发布"),
    });
  }

  if (result.exitCode === 3) {
    throw new Error(
      (result.lastJson as any)?.message ?? "发布失败(登录态异常)"
    );
  }

  if (result.exitCode === 1) {
    throw new Error("发布超时或失败: " + result.stderr.slice(0, 300));
  }

  if (result.exitCode === 2) {
    throw new Error("参数错误: " + result.stderr.slice(0, 200));
  }

  throw new Error("未知错误 exit " + String(result.exitCode));
}
