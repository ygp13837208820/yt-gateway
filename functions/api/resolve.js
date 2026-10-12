// 视频下载直链解析网关（Cloudflare Pages Functions）
const GW = "https://yt-gateway.pages.dev";

const VID = (u) => (u.match(/(?:v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/) || [])[1];

// ── 后端 1：davidcyriltech（主力，已实测沙箱可用）──
async function davidcyriltech(url) {
  const r = await fetch(`https://apis.davidcyriltech.my.id/download/ytmp4?url=${encodeURIComponent(url)}`, {
    headers: { "user-agent": "yt-gateway/1.0" }, signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j?.success || !j?.result?.download_url) throw new Error("bad shape");
  // davidcyriltech 直链在 savetube.vip，沙箱能直下，不用 wrap
  return j;
}

// ── 后端 2：Piped（兜底）──
const PIPED = [
  "https://pipedapi.kavin.rocks", "https://api.piped.yt",
  "https://pipedapi.ducks.party", "https://api.piped.private.coffee",
];
async function pipedStream(id) {
  let last;
  for (const b of PIPED) {
    try {
      const r = await fetch(`${b}/streams/${id}`, { headers: { "user-agent": "yt-gateway/1.0" }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) { last = `${b} ${r.status}`; continue; }
      const j = await r.json();
      const vs = (j.videoStreams || []).sort((a, b) => (b.height || 0) - (a.height || 0));
      const best = vs.find((s) => !s.videoOnly) || vs[0];
      if (!best?.url) { last = `${b} no stream`; continue; }
      return {
        success: true, result: {
          type: "video", format: best.format || "mp4", title: j.title,
          thumbnail: j.thumbnailUrl, quality: best.quality,
          download_url: `${GW}/api/stream?u=${encodeURIComponent(best.url)}`, _backend: "piped",
        },
      };
    } catch (e) { last = `${b} ${String(e).slice(0,50)}`; }
  }
  throw new Error(`piped: ${last}`);
}

// ── 后端 3：InnerTube（最后兜底，可能被风控）──
const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
async function innertubePlayer(id) {
  const r = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: "2.20251001.00.00", hl: "en", gl: "US" } }, videoId: id }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const title = j.videoDetails?.title;
  if (!title || j.playabilityStatus?.status === "ERROR") throw new Error("no playable");
  const formats = j.streamingData?.formats || [];
  const best = formats.sort((a, b) => (b.height||0)-(a.height||0))[0];
  if (!best?.url) throw new Error("signed cipher");
  return {
    success: true, result: {
      type: "video", format: "mp4", title, quality: best.qualityLabel,
      download_url: `${GW}/api/stream?u=${encodeURIComponent(best.url)}`, _backend: "innertube",
    },
  };
}

export async function onRequestGet({ request }) {
  const target = new URL(request.url).searchParams.get("url");
  if (!target) return json({ error: "missing url" }, 400);
  const id = VID(target);

  const errors = [];
  // davidcyriltech 主力 → piped 兜底 → innertube 最后
  try { return new Response(JSON.stringify(await davidcyriltech(target)), { headers: { "content-type": "application/json", "x-backend": "davidcyriltech" } }); }
  catch (e) { errors.push({ backend: "davidcyriltech", error: String(e) }); }

  if (id) try { return new Response(JSON.stringify(await pipedStream(id)), { headers: { "content-type": "application/json", "x-backend": "piped" } }); }
  catch (e) { errors.push({ backend: "piped", error: String(e) }); }

  if (id) try { return new Response(JSON.stringify(await innertubePlayer(id)), { headers: { "content-type": "application/json", "x-backend": "innertube" } }); }
  catch (e) { errors.push({ backend: "innertube", error: String(e) }); }

  return json({ error: "all backends failed", errors }, 502);
}

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
