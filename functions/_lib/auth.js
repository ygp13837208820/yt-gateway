// 网关鉴权（可选）
//
// 设计原则：**只有配置了 GATEWAY_KEY 才启用**；没配就保持公开。
// 这样先上代码、后配环境变量，永远不会把自己锁在门外（配错也不会 401 到底）。
//
// 用法：
//   Cloudflare Pages → Settings → Environment variables → 加 GATEWAY_KEY（Production）
//   客户端在请求头里带 x-gateway-key: <同一个值>
//
// 只校验请求头，不接受 ?key= 查询参数——查询串会进访问日志和浏览器历史。

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}

export function keyConfigured(env) {
  return String((env && env.GATEWAY_KEY) || "").trim().length > 0;
}

// 通过返回 null；不通过返回一个 401 Response，调用方直接 return 它
export function checkKey(request, env) {
  const key = String((env && env.GATEWAY_KEY) || "").trim();
  if (!key) return null; // 公开模式（未配置）

  const got = String(request.headers.get("x-gateway-key") || "").trim();
  if (got.length !== key.length) return deny();
  let diff = 0;
  for (let i = 0; i < key.length; i += 1) diff |= got.charCodeAt(i) ^ key.charCodeAt(i);
  return diff === 0 ? null : deny();
}

function deny() {
  return json({ success: false, error: "unauthorized", hint: "send header x-gateway-key" }, 401);
}

// OPTIONS 预检（浏览器跨域带自定义头时会先发这个）
export function preflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "x-gateway-key, content-type",
      "access-control-max-age": "86400",
    },
  });
}
