/**
 * Background Function (Netlify returns 202 at once; this runs up to 15 minutes).
 * Transcribes queued public-YouTube lectures with Gemini, saving each window as it finishes.
 * If time runs out it starts itself again; the scheduled `cloud-kick` restarts anything left waiting.
 * Talks to the site's own /api/worker endpoints, exactly like the home computer does.
 */
import { runCloud } from "../../worker/src/cloud.ts";
import { HttpStore } from "../../worker/src/store.ts";

const RUN_MS = 14 * 60_000;

export default async (req: Request) => {
  const secret = process.env.WORKER_SECRET ?? "";
  const key = process.env.GEMINI_API_KEY ?? "";
  if (!secret || !key || req.headers.get("x-worker-secret") !== secret) return;
  const base = process.env.URL || new URL(req.url).origin;
  const store = new HttpStore(base, secret, { "x-worker-kind": "cloud" });
  const started = Date.now();
  const result = await runCloud({
    store,
    apiKey: key,
    workerId: `cloud-${crypto.randomUUID()}`,
    deadline: started + RUN_MS,
    windowSeconds: Number(process.env.CLOUD_WINDOW_SECONDS || 1200),
    log: (m) => console.log(m),
  });
  if (result === "more") {
    await fetch(`${base}/.netlify/functions/cloud-background`, { method: "POST", headers: { "x-worker-secret": secret } }).catch(() => {});
  } else {
    await store.cloudIdle().catch((e) => console.log(`cloud-idle failed: ${(e as Error).message}`));
  }
};
