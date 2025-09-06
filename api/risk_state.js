import { kv, kDailyLoss, kPaused } from "../lib/kv.js";

export default async function handler(req, res) {
  const cap = Number(process.env.TRAILING_CUSHION||3000) * Number(process.env.USE_PCT_OF_CUSHION||0.5);
  const used = Number(await kv.get(kDailyLoss())) || 0;
  const paused = !!(await kv.get(kPaused));
  res.json({
    date: new Date().toISOString().slice(0,10),
    daily_cap: cap,
    per_trade_cap: cap*Number(process.env.PER_TRADE_PCT_OF_DAILY||0.2),
    realized_loss: used,
    remaining: Math.max(0, cap-used),
    paused,
    apex_mode: true
  });
}
