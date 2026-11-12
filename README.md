# YouTube 浠ｅ彇缃戝叧锛圕loudflare Pages Functions锛?

娌欑锛堝浗鍐呭彈闄愮幆澧冿級鏃犳硶鐩磋繛 youtube.com / googlevideo.com / youtubei.googleapis.com锛圱CP/TLS 琚嫤锛孒TTP 000锛夈€?
鏈綉鍏抽儴缃插湪 Cloudflare Pages锛坄*.pages.dev`锛夛紝鍦ㄨ竟缂樺洖婧?YouTube 鐨?InnerTube 鎺ュ彛 + Piped 鍏叡瀹炰緥锛?
娌欑鍙闂綉鍏冲煙鍚嶏紝涓嶇琚薄鏌撶殑鍩熴€?

## 鍔熻兘

| 绔偣 | 鐢ㄩ€?|
|---|---|
| `GET /api/channel?channel=@handle` | **棰戦亾鏋氫妇**锛氬垪鍑烘煇棰戦亾鎵€鏈夎棰戯紙鏍囬/閾炬帴/鏃ユ湡/鏃堕暱/鎾斁閲忥級 |
| `GET /api/resolve?url=<瑙嗛URL>` | **瑙嗛涓嬭浇鐩撮摼**锛氳В鏋愬嚭娌欑鍙笅杞界殑鐩撮摼 |
| `GET /api/stream?u=<鐩撮摼>` | **瑙嗛瀛楄妭閫忎紶**锛氭敮鎸?Range锛屼唬鐞?googlevideo/pipedproxy 鐩撮摼 |

## 鐩綍缁撴瀯

```
yt-gateway/
鈹斺攢鈹€ functions/
    鈹溾攢鈹€ _lib/            # 涓嬪垝绾垮紑澶达細涓嶄細鍙樻垚璺敱锛屾斁鍏变韩浠ｇ爜
    鈹?  鈹溾攢鈹€ innertube.js # clientVersion 鑷彂鐜?+ innertubePost + context
    鈹?  鈹斺攢鈹€ health.js    # 鍚庣/瀹炰緥鍐峰嵈锛堣繛缁け璐?3 娆℃墠杩涘喎鍗达紝鍐峰嵈涓彧娌夐槦灏句笉鍓旈櫎锛?
    鈹斺攢鈹€ api/
        鈹溾攢鈹€ channel.js   # 棰戦亾鏋氫妇锛圛nnerTube browse 涓诲姏 鈫?Piped 鈫?棰戦亾 RSS锛?
        鈹溾攢鈹€ resolve.js   # 瑙嗛涓嬭浇鐩撮摼锛坉avidcyriltech 涓诲姏 鈫?Piped 鈫?InnerTube player锛?
        鈹斺攢鈹€ stream.js    # 閫忎紶瑙嗛瀛楄妭锛堟敮鎸?Range锛?
```

## 鍚庣閫夊瀷

| 鍚庣 | 鐘舵€?| 缁撹 |
|---|---|---|
| davidcyriltech (`apis.davidcyriltech.my.id`) | 鈿狅笍 2026-10-12 鍒ゆ锛圫SL EOF锛夛紱`/api/resolve` 瀹炴祴鍙堟椿浜嗭紙2026-11-06锛屼粛浣滀笅杞戒富鍔涳級 | 淇濈暀锛孭iped 鍏滃簳 |
| Invidious 鍏叡瀹炰緥 | 鉂?API 鍏ㄥ叧锛坄api.invidious.io` 瀹炴祴 `api:false`锛屽彧鍓?3 涓疄渚嬩笖瀹樻柟寤鸿鑷墭绠★級 | 绉婚櫎 |
| **InnerTube 鐩磋繛**锛坄youtubei/v1/browse` + `/player`锛?| 鉁?涓诲姏 | 涓嶄緷璧栦换浣曠涓夋柟瀹炰緥锛屽疄渚嬫鍏変篃鑳界敤 |
| **Piped 鍏叡瀹炰緥** | 鉁?鍏滃簳 | 鑱旈偊鏋舵瀯锛沗/c/{handle}` 宸叉櫘閬?500锛屽繀椤诲厛鎶?handle 瑙ｆ瀽鎴?UCid 鍐嶈蛋 `/channel/{id}` |
| **棰戦亾 RSS**锛坄feeds/videos.xml`锛?| 鉁?鏈€鍚庡厹搴曪紙2026-11-06 鏂板锛?| 鍙洖 15 鏉°€佹棤缈婚〉锛屼絾鍙 `youtube.com` 閫氬氨鏈夋暟鎹?|

## 2026-11-06 淇锛歚/api/channel` 浠庛€屼竴寰?502銆嶆仮澶嶅埌鍙敤

