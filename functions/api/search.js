// 搜索网关（Cloudflare Pages Functions）
// GET /api/search?q=<关键词>&limit=20&page=<continuationToken>&sort=<date|views>&since=<today|week|month|year>
// 输出：{success, query, backend, count, videos:[{videoId,title,channel,published,duration,views,url}], continuation}
//
// 后端：InnerTube /youtubei/v1/search（主力）→ Piped /search?filter=videos（降级）
// 鉴权：配置了 GATEWAY_KEY 才校验 x-gateway-key；未配置则公开（见 _lib/auth.js）
// 说明：params=EgIQAQ%3D%3D 是“只搜视频”的 protobuf 常量；不传会混进频道/播放列表。
// 解析同时认老 videoRenderer 与新 lockupViewModel（2026 年 YouTube 已在搜索页混用）。
//
// 2026-11-08 新增 sort=date|views：
//   排序不能写死常量——排序位嵌在 params 的 field2 里（field2 内 field1=排序方式、
//   field2=视频类型），层级拼错时 YouTube 不报错、只是静默按相关度返回。
//   所以这里改成「从筛选 chip 自发现」：发一次不带 params 的 search，把 chip 的
//   可见文案和 navigationEndpoint.searchEndpoint.params 建映射，再拿真值去请求。
//   响应头 x-sort 自证：date / views / fallback（请求了但没拿到）/ none（没请求）。
//
//   ⚠️ 2026-11-08 实抓 YouTube 搜索响应核对过：现在的排序入口是筛选面板里的
//   "Prioritize → Popularity"（= 按播放量，params "CAM%3D"），而不是旧的
//   "Upload date / View count" 两个 chip；"Upload date" 在响应里只是日期范围
//   筛选组的标题（Today / This week / …），拿它当排序会静默变成"只搜今天"，
//   所以下面按「本层文案」分类、绝不被组标题带偏。若某天 date 找不到唯一入口，
//   就老老实实回落（x-sort: fallback），不猜。
//
// 2026-11-08 再加 since=today|week|month|year（与 sort 可组合）：
//   时间范围在真实响应里是 searchFilterRenderer（带 params），和「类型=视频」是
//   同一层 field2 的并列消息，所以用一个小编码器重新拼 params，而不是手工拼串：
//   field1 varint(sort 编号) + field2 msg(类型=视频) + field2 msg(时间范围编号)。
//   响应头 x-since 自证；认不出 → fallback 且不改 body。

import { UA, innertubePost, webContext } from "../_lib/innertube.js";
import { createCooldown } from "../_lib/health.js";
import { checkKey, keyConfigured, preflight } from "../_lib/auth.js";

const VIDEO_PARAMS = "EgIQAQ%3D%3D";
const MAX_LIMIT = 30;
const DEFAULT_LIMIT = 20;

// ── 排序：chip 自发现 + 6h 缓存 + 失败 10min 不再试（写法同 _lib/innertube.js 的 clientVersion）──
const SORT_CACHE_MS = 6 * 3600 * 1000;
const SORT_RETRY_MS = 10 * 60 * 1000;

const SORT_ALIASES = {
  date: "date",
  upload_date: "date",
  uploaddate: "date",
  views: "views",
  view_count: "views",
  viewcount: "views",
};

// 没请求 → null；请求了但认不出 → "unsupported"（响应头记 fallback，不报错）
function normalizeSort(raw) {
  const s = String(raw == null ? "" : raw)
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  if (!s) return null;
  return SORT_ALIASES[s] || "unsupported";
}

// ── since（时间范围）与 sort 的 protobuf 编码 ────────────────────────────────
// 字面值来源：2026-11-08 真实搜索页 ytInitialData 里的 searchFilterRenderer（不是猜的）：
//   Videos    EgIQAQ==   (12 02 10 01)
//   Today     EgIIAg==   (12 02 08 02)
//   This week EgIIAw==   (12 02 08 03)
//   This month EgIIBA==  (12 02 08 04)
//   This year EgIIBQ==   (12 02 08 05)
// 这些是同一层 field2 的并列消息，protobuf 允许重复字段拼接，所以「视频+本周」
// 就是两段字节直接相连（12 02 10 01 12 02 08 03 = EgIQARICCAM=）。
// sort 那个数从发现的 params 里读（Prioritize: Popularity 是顶层 field1=3，即 CAM=）。
const SINCE_CODES = { today: 2, week: 3, month: 4, year: 5 };
const SINCE_ALIASES = {
  today: "today",
  day: "today",
  week: "week",
  this_week: "week",
  month: "month",
  this_month: "month",
  year: "year",
  this_year: "year",
};

