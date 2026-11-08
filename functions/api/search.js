// 搜索网关（Cloudflare Pages Functions）
// GET /api/search?q=<关键词>&limit=20&page=<continuationToken>
// 输出：{success, query, backend, count, videos:[{videoId,title,channel,published,duration,views,url}], continuation}
//
// 后端：InnerTube /youtubei/v1/search（主力）→ Piped /search?filter=videos（降级）
// 鉴权：配置了 GATEWAY_KEY 才校验 x-gateway-key；未配置则公开（见 _lib/auth.js）
// 说明：params=EgIQAQ%3D%3D 是“只搜视频”的 protobuf 常量；不传会混进频道/播放列表。
// 解析同时认老 videoRenderer 与新 lockupViewModel（2026 年 YouTube 已在搜索页混用）。

import { UA, innertubePost, webContext } from "../_lib/innertube.js";
import { createCooldown } from "../_lib/health.js";
import { checkKey, keyConfigured, preflight } from "../_lib/auth.js";

const VIDEO_PARAMS = "EgIQAQ%3D%3D";
const MAX_LIMIT = 30;
const DEFAULT_LIMIT = 20;

const PIPED_INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://api.piped.private.coffee",
];
const pipedCooldown = createCooldown();

const isVideoId = (s) => /^[\w-]{11}$/.test(String(s || ""));

function respond(data, status = 200, cache = "public, max-age=300") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": cache,
    },
  });
}

// 递归遍历任意 JSON，把 visitor 需要的节点交给它
function walk(node, visit, depth = 0) {
  if (!node || typeof node !== "object" || depth > 30) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit, depth + 1);
    return;
  }
  visit(node);
  for (const key in node) walk(node[key], visit, depth + 1);
}

function textOf(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.simpleText) return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map((r) => r.text || "").join("");
  if (node.content) return textOf(node.content);
  return "";
}

function parseInnertube(j, limit) {
  const videos = [];
  const seen = new Set();
  let continuation = null;

  walk(j, (n) => {
    if (!continuation) {
      const token =
        n.continuationCommand?.token ||
        n.continuationEndpoint?.continuationCommand?.token;
      if (token) continuation = token;
    }
    if (videos.length >= limit) return;

    const vr = n.videoRenderer;
    if (vr?.videoId && isVideoId(vr.videoId) && !seen.has(vr.videoId)) {
      seen.add(vr.videoId);
      videos.push({
        videoId: vr.videoId,
        title: textOf(vr.title),
        channel: textOf(vr.ownerText) || textOf(vr.longBylineText),
        published: textOf(vr.publishedTimeText),
        duration: textOf(vr.lengthText),
        views: textOf(vr.viewCountText),
        url: "https://www.youtube.com/watch?v=" + vr.videoId,
      });
      return;
    }

    const lv = n.lockupViewModel;
    const id = lv?.contentId;
    if (id && isVideoId(id) && !seen.has(id)) {
      const meta = lv?.metadata?.lockupMetadataViewModel;
      const rows = [];
      walk(meta, (m) => {
        if (m?.content && typeof m.content === "string" && m.content.length < 60) rows.push(m.content);
      });
      seen.add(id);
      videos.push({
        videoId: id,
        title: textOf(meta?.title),
        channel: rows.find((r) => !/^\d|ago$|views?$|watch/i.test(r)) || "",
        published: rows.find((r) => /ago$/.test(r)) || "",
        duration: "",
        views: rows.find((r) => /views?$/.test(r)) || "",
        url: "https://www.youtube.com/watch?v=" + id,
      });
    }
  });

  return { videos, continuation };
}

async function viaPiped(q, limit) {
  for (const base of pipedCooldown.order(PIPED_INSTANCES)) {
    if (pipedCooldown.isCooling(base)) continue;
    try {
      const r = await fetch(`${base}/api/v1/search?q=${encodeURIComponent(q)}&filter=videos`, {
        headers: { "user-agent": UA },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      const items = (j.items || []).filter((x) => x.type === "stream" && isVideoId(x.url?.split("v=")[1]));
      const videos = items.slice(0, limit).map((x) => ({
        videoId: x.url.split("v=")[1],
        title: x.title || "",
        channel: x.uploaderName || "",
        published: x.uploadedDate || "",
        duration: String(x.duration || ""),
        views: String(x.views || ""),
        url: "https://www.youtube.com/watch?v=" + x.url.split("v=")[1],
      }));
      pipedCooldown.ok(base);
      return { videos, backend: base };
    } catch (e) {
      pipedCooldown.fail(base);
    }
  }
  return null;
}

export function onRequestOptions() {
  return preflight();
}

export async function onRequestGet({ request, env }) {
  const denied = checkKey(request, env);
  if (denied) return denied;

  // 开了鉴权就不再让边缘缓存：否则同一 URL 的缓存会绕过函数、绕过 key
  const cache = keyConfigured(env) ? "no-store" : "public, max-age=300";

  const u = new URL(request.url);
  const q = (u.searchParams.get("q") || "").trim();
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(u.searchParams.get("limit") || DEFAULT_LIMIT, 10) || DEFAULT_LIMIT));
  const page = u.searchParams.get("page") || "";

  if (!q) return respond({ success: false, error: "missing q" }, 400, cache);
  if (q.length > 120) return respond({ success: false, error: "q too long" }, 400, cache);

  try {
    const body = { context: await webContext(), query: q };
    if (page) {
      body.continuation = page;
    } else {
      body.params = VIDEO_PARAMS;
    }
    const j = await innertubePost("search", body, { timeout: 15000 });
    const { videos, continuation } = parseInnertube(j, limit);
    if (videos.length) {
      return respond({ success: true, query: q, backend: "innertube", count: videos.length, videos, continuation }, 200, cache);
    }
    throw new Error("empty result");
  } catch (e) {
    const fb = await viaPiped(q, limit);
    if (fb) {
      return respond({
        success: true, query: q, backend: "piped:" + fb.backend,
        count: fb.videos.length, videos: fb.videos, continuation: null,
        note: "innertube failed: " + String(e.message || e),
      }, 200, cache);
    }
    return respond({
      success: false, query: q,
      error: "innertube failed: " + String(e.message || e),
      hint: "check clientVersion / bot check; piped fallback also unavailable",
    }, 502, cache);
  }
}
