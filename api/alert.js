import { kv, kDailyLoss, kTicket, kCodeToId } from "../lib/kv.js";
import twilioPkg from "twilio";
import { randomUUID, createHash } from "node:crypto";

const twilio = twilioPkg(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Futures specs
const SPECS = {
  ES:{tick:0.25,dpt:12.5}, MES:{tick:0.25,dpt:1.25},
  NQ:{tick:0.25,dpt:5.0},  MNQ:{tick:0.25,dpt:0.5},
  GC:{tick:0.1,dpt:10.0},  MGC:{tick:0.1,dpt:1.0},
  CL:{tick:0.01,dpt:10.0}
};
const root = (s) => {
  s = (s||"").toUpperCase();
  for (const r of ["MES","MNQ","ES","NQ","GC","MGC","CL"]) {
    if (s===r || s.startsWith(r)) return r;
  }
  return s;
};
const ticksBetween = (sym, entry, stop) => {
  const r = root(sym), spec = SPECS[r];
  if (!spec) return {ticks:0, dpt:0};
  const ticks = Math.max(1, Math.round(Math.abs(entry - stop)/spec.tick));
  return {ticks, dpt: spec.dpt};
};
const shortCode = (id) => {
  const h = createHash("sha256").update(id).digest("hex");
  return (h.slice(0,2) + h.slice(-1)).toUpperCase(); // 3-char
};

// robust JSON body parse (serverless friendly)
const parseJsonBody = async (req) => {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  if (req.headers["x-alert-secret"] !== process.env.ALERT_SECRET)
    return res.status(401).json({ ok:false, error:"unauthorized" });

  const body = await parseJsonBody(req);
  const { symbol, side, timeframe, entry, stop, strategy, note } = body || {};

  const whitelist = (process.env.SYMBOL_WHITELIST||"").split(",").map(s=>s.trim().toUpperCase()).filter(Boolean);
  const symUp = (symbol||"").toUpperCase();
  if (!whitelist.includes(symUp) && !whitelist.includes(root(symUp)))
    return res.json({ ok:true, filtered:"symbol_not_whitelisted" });

  if (!stop || typeof stop.price !== "number")
    return res.json({ ok:true, filtered:"stop_required" });

  const dailyCap = Number(process.env.TRAILING_CUSHION||3000) * Number(process.env.USE_PCT_OF_CUSHION||0.5);
  const perTrade = dailyCap * Number(process.env.PER_TRADE_PCT_OF_DAILY||0.2);

  const lossUsed = Number(await kv.get(kDailyLoss())) || 0;
  const left = Math.max(0, dailyCap - lossUsed);
  if (left <= 0) return res.json({ ok:true, filtered:"daily_cap_reached" });

  const entryPx = (entry && typeof entry.price==="number") ? entry.price : (stop.price + 10); // placeholder for sizing
  const {ticks, dpt} = ticksBetween(symUp, entryPx, stop.price);
  if (ticks<=0) return res.json({ ok:true, filtered:"invalid_ticks" });

  const rpc = ticks * dpt;
  const qty = Math.floor(Math.min(perTrade, left) / rpc);
  if (qty < 1) return res.json({ ok:true, filtered:"risk_too_wide_for_cap" });

  const id = randomUUID().slice(0,8).toUpperCase();
  const code = shortCode(id);

  const ticket = {
    id, code, status:"PENDING",
    symbol:symUp, side:String(side||"").toUpperCase(),
    entry: entryPx, stop: stop.price, qty, rpc: Math.round(rpc),
    timeframe: timeframe||1, strategy: strategy||"", note: note||"",
    ts: new Date().toISOString()
  };

  await kv.set(kTicket(id), ticket);
  await kv.set(kCodeToId(code), id);

  const recipients = (process.env.RECIPIENTS||"").split(",").map(s=>s.trim()).filter(Boolean);
  const msg = `Ticket ${code} • ${ticket.symbol} ${ticket.side} QTY ${qty} @MKT SL ${ticket.stop.toFixed(4)} (Risk/ctr $${ticket.rpc})
Reply: Y${code}=CONFIRM, N${code}=CANCEL, Q${code}=<qty>, S${code}=<stop>
STATUS/PAUSE/RESUME/HELP`;

  for (const to of recipients) {
    await twilio.messages.create({
      to,
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
      body: msg
    });
  }

  return res.json({ ok:true, ticket });
}
