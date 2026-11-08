// /api/stream?u=<直链>
// 把直链字节经 pages.dev 回源给沙箱（沙箱下不动 googlevideo，必须走这里）
// 必须透传 Range 请求头，否则大文件下不动。
//
// 2026-11-08 加固：原来这里谁给 ?u= 都回源，等于开放代理。
//   1. u 必须是 http(s)，host 过「后缀白名单」（含子域，但不含 googlevideo.com.evil.com）；
//   2. 白名单可用环境变量 STREAM_ALLOW（逗号分隔后缀）追加，不用改代码；
//   3. 与 /api/search 共用 _lib/auth.js 的 checkKey：配了 GATEWAY_KEY 就要 x-gateway-key，
//      没配就保持公开（不给自己上锁）。
// Range 仍然透传，且不缓存。

import { checkKey } from "../_lib/auth.js";

// 后缀白名单：匹配 host 本身或其子域。googlevideo 的直链会在
// r1---sn-xxx.googlevideo.com 这类主机之间跳，所以只写后缀。
const ALLOW_SUFFIX = ["googlevideo.com", "savetube.vip", "savetube.me", "odycdn.com"];

// Piped 的代理地址形如 pipedproxy-x.kavin.rocks，域名不固定，按片段放行
const ALLOW_FRAGMENT = ["pipedproxy"];

const MAX_REDIRECTS = 3;

function extraSuffixes(env) {
  return String((env && env.STREAM_ALLOW) || "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^\*?\./, ""))
    .filter(Boolean);
}

// 导出给单测用（Pages Functions 只把 onRequest* 当路由，多导出一个函数无副作用）
export function hostAllowed(host, env) {
  const h = String(host || "").trim().toLowerCase().replace(/\.$/, ""); // 去掉 FQDN 末尾的点
  if (!h) return false;
  for (const s of [...ALLOW_SUFFIX, ...extraSuffixes(env)]) {
    if (h === s || h.endsWith("." + s)) return true; // googlevideo.com.evil.com 不满足 endsWith(".googlevideo.com")
  }
  for (const f of ALLOW_FRAGMENT) {
    if (h.includes(f)) return true;
  }
  return false;
}

function forbid() {
  return new Response(JSON.stringify({ success: false, error: "host not allowed" }), {
    status: 403,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function onRequestGet({ request, env }) {
  const denied = checkKey(request, env);
  if (denied) return denied;

  const u = new URL(request.url).searchParams.get("u");
  if (!u) return new Response("missing u", { status: 400 });

  let target;
  try {
    target = new URL(u);
  } catch {
    return forbid();
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return forbid();
  if (!hostAllowed(target.hostname, env)) return forbid();

  const range = request.headers.get("range");
  const ua = request.headers.get("user-agent") || "yt-gateway/1.0";

  // 重定向也走白名单：否则一个放行域名上的开放重定向就能把这里变成任意回源。
  // 用原始字符串去 fetch（重新序列化 URL 可能改掉签名串里的百分号编码）。
  let current = u;
  let up;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    up = await fetch(current, {
      headers: { ...(range ? { range } : {}), "user-agent": ua },
      redirect: "manual",
      cf: { cacheTtl: 0 },
    });
    if (up.status < 300 || up.status >= 400) break;
    const loc = up.headers.get("location");
    if (!loc) break;
    let next;
    try {
      next = new URL(loc, current);
    } catch {
      return forbid();
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") return forbid();
    if (!hostAllowed(next.hostname, env)) return forbid();
    current = next.href;
  }

  // 上游非 2xx：不瞎透传，返回带错误信息的响应
  if (!up.ok) {
    return new Response(`upstream error: ${up.status}`, { status: 502 });
  }

  const h = new Headers();
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = up.headers.get(k);
    if (v) h.set(k, v);
  }

  return new Response(up.body, { status: up.status, headers: h });
}