| 鐜拌薄 | 鏍瑰洜 | 淇硶 |
|---|---|---|
| `@handle` 鏌ヨ蹇?502锛宍error: innertube HTTP 400 invalid argument` | `@handle` 琚洿鎺ュ綋鎴?`browseId` 鍙戝嚭鍘伙紝InnerTube 鍙 `UC...` | 鏂板 `resolveChannelId()`锛氬厛鎵?`navigation/resolve_url` 鎹?UCid锛堝甫杩涚▼鍐呯紦瀛橈級 |
| 鎹㈡垚 UCid 鍚?200锛屼絾 `videos: []` | 棰戦亾椤佃棰戝凡浠?`videoRenderer` 鎹㈡垚 `lockupViewModel`锛屾棫瑙ｆ瀽鍣ㄤ竴鏉￠兘鎶戒笉鍒?| 瑙ｆ瀽鍣ㄤ袱绉嶇粨鏋勯兘璁わ紱鏃堕暱鍙?badge 鏂囨湰锛屾挱鏀鹃噺/鍙戝竷鏃堕棿浠?`metadataRows` 閲屽彇 |
| Videos 鏍囩鎷垮埌鐨勫叾瀹炴槸 Home 鏍囩鍐呭 | Videos 鐨?`params` 涓嶆槸鍥哄畾甯搁噺锛堟棫鍊间細钀藉洖 Home锛?| 浠庨閬撻〉 `tabs[].tabRenderer.endpoint.browseEndpoint.params` 閲岃锛岃涓嶅埌鎵嶅洖閫€鍐呯疆鍊?|
| InnerTube 鍋跺彂 `bad client` | `clientVersion` 鍐欐浼氳繃鏈?| 鍚姩鏃朵粠 `youtube.com` 棣栭〉鐨?`INNERTUBE_CLIENT_VERSION` 鍙栵紙缂撳瓨 6h锛夛紝鍙栦笉鍒扮敤甯搁噺鍏滃簳 |

鍚屾壒灏忔敼锛歅iped 瀹炰緥 4 鈫?9 涓紙澶辫触瀹炰緥杩?5 鍒嗛挓鍐峰嵈锛夈€佹柊澧?RSS 鍏滃簳鍚庣銆佷笉瀛樺湪鐨勯閬撶洿鎺ュ洖 404 `channel not found`锛堜笉鍐嶈涓変釜鍚庣鍚勫け璐ヤ竴閬嶏級銆?

瀹炴祴锛?026-11-06锛屾湰鏈虹洿杩?YouTube锛夛細

```
@MrBeast                  鈫?200 innertube 30 鏉?+ nextpage锛堢炕椤?30 鏉★級
UCX6OQ3DkcsbYNE6H8uQQuVA  鈫?200 innertube 30 鏉?
瀹屾暣棰戦亾 URL              鈫?200 innertube 30 鏉?
@MrBeast&backend=piped    鈫?200 piped 30 鏉?
@MrBeast&backend=rss      鈫?200 rss 15 鏉?
@涓嶅瓨鍦ㄧ殑棰戦亾             鈫?404 {"error":"channel not found"}
```

## 2026-11-06 鍔犲浐锛歚/api/resolve`锛堝悓涓€濂楁€濊矾锛?

