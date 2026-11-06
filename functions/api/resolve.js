// 视频下载直链解析网关（Cloudflare Pages Functions）
//
// 返回形状保持不变（video_origin.py 零改动）：
//   { success, result: { type, format, title, thumbnail?, quality, download_url, _backend } }
// download_url 一律指回本网关的 /api/stream?u=...（沙箱下不动 googlevideo / pipedproxy）
//
// 后端链路：davidcyriltech → Piped（多实例 + 冷却）→ InnerTube player（WEB → ANDROID）
//
// 2026-11-06 加固（和 channel.js 同一套思路）：
//   1. clientVersion 不再写死，从 youtube.com 首页自发现（_lib/innertube.js），过期自愈。
//   2. 每个后端/实例都有冷却：失败进 5 分钟冷却并沉到队尾，不会每次都从头撞一遍。
//   3. Piped 实例 4 → 9 个，逐个 8 秒超时；挑非 videoOnly 的最高清流。
//   4. InnerTube player 增加 ANDROID 客户端兜底（WEB 现在常回 LOGIN_REQUIRED）。
//   5. 所有上游都有超时，避免一个挂住的实例把整个函数拖到 CPU 超时。

import { UA, ANDROID_UA, clientVersion, innertubePost } from "../_lib/innertube.js";
import { createCooldown } from "../_lib/health.js";

// 网关自己的域名：resolve 出来的直链要指回这里，沙箱才能下得动
const GW = "https://yt-gateway.pages.dev";

