import { Redis } from "@upstash/redis";

export const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Redis keys
export const kDailyLoss = () => `loss:${new Date().toISOString().slice(0,10)}`;
export const kPaused = "paused";
export const kTicket = (id) => `ticket:${id}`;
export const kCodeToId = (code) => `code:${code}`;