| 椤?| 涔嬪墠 | 鐜板湪 |
|---|---|---|
| `clientVersion` | 鍐欐 `2.20251001.00.00`锛岃繃鏈熷嵆澶辨晥 | 浠?`youtube.com` 棣栭〉 `INNERTUBE_CLIENT_VERSION` 鑷彂鐜帮紝缂撳瓨 6h锛坄_lib/innertube.js`锛?|
| Piped 瀹炰緥 | 4 涓紝鏃犲喎鍗达紝姣忔浠庡ご鎾?| 9 涓紝閫愪釜 8s 瓒呮椂锛?*杩炵画澶辫触 3 娆?*鎵嶈繘 5 鍒嗛挓鍐峰嵈锛屽喎鍗翠腑鍙矇闃熷熬涓嶅墧闄わ紙`_lib/health.js`锛?|
| 鍗曡棰戝け璐?| 鐩存帴灏佸悗绔?5 鍒嗛挓锛堜竴涓洿鎾棰戝氨鑳芥妸 david 鎵撲笅鍘伙級 | 涓嶅皝锛氫竴娆″け璐ュ彧璁颁竴鍑伙紝3 鍑绘墠鍐峰嵈 |
| 閫夋祦 | 鎸?`height` 鎺掑簭锛孭iped 鐨?LBRY/HLS 鍏滃簳婧?`height` 鍏ㄦ槸 0锛屼細閫変腑 LBRY锛堝疄娴?60s 鎷夸笉鍒板瓧鑺傦級 | 鎸夈€宮p4 浼樺厛 / YouTube 鍘熺敓娓呮櫚搴?> LBRY銆嶆墦鍒嗭紝HLS锛坢3u8锛夌洿鎺ヤ笉鐢ㄢ€斺€擿/api/stream` 鏄瓧鑺傞€忎紶锛岄€忎紶鎾斁鍒楄〃娌℃剰涔?|
| InnerTube player | 鍙湁 WEB 瀹㈡埛绔紙鐜板湪甯稿洖 `LOGIN_REQUIRED`锛?| WEB 鈫?ANDROID 涓ゆ。鍏滃簳 |
| `?url=` 涔嬪 | 鍙兘浼犲畬鏁?URL | 涔熸敮鎸?`?v=<11 浣?videoId>` |

瀹炴祴锛堟湰鏈猴紝2026-11-06锛夛細

```
?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ 鈫?200 davidcyriltech 480p
?v=dQw4w9WgXcQ                                  鈫?200 davidcyriltech 480p
?v=涓嶅瓨鍦ㄧ殑 id                                  鈫?502锛堜笁涓悗绔悇鑷姤閿欙紝errors 閲岃兘鐪嬶級
鏃犲弬鏁?                                         鈫?400
download_url 璧?/api/stream 鈫?206 + 鍓?1024 瀛楄妭锛宮agic "ftyp"锛堢湡路mp4锛?
鐩存挱锛堝 jfKfPfyJRdk锛?                         鈫?502锛歞avid 500 / piped 500 / innertube 瑕佺櫥褰曪紝涓夊閮戒笉鏀寔锛屽睘宸茬煡闄愬埗
```

## 绔偣璇﹁В

### 1. 棰戦亾鏋氫妇

```
GET /api/channel?channel=@mkbhd
GET /api/channel?channel=UCxxxxxxxxxxxxxxxxxxxxxx
GET /api/channel?channel=https://www.youtube.com/@mkbhd/videos
```

杩斿洖锛堢粺涓€褰㈢姸锛夛細

```json
{
  "success": true,
  "backend": "innertube",              // innertube | piped
  "channel": { "id": "UC...", "name": "...", "subscribers": "..." },
  "videos": [
    { "videoId": "abc123", "title": "...", "url": "https://www.youtube.com/watch?v=abc123",
      "published": "2 weeks ago", "views": "12,345", "duration": "10:25" }
  ],
  "nextpage": "<token>",               // 鏈変笅涓€椤垫椂鐨勭炕椤?token
  "count": 30
}
```

