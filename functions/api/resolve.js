// 视频下载直链解析网关（Cloudflare Pages Functions）
// 目标：把 YouTube 视频 URL 解析成沙箱可下载的直链
// 后端（按可靠性排序）：InnerTube player 直连（主力）→ Piped /streams（fallback）
// 归一化输出：{success, result:{type,format,title,quality,download_url}}（与 davidcyriltech 旧形状兼容）

// ⚠️ 部署后必填：你的网关域名（用于把 googlevideo 直链包成 /api/stream 回源）
const GW = "";

// InnerTube 公共 key（YouTube Web 客户端硬编码的公开 key，yt-dlp 等工具同款）
const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const CTX = {
  context: {
    client: { clientName: "WEB", clientVersion: "2.20251001.00.00", hl: "en", gl: "US" },
  },
};

// 从任意 YouTube URL 提取 11 位 videoId
const VID = (u) => (u.match(/(?:v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/) || [])[1];

// 把直链包一层 /api/stream（沙箱下不动 googlevideo，必须经网关回源）
function wrap(url) {
  return url ? `${GW}/api/stream?u=${encodeURIComponent(url)}` : url;
}

// ── 后端 1：InnerTube player 直连（主力，不依赖第三方实例）──
async function innertubePlayer(id) {
  const r = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...CTX, videoId: id }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const title = j.videoDetails?.title;
  if (!title || j.playabilityStatus?.status === "ERROR") {
    throw new Error(j.playabilityStatus?.reason || "no playable video");
  }
  const formats = j.streamingData?.formats || [];
  // 优先选「带音轨的 mp4」（muxed），否则取最高画质
  const muxed = formats.filter((f) => f.mimeType?.startsWith("video/mp4") && f.audioChannels);
  const pool = (muxed.length ? muxed : formats).sort((a, b) => (b.height || 0) - (a.height || 0));
  const best = pool[0];
  if (!best?.url) throw new Error("no downloadable url");
  return {
    success: true,
    result: {
      type: "video",
      format: "mp4",
      title,
      thumbnail: j.videoDetails?.thumbnail?.thumbnails?.slice(-1)[0]?.url,
      quality: best.qualityLabel || `${best.height || "?"}p`,
      download_url: wrap(best.url),
      _backend: "innertube",
    },
  };
}

// ── 后端 2：Piped /streams（fallback）──
const PIPED = [
  "https://pipedapi.kavin.rocks",
  "https://api.piped.yt",
  "https://pipedapi.ducks.party",
  "https://api.piped.private.coffee",
];

async function pipedStream(id) {
  let last;
  for (const b of PIPED) {
    try {
      const r = await fetch(`${b}/streams/${id}`, { headers: { "user-agent": "yt-gateway/1.0" } });
      if (!r.ok) { last = `${b} ${r.status}`; continue; }
      const j = await r.json();
      const vs = (j.videoStreams || []).sort((a, b) => (b.height || 0) - (a.height || 0));
      const best = vs.find((s) => !s.videoOnly) || vs[0];
      if (!best?.url) { last = `${b} no stream`; continue; }
      return {
        success: true,
        result: {
          type: "video",
          format: best.format || "mp4",
          title: j.title,
          thumbnail: j.thumbnailUrl,
          quality: best.quality || `${best.height || "?"}p`,
          download_url: wrap(best.url),
          _backend: "piped",
        },
      };
    } catch (e) { last = String(e); }
  }
  throw new Error(`piped: ${last}`);
}

const BACKENDS = { innertube: innertubePlayer, piped: pipedStream };

export async function onRequestGet({ request }) {
  const target = new URL(request.url).searchParams.get("url");
  const id = target ? VID(target) : null;
  if (!id) return json({ error: "invalid youtube url" }, 400);

  const errors = [];
  for (const [name, fn] of Object.entries(BACKENDS)) {
    try {
      const data = await fn(id);
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