const VID = (u) => (u.match(/(?:v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/) || [])[1];

const cool = createCooldown({ cooldownMs: 5 * 60 * 1000 });

// ── 后端 1：davidcyriltech（下载器；直链在自家 CDN，不绑 IP）──
async function davidResolve(url) {
  const r = await fetch(`https://apis.davidcyriltech.my.id/download/ytmp4?url=${encodeURIComponent(url)}`, {
    headers: { "user-agent": "yt-gateway/1.1" },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const res = j?.result ?? {};
  if (!res.download_url || !/^https?:\/\//.test(res.download_url)) throw new Error("bad shape");
  return {
    success: true,
    result: {
      type: "video",
      format: (res.format || "mp4").toLowerCase(),
      title: res.title || "",
      thumbnail: res.thumbnail || "",
      quality: res.quality || "",
      download_url: res.download_url, // savetube CDN，沙箱可直下
      _backend: "davidcyriltech",
    },
  };
}

// ── 后端 2：Piped（多实例轮询；直链可能是 pipedproxy，统一走 /api/stream）──
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

async function pipedResolve(id) {
  let last = "no instance";
  for (const b of cool.order(PIPED)) {
    try {
      const r = await fetch(`${b}/streams/${id}`, {
        headers: { "user-agent": "yt-gateway/1.1" },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) {
        cool.fail(b);
        last = `${b} ${r.status}`;
        continue;
      }
      const j = await r.json();
      // Piped 的 videoStreams 里混着 LBRY / HLS 这类兜底源（height 都是 0，按高排序会选错），
      // 这里按「mp4 > YouTube 原生清晰度 > LBRY」打分；HLS（m3u8）直接不用——
      // /api/stream 是字节透传，透传一个播放列表没有意义。
      const rank = (s) => {
        const q = String(s.quality || "").toLowerCase();
        const mime = s.mimeType || "";
        if (q.includes("hls") || mime.includes("mpegurl")) return -1e9;
        const mp4 = mime.includes("video/mp4") ? 1000 : 0;
        const lbry = /lbry|odysee/.test(q) || /odycdn/.test(s.url || "") ? -500 : 0;
        const h = Number((q.match(/(\d{3,4})p/) || [])[1] || s.height || 0);
        return mp4 + lbry + h - (s.videoOnly ? 1 : 0);
      };
      const streams = (j.videoStreams || []).filter((s) => s?.url).sort((a, b) => rank(b) - rank(a));
      const best = streams[0];
      // 只有 HLS / 空列表：这是「这个视频不支持」，不算实例故障，不给它记失败
      if (!best?.url || rank(best) < -1e8) {
        last = `${b} no mp4 stream (hls-only or empty)`;
        continue;
      }
      cool.ok(b);
      return {
        success: true,
        result: {
          type: "video",
          // Piped 的 format 是 MPEG_4 这种枚举，统一成 mp4，别把 "mpeg_4" 漏给下游当扩展名
          format: (best.mimeType || "").includes("video/mp4") ? "mp4" : (best.format || "mp4").toLowerCase(),
          title: j.title || "",
          thumbnail: j.thumbnailUrl || "",
          quality: best.quality || "",
          download_url: `${GW}/api/stream?u=${encodeURIComponent(best.url)}`,
          _backend: "piped",
          _instance: b.replace("https://", ""),
          _muxed: !best.videoOnly,
        },
      };
    } catch (e) {
      cool.fail(b, 2 * 60 * 1000);
      last = `${b} ${String(e).slice(0, 60)}`;
    }
  }
  throw new Error(`piped: ${last}`);
}

// ── 后端 3：InnerTube player（最后兜底；WEB 常回 LOGIN_REQUIRED，故补 ANDROID）──
async function innertubePlayer(id) {
  const clients = [
    {
      name: "WEB",
      ua: UA,
      client: { clientName: "WEB", clientVersion: await clientVersion(), hl: "en", gl: "US" },
    },
    {
      name: "ANDROID",
      ua: ANDROID_UA,
      client: { clientName: "ANDROID", clientVersion: "19.09.37", androidSdkVersion: 30, hl: "en", gl: "US" },
    },
  ];

  const errors = [];
  for (const c of clients) {
    try {
      const j = await innertubePost("player", { context: { client: c.client }, videoId: id }, { ua: c.ua });
      const status = j.playabilityStatus?.status;
      if (status && status !== "OK") throw new Error(`playability ${status}`);

      const parsed = j.streamingData || {};
      const withUrl = (list) => (list || []).filter((f) => f?.url);
      const muxed = withUrl(parsed.formats).sort((a, b) => (b.height || 0) - (a.height || 0));
      const videoOnly = withUrl(parsed.adaptiveFormats)
        .filter((f) => (f.mimeType || "").startsWith("video/"))
        .sort((a, b) => (b.height || 0) - (a.height || 0));
      const best = muxed[0] || videoOnly[0];
      if (!best?.url) throw new Error("no direct url (cipher / PO token)");

      return {
        success: true,
        result: {
          type: "video",
          format: "mp4",
          title: j.videoDetails?.title || "",
          thumbnail: (j.videoDetails?.thumbnail?.thumbnails || []).slice(-1)[0]?.url || "",
          quality: best.qualityLabel || "",
          download_url: `${GW}/api/stream?u=${encodeURIComponent(best.url)}`,
          _backend: `innertube-${c.name.toLowerCase()}`,
          _muxed: muxed.length > 0,
        },
      };
    } catch (e) {
      errors.push(`${c.name}: ${String(e).slice(0, 80)}`);
    }
  }
  throw new Error(errors.join(" | "));
}

export async function onRequestGet({ request }) {
  const q = new URL(request.url).searchParams;
  const target = q.get("url") || q.get("u") || q.get("v");
  if (!target) return json({ error: "missing url (pass ?url=<视频URL> 或 ?v=<11 位 videoId>)" }, 400);

  const url = /^[A-Za-z0-9_-]{11}$/.test(target) ? `https://www.youtube.com/watch?v=${target}` : target;
  const id = VID(url);

  const errors = [];
  // davidcyriltech → piped → innertube
  if (!cool.isCooling("davidcyriltech")) {
    try {
      const out = await davidResolve(url);
      cool.ok("davidcyriltech");
      return respond(out, "davidcyriltech");
    } catch (e) {
      cool.fail("davidcyriltech");
      errors.push({ backend: "davidcyriltech", error: String(e) });
    }
  } else {
    errors.push({ backend: "davidcyriltech", error: "cooldown" });
  }

  if (id) {
    try {
      const out = await pipedResolve(id);
      return respond(out, "piped");
    } catch (e) {
      errors.push({ backend: "piped", error: String(e) });
    }

    try {
      const out = await innertubePlayer(id);
      return respond(out, out.result._backend);
    } catch (e) {
      errors.push({ backend: "innertube", error: String(e) });
    }
  } else {
    errors.push({ backend: "piped", error: "no videoId in url" });
  }

  return json({ error: "all backends failed", errors }, 502);
}

const respond = (payload, backend) =>
  new Response(JSON.stringify(payload), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-backend": backend,
      "cache-control": "no-store",
    },
  });

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