缈婚〉锛?*蹇呴』甯?backend 閿佸洖鍚屼竴鍚庣**锛夛細

```
GET /api/channel?channel=@mkbhd&nextpage=<涓婁竴椤电殑nextpage>&backend=innertube
```

### 2. 瑙嗛涓嬭浇鐩撮摼

```
GET /api/resolve?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ
```

杩斿洖锛堜笌鏃?davidcyriltech 褰㈢姸鍏煎锛宍video_origin.py` 闆舵敼鍔級锛?

```json
{
  "success": true,
  "result": {
    "type": "video", "format": "mp4", "title": "...",
    "quality": "720p", "download_url": "https://浣犵殑缃戝叧.pages.dev/api/stream?u=...",
    "_backend": "innertube"
  }
}
```

### 3. 瑙嗛瀛楄妭閫忎紶

```
GET /api/stream?u=<涓婁竴姝?download_url 閲岀殑 u 鍙傛暟>
```

## 閮ㄧ讲姝ラ

```bash
# 1. 瑁?wrangler 骞剁櫥褰?Cloudflare 璐﹀彿锛堥娆″繀椤伙級
npm install -g wrangler
npx wrangler login

# 2. 鍦ㄤ粨搴撴牴鐩綍锛堝惈 functions/ 鐨勯偅涓€灞傦級閮ㄧ讲
cd <杩欎釜浠撳簱鐨勬鍑虹洰褰?
npx wrangler pages deploy . --project-name=yt-gateway

# 3. 閮ㄧ讲瀹屾嬁鍒?https://yt-gateway.pages.dev
```

## 閮ㄧ讲鍚庡繀鍋氾細濉?GW 甯搁噺

鎵撳紑 `functions/api/resolve.js`锛屾妸绗?7 琛?`GW` 濉垚浣犵殑缃戝叧鍩熷悕锛?

```js
const GW = "https://yt-gateway.pages.dev";
```

**涓嶅～ GW锛孖nnerTube/Piped 杩斿洖鐨勭洿閾惧氨鏄８ googlevideo/pipedproxy 閾炬帴锛屾矙绠变笅涓嶅姩銆?*
濉畬閲嶆柊閮ㄧ讲涓€娆°€?

### 鐜鍙橀噺锛圥ages 鈫?Settings 鈫?Variables and secrets锛?

| 鍙橀噺 | 浣滅敤 | 渚嬪瓙 |
| --- | --- | --- |
| `GATEWAY_KEY` | 閰嶄簡灏辫姹傚甫 `x-gateway-key` 澶达紝鍚﹀垯 `/api/search` 绛夎繑鍥?401锛涗笉閰嶅垯鍏紑 | 32 浣嶉殢鏈轰覆 |
| `STREAM_ALLOW` | `/api/stream` 棰濆鏀捐鐨勭洿閾惧煙鍚嶏紝閫楀彿鍒嗛殧 | `ducks.party` |

`/api/stream` 鐨勯粯璁ょ櫧鍚嶅崟鍙湁 `googlevideo.com`銆乣savetube.vip|me`銆乣odycdn.com` 鍜岀墖娈?`pipedproxy`銆?
2026-11-12 瀹炴祴锛歚/api/resolve` 缁欏嚭鐨勭洿閾捐惤鍦?`piped-proxy.ducks.party`锛?*甯﹁繛瀛楃鐨?`piped-proxy` 涓嶅尮閰?`pipedproxy`**锛?
浜庢槸 `/api/stream` 涓€寰?`403 host not allowed`銆傚姞涓?`STREAM_ALLOW=ducks.party` 骞堕噸鏂伴儴缃插悗锛屾暣鏉?resolve 鈫?stream 鎵嶉€氥€?

鐜鍙橀噺鏀逛簡瑕侀噸鏂伴儴缃蹭竴娆℃墠鐢熸晥锛圙it 杩炴帴鐨勫伐绋嬶細push 涓€娆℃垨 Deployments 鈫?Retry锛夈€?

## 閮ㄧ讲鍚庡繀娴嬶紙浠庢矙绠?curl锛?

