import { kv, kDailyLoss, kTicket, kCodeToId, kPaused } from "../lib/kv.js";
import twilioPkg from "twilio";

const twilio = twilioPkg(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const sms = async (text) => {
  const recipients = (process.env.RECIPIENTS||"").split(",").map(s=>s.trim()).filter(Boolean);
  for (const to of recipients) {
    await twilio.messages.create({
      to,
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
      body: text.slice(0,1400)
    });
  }
};

const parseForm = async (req) => {
  if (typeof req.body === "string") {
    return Object.fromEntries(new URLSearchParams(req.body));
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return Object.fromEntries(new URLSearchParams(raw));
};

const helpText = "Commands:\nY<code>=confirm • N<code>=cancel\nQ<code>=<qty> • S<code>=<stop>\nSTATUS • PAUSE • RESUME • FLAT <SYM>";

const parseCmd = (t) => {
  t = (t||"").trim().toUpperCase();
  if (["STATUS","PAUSE","RESUME","HELP"].includes(t)) return {cmd:t};
  let m = t.match(/^(Y|N|Q|S)\s*([A-Z0-9]{3})\s*(?:=\s*([0-9.]+))?$/);
  if (m) return {cmd:m[1], code:m[2], val:m[3]};
  m = t.match(/^FLAT\s+([A-Z0-9]+)$/);
  if (m) return {cmd:"FLAT", sym:m[1]};
  return {cmd:"UNKNOWN"};
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const form = await parseForm(req);
  const text = form.Body || "";

  const {cmd, code, val, sym} = parseCmd(text);

  if (cmd === "HELP") { await sms(helpText); return res.status(200).end(); }

  if (cmd === "STATUS") {
    const cap = Number(process.env.TRAILING_CUSHION||3000) * Number(process.env.USE_PCT_OF_CUSHION||0.5);
    const used = Number(await kv.get(kDailyLoss())) || 0;
    const paused = !!(await kv.get(kPaused));
    await sms(`PnL Loss Used $${used.toFixed(0)} / Cap $${cap.toFixed(0)} • Left $${(cap-used).toFixed(0)} • Paused=${paused}`);
    return res.status(200).end();
  }

  if (cmd === "PAUSE") { await kv.set(kPaused, 1); await sms("Paused."); return res.status(200).end(); }
  if (cmd === "RESUME") { await kv.del(kPaused); await sms("Resumed."); return res.status(200).end(); }

  if (cmd === "FLAT") { await sms(`(Note) FLAT ${sym}: close manually on your DOM (Apex-safe).`); return res.status(200).end(); }

  if (["Y","N","Q","S"].includes(cmd)) {
    const id = await kv.get(kCodeToId(code));
    if (!id) { await sms(`Ticket ${code} not found.`); return res.status(200).end(); }

    const t = await kv.get(kTicket(id));
    if (!t || t.status !== "PENDING") {
      await sms(`Ticket ${code} already ${t?.status || "NA"}.`); return res.status(200).end();
    }

    if (cmd === "N") {
      t.status = "CANCELLED";
      await kv.set(kTicket(id), t);
      await sms(`Cancelled ${code} • ${t.symbol} ${t.side}`);
      return res.status(200).end();
    }

    if (cmd === "Q") {
      const q = parseInt(val||"0",10);
      if (q < 1) { await sms("Qty must be >= 1"); return res.status(200).end(); }
      t.qty = q; await kv.set(kTicket(id), t);
      await sms(`Qty set: ${t.symbol} ${t.side} QTY ${t.qty} @MKT SL ${t.stop.toFixed(4)} (code ${code})`);
      return res.status(200).end();
    }

    if (cmd === "S") {
      const st = Number(val);
      if (!Number.isFinite(st)) { await sms("Send like: SABC=2450.5"); return res.status(200).end(); }
      t.stop = st; await kv.set(kTicket(id), t);
      await sms(`Stop set: ${t.symbol} ${t.side} QTY ${t.qty} @MKT SL ${t.stop.toFixed(4)} (code ${code})`);
      return res.status(200).end();
    }

    if (cmd === "Y") {
      // Apex-safe: send manual entry instructions (no auto-exec)
      t.status = "INSTRUCTED";
      await kv.set(kTicket(id), t);
      await sms(`ENTER NOW\n${t.symbol} ${t.side} QTY ${t.qty} @MKT\nSTOP ${t.stop.toFixed(4)}\n(Place in DOM) • Code ${code}`);
      return res.status(200).end();
    }
  }

  await sms("Unknown. Send HELP.");
  return res.status(200).end();
}
