/**
 * Scheduled every 10 minutes (cheap: reads one small blob). If cloud work is due — a delayed retry after
 * Google was busy, or a run that died — it starts the background function. Long work never runs here.
 */
import { getStore } from "@netlify/blobs";

export const config = { schedule: "*/10 * * * *" };

export default async () => {
  const secret = process.env.WORKER_SECRET ?? "";
  const base = process.env.URL ?? "";
  if (!process.env.GEMINI_API_KEY || !secret || !base) return;
  const s = getStore({ name: "halaqa", consistency: "strong" });
  const next = (await s.get("meta/cloud-next", { type: "json" })) as { at: string } | null;
  if (!next || next.at > new Date().toISOString()) return;
  // Push the watchdog forward so we don't start a second run while this one works.
  await s.setJSON("meta/cloud-next", { at: new Date(Date.now() + 16 * 60_000).toISOString() });
  await fetch(`${base}/.netlify/functions/cloud-background`, { method: "POST", headers: { "x-worker-secret": secret } }).catch(() => {});
};