```bash
# 1. 棰戦亾鏋氫妇锛氬簲杩斿洖 JSON锛寈-backend 澶村憡璇変綘瀹為檯璧板摢涓悗绔?
curl -i "https://yt-gateway.pages.dev/api/channel?channel=@mkbhd"

# 2. 瑙嗛鐩撮摼锛氬簲杩斿洖 JSON锛宒ownload_url 鎸囧悜浣犵殑缃戝叧
curl -i "https://yt-gateway.pages.dev/api/resolve?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ"

# 3. 瀛楄妭閫忎紶锛氬簲杩斿洖瑙嗛瀛楄妭锛圚TTP 206锛?
curl -i -H "Range: bytes=0-1023" "https://yt-gateway.pages.dev/api/stream?u=<download_url 閲岀殑 u>"
```

## 鍏抽敭娉ㄦ剰 / 宸茶俯鐨勫潙

| 浜嬪疄 | 褰卞搷 |
|---|---|
| `*.workers.dev` DNS 姹℃煋 | 涓嶈兘鐢?Workers锛屽繀椤荤敤 Pages Functions |
| `hello.pages.dev` 瀹炴祴 200锛?0-12锛?| `*.pages.dev` 鍩虹璁炬柦鏈満鍙揪 |
| 浣犵殑鑷畾涔?pages.dev 鍩熷悕鏄惁鍙揪**灏氭湭楠岃瘉** | 閮ㄧ讲鍚庣涓€姝ュ氨娴嬪畠锛宍hello` 閫?鈮?浣犵殑鍩熷悕閫?|
| `googlevideo.com` / `youtubei.googleapis.com` 鏈満涓嶅彲杈?| 鐩撮摼蹇呴』缁?`/api/stream` 鍥炴簮锛屾灇涓?瑙ｆ瀽璧扮綉鍏?|
| InnerTube `clientVersion` 浼氳繃鏈?| 鑻?InnerTube 杩斿洖 404/`bad client`锛屾洿鏂?`resolve.js`/`channel.js` 閲岀殑 `clientVersion` 涓烘洿鏂扮殑 `2.YYYYMMDD.XX.YY` |
| InnerTube 瀵规暟鎹腑蹇?IP 鏈夐鎺?| browse锛堟灇涓撅級鐩稿瀹芥澗锛宲layer锛堜笅杞界洿閾撅級鍙兘鍋跺彂 429 鈫?姝ゆ椂鑷姩钀藉埌 Piped 鍏滃簳 |
| Piped 鐩撮摼鏄?`pipedproxy-*.kavin.rocks` 浠ｇ悊鍦板潃 | 娌欑鑳藉惁鐩磋繛鏈煡锛岀粺涓€璧?`/api/stream` 鍏滃簳 |
| Cloudflare Pages Functions 鍏嶈垂鐗堝澶у搷搴旀湁闄愬埗 | 瓒呭ぇ瑙嗛锛?100MB锛夐€忎紶鍙兘澶辫触锛宍/api/stream` 鏄祦寮忎絾闇€瀹炴祴涓婇檺 |
| 娌欑 UDP 鍑虹珯鐧藉悕鍗?| WARP / WireGuard 闅ч亾寤轰笉璧锋潵锛屼笉瑕佸湪娌欑閲岃瘯 |

## 鎺ヨ繘 video_origin.py

```python
# 棰戦亾鏋氫妇
export VIDEO_ENUM_API="https://yt-gateway.pages.dev/api/channel?channel={u}"

# 瑙嗛涓嬭浇鐩撮摼
export VIDEO_ORIGIN_API="https://yt-gateway.pages.dev/api/resolve?url={u}"
```

`{u}` 浼氳鏇挎崲鎴?URL 缂栫爜鍚庣殑閾炬帴銆俙resolve` 杩斿洖 JSON 褰㈢姸涓?davidcyriltech 涓€鑷达細
`{success, result:{title, quality, download_url, ...}}`锛岀幇鏈夎В鏋愪唬鐮侀浂鏀瑰姩銆?
