// functions/_lib/health.js —— 后端/实例冷却。
//
// 每个 isolate 一份内存状态。规则和 digest-md-pipeline 里那版一致：
// **连续失败 N 次**才进冷却（默认 3 次），冷却中的排到队尾但**不剔除**——
// 全都在冷却时仍然按原顺序试一遍，避免一个坏判断把整条链路卡死。
//
// 为什么不「失败一次就冷却」：单个视频解析失败（直播、地区限制）不代表后端挂了，
// 一次失败就封 5 分钟会让整条链路对后续正常视频退化成慢路径。

export function createCooldown({ cooldownMs = 5 * 60 * 1000, threshold = 3 } = {}) {
  const until = new Map(); // name -> 冷却到期时间
  const fails = new Map(); // name -> 连续失败次数

  return {
    // 冷却中的排后面，其余保持传入顺序
    order(list) {
      const now = Date.now();
      const alive = [];
      const cold = [];
      for (const item of list) ((until.get(item) || 0) > now ? cold : alive).push(item);
      return [...alive, ...cold];
    },
    ok(name) {
      fails.delete(name);
      until.delete(name);
    },
    fail(name, ms = cooldownMs) {
      const n = (fails.get(name) || 0) + 1;
      if (n >= threshold) {
        until.set(name, Date.now() + ms);
        fails.set(name, 0);
      } else {
        fails.set(name, n);
      }
    },
    isCooling(name) {
      return (until.get(name) || 0) > Date.now();
    },
    // 调试用：谁在冷却、谁已经攒了几次失败
    snapshot() {
      const now = Date.now();
      return {
        cooling: [...until.entries()].filter(([, t]) => t > now).map(([k, t]) => `${k}(-${Math.round((t - now) / 1000)}s)`),
        strikes: [...fails.entries()],
      };
    },
  };
}
