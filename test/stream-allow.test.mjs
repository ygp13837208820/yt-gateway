// test/stream-allow.test.mjs —— 纯 Node、不联网
//
// 跑法：node test/stream-allow.test.mjs
// 覆盖：/api/stream 的 host 后缀白名单、403 形状、以及可选鉴权。

import assert from "node:assert/strict";
import { hostAllowed, onRequestGet } from "../functions/api/stream.js";

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push([true, name]);
  } catch (e) {
    results.push([false, name + " :: " + (e && e.message)]);
  }
}

// 题目要求的 6 个样例 host
const CASES = [
  ["r1.googlevideo.com", true, "放行：googlevideo 子域"],
  ["cdn403.savetube.vip", true, "放行：savetube 子域"],
  ["pipedproxy-x.kavin.rocks", true, "放行：pipedproxy 片段"],
  ["evil.com", false, "拒绝：不在白名单"],
  ["googlevideo.com.evil.com", false, "拒绝：后缀绕过"],
  ["127.0.0.1", false, "拒绝：回环地址（http://127.0.0.1/x 的主机部分）"],
];

for (const [host, want, label] of CASES) {
  check(`${label}  ->  ${host} = ${want}`, () => {
    assert.equal(hostAllowed(host, {}), want);
  });
}

// 白名单的边角：大小写、末尾点、裸域、STREAM_ALLOW 追加
check("裸域 googlevideo.com 放行", () => assert.equal(hostAllowed("googlevideo.com", {}), true));
check("大小写不敏感 R1.GoogleVideo.COM", () =>
  assert.equal(hostAllowed("R1.GoogleVideo.COM", {}), true));
check("末尾点 r1.googlevideo.com. 放行", () =>
  assert.equal(hostAllowed("r1.googlevideo.com.", {}), true));
check("STREAM_ALLOW 追加后缀生效", () =>
  assert.equal(hostAllowed("cdn.example.net", { STREAM_ALLOW: "example.net" }), true));
check("STREAM_ALLOW 不匹配时不放行", () =>
  assert.equal(hostAllowed("cdn.other.net", { STREAM_ALLOW: "example.net" }), false));

// 走一遍 handler：非 http(s) 与非白名单都要 403 + 固定 JSON
async function deniedResponse(url, env = {}) {
  return onRequestGet({
    request: new Request("https://gw.example/api/stream?u=" + encodeURIComponent(url)),
    env,
  });
}

{
  const r = await deniedResponse("http://127.0.0.1/x");
  const j = await r.json();
  check("handler: http://127.0.0.1/x → 403 host not allowed", () => {
    assert.equal(r.status, 403);
    assert.deepEqual(j, { success: false, error: "host not allowed" });
  });
}

{
  const r = await deniedResponse("https://evil.com/a.mp4");
  check("handler: evil.com → 403", () => {
    assert.equal(r.status, 403);
  });
}

{
  const r = await deniedResponse("file:///etc/passwd");
  check("handler: 非 http(s) 协议 → 403", () => {
    assert.equal(r.status, 403);
  });
}

{
  const r = await deniedResponse("https://r1.googlevideo.com/a", { GATEWAY_KEY: "secret" });
  check("handler: 配了 GATEWAY_KEY 且没带头 → 401", () => {
    assert.equal(r.status, 401);
  });
}

{
  const r = await onRequestGet({
    request: new Request("https://gw.example/api/stream?u=https%3A%2F%2Fevil.com%2Fa", {
      headers: { "x-gateway-key": "secret" },
    }),
    env: { GATEWAY_KEY: "secret" },
  });
  check("handler: 带了正确 key 但 host 不合法 → 仍是 403（不是 401）", () => {
    assert.equal(r.status, 403);
  });
}

// ── 重定向：放行域名 302 到另一个放行域名，必须跟着走；到未放行的必须 403 ──
{
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts = {}) => {
    seen.push({ url: String(url), headers: opts.headers || {}, redirect: opts.redirect });
    if (String(url) === "https://cdn403.savetube.vip/x") {
      return new Response(null, {
        status: 302,
        headers: { location: "https://cdn.savetube.vip/y" },
      });
    }
    if (String(url) === "https://cdn.savetube.vip/y") {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 206,
        headers: { "content-type": "video/mp4", "content-range": "bytes 0-2/3" },
      });
    }
    throw new Error("unexpected fetch: " + url);
  };
  let r;
  try {
    r = await onRequestGet({
      request: new Request(
        "https://gw.example/api/stream?u=" + encodeURIComponent("https://cdn403.savetube.vip/x"),
        { headers: { range: "bytes=0-2" } }
      ),
      env: {},
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  check("放行域名 302 到另一个放行域名：跟随后 206，不误杀", () => {
    assert.equal(r.status, 206);
    assert.deepEqual(
      seen.map((s) => s.url),
      ["https://cdn403.savetube.vip/x", "https://cdn.savetube.vip/y"]
    );
  });
  check("重定向过程中 Range 与手动跟随都保持", () => {
    assert.equal(seen[0].headers.range, "bytes=0-2");
    assert.equal(seen[1].headers.range, "bytes=0-2");
    assert.equal(seen[0].redirect, "manual");
    assert.equal(seen[1].redirect, "manual");
  });
}

{
  const realFetch = globalThis.fetch;
  let hits = 0;
  globalThis.fetch = async (url) => {
    hits += 1;
    if (String(url) === "https://cdn403.savetube.vip/x") {
      return new Response(null, { status: 302, headers: { location: "https://evil.com/y" } });
    }
    throw new Error("must not fetch " + url);
  };
  let r;
  try {
    r = await onRequestGet({
      request: new Request(
        "https://gw.example/api/stream?u=" + encodeURIComponent("https://cdn403.savetube.vip/x")
      ),
      env: {},
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  const j = await r.json();
  check("放行域名 302 到未放行域名：403 且不再回源", () => {
    assert.equal(r.status, 403);
    assert.equal(hits, 1);
    assert.deepEqual(j, { success: false, error: "host not allowed" });
  });
}

let bad = 0;
for (const [ok, name] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) bad += 1;
}
console.log(`\nstream-allow: ${results.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
