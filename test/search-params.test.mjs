// test/search-params.test.mjs —— 纯 Node、不联网（globalThis.fetch 全部 mock）
//
// 跑法：node test/search-params.test.mjs
//
// 三件事：
//   (a) mock InnerTube 响应里的 chip 文案能映射成 params
//   (b) 请求 sort=date 时，真正发给 /youtubei/v1/search 的 body 带上了映射到的 params
//   (c) 不请求 sort 时，body 与旧版逐字节相同（OLD_BODY 是硬编码的旧字符串）

import assert from "node:assert/strict";

const CLIENT_VERSION = "2.20261108.00.00";

// 旧版（加排序之前）的请求体，一个字都不能变
const OLD_BODY =
  '{"context":{"client":{"clientName":"WEB","clientVersion":"' +
  CLIENT_VERSION +
  '","hl":"en","gl":"US"}},"query":"endoscopy","params":"EgIQAQ%3D%3D"}';

// 模拟一次「不带 params」的搜索响应：旧式 chipCloudChipRenderer + 新式 chipViewModel 混用
const CHIPS = {
  contents: {
    twoColumnSearchResultsRenderer: {
      primaryContents: {
        sectionListRenderer: {
          contents: [
            {
              chipCloudRenderer: {
                chips: [
                  {
                    chipCloudChipRenderer: {
                      isSelected: false,
                      text: { simpleText: "Upload date" },
                      navigationEndpoint: {
                        searchEndpoint: { params: "EgQIAhAB", query: "endoscopy" },
                      },
                    },
                  },
                  {
                    chipCloudChipRenderer: {
                      isSelected: false,
                      text: { runs: [{ text: "View count" }] },
                      navigationEndpoint: {
                        searchEndpoint: { params: "EgQIAxAB", query: "endoscopy" },
                      },
                    },
                  },
                  {
                    // 非排序 chip：文案认不出，必须被忽略
                    chipViewModel: {
                      text: { content: "All" },
                      tapCommand: {
                        innertubeCommand: { searchEndpoint: { params: "EgIQAQ==" } },
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    },
  },
};

const RESULTS = {
  contents: {
    twoColumnSearchResultsRenderer: {
      primaryContents: {
        sectionListRenderer: {
          contents: [
            {
              itemSectionRenderer: {
                contents: [
                  {
                    videoRenderer: {
                      videoId: "abc12345678",
                      title: { runs: [{ text: "A video" }] },
                      ownerText: { runs: [{ text: "A channel" }] },
                      publishedTimeText: { simpleText: "1 day ago" },
                      lengthText: { simpleText: "10:00" },
                      viewCountText: { simpleText: "1,000 views" },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    },
  },
};

const json = (o) =>
  new Response(JSON.stringify(o), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

// 每个用例都拿一份全新的模块（模块内有 6h chip 缓存，不隔离会串味）
let seq = 0;
async function freshSearch() {
  seq += 1;
  return import(new URL(`../functions/api/search.js?case=${seq}`, import.meta.url));
}

function installFetch({ chips = CHIPS, results = RESULTS } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({
      url: u,
      method: opts.method || "GET",
      body: opts.body == null ? null : String(opts.body),
    });
    // 注意顺序：InnerTube 的 API 也在 www.youtube.com 下，必须先认 /youtubei/v1/
    if (u.includes("/youtubei/v1/search")) {
      const body = JSON.parse(opts.body);
      return json(body.params ? results : chips); // 带 params 的才算“真请求”
    }
    if (u.startsWith("https://www.youtube.com/")) {
      return new Response(`<script>var s='"INNERTUBE_CLIENT_VERSION":"${CLIENT_VERSION}"';</script>`, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    throw new Error("unexpected fetch: " + u);
  };
  return calls;
}

const searchCalls = (calls) => calls.filter((c) => c.url.includes("/youtubei/v1/search"));
const get = (url, env = {}) =>
  ({ request: new Request("https://gw.example" + url), env });

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push([true, name]);
  } catch (e) {
    results.push([false, name + " :: " + (e && e.message)]);
  }
}

// ── (a) 不带 sort 时不探测，body 保持旧样 ────────────────────────────────────
{
  const mod = await freshSearch();
  const calls = installFetch();
  await mod.onRequestGet(get("/api/search?q=endoscopy"));
  const probe = searchCalls(calls)[0];
  check("(a) 无 sort 时不发探测请求（只有 1 次 search）", () => {
    assert.ok(probe, "没有任何 search 请求");
    assert.equal(searchCalls(calls).length, 1);
    assert.equal(JSON.parse(probe.body).params, "EgIQAQ%3D%3D");
  });
}

// 直接验证映射结果：用 sort 走一遍，看真请求用了哪个 params
{
  const mod = await freshSearch();
  const calls = installFetch();
  const r = await mod.onRequestGet(get("/api/search?q=endoscopy&sort=date"));
  const sc = searchCalls(calls);
  check("(a/b) sort=date：探测 + 真请求共 2 次 search", () => {
    assert.equal(sc.length, 2);
  });
  check("(a) Upload date chip 的 params 被读出来", () => {
    assert.equal(JSON.parse(sc[0].body).params, undefined, "探测请求不能带 params");
    assert.equal(JSON.parse(sc[1].body).params, "EgQIAhAB");
  });
  check("(b) 响应头 x-sort: date", () => {
    assert.equal(r.headers.get("x-sort"), "date");
  });
  check("(b) 响应体结构未变", () => {
    assert.equal(r.status, 200);
  });
}

// ── (b) 别名 + 分页继承 ────────────────────────────────────────────────────
{
  const mod = await freshSearch();
  const calls = installFetch();
  const r = await mod.onRequestGet(get("/api/search?q=endoscopy&sort=upload_date"));
  const j = JSON.parse(searchCalls(calls)[1].body);
  check("(b) 别名 upload_date → date", () => {
    assert.equal(r.headers.get("x-sort"), "date");
    assert.equal(j.params, "EgQIAhAB");
  });
}

{
  const mod = await freshSearch();
  const calls = installFetch();
  const r = await mod.onRequestGet(get("/api/search?q=endoscopy&sort=view_count"));
  const j = JSON.parse(searchCalls(calls)[1].body);
  check("(b) 别名 view_count → views 且 params 正确", () => {
    assert.equal(r.headers.get("x-sort"), "views");
    assert.equal(j.params, "EgQIAxAB");
  });
}

{
  const mod = await freshSearch();
  const calls = installFetch();
  const r = await mod.onRequestGet(get("/api/search?q=endoscopy&sort=date&page=TOKEN123"));
  const j = JSON.parse(searchCalls(calls)[1].body);
  check("(b) 分页时同时带 continuation 和 params", () => {
    assert.equal(j.continuation, "TOKEN123");
    assert.equal(j.params, "EgQIAhAB");
    assert.equal(r.headers.get("x-sort"), "date");
  });
}

// ── (c) 零回归：不带 sort 时 body 与旧版逐字节相同 ──────────────────────────
{
  const mod = await freshSearch();
  const calls = installFetch();
  const r = await mod.onRequestGet(get("/api/search?q=endoscopy"));
  check("(c) 不带 sort 的 body 与旧版逐字节相同", () => {
    assert.equal(searchCalls(calls).length, 1);
    assert.equal(searchCalls(calls)[0].body, OLD_BODY);
  });
  check("(c) 不带 sort 时 x-sort: none", () => {
    assert.equal(r.headers.get("x-sort"), "none");
    assert.equal(r.status, 200);
  });
}

// ── 回落：拿不到 chip 时不谎报，body 仍与旧版一致 ──────────────────────────
{
  const mod = await freshSearch();
  const calls = installFetch({ chips: { contents: {} } });
  const r = await mod.onRequestGet(get("/api/search?q=endoscopy&sort=date"));
  const sc = searchCalls(calls);
  check("回落：没有 chip → x-sort: fallback", () => {
    assert.equal(r.headers.get("x-sort"), "fallback");
  });
  check("回落：body 仍是旧版 params", () => {
    assert.equal(JSON.parse(sc[1].body).params, "EgIQAQ%3D%3D");
    assert.equal(JSON.parse(sc[1].body).continuation, undefined);
  });
}

// ── 缓存：6h 内第二次请求不再探测 ─────────────────────────────────────────
{
  const mod = await freshSearch();
  const calls = installFetch();
  await mod.onRequestGet(get("/api/search?q=endoscopy&sort=date"));
  const afterFirst = searchCalls(calls).length;
  await mod.onRequestGet(get("/api/search?q=endoscopy&sort=views"));
  check("缓存：第二次 sort 请求不再探测（只多 1 次 search）", () => {
    assert.equal(afterFirst, 2);
    assert.equal(searchCalls(calls).length, 3);
  });
}

// ── 输出 ─────────────────────────────────────────────────────────────────
// ── 真实结构回归（2026-11-08 实抓的 YouTube 搜索响应）：──
// 排序入口是 "Prioritize → Popularity"；"Upload date" 只是日期范围筛选组的标题，
// 组里的 Today/This week 带 params——绝不能把 "Upload date" 映射成 "只搜今天"。
const REAL_CHIPS = {
  contents: {
    twoColumnSearchResultsRenderer: {
      primaryContents: {
        sectionListRenderer: {
          contents: [
            {
              chipCloudRenderer: {
                chips: [
                  {
                    chipCloudChipRenderer: {
                      text: { simpleText: "All" },
                      isSelected: true,
                    },
                  },
                  {
                    chipCloudChipRenderer: {
                      text: { simpleText: "Recently uploaded" },
                      navigationEndpoint: { continuationCommand: { token: "TOK" } },
                    },
                  },
                ],
              },
            },
            {
              expandableTabRenderer: {
                content: {
                  sectionListRenderer: {
                    contents: [
                      {
                        searchFilterGroupRenderer: {
                          title: { simpleText: "Upload date" },
                          filters: [
                            {
                              searchFilterRenderer: {
                                label: { simpleText: "Today" },
                                navigationEndpoint: {
                                  searchEndpoint: { query: "endoscopy", params: "EgIIAg%3D%3D" },
                                },
                              },
                            },
                            {
                              searchFilterRenderer: {
                                label: { simpleText: "This week" },
                                navigationEndpoint: {
                                  searchEndpoint: { query: "endoscopy", params: "EgIIAw%3D%3D" },
                                },
                              },
                            },
                          ],
                        },
                      },
                      {
                        searchFilterGroupRenderer: {
                          title: { simpleText: "Prioritize" },
                          filters: [
                            {
                              searchFilterRenderer: {
                                label: { simpleText: "Relevance" },
                                status: "FILTER_STATUS_SELECTED",
                              },
                            },
                            {
                              searchFilterRenderer: {
                                label: { simpleText: "Popularity" },
                                navigationEndpoint: {
                                  searchEndpoint: { query: "endoscopy", params: "CAM%3D" },
                                },
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    },
  },
};

{
  const mod = await freshSearch();
  const calls = installFetch({ chips: REAL_CHIPS });
  const r = await mod.onRequestGet(get("/api/search?q=endoscopy&sort=views"));
  const j = JSON.parse(searchCalls(calls)[1].body);
  check("真实结构：Prioritize/Popularity → x-sort: views + params CAM%3D", () => {
    assert.equal(r.headers.get("x-sort"), "views");
    assert.equal(j.params, "CAM%3D");
  });
}

{
  const mod = await freshSearch();
  const calls = installFetch({ chips: REAL_CHIPS });
  const r = await mod.onRequestGet(get("/api/search?q=endoscopy&sort=date"));
  const j = JSON.parse(searchCalls(calls)[1].body);
  check("真实结构：没有 date 排序入口 → fallback，且绝不误用日期范围筛选", () => {
    assert.equal(r.headers.get("x-sort"), "fallback");
    assert.equal(j.params, "EgIQAQ%3D%3D", "不能把 Upload date 组里的 Today 当成排序");
  });
}

// ── since：时间范围 + 与 sort 组合（表驱动）──────────────────────────────────
// 4 个 since 单独使用时的期望值，来自 2026-11-08 真实页面的 searchFilterRenderer
// （Videos 12 02 10 01 与 Today/Week/Month/Year 12 02 08 02..05 直接拼接）。
const SINCE_ONLY = {
  today: "EgIQARICCAI=",
  week: "EgIQARICCAM=",
  month: "EgIQARICCAQ=",
  year: "EgIQARICCAU=",
};
const SINCE_CODE = { today: 2, week: 3, month: 4, year: 5 };

// 极简 protobuf 解码，只为断言「结构对」，不依赖编码器
function decodeParams(p) {
  const bytes = Uint8Array.from(Buffer.from(p, "base64"));
  const fields = [];
  let i = 0;
  while (i < bytes.length) {
    const key = bytes[i];
    i += 1;
    const field = key >> 3;
    const wire = key & 7;
    if (wire === 0) {
      let v = 0;
      let shift = 0;
      for (;;) {
        const b = bytes[i];
        i += 1;
        v |= (b & 0x7f) << shift;
        if (!(b & 0x80)) break;
        shift += 7;
      }
      fields.push([field, v]);
    } else if (wire === 2) {
      const len = bytes[i];
      i += 1;
      fields.push([field, Array.from(bytes.slice(i, i + len))]);
      i += len;
    } else {
      throw new Error("unexpected wire type " + wire);
    }
  }
  return fields;
}

const sinceCombos = [];
for (const key of Object.keys(SINCE_ONLY)) {
  for (const sort of ["", "views"]) sinceCombos.push({ key, sort });
}

for (const { key, sort } of sinceCombos) {
  const mod = await freshSearch();
  const calls = installFetch();
  const url = `/api/search?q=endoscopy&since=${key}` + (sort ? `&sort=${sort}` : "");
  const r = await mod.onRequestGet(get(url));
  const sc = searchCalls(calls);
  const j = JSON.parse(sc[sc.length - 1].body);
  const tag = `since=${key}${sort ? "&sort=" + sort : ""}`;
  check(`${tag} → x-since: ${key}${sort ? " / x-sort: views" : ""}`, () => {
    assert.equal(r.headers.get("x-since"), key);
    assert.equal(r.headers.get("x-sort"), sort || "none");
  });
  if (!sort) {
    check(`${tag} → params 等于真实页面的字面值`, () => {
      assert.equal(j.params, SINCE_ONLY[key]);
    });
  } else {
    check(`${tag} → 结构 = field1(3) + field2{10 01} + field2{08 ${SINCE_CODE[key]}}`, () => {
      const f = decodeParams(j.params);
      assert.deepEqual(f[0], [1, 3], "sort 编号应为 3（Popularity）");
      assert.deepEqual(f[1], [2, [0x10, 0x01]], "第二个字段应是「类型=视频」");
      assert.deepEqual(f[2], [2, [0x08, SINCE_CODE[key]]], "第三个字段应是时间范围");
      assert.equal(f.length, 3);
    });
  }
}

// 组合值单独打出来，方便拿去做线上验证
{
  const mod = await freshSearch();
  const calls = installFetch();
  await mod.onRequestGet(get("/api/search?q=endoscopy&sort=views&since=week"));
  const j = JSON.parse(searchCalls(calls)[1].body);
  check("sort=views&since=week 的最终 params 可复现", () => {
    assert.equal(j.params, "CAMSAhABEgIIAw==");
  });
}

// 分页 + since 也要带 params
{
  const mod = await freshSearch();
  const calls = installFetch();
  await mod.onRequestGet(get("/api/search?q=endoscopy&since=month&page=TOKEN9"));
  const sc = searchCalls(calls);
  const j = JSON.parse(sc[sc.length - 1].body);
  check("since 分页：continuation 与 params 同时带", () => {
    assert.equal(j.continuation, "TOKEN9");
    assert.equal(j.params, SINCE_ONLY.month);
  });
}

// 认不出的 since：不改 body，只标 fallback
{
  const mod = await freshSearch();
  const calls = installFetch();
  const r = await mod.onRequestGet(get("/api/search?q=endoscopy&since=bogus"));
  const sc = searchCalls(calls);
  const j = JSON.parse(sc[sc.length - 1].body);
  check("since=bogus → x-since: fallback 且 body 仍是 EgIQAQ%3D%3D", () => {
    assert.equal(r.headers.get("x-since"), "fallback");
    assert.equal(j.params, "EgIQAQ%3D%3D");
  });
}

// 都不带：body 逐字节不变 + 两个头都是 none
{
  const mod = await freshSearch();
  const calls = installFetch();
  const r = await mod.onRequestGet(get("/api/search?q=endoscopy"));
  check("sort/since 都不带：body 逐字节不变、x-sort/x-since 均 none", () => {
    assert.equal(searchCalls(calls)[0].body, OLD_BODY);
    assert.equal(r.headers.get("x-sort"), "none");
    assert.equal(r.headers.get("x-since"), "none");
  });
}

let bad = 0;
for (const [ok, name] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) bad += 1;
}
console.log(`\nsearch-params: ${results.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
