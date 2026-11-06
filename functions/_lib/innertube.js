// functions/_lib/innertube.js —— InnerTube 公共部分（channel.js / resolve.js 共用）
//
// 下划线开头的目录不会变成路由，放共享代码是 Pages Functions 的常规做法。
//
// clientVersion 不写死：YouTube 大约每个月换一次，写死的值迟早会被回 400/404。
// 这里从 youtube.com 首页 HTML 的 INNERTUBE_CLIENT_VERSION 取，按 isolate 缓存 6 小时；
// 取不到（首页挂了 / 被风控）才退回到常量。

export const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export const ANDROID_UA = "com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip";

// 兜底值：只在首页取不到 INNERTUBE_CLIENT_VERSION 时使用
const DEFAULT_CLIENT_VERSION = "2.20261030.02.00";

const API = "https://www.youtube.com/youtubei/v1";

let cache = { value: null, at: 0 };

export async function clientVersion() {
  if (cache.value && Date.now() - cache.at < 6 * 3600 * 1000) return cache.value;
  try {
    const r = await fetch("https://www.youtube.com/", {
      headers: { "user-agent": UA },
      cf: { cacheTtl: 3600, cacheEverything: true },
      signal: AbortSignal.timeout(8000),
    });
    const v = (await r.text()).match(/"INNERTUBE_CLIENT_VERSION":"([\d.]+)"/)?.[1];
    if (v) {
      cache = { value: v, at: Date.now() };
      return v;
    }
  } catch {
    /* 取不到就用兜底值 */
  }
  return DEFAULT_CLIENT_VERSION;
}

// POST /youtubei/v1/<path>；body 里不带 context 的部分由调用方给全
export async function innertubePost(path, body, { ua = UA, timeout = 15000 } = {}) {
  const r = await fetch(`${API}/${path}?key=${INNERTUBE_KEY}&prettyPrint=false`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": ua },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

// WEB 客户端 context（browse / player 都用它）
export async function webContext() {
  return { client: { clientName: "WEB", clientVersion: await clientVersion(), hl: "en", gl: "US" } };
}
