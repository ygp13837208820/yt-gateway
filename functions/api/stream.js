// /api/stream?u=<直链>
// 把直链字节经 pages.dev 回源给沙箱（沙箱下不动 googlevideo，必须走这里）
// 必须透传 Range 请求头，否则大文件下不动。

export async function onRequestGet({ request }) {
  const u = new URL(request.url).searchParams.get('u');
  if (!u) return new Response('missing u', { status: 400 });

  const range = request.headers.get('range');
  const ua = request.headers.get('user-agent') || 'yt-gateway/1.0';
  const up = await fetch(u, {
    headers: { ...(range ? { range } : {}), 'user-agent': ua },
    cf: { cacheTtl: 0 },
  });

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
