/**
 * Background Function (Netlify returns 202 at once; this runs up to 15 minutes).
 * Transcribes queued public-YouTube lectures with Gemini, saving each window as it finishes.
 * Only one run at a time (a lease), and it never sleeps waiting for Google: busy/quota → the job records when
 * to try again and the run ends. If time runs out mid-lecture it starts itself again; the scheduled
 * `cloud-kick` restarts anything left waiting. Talks to the site's own /api/worker endpoints like the home PC.
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
  const runner = `cloud-${crypto.randomUUID()}`;
  const started = Date.now();
  const lease = await store.cloudLease(runner).catch(() => ({ ok: false, reason: "error" }));
  if (!lease.ok) return console.log(`not starting: ${lease.reason}`); // another run is working, or the monthly allowance is used up

  let result: "idle" | "more" = "idle";
  try {
    result = await runCloud({
      store,
      apiKey: key,
      workerId: runner,
      deadline: started + RUN_MS,
      windowSeconds: Number(process.env.CLOUD_WINDOW_SECONDS || 1200),
      log: (m) => console.log(m),
    });
  } finally {
    await store.cloudLease(runner, true, (Date.now() - started) / 1000).catch(() => {});
  }
  console.log(`run ${result} after ${Math.round((Date.now() - started) / 1000)} s`);
  if (result === "more") {
    await fetch(`${base}/.netlify/functions/cloud-background`, { method: "POST", headers: { "x-worker-secret": secret } }).catch(() => {});
  } else {
    await store.cloudIdle().catch((e) => console.log(`cloud-idle failed: ${(e as Error).message}`));
  }
};
