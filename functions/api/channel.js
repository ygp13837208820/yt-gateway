// 频道枚举网关（Cloudflare Pages Functions）
// 目标：列出某频道视频（标题/链接/日期/时长/播放量）
// 后端（按可靠性排序）：InnerTube browse 直连（主力）→ Piped /channel（fallback）→ 频道 RSS（最后兜底）
// 输出：{success, backend, channel:{id,name,subscribers}, videos:[...], nextpage, count}
//
// 2026-11-06 修复三处（原来 /api/channel 一律 502）：
//   1. @handle 被直接当成 browseId 发给 browse，InnerTube 回 400 invalid argument；
//      现在先走 navigation/resolve_url 把 handle 换成 UCid。
//   2. 频道页把视频从 videoRenderer 换成了 lockupViewModel，旧解析器一条也抽不出来；
//      现在两种结构都认，时长/播放量/发布时间从 lockup 的 badge 与 metadataRows 里取。
//   3. Videos 标签的 params 不再是固定常量（固定值会落回 Home 标签），改为从频道页
//      自己的 tab 列表里读，读不到才回退到内置值。
// 另外：clientVersion 不再写死，启动时从 youtube.com 首页的 INNERTUBE_CLIENT_VERSION 取，
// 取不到才用常量兜底；Piped 实例从 4 个扩到 9 个，失败的实例记 5 分钟冷却。

const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const API = "https://www.youtube.com/youtubei/v1";

// 兜底值：只在首页取不到 INNERTUBE_CLIENT_VERSION 时使用
const DEFAULT_CLIENT_VERSION = "2.20261030.02.00";
// 兜底值：Videos 标签的 params（正常路径是从频道页 tabs 里读）
const FALLBACK_VIDEOS_PARAMS = "EgZ2aWRlb3PyBgQKAjoA";

// ── clientVersion 自发现（模块作用域缓存，Workers 实例存活期间有效）──
let clientVersionCache = { value: null, at: 0 };

