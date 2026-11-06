# YouTube 代取网关（Cloudflare Pages Functions）

沙箱（国内受限环境）无法直连 youtube.com / googlevideo.com / youtubei.googleapis.com（TCP/TLS 被拦，HTTP 000）。
本网关部署在 Cloudflare Pages（`*.pages.dev`），在边缘回源 YouTube 的 InnerTube 接口 + Piped 公共实例，
沙箱只访问网关域名，不碰被污染的域。

## 功能

| 端点 | 用途 |
|---|---|
| `GET /api/channel?channel=@handle` | **频道枚举**：列出某频道所有视频（标题/链接/日期/时长/播放量） |
| `GET /api/resolve?url=<视频URL>` | **视频下载直链**：解析出沙箱可下载的直链 |
| `GET /api/stream?u=<直链>` | **视频字节透传**：支持 Range，代理 googlevideo/pipedproxy 直链 |

## 目录结构

```
yt-gateway/
└── functions/
    ├── _lib/            # 下划线开头：不会变成路由，放共享代码
    │   ├── innertube.js # clientVersion 自发现 + innertubePost + context
    │   └── health.js    # 后端/实例冷却（连续失败 3 次才进冷却，冷却中只沉队尾不剔除）
    └── api/
        ├── channel.js   # 频道枚举（InnerTube browse 主力 → Piped → 频道 RSS）
        ├── resolve.js   # 视频下载直链（davidcyriltech 主力 → Piped → InnerTube player）
        └── stream.js    # 透传视频字节（支持 Range）
```

## 后端选型

| 后端 | 状态 | 结论 |
|---|---|---|
| davidcyriltech (`apis.davidcyriltech.my.id`) | ⚠️ 2026-10-12 判死（SSL EOF）；`/api/resolve` 实测又活了（2026-11-06，仍作下载主力） | 保留，Piped 兜底 |
| Invidious 公共实例 | ❌ API 全关（`api.invidious.io` 实测 `api:false`，只剩 3 个实例且官方建议自托管） | 移除 |
| **InnerTube 直连**（`youtubei/v1/browse` + `/player`） | ✅ 主力 | 不依赖任何第三方实例，实例死光也能用 |
| **Piped 公共实例** | ✅ 兜底 | 联邦架构；`/c/{handle}` 已普遍 500，必须先把 handle 解析成 UCid 再走 `/channel/{id}` |
| **频道 RSS**（`feeds/videos.xml`） | ✅ 最后兜底（2026-11-06 新增） | 只回 15 条、无翻页，但只要 `youtube.com` 通就有数据 |

## 2026-11-06 修复：`/api/channel` 从「一律 502」恢复到可用

| 现象 | 根因 | 修法 |
|---|---|---|
| `@handle` 查询必 502，`error: innertube HTTP 400 invalid argument` | `@handle` 被直接当成 `browseId` 发出去，InnerTube 只认 `UC...` | 新增 `resolveChannelId()`：先打 `navigation/resolve_url` 换 UCid（带进程内缓存） |
| 换成 UCid 后 200，但 `videos: []` | 频道页视频已从 `videoRenderer` 换成 `lockupViewModel`，旧解析器一条都抽不到 | 解析器两种结构都认；时长取 badge 文本，播放量/发布时间从 `metadataRows` 里取 |
| Videos 标签拿到的其实是 Home 标签内容 | Videos 的 `params` 不是固定常量（旧值会落回 Home） | 从频道页 `tabs[].tabRenderer.endpoint.browseEndpoint.params` 里读，读不到才回退内置值 |
| InnerTube 偶发 `bad client` | `clientVersion` 写死会过期 | 启动时从 `youtube.com` 首页的 `INNERTUBE_CLIENT_VERSION` 取（缓存 6h），取不到用常量兜底 |

同批小改：Piped 实例 4 → 9 个（失败实例进 5 分钟冷却）、新增 RSS 兜底后端、不存在的频道直接回 404 `channel not found`（不再让三个后端各失败一遍）。

实测（2026-11-06，本机直连 YouTube）：

```
@MrBeast                  → 200 innertube 30 条 + nextpage（翻页 30 条）
UCX6OQ3DkcsbYNE6H8uQQuVA  → 200 innertube 30 条
完整频道 URL              → 200 innertube 30 条
@MrBeast&backend=piped    → 200 piped 30 条
@MrBeast&backend=rss      → 200 rss 15 条
@不存在的频道             → 404 {"error":"channel not found"}
```

## 2026-11-06 加固：`/api/resolve`（同一套思路）

| 项 | 之前 | 现在 |
|---|---|---|
| `clientVersion` | 写死 `2.20251001.00.00`，过期即失效 | 从 `youtube.com` 首页 `INNERTUBE_CLIENT_VERSION` 自发现，缓存 6h（`_lib/innertube.js`） |
| Piped 实例 | 4 个，无冷却，每次从头撞 | 9 个，逐个 8s 超时；**连续失败 3 次**才进 5 分钟冷却，冷却中只沉队尾不剔除（`_lib/health.js`） |
| 单视频失败 | 直接封后端 5 分钟（一个直播视频就能把 david 打下去） | 不封：一次失败只记一击，3 击才冷却 |
| 选流 | 按 `height` 排序，Piped 的 LBRY/HLS 兜底源 `height` 全是 0，会选中 LBRY（实测 60s 拿不到字节） | 按「mp4 优先 / YouTube 原生清晰度 > LBRY」打分，HLS（m3u8）直接不用——`/api/stream` 是字节透传，透传播放列表没意义 |
| InnerTube player | 只有 WEB 客户端（现在常回 `LOGIN_REQUIRED`） | WEB → ANDROID 两档兜底 |
| `?url=` 之外 | 只能传完整 URL | 也支持 `?v=<11 位 videoId>` |

