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
youtube-gateway/
└── functions/
    └── api/
        ├── channel.js   # 频道枚举（InnerTube browse 主力 + Piped 兜底）
        ├── resolve.js   # 视频下载直链（InnerTube player 主力 + Piped 兜底）
        └── stream.js    # 透传视频字节（支持 Range）
```

## 后端选型（2026-10-12 实测后重定）

| 后端 | 状态 | 结论 |
|---|---|---|
| davidcyriltech (`apis.davidcyriltech.my.id`) | ❌ 已死（SSL EOF，10-11/10-12 两次复测一致） | 移除 |
| Invidious 公共实例 | ❌ API 全关（`api.invidious.io` 实测 `api:false`，只剩 3 个实例且官方建议自托管） | 移除 |
| **InnerTube 直连**（`youtubei/v1/browse` + `/player`） | ✅ 主力 | 不依赖任何第三方实例，实例死光也能用 |
| **Piped 公共实例**（kavin.rocks / piped.yt / ducks.party / private.coffee） | ✅ 兜底 | 15 个存活实例、联邦架构，比 Invidious 稳 |

## 端点详解

### 1. 频道枚举

```
GET /api/channel?channel=@OlympusMedical
GET /api/channel?channel=UCxxxxxxxxxxxxxxxxxxxxxx
GET /api/channel?channel=https://www.youtube.com/@OlympusMedical/videos
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
GET /api/channel?channel=@OlympusMedical&nextpage=<上一页的nextpage>&backend=innertube
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

# 2. 在 youtube-gateway/ 目录下部署（注意：是 gateway 目录，不是 functions/）
cd E:\豆包交付\youtube-gateway
npx wrangler pages deploy . --project-name=youtube-gateway

# 3. 部署完拿到 https://youtube-gateway.pages.dev
```

## 部署后必做：填 GW 常量

打开 `functions/api/resolve.js`，把第 7 行 `GW` 填成你的网关域名：

```js
const GW = "https://youtube-gateway.pages.dev";
```

**不填 GW，InnerTube/Piped 返回的直链就是裸 googlevideo/pipedproxy 链接，沙箱下不动。**
填完重新部署一次。

## 部署后必测（从沙箱 curl）

```bash
# 1. 频道枚举：应返回 JSON，x-backend 头告诉你实际走哪个后端
curl -i "https://youtube-gateway.pages.dev/api/channel?channel=@OlympusMedical"

# 2. 视频直链：应返回 JSON，download_url 指向你的网关
curl -i "https://youtube-gateway.pages.dev/api/resolve?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ"

# 3. 字节透传：应返回视频字节（HTTP 206）
curl -i -H "Range: bytes=0-1023" "https://youtube-gateway.pages.dev/api/stream?u=<download_url 里的 u>"
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
export VIDEO_ENUM_API="https://youtube-gateway.pages.dev/api/channel?channel={u}"

# 视频下载直链
export VIDEO_ORIGIN_API="https://youtube-gateway.pages.dev/api/resolve?url={u}"
```

`{u}` 会被替换成 URL 编码后的链接。`resolve` 返回 JSON 形状与 davidcyriltech 一致：
`{success, result:{title, quality, download_url, ...}}`，现有解析代码零改动。