async function clientVersion() {
  if (clientVersionCache.value && Date.now() - clientVersionCache.at < 6 * 3600 * 1000) {
    return clientVersionCache.value;
  }
  try {
    const r = await fetch("https://www.youtube.com/", {
      headers: { "user-agent": UA },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    const html = await r.text();
    const v = html.match(/"INNERTUBE_CLIENT_VERSION":"([\d.]+)"/)?.[1];
    if (v) {
      clientVersionCache = { value: v, at: Date.now() };
      return v;
    }
  } catch {
    /* 取不到就用兜底值 */
  }
  return DEFAULT_CLIENT_VERSION;
}

async function innertube(path, body) {
  const r = await fetch(`${API}/${path}?key=${INNERTUBE_KEY}&prettyPrint=false`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const isChannelId = (s) => /^UC[\w-]{22}$/.test(String(s));

// 归一化输入：支持 @handle / UCid / 各种频道 URL
function parseChannelTarget(input) {
  const s = String(input).trim();
  const m = s.match(/youtube\.com\/(@[\w.\-]+|channel\/(UC[\w-]{22})|c\/([\w.\-]+)|user\/([\w.\-]+))/);
  if (m) {
    if (m[1]?.startsWith("@")) return m[1];
    if (m[2]) return m[2];
    if (m[3]) return "@" + m[3];
    if (m[4]) return "@" + m[4];
  }
  return s; // 原样交给后端
}

// @handle / 自定义名 → UCid（InnerTube 只认 UCid，handle 会 400；Piped 的 /c/{name} 也基本废了）
const handleCache = new Map(); // handle -> UCid（模块作用域，省掉重复解析）

async function resolveChannelId(target) {
  if (isChannelId(target)) return target;
  if (handleCache.has(target)) return handleCache.get(target);
  const url = /^@/.test(target)
    ? `https://www.youtube.com/${target}`
    : `https://www.youtube.com/c/${target}`;
  const j = await innertube("navigation/resolve_url", {
    context: { client: { clientName: "WEB", clientVersion: await clientVersion(), hl: "en", gl: "US" } },
    url,
  });
  let id = null;
  const walk = (n) => {
    if (id || !n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    const bid = n.browseEndpoint?.browseId;
    if (bid && isChannelId(bid)) id = bid;
    for (const k in n) if (k !== "browseEndpoint") walk(n[k]);
  };
  walk(j);
  if (!id) throw new Error(`handle 解析失败: ${target}`);
  handleCache.set(target, id);
  return id;
}

// 从频道首页的 tabs 里读 Videos 标签的 params
function videosTabParams(home) {
  const tabs = home?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
  for (const t of tabs) {
    const tr = t.tabRenderer;
    if (tr?.title === "Videos" && tr.endpoint?.browseEndpoint?.params) {
      return tr.endpoint.browseEndpoint.params;
    }
  }
  return FALLBACK_VIDEOS_PARAMS;
}

// 递归遍历：同时认老 videoRenderer 和新 lockupViewModel，并收集 continuation token
function parseInnertube(j) {
  const videos = [];
  const seen = new Set();
  const tokens = [];

  const push = (v) => {
    if (!v.videoId || seen.has(v.videoId)) return;
    seen.add(v.videoId);
    videos.push(v);
  };

  const walk = (node, path) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x, path);
      return;
    }

    if (node.videoRenderer?.videoId) {
      const vr = node.videoRenderer;
      push({
        videoId: vr.videoId,
        title: (vr.title?.runs || []).map((r) => r.text).join("") || vr.title?.simpleText || "",
        url: `https://www.youtube.com/watch?v=${vr.videoId}`,
        published: vr.publishedTimeText?.simpleText || "",
        views: vr.viewCountText?.simpleText || "",
        duration: vr.lengthText?.simpleText || "",
      });
    }

    const lv = node.lockupViewModel;
    if (lv?.contentId && lv.contentType === "LOCKUP_CONTENT_TYPE_VIDEO") {
      const meta = lv.metadata?.lockupMetadataViewModel || {};
      const rows = meta.metadata?.contentMetadataViewModel?.metadataRows || [];
      const parts = rows.flatMap((row) => (row.metadataParts || []).map((p) => p.text?.content || ""));
      const badge =
        lv.contentImage?.thumbnailViewModel?.overlays
          ?.map((o) => o.thumbnailBottomOverlayViewModel?.badges?.[0]?.thumbnailBadgeViewModel?.text)
          .find((t) => /^\d+:\d+(?::\d+)?$/.test(t || "")) || "";
      push({
        videoId: lv.contentId,
        title: meta.title?.content || "",
        url: `https://www.youtube.com/watch?v=${lv.contentId}`,
        published: parts.find((t) => /\bago\b|前$/.test(t)) || "",
        views: parts.find((t) => /views|观看/.test(t)) || "",
        duration: badge,
      });
    }

    const tok =
      node.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ||
      node.continuationCommand?.token;
    if (tok) tokens.push({ tok, inGrid: /richGridRenderer|gridRenderer/.test(path) });

    for (const k in node) {
      if (k === "continuationItemRenderer") continue;
      walk(node[k], path + "." + k);
    }
  };

  walk(j, "");
  const nextpage = (tokens.find((t) => t.inGrid) || tokens[0])?.tok || null;
  return { videos, nextpage };
}

// 频道头信息：新版 pageHeaderViewModel / 老版 c4TabbedHeaderRenderer 都认
function parseChannelHeader(j, fallbackId) {
  const meta = j?.metadata?.channelMetadataRenderer || {};
  const header = j?.header?.pageHeaderRenderer
    ? j.header.pageHeaderRenderer.content?.pageHeaderViewModel || {}
    : j?.header?.c4TabbedHeaderRenderer || {};
  let subscribers = header.subscriberCountText?.simpleText || "";
  if (!subscribers) {
    const s = JSON.stringify(header);
    subscribers = s.match(/"([\d.,]+[KMB]? [Ss]ubscribers?)"/)?.[1]?.replace(/\\/g, "") || "";
  }
  return {
    id: meta.externalId || header.channelId || fallbackId || "",
    name: meta.title || header.title?.simpleText || "",
    subscribers,
    description: meta.description || "",
  };
}

// ── 后端 1：InnerTube browse 直连 ──
async function innertubeChannel(target, continuation) {
  const cv = await clientVersion();
  const ctx = { client: { clientName: "WEB", clientVersion: cv, hl: "en", gl: "US" } };

  if (continuation) {
    const j = await innertube("browse", { context: ctx, continuation });
    const { videos, nextpage } = parseInnertube(j);
    return { channel: { id: "", name: "", subscribers: "" }, videos, nextpage };
  }

  const channelId = await resolveChannelId(target);
  const home = await innertube("browse", { context: ctx, browseId: channelId });
  const params = videosTabParams(home);
  let j = home;
  try {
    j = await innertube("browse", { context: ctx, browseId: channelId, params });
  } catch {
    /* 拿不到 Videos 标签就用首页 */
  }

  let { videos, nextpage } = parseInnertube(j);
  if (!videos.length) ({ videos, nextpage } = parseInnertube(home)); // 兜底：首页 shelves 里也有视频
  return { channel: parseChannelHeader(j, channelId), videos, nextpage };
}

// ── 后端 2：Piped（/channel/{UCid} 或 /c/{handle}，/nextpage 翻页）──
const PIPED = [
  "https://pipedapi.ducks.party",
  "https://pipedapi.kavin.rocks",
  "https://api.piped.private.coffee",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.reallyaweso.me",
  "https://pipedapi.leptons.xyz",
  "https://pipedapi.smnz.de",
  "https://pipedapi.r4fo.com",
  "https://pipedapi.darkness.services",
];

// 实例冷却：坏掉的 5 分钟内不再排前面（内存级，够用）
const pipedCooldown = new Map();

function pipedOrder() {
  const now = Date.now();
  const alive = PIPED.filter((b) => (pipedCooldown.get(b) || 0) < now);
  const cooling = PIPED.filter((b) => (pipedCooldown.get(b) || 0) >= now);
  return [...alive, ...cooling];
}

async function pipedChannel(target, nextpage) {
  // Piped 的 /c/{handle} 现在多半 500，先解析成 UCid 再走 /channel/{id}
  let id = target;
  if (!nextpage) {
    try {
      id = isChannelId(target) ? target : await resolveChannelId(target);
    } catch {
      id = target; // 解析失败就把原值丢给 /c/，让下面按实例报错
    }
  }
  let last = "no instance";
  for (const b of pipedOrder()) {
    try {
      let url;
      if (nextpage) {
        url = `${b}/nextpage/channel/${encodeURIComponent(id)}?nextpage=${encodeURIComponent(nextpage)}`;
      } else {
        // 有 UCid 走 /channel，否则按 @handle 走 /c/{name}（去掉 @）
        const path = isChannelId(id) ? `/channel/${id}` : `/c/${String(id).replace(/^@/, "")}`;
        url = `${b}${path}`;
      }
      const r = await fetch(url, {
        headers: { "user-agent": "yt-gateway/1.1" },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) {
        pipedCooldown.set(b, Date.now() + 5 * 60 * 1000);
        last = `${b} ${r.status}`;
        continue;
      }
      const j = await r.json();
      const list = j.relatedStreams;
      if (!Array.isArray(list) || (!list.length && !nextpage)) {
        pipedCooldown.set(b, Date.now() + 5 * 60 * 1000);
        last = `${b} empty`;
        continue;
      }
      const videos = list.map((s) => ({
        videoId: (s.url?.match(/[?&]v=([A-Za-z0-9_-]{11})/) || [])[1] || "",
        title: s.title || "",
        url: s.url ? `https://www.youtube.com/watch?v=${(s.url.match(/[?&]v=([A-Za-z0-9_-]{11})/) || [])[1] || ""}` : "",
        published: s.uploadedDate || "",
        views: s.views != null ? String(s.views) : "",
        duration: s.duration != null ? `${s.duration}s` : "",
      }));
      return {
        channel: {
          id: j.id || target,
          name: j.name || "",
          subscribers: j.subscriberCount != null ? String(j.subscriberCount) : "",
        },
        videos: videos.filter((v) => v.videoId),
        nextpage: j.nextpage || null,
      };
    } catch (e) {
      pipedCooldown.set(b, Date.now() + 2 * 60 * 1000);
      last = `${b} ${String(e).slice(0, 60)}`;
    }
  }
  throw new Error(`piped: ${last}`);
}

// ── 后端 3：频道 RSS（15 条，无翻页；只依赖 youtube.com，最稳但最短）──
async function rssChannel(target) {
  const id = await resolveChannelId(target);
  const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`, {
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`rss HTTP ${r.status}`);
  const xml = await r.text();
  const videos = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, entry]) => {
    const pick = (re) => (entry.match(re) || [])[1] || "";
    const videoId = pick(/<yt:videoId>([\w-]{11})<\/yt:videoId>/);
    return {
      videoId,
      title: decodeXml(pick(/<title>([\s\S]*?)<\/title>/)),
      url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : "",
      published: pick(/<published>([\d-]+)/),
      views: pick(/views="(\d+)"/),
      duration: "",
    };
  });
  const name = decodeXml((xml.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "");
  return {
    channel: { id, name, subscribers: "" },
    videos: videos.filter((v) => v.videoId),
    nextpage: null,
  };
}

const decodeXml = (s) =>
  String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();

export async function onRequestGet({ request }) {
  const q = new URL(request.url).searchParams;
  const target = q.get("channel") || q.get("url") || q.get("id");
  const nextpage = q.get("nextpage") || null;
  const backend = q.get("backend") || null; // 翻页时必须指定，锁定同一后端
  if (!target) return json({ error: "missing channel (pass ?channel=@handle 或 UCid 或频道URL)" }, 400);

  const bid = parseChannelTarget(target);
  const errors = [];

  // 先把 handle 解析成 UCid：解析器是权威的（404 = 频道真的不存在，直接 404，
  // 不用再让三个后端各失败一遍）；网络抖动之类的失败则继续交给后端试。
  let resolved = bid;
  if (!isChannelId(bid)) {
    try {
      resolved = await resolveChannelId(bid);
    } catch (e) {
      if (/\b404\b/.test(String(e))) return json({ error: "channel not found", channel: bid }, 404);
    }
  }

  // 翻页锁定后端；首请求 innertube → piped → rss
  const order =
    backend === "piped"
      ? [["piped", pipedChannel]]
      : backend === "rss"
        ? [["rss", rssChannel]]
        : backend === "innertube"
          ? [["innertube", innertubeChannel]]
          : [
              ["innertube", innertubeChannel],
              ["piped", pipedChannel],
              ["rss", rssChannel],
            ];

  for (const [name, fn] of order) {
    try {
      const data = await fn(resolved, nextpage);
      data.backend = name;
      data.success = true;
      data.count = data.videos.length;
      if (data.channel && !data.channel.id && isChannelId(resolved)) data.channel.id = resolved; // 翻页响应里没有频道头
      return new Response(JSON.stringify(data), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-backend": name,
          "cache-control": "no-store",
        },
      });
    } catch (e) {
      errors.push({ backend: name, error: String(e) });
    }
  }
  return json({ error: "all backends failed", errors }, 502);
}

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