function normalizeSince(raw) {
  const s = String(raw == null ? "" : raw)
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  if (!s) return null;
  return SINCE_ALIASES[s] || "unsupported";
}

function uvarint(n) {
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}
// length-delimited 字段（wire type 2）
const pbBytes = (num, payload) => [(num << 3) | 2, ...uvarint(payload.length), ...payload];
// varint 字段（wire type 0）
const pbVarint = (num, v) => [(num << 3) | 0, ...uvarint(v)];

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));

function atobBytes(s) {
  try {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

// 从发现的 params 里读出「排序编号」：优先顶层 field1 varint（新式 Prioritize，CAM= → 3），
// 退而求其次读 field2 消息里的 field1（旧式排序，EgQIAhAB → 2）。读不出就是 null。
function sortCodeOf(params) {
  let s = String(params || "");
  try {
    s = decodeURIComponent(s);
  } catch {
    /* 已经是原文 */
  }
  const b = atobBytes(s);
  if (!b || !b.length) return null;
  if (b[0] === 0x08) return b[1];
  if (b[0] === 0x12) {
    const inner = b.slice(2, 2 + b[1]);
    if (inner[0] === 0x08) return inner[1];
  }
  return null;
}

// field1 varint(sort) + field2 msg(type=video=field2:1) + field2 msg(dateRange=field1:N)
function encodeParams(sortCode, sinceKey) {
  const bytes = [];
  if (sortCode != null) bytes.push(...pbVarint(1, sortCode));
  bytes.push(...pbBytes(2, pbVarint(2, 1))); // 类型筛选项：只搜视频
  if (sinceKey && SINCE_CODES[sinceKey] != null) {
    bytes.push(...pbBytes(2, pbVarint(1, SINCE_CODES[sinceKey]))); // 时间范围筛选项（可缺省）
  }
  return b64(bytes);
}

// chip 的可见文案 → 排序种类。
// 2026-11-08 实测（真实 search 响应）：排序入口已经不是 "Upload date / View count" 两个 chip，
// 而是筛选面板里的 "Prioritize → Popularity"（等价于按播放量）；"Upload date" 只是
// 日期范围筛选组的标题（Today / This week …），不是排序。按文案分类，别按位置猜。
function chipKind(text) {
  const t = String(text || "").toLowerCase();
  if (/^(upload date|latest|newest)$|上传日期|上传时间|最新/.test(t)) return "date";
  if (/popularity|view count|播放量|观看次数|观看量/.test(t)) return "views";
  return null;
}

// 只在自己这一层找文案：自身 text/title/label，或已知的几个包一层的 Renderer。
// 不往子树深挖——否则一个带 params 的容器会把子孙里的 "Upload date"（筛选组标题）当自己。
function labelOf(n) {
  const own = textOf(n.text) || textOf(n.title) || textOf(n.label);
  if (own) return own;
  for (const key of ["chipCloudChipRenderer", "chipViewModel", "searchFilterRenderer"]) {
    const c = n[key];
    if (c) {
      const t = textOf(c.text) || textOf(c.title) || textOf(c.label);
      if (t) return t;
    }
  }
  return "";
}

// 宽容遍历：任意节点，只要「拿得到 params」且「本层读得到文案」就收进映射。
// 不写死 chipCloudChipRenderer 的路径——2026 年 YouTube 在混用 chipViewModel / searchFilterRenderer。
function findChipParams(root) {
  const map = {};
  walk(root, (n) => {
    if (!n || typeof n !== "object") return;
    const params =
      n.navigationEndpoint?.searchEndpoint?.params ||
      n.searchEndpoint?.params ||
      n.tapCommand?.innertubeCommand?.searchEndpoint?.params ||
      n.command?.searchEndpoint?.params ||
      n.chipCloudChipRenderer?.navigationEndpoint?.searchEndpoint?.params;
    if (!params || typeof params !== "string") return;
    const kind = chipKind(labelOf(n));
    if (kind && !map[kind]) map[kind] = params;
  });
  return map;
}

let sortChips = { map: null, at: 0 };
let sortFailAt = 0;

async function discoverSortParams(q) {
  if (sortChips.map && Date.now() - sortChips.at < SORT_CACHE_MS) return sortChips.map;
  if (sortFailAt && Date.now() - sortFailAt < SORT_RETRY_MS) return null;
  try {
    // 不带 params，返回里才会有「筛选 chip」那一排；带上 params 就没有 chip 列表了
    const j = await innertubePost("search", { context: await webContext(), query: q }, { timeout: 15000 });
    const map = findChipParams(j);
    if (!map.date && !map.views) throw new Error("no sort chip in response");
    sortChips = { map, at: Date.now() };
    sortFailAt = 0;
    return map;
  } catch {
    sortFailAt = Date.now(); // 10 分钟内不再打首页
    return null;
  }
}

const PIPED_INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://api.piped.private.coffee",
];
const pipedCooldown = createCooldown();

const isVideoId = (s) => /^[\w-]{11}$/.test(String(s || ""));

function respond(data, status = 200, cache = "public, max-age=300", xSort = "none", xSince = "none") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "x-sort, x-since",
      "x-sort": xSort,
      "x-since": xSince,
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

  if (!q) return respond({ success: false, error: "missing q" }, 400, cache, "none");
  if (q.length > 120) return respond({ success: false, error: "q too long" }, 400, cache, "none");

  // 排序：只有 chip 自发现成功才覆盖 params；拿不到就保持原请求体，只标 x-sort: fallback
  const want = normalizeSort(u.searchParams.get("sort"));
  let xSort = "none";
  let sortParams = null;
  if (want === "unsupported") {
    xSort = "fallback";
  } else if (want) {
    const map = await discoverSortParams(q);
    if (map && map[want]) {
      sortParams = map[want];
      xSort = want;
    } else {
      xSort = "fallback";
    }
  }

  // 时间范围：与排序同一个 params，所以一律走编码器重新拼
  const since = normalizeSince(u.searchParams.get("since"));
  let xSince = "none";
  let sinceParams = null;
  if (since === "unsupported") {
    xSince = "fallback";
  } else if (since) {
    // sort 没请求 / 没发现时，sortCode 为 null，编出来的就是「视频 + 时间范围」表里的值
    sinceParams = encodeParams(sortParams ? sortCodeOf(sortParams) : null, since);
    xSince = since;
  }

  try {
    const body = { context: await webContext(), query: q };
    if (page) {
      body.continuation = page;
    } else {
      body.params = VIDEO_PARAMS;
    }
    // 分页时也要带 params，否则第二页会悄悄跳回相关度排序
    if (sinceParams) {
      body.params = sinceParams;
    } else if (sortParams) {
      // 只带 sort 时也走编码器：统一带上「只看视频」的类型筛选（CAM= → CAMSAhAB）。
      // 解不出排序编号就退回发现值，绝不丢掉排序。
      const code = sortCodeOf(sortParams);
      body.params = code != null ? encodeParams(code, null) : sortParams;
    }
    const j = await innertubePost("search", body, { timeout: 15000 });
    const { videos, continuation } = parseInnertube(j, limit);
    if (videos.length) {
      return respond({ success: true, query: q, backend: "innertube", count: videos.length, videos, continuation }, 200, cache, xSort, xSince);
    }
    throw new Error("empty result");
  } catch (e) {
    const fb = await viaPiped(q, limit);
    if (fb) {
      return respond({
        success: true, query: q, backend: "piped:" + fb.backend,
        count: fb.videos.length, videos: fb.videos, continuation: null,
        note: "innertube failed: " + String(e.message || e),
      }, 200, cache, xSort === "none" ? "none" : "fallback", xSince === "none" ? "none" : "fallback"); // Piped 不复用这套 params，别谎报已排序/已限时
    }
    return respond({
      success: false, query: q,
      error: "innertube failed: " + String(e.message || e),
      hint: "check clientVersion / bot check; piped fallback also unavailable",
    }, 502, cache, xSort, xSince);
  }
}
