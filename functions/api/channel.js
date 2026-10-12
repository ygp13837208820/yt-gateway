// 频道枚举网关（Cloudflare Pages Functions）
// 目标：列出某频道所有视频（标题/链接/日期/时长/播放量）
// 后端（按可靠性排序）：InnerTube browse 直连（主力）→ Piped /channel（fallback）
// 输出：{success, backend, channel:{id,name,subscribers}, videos:[...], nextpage, count}

const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const CTX = {
  context: {
    client: { clientName: "WEB", clientVersion: "2.20251001.00.00", hl: "en", gl: "US" },
  },
};
// "Videos" 标签页的 protobuf 参数（base64）
const VIDEOS_TAB = "EgZ2aWRlb3M%3D";

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

// 递归遍历 InnerTube browse 响应，抽出所有 videoRenderer + continuation token
// 兼容两种结构：首请求的 contents/richGridRenderer，翻页的 onResponseReceivedActions
function parseInnertube(j) {
  const videos = [];
  let continuation = null;
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const x of node) walk(x); return; }
    const vr = node.videoRenderer;
    if (vr?.videoId) {
      videos.push({
        videoId: vr.videoId,
        title: (vr.title?.runs || []).map((r) => r.text).join("") || vr.title?.simpleText || "",
        url: `https://www.youtube.com/watch?v=${vr.videoId}`,
        published: vr.publishedTimeText?.simpleText || "",
        views: vr.viewCountText?.simpleText || "",
        duration: vr.lengthText?.simpleText || "",
      });
    }
    const tok = node.continuationCommand?.token
      || node.continuationEndpoint?.continuationCommand?.token;
    if (tok) continuation = tok;
    for (const k in node) if (k !== "videoRenderer") walk(node[k]);
  };
  walk(j);
  return { videos, continuation };
}

// ── 后端 1：InnerTube browse 直连 ──
async function innertubeChannel(browseId, continuation) {
  const body = continuation ? { ...CTX, continuation } : { ...CTX, browseId, params: VIDEOS_TAB };
  const r = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${INNERTUBE_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const meta = j.metadata?.channelMetadataRenderer || {};
  const header = j.header?.c4TabbedHeaderRenderer || {};
  const { videos, continuation: next } = parseInnertube(j);
  return {
    channel: {
      id: meta.externalId || header.channelId || (browseId.startsWith("UC") ? browseId : ""),
      name: meta.title || header.title || "",
      subscribers: header.subscriberCountText?.simpleText || "",
      description: meta.description || "",
    },
    videos,
    nextpage: next || null,
  };
}

// ── 后端 2：Piped（/channel/{id} 或 /c/{handle}，/nextpage 翻页）──
const PIPED = [
  "https://pipedapi.kavin.rocks",
  "https://api.piped.yt",
  "https://pipedapi.ducks.party",
  "https://api.piped.private.coffee",
];

async function pipedChannel(target, nextpage) {
  let last;
  for (const b of PIPED) {
    try {
      let r;
      if (nextpage) {
        r = await fetch(`${b}/nextpage/channel/${encodeURIComponent(target)}?nextpage=${encodeURIComponent(nextpage)}`, {
          headers: { "user-agent": "yt-gateway/1.0" },
        });
      } else {
        // UC 开头走 /channel，否则按 @handle 走 /c/{name}（去掉 @）
        const path = target.startsWith("UC") ? `/channel/${target}` : `/c/${String(target).replace(/^@/, "")}`;
        r = await fetch(`${b}${path}`, { headers: { "user-agent": "yt-gateway/1.0" } });
      }
      if (!r.ok) { last = `${b} ${r.status}`; continue; }
      const j = await r.json();
      const videos = (j.relatedStreams || []).map((s) => ({
        videoId: (s.url?.match(/[?&]v=([A-Za-z0-9_-]{11})/) || [])[1] || "",
        title: s.title || "",
        url: s.url ? `https://piped.video${s.url}` : "",
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
        videos,
        nextpage: j.nextpage || null,
      };
    } catch (e) { last = String(e); }
  }
  throw new Error(`piped: ${last}`);
}

export async function onRequestGet({ request }) {
  const q = new URL(request.url).searchParams;
  const target = q.get("channel") || q.get("url") || q.get("id");
  const nextpage = q.get("nextpage") || null;
  const backend = q.get("backend") || null; // 翻页时必须指定，锁定同一后端
  if (!target) return json({ error: "missing channel (pass ?channel=@handle 或 UCid 或频道URL)" }, 400);

  const bid = parseChannelTarget(target);
  const errors = [];
  // 翻页锁定后端；首请求 innertube 优先 → piped 兜底
  const order = backend === "piped"
    ? [["piped", pipedChannel]]
    : backend === "innertube"
      ? [["innertube", innertubeChannel]]
      : [["innertube", innertubeChannel], ["piped", pipedChannel]];

  for (const [name, fn] of order) {
    try {
      const data = await fn(bid, nextpage);
      data.backend = name;
      data.success = true;
      data.count = data.videos.length;
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

const json = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s,
  headers: { "content-type": "application/json; charset=utf-8" },
});