实测（本机，2026-11-06）：

```
?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ → 200 davidcyriltech 480p
?v=dQw4w9WgXcQ                                  → 200 davidcyriltech 480p
?v=不存在的 id                                  → 502（三个后端各自报错，errors 里能看）
无参数                                          → 400
download_url 走 /api/stream → 206 + 前 1024 字节，magic "ftyp"（真·mp4）
直播（如 jfKfPfyJRdk）                          → 502：david 500 / piped 500 / innertube 要登录，三家都不支持，属已知限制
```

## 端点详解

### 1. 频道枚举

```
GET /api/channel?channel=@mkbhd
GET /api/channel?channel=UCxxxxxxxxxxxxxxxxxxxxxx
GET /api/channel?channel=https://www.youtube.com/@mkbhd/videos
```

返回（统一形状）：

```json
{
  "success": true,
  "backend": "innertube",              // innertube | piped
  "channel": { "id": "UC...", "name": "...", "subscribers": "..." },
  "videos": [
    { "videoId": "abc123", "title": "...", "url": "https://www.youtube.com/watch?v=abc123",
      "published": "2 weeks ago", "views": "12,345", "duration": "10:25" }
  ],
  "nextpage": "<token>",               // 有下一页时的翻页 token
  "count": 30
}
```

翻页（**必须带 backend 锁回同一后端**）：

```
GET /api/channel?channel=@mkbhd&nextpage=<上一页的nextpage>&backend=innertube
```

### 2. 视频下载直链

```
GET /api/resolve?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ
```

返回（与旧 davidcyriltech 形状兼容，`video_origin.py` 零改动）：

```json
{
  "success": true,
  "result": {
    "type": "video", "format": "mp4", "title": "...",
    "quality": "720p", "download_url": "https://你的网关.pages.dev/api/stream?u=...",
    "_backend": "innertube"
  }
}
```

### 3. 视频字节透传

```
GET /api/stream?u=<上一步 download_url 里的 u 参数>
```

## 部署步骤

```bash
# 1. 装 wrangler 并登录 Cloudflare 账号（首次必须）
npm install -g wrangler
npx wrangler login

# 2. 在仓库根目录（含 functions/ 的那一层）部署
cd <这个仓库的检出目录>
npx wrangler pages deploy . --project-name=yt-gateway

# 3. 部署完拿到 https://yt-gateway.pages.dev
```

## 部署后必做：填 GW 常量

打开 `functions/api/resolve.js`，把第 7 行 `GW` 填成你的网关域名：

```js
const GW = "https://yt-gateway.pages.dev";
```

**不填 GW，InnerTube/Piped 返回的直链就是裸 googlevideo/pipedproxy 链接，沙箱下不动。**
填完重新部署一次。

## 部署后必测（从沙箱 curl）

```bash
# 1. 频道枚举：应返回 JSON，x-backend 头告诉你实际走哪个后端
curl -i "https://yt-gateway.pages.dev/api/channel?channel=@mkbhd"

# 2. 视频直链：应返回 JSON，download_url 指向你的网关
curl -i "https://yt-gateway.pages.dev/api/resolve?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ"

# 3. 字节透传：应返回视频字节（HTTP 206）
curl -i -H "Range: bytes=0-1023" "https://yt-gateway.pages.dev/api/stream?u=<download_url 里的 u>"
```

## 关键注意 / 已踩的坑

| 事实 | 影响 |
|---|---|
| `*.workers.dev` DNS 污染 | 不能用 Workers，必须用 Pages Functions |
| `hello.pages.dev` 实测 200（10-12） | `*.pages.dev` 基础设施本机可达 |
| 你的自定义 pages.dev 域名是否可达**尚未验证** | 部署后第一步就测它，`hello` 通 ≠ 你的域名通 |
| `googlevideo.com` / `youtubei.googleapis.com` 本机不可达 | 直链必须经 `/api/stream` 回源，枚举/解析走网关 |
| InnerTube `clientVersion` 会过期 | 若 InnerTube 返回 404/`bad client`，更新 `resolve.js`/`channel.js` 里的 `clientVersion` 为更新的 `2.YYYYMMDD.XX.YY` |
| InnerTube 对数据中心 IP 有风控 | browse（枚举）相对宽松，player（下载直链）可能偶发 429 → 此时自动落到 Piped 兜底 |
| Piped 直链是 `pipedproxy-*.kavin.rocks` 代理地址 | 沙箱能否直连未知，统一走 `/api/stream` 兜底 |
| Cloudflare Pages Functions 免费版对大响应有限制 | 超大视频（>100MB）透传可能失败，`/api/stream` 是流式但需实测上限 |
| 沙箱 UDP 出站白名单 | WARP / WireGuard 隧道建不起来，不要在沙箱里试 |

## 接进 video_origin.py

```python
# 频道枚举
export VIDEO_ENUM_API="https://yt-gateway.pages.dev/api/channel?channel={u}"

# 视频下载直链
export VIDEO_ORIGIN_API="https://yt-gateway.pages.dev/api/resolve?url={u}"
```

`{u}` 会被替换成 URL 编码后的链接。`resolve` 返回 JSON 形状与 davidcyriltech 一致：
`{success, result:{title, quality, download_url, ...}}`，现有解析代码零改动。
