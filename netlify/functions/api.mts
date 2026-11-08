/**
 * The site's whole backend: one Netlify Function, data in Netlify Blobs.
 *  - /api/login                     password → session token
 *  - /api/classes…, /api/search…    the website (Bearer token)
 *  - /api/uploads…                  resumable uploads in 4 MB parts
 *  - /api/worker/…                  the transcription worker (x-worker-secret)
 */
import { getStore } from "@netlify/blobs";
import { normalizeForSearch } from "@halaqa/shared/src/arabic.ts";
import type { ClassRow, StudyKind } from "@halaqa/shared";

export const config = { path: "/api/*" };

const KINDS: StudyKind[] = ["summary", "notes", "takeaways", "glossary"];
const PART_SIZE = 4 * 1024 * 1024; // keeps each request under Netlify's 6 MB body limit
const STALE_MS = 10 * 60_000;

const env = (k: string) => process.env[k] ?? "";
const db = () => getStore({ name: "halaqa", consistency: "strong" });
const now = () => new Date().toISOString();

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (status: number, error: string) => json({ error }, status);

// ───────────────────────── auth ─────────────────────────
const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer | Uint8Array) => Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString("base64url");

async function hmac(data: string): Promise<string> {
  // Changing APP_PASSWORD signs everyone out.
  const key = await crypto.subtle.importKey("raw", enc.encode(`${env("SESSION_SECRET")}|${env("APP_PASSWORD")}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}
const sha256 = async (s: string) => b64url(await crypto.subtle.digest("SHA-256", enc.encode(s)));

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function makeToken(): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ exp: Date.now() + 180 * 86_400_000 })));
  return `${payload}.${await hmac(payload)}`;
}

async function validToken(req: Request): Promise<boolean> {
  const t = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const [payload, sig] = t.split(".");
  if (!payload || !sig || !safeEqual(sig, await hmac(payload))) return false;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > Date.now();
  } catch {
    return false;
  }
}

// ───────────────────────── data helpers ─────────────────────────
type Store = ReturnType<typeof db>;
type StudyRow = {
  id: string;
  class_id: string;
  kind: StudyKind;
  status: string;
  content: string | null;
  data: unknown;
  error: string | null;
  status_message?: string | null;
  attempts: number;
  next_attempt_at: string;
  locked_by: string | null;
  locked_at: string | null;
  created_at: string;
  updated_at: string;
};

const getJSON = <T,>(s: Store, key: string) => s.get(key, { type: "json" }) as Promise<T | null>;
const putClass = (s: Store, row: ClassRow) => s.setJSON(`class/${row.id}`, { ...row, updated_at: now() });

async function listJSON<T>(s: Store, prefix: string): Promise<T[]> {
  const { blobs } = await s.list({ prefix });
  const items = await Promise.all(blobs.map((b) => getJSON<T>(s, b.key)));
  return items.filter((x): x is Awaited<T> & T => x !== null);
}

function newClass(fields: Partial<ClassRow> & Pick<ClassRow, "source_type">): ClassRow {
  const t = now();
  return {
    id: crypto.randomUUID(),
    user_id: "owner",
    youtube_id: null,
    source_url: null,
    storage_path: null,
    upload_fingerprint: null,
    title: null,
    channel: null,
    thumbnail_url: null,
    class_date: null,
    duration_seconds: null,
    status: "queued",
    stage: "waiting",
    progress: 0,
    status_message: null,
    error: null,
    error_code: null,
    transcript_source: null,
    provider: null,
    attempts: 0,
    speaker_names: {},
    created_at: t,
    updated_at: t,
    ...fields,
    ...({ next_attempt_at: t, locked_by: null, locked_at: null } as object),
  };
}

/** Worker ids are "<hostname>-<pid>": a restarted worker on the same machine takes its old jobs back at once. */
const sameHostRestart = (lockedBy: string | null | undefined, workerId: string) =>
  !!lockedBy && lockedBy !== workerId && lockedBy.replace(/-\d+$/, "") === workerId.replace(/-\d+$/, "");

const claimable = (workerId: string) => (r: { status: string; next_attempt_at?: string; locked_at?: string | null; locked_by?: string | null }) =>
  (r.status === "queued" && (!r.next_attempt_at || r.next_attempt_at <= now())) ||
  (r.status === "processing" &&
    (!r.locked_at || Date.parse(r.locked_at) < Date.now() - STALE_MS || (!isCloudWorker(workerId) && sameHostRestart(r.locked_by, workerId))));

/** Cloud runs take only cloud jobs; the home computer takes everything else (uploads, private, handed-back jobs). */
const rightEngine = (workerId: string) => (r: CloudFields) => isCloudWorker(workerId) === (r.engine === "cloud");

async function deleteClass(s: Store, c: ClassRow) {
  const keys = [`class/${c.id}`, `transcript/${c.id}`, `search/${c.id}`, `chunks/${c.id}`];
  if (c.youtube_id) keys.push(`yt/${c.youtube_id}`);
  if (c.upload_fingerprint) keys.push(`fp/${await sha256(c.upload_fingerprint)}`, `upload-fp/${await sha256(c.upload_fingerprint)}`);
  for (const prefix of [`refine/${c.id}/`, `part/${c.id}/`, `study/${c.id}/`, ...(c.storage_path ? [`upload/${c.storage_path}/`] : [])]) {
    const { blobs } = await s.list({ prefix });
    keys.push(...blobs.map((b) => b.key));
  }
  await Promise.all(keys.map((k) => s.delete(k)));
}

const DAILY_LIMIT = 30;
async function overDailyLimit(s: Store) {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  return (await listJSON<ClassRow>(s, "class/")).filter((c) => c.created_at > since).length >= DAILY_LIMIT;
}

/** The home computer counts as online if it talked to us in the last 3 minutes. */
async function touchWorker(s: Store) {
  const prev = await getJSON<{ last_seen: string }>(s, "meta/worker");
  if (!prev || Date.now() - Date.parse(prev.last_seen) > 30_000) await s.setJSON("meta/worker", { last_seen: now() });
}

// ───────────────────────── cloud transcription (Gemini) ─────────────────────────
/** Public YouTube lectures go to the cloud path when a Gemini key is set on the site; private ones never do. */
const cloudEnabled = () => !!env("GEMINI_API_KEY");
const isCloudWorker = (workerId: string) => workerId.startsWith("cloud-");
type CloudFields = { engine?: "cloud" | "local"; cloud_failures?: number };

/** Earliest time the cloud runner has work; a scheduled function reads this one small blob every 10 minutes. */
const setCloudNext = (s: Store, at: string) => s.setJSON("meta/cloud-next", { at });

/** Start the background function now (returns immediately; it runs up to 15 minutes). */
async function kickCloud(s: Store) {
  if (!cloudEnabled()) return;
  await setCloudNext(s, now()); // safety net if this call is lost: the scheduler picks it up
  const base = env("URL") || env("DEPLOY_URL");
  if (!base) return;
  await fetch(`${base}/.netlify/functions/cloud-background`, { method: "POST", headers: { "x-worker-secret": env("WORKER_SECRET") } }).catch(() => {});
}

// ── free-allowance guard: Netlify's free plan includes 100 GB-hours of function time a month ──
const LEASE_MS = 15.5 * 60_000; // longer than a background function can live (15 min)
const usageKey = () => `meta/cloud-usage/${now().slice(0, 7)}`;
const budgetSeconds = () => Number(env("CLOUD_MONTHLY_HOURS") || 40) * 3600;
const cloudUsage = async (s: Store) => (await getJSON<{ seconds: number }>(s, usageKey()))?.seconds ?? 0;
async function addCloudUsage(s: Store, seconds: number) {
  for (let i = 0; i < 5 && seconds > 0; i++) {
    const cur = await s.getWithMetadata(usageKey(), { type: "json" });
    const next = { seconds: ((cur?.data as { seconds?: number } | null)?.seconds ?? 0) + seconds, updated_at: now() };
    // `cur?.etag` can be falsy even when the blob exists (seen in the local Blobs emulator); gate the CAS mode on
    // whether we read a document at all, not on etag truthiness, or an existing blob falls into onlyIfNew and every
    // write is rejected forever.
    const res = await s.setJSON(usageKey(), next, cur ? (cur.etag ? { onlyIfMatch: cur.etag } : {}) : { onlyIfNew: true });
    if (!res || res.modified !== false) return;
  }
}
const cloudAvailable = async (s: Store) => cloudEnabled() && (await cloudUsage(s)) < budgetSeconds();
/** Monthly online allowance used up: waiting cloud lectures finish on the home computer instead. */
async function handCloudJobsHome(s: Store) {
  const rows = (await listJSON<ClassRow & CloudFields>(s, "class/")).filter((r) => r.engine === "cloud" && r.status === "queued");
  for (const r of rows)
    await putClass(s, { ...r, engine: "local", status_message: "This month's free online transcription time is used up, so this will finish on the home computer next time it's on." } as ClassRow);
}

// ───────────────────────── routing ─────────────────────────
type Handler = (req: Request, m: string[], s: Store) => Promise<Response>;
const routes: Array<[string, RegExp, Handler, "user" | "worker" | "public"]> = [];
const route = (method: string, pattern: string, auth: "user" | "worker" | "public", h: Handler) =>
  routes.push([method, new RegExp(`^${pattern.replace(/:\w+/g, "([^/]+)")}$`), h, auth]);

route("POST", "/login", "public", async (req) => {
  const { password } = (await req.json().catch(() => ({}))) as { password?: string };
  if (!env("APP_PASSWORD") || !env("SESSION_SECRET")) return fail(500, "The site isn't configured yet (APP_PASSWORD / SESSION_SECRET).");
  const s = db();
  const fails = (await getJSON<{ count: number; since: number }>(s, "meta/login-fails")) ?? { count: 0, since: Date.now() };
  if (Date.now() - fails.since > 15 * 60_000) Object.assign(fails, { count: 0, since: Date.now() });
  if (fails.count >= 10) return fail(429, "Too many attempts. Please wait 15 minutes and try again.");
  if (!password || !safeEqual(await sha256(password), await sha256(env("APP_PASSWORD")))) {
    await s.setJSON("meta/login-fails", { ...fails, count: fails.count + 1 });
    await new Promise((r) => setTimeout(r, 800)); // slow down guessing
    return fail(401, "That password isn't right.");
  }
  if (fails.count) await s.delete("meta/login-fails");
  return json({ token: await makeToken() });
});

// ── classes ──
route("GET", "/classes", "user", async (_req, _m, s) => {
  const rows = await listJSON<ClassRow>(s, "class/");
  return json(rows.sort((a, b) => b.created_at.localeCompare(a.created_at)));
});

route("POST", "/classes", "user", async (req, _m, s) => {
  const { youtube_id, ai_opt_out } = (await req.json()) as { youtube_id?: string; ai_opt_out?: boolean };
  if (!youtube_id || !/^[A-Za-z0-9_-]{11}$/.test(youtube_id)) return fail(400, "That doesn't look like a YouTube video.");
  const existing = await getJSON<{ id: string }>(s, `yt/${youtube_id}`);
  if (existing && (await getJSON(s, `class/${existing.id}`))) return json({ id: existing.id, existing: true });
  if (await overDailyLimit(s)) return fail(429, `You've added ${DAILY_LIMIT} lectures today. Please add more tomorrow.`);
  const privateLecture = ai_opt_out !== false;
  const engine = !privateLecture && (await cloudAvailable(s)) ? "cloud" : "local";
  const row = newClass({ source_type: "youtube", youtube_id, source_url: `https://www.youtube.com/watch?v=${youtube_id}`, ...({ ai_opt_out: privateLecture, engine } as object) });
  await putClass(s, row);
  await s.setJSON(`yt/${youtube_id}`, { id: row.id });
  if (engine === "cloud") await kickCloud(s);
  return json({ id: row.id }, 201);
});

route("GET", "/status", "user", async (_req, _m, s) => {
  const w = await getJSON<{ last_seen: string }>(s, "meta/worker");
  return json({ workerOnline: !!w && Date.now() - Date.parse(w.last_seen) < 3 * 60_000, lastSeen: w?.last_seen ?? null, cloudEnabled: cloudEnabled() });
});

/** Transcript so far (unpolished) while a long lecture is still processing. */
route("GET", "/classes/:id/partial", "user", async (_req, [id], s) => {
  const chunks = await assembledChunks(s, id);
  const done = chunks.filter((c) => c.done && c.segments);
  return json({ partsDone: done.length, partsTotal: chunks.length, segments: done.sort((a, b) => a.idx - b.idx).flatMap((c) => c.segments!) });
});

route("GET", "/classes/:id", "user", async (_req, [id], s) => {
  const row = await getJSON<ClassRow>(s, `class/${id}`);
  return row ? json(row) : fail(404, "Not found");
});

route("PATCH", "/classes/:id", "user", async (req, [id], s) => {
  const row = await getJSON<ClassRow>(s, `class/${id}`);
  if (!row) return fail(404, "Not found");
  const body = (await req.json()) as Partial<ClassRow>;
  const allowed: Partial<ClassRow> = {};
  if (typeof body.title === "string") allowed.title = body.title.slice(0, 300);
  if (body.class_date === null || typeof body.class_date === "string") allowed.class_date = body.class_date;
  if (body.speaker_names && typeof body.speaker_names === "object") allowed.speaker_names = body.speaker_names;
  if (typeof (body as { ai_opt_out?: unknown }).ai_opt_out === "boolean") {
    const optOut = (body as { ai_opt_out: boolean }).ai_opt_out;
    Object.assign(allowed, { ai_opt_out: optOut });
    // Marked private before the cloud finished: keep it on the home computer from now on.
    if (optOut && row.status !== "completed") Object.assign(allowed, { engine: "local" });
  }
  await putClass(s, { ...row, ...allowed });
  return json({ ok: true });
});

route("DELETE", "/classes/:id", "user", async (_req, [id], s) => {
  const row = await getJSON<ClassRow>(s, `class/${id}`);
  if (row) await deleteClass(s, row);
  return json({ ok: true });
});

route("POST", "/classes/:id/retry", "user", async (_req, [id], s) => {
  const row = await getJSON<ClassRow>(s, `class/${id}`);
  if (!row) return fail(404, "Not found");
  if (row.status !== "failed") return json({ ok: true });
  await putClass(s, { ...row, status: "queued", stage: "waiting", attempts: 0, error: null, error_code: null, status_message: null, ...({ next_attempt_at: now(), locked_by: null, locked_at: null, cloud_failures: 0 } as object) });
  if ((row as CloudFields).engine === "cloud") await kickCloud(s);
  return json({ ok: true });
});

route("GET", "/classes/:id/transcript", "user", async (_req, [id], s) => {
  const t = await getJSON<{ doc: unknown }>(s, `transcript/${id}`);
  return t ? json(t.doc) : fail(404, "Not found");
});

route("GET", "/classes/:id/study", "user", async (_req, [id], s) => json(await listJSON<StudyRow>(s, `study/${id}/`)));

route("POST", "/classes/:id/study", "user", async (req, [id], s) => {
  const row = await getJSON<ClassRow>(s, `class/${id}`);
  if (!row || row.status !== "completed") return fail(400, "The transcript isn't finished yet.");
  const { kinds, force } = (await req.json().catch(() => ({}))) as { kinds?: StudyKind[]; force?: boolean };
  for (const kind of (kinds ?? KINDS).filter((k) => KINDS.includes(k))) {
    const key = `study/${id}/${kind}`;
    const prev = await getJSON<StudyRow>(s, key);
    if (prev && !force && prev.status !== "failed") continue;
    await s.setJSON(key, {
      id: `${id}:${kind}`,
      class_id: id,
      kind,
      status: "queued",
      content: prev?.content ?? null,
      data: prev?.data ?? null,
      error: null,
      status_message: null,
      attempts: 0,
      next_attempt_at: now(),
      locked_by: null,
      locked_at: null,
      created_at: prev?.created_at ?? now(),
      updated_at: now(),
    } satisfies StudyRow);
  }
  if (!row.ai_opt_out) await kickCloud(s);
  return json({ ok: true });
});

route("GET", "/search", "user", async (req, _m, s) => {
  const q = normalizeForSearch(new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) return json([]);
  const [classes, texts] = await Promise.all([listJSON<ClassRow>(s, "class/"), listJSON<{ class_id: string; search_text: string }>(s, "search/")]);
  const byId = new Map(texts.map((t) => [t.class_id, t.search_text]));
  const out: Array<{ class_id: string; snippet: string | null }> = [];
  for (const c of classes) {
    const text = byId.get(c.id) ?? "";
    const at = text.indexOf(q);
    if (at >= 0) out.push({ class_id: c.id, snippet: `…${text.slice(Math.max(0, at - 60), at + 120)}…` });
    else if (normalizeForSearch(c.title ?? "").includes(q)) out.push({ class_id: c.id, snippet: null });
  }
  return json(out);
});

// ── uploads (resumable, 4 MB parts) ──
route("POST", "/uploads", "user", async (req, _m, s) => {
  const f = (await req.json()) as { name: string; size: number; type?: string; lastModified?: number };
  if (!f.name || !(f.size > 0)) return fail(400, "Missing file details.");
  if (!/\.(mp3|m4a|aac|wav|ogg|opus|flac|wma|amr|mp4|m4v|mov|webm|mkv|3gp)$/i.test(f.name)) return fail(400, "Please choose an audio or video file (for example MP3, M4A or MP4).");
  if (await overDailyLimit(s)) return fail(429, `You've added ${DAILY_LIMIT} lectures today. Please add more tomorrow.`);
  if (f.size > 2 * 1024 ** 3) return fail(400, "Files over 2 GB aren't supported. Please convert the recording to audio (MP3/M4A) first.");
  const fingerprint = `${f.name}:${f.size}:${f.lastModified ?? 0}`;
  const fp = await sha256(fingerprint);
  const done = await getJSON<{ id: string }>(s, `fp/${fp}`);
  if (done && (await getJSON(s, `class/${done.id}`))) return json({ existingClassId: done.id });
  let meta = await getJSON<{ id: string; parts: number }>(s, `upload-fp/${fp}`);
  if (!meta) {
    meta = { id: crypto.randomUUID(), parts: Math.ceil(f.size / PART_SIZE) };
    await s.setJSON(`upload/${meta.id}/meta`, { ...meta, name: f.name, size: f.size, type: f.type ?? "", fingerprint, created_at: now() });
    await s.setJSON(`upload-fp/${fp}`, meta);
  }
  const { blobs } = await s.list({ prefix: `upload/${meta.id}/part/` });
  const received = blobs.map((b) => Number(b.key.split("/").pop()));
  return json({ uploadId: meta.id, partSize: PART_SIZE, parts: meta.parts, received });
});

route("PUT", "/uploads/:id/parts/:n", "user", async (req, [id, n], s) => {
  const meta = await getJSON<{ parts: number }>(s, `upload/${id}/meta`);
  if (!meta || !(Number(n) >= 0 && Number(n) < meta.parts)) return fail(404, "Unknown upload part");
  const body = await req.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > PART_SIZE) return fail(400, "Bad part size");
  await s.set(`upload/${id}/part/${n}`, body);
  return json({ ok: true });
});

route("POST", "/uploads/:id/complete", "user", async (req, [id], s) => {
  const meta = await getJSON<{ parts: number; name: string; fingerprint: string }>(s, `upload/${id}/meta`);
  if (!meta) return fail(404, "Unknown upload");
  const { blobs } = await s.list({ prefix: `upload/${id}/part/` });
  if (blobs.length < meta.parts) return fail(409, `Upload incomplete (${blobs.length}/${meta.parts} parts).`);
  const body = (await req.json().catch(() => ({}))) as { title?: string; class_date?: string | null };
  const row = newClass({
    source_type: "upload",
    ai_opt_out: true,
    storage_path: id,
    upload_fingerprint: meta.fingerprint,
    title: body.title || meta.name.replace(/\.[^.]+$/, ""),
    class_date: body.class_date ?? null,
    ...({ ai_opt_out: true, engine: "local" } as object),
  });
  await putClass(s, row);
  await s.setJSON(`fp/${await sha256(meta.fingerprint)}`, { id: row.id });
  return json({ id: row.id }, 201);
});

// ───────────────────────── worker endpoints ─────────────────────────
route("POST", "/worker/claim-class", "worker", async (req, _m, s) => {
  const { workerId } = (await req.json()) as { workerId: string };
  const rows = (await listJSON<ClassRow & CloudFields & { next_attempt_at?: string; locked_at?: string | null; locked_by?: string | null }>(s, "class/"))
    .filter(claimable(workerId))
    .filter(rightEngine(workerId));
  rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const candidate of rows) {
    // Compare-and-swap: if another run changed the row since we read it, skip it (no double processing).
    const cur = await s.getWithMetadata(`class/${candidate.id}`, { type: "json" });
    const row = cur?.data as (typeof rows)[number] | undefined;
    if (!cur || !row || !claimable(workerId)(row) || !rightEngine(workerId)(row)) continue;
    const claimed = { ...row, status: "processing" as const, attempts: row.attempts + 1, status_message: row.status_message ?? "Starting…", locked_by: workerId, locked_at: now(), updated_at: now() };
    const res = await s.setJSON(`class/${row.id}`, claimed, cur.etag ? { onlyIfMatch: cur.etag } : {});
    if (res && res.modified === false) continue;
    if (isCloudWorker(workerId)) await setCloudNext(s, new Date(Date.now() + 16 * 60_000).toISOString()); // watchdog if the run dies
    return json(claimed);
  }
  return json(null);
});

route("POST", "/worker/claim-study", "worker", async (req, _m, s) => {
  const { workerId } = (await req.json()) as { workerId: string };
  const rows = (await listJSON<StudyRow>(s, "study/")).filter(claimable(workerId)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const candidate of rows) {
    const key = `study/${candidate.class_id}/${candidate.kind}`;
    const cur = await s.getWithMetadata(key, { type: "json" });
    const row = cur?.data as StudyRow | undefined;
    if (!cur || !row || !claimable(workerId)(row)) continue;
    const claimed = { ...row, status: "processing", attempts: row.attempts + 1, locked_by: workerId, locked_at: now(), updated_at: now() };
    const res = await s.setJSON(key, claimed, cur.etag ? { onlyIfMatch: cur.etag } : {});
    if (res && res.modified === false) continue; // another run got it first
    return json(claimed);
  }
  return json(null);
});

/** One cloud run at a time (scheduler, self-restart and API kicks can all fire together); track its time. */
/**
 * Atomic: every acquisition (first ever, after a release, or taking over from a crashed run) must CREATE the key
 * `meta/cloud-lease-gen/<n+1>` with onlyIfNew. Storage lets exactly one caller create it, so two workers that both
 * saw the same expired lease can't both win - no reliance on etags. The lease outlives any run (15.5 > 15 min),
 * so a run is always dead before another can take over its work.
 */
type Lease = { runner: string; until: string; gen?: number };
route("POST", "/worker/cloud-lease", "worker", async (req, _m, s) => {
  const { runner, release, seconds } = (await req.json()) as { runner: string; release?: boolean; seconds?: number };
  const lease = await getJSON<Lease>(s, "meta/cloud-lease");
  if (release) {
    // Only the current owner, and only while its lease is clearly still live: a takeover needs the lease to have
    // expired, so with ≥ 5 s left nobody else can have taken it between this read and the write below. A late
    // release (lease expired or already taken over) changes nothing and isn't counted — the run that takes over
    // counts it as a full 15 minutes instead, so time is never counted twice.
    if (lease?.runner !== runner || Date.parse(lease.until) < Date.now() + 5_000) return json({ ok: true, late: true });
    await s.setJSON("meta/cloud-lease", { ...lease, until: new Date(0).toISOString() }); // released; keeps `gen`
    await addCloudUsage(s, Math.min(Math.max(0, seconds ?? 0), 900));
    return json({ ok: true });
  }
  if (lease && Date.parse(lease.until) > Date.now()) return json({ ok: false, reason: "busy" });
  if ((await cloudUsage(s)) >= budgetSeconds()) {
    await handCloudJobsHome(s);
    return json({ ok: false, reason: "budget" });
  }
  const gen = (lease?.gen ?? 0) + 1;
  const won = await s.setJSON(`meta/cloud-lease-gen/${gen}`, { runner, at: now() }, { onlyIfNew: true });
  if (won && won.modified === false) return json({ ok: false, reason: "busy" }); // another worker took this turn
  await s.setJSON("meta/cloud-lease", { runner, until: new Date(Date.now() + LEASE_MS).toISOString(), gen });
  if (gen > 50) await s.delete(`meta/cloud-lease-gen/${gen - 50}`); // tidy; far too old for any worker to race on
  if (lease && Date.parse(lease.until) > 0) await addCloudUsage(s, 900); // previous run died without reporting: count 15 min
  return json({ ok: true });
});

/** The cloud runner found nothing to do: remember when the earliest waiting cloud job is due (or clear). */
route("POST", "/worker/cloud-idle", "worker", async (_req, _m, s) => {
  const due = [
    ...(await listJSON<ClassRow & CloudFields & { next_attempt_at?: string }>(s, "class/")).filter((r) => r.engine === "cloud" && r.status !== "completed" && r.status !== "failed"),
    ...(await listJSON<StudyRow>(s, "study/")).filter((r) => r.status === "queued" || r.status === "processing"),
  ]
    .map((r) => (r.status === "processing" ? new Date(Date.now() + 16 * 60_000).toISOString() : (r.next_attempt_at ?? now())))
    .sort();
  if (due[0]) await setCloudNext(s, due[0]);
  else await s.delete("meta/cloud-next");
  return json({ next: due[0] ?? null });
});

route("GET", "/worker/classes/:id", "worker", async (_req, [id], s) => {
  const row = await getJSON(s, `class/${id}`);
  return row ? json(row) : fail(404, "Not found");
});

route("PATCH", "/worker/classes/:id", "worker", async (req, [id], s) => {
  const row = await getJSON<ClassRow & { locked_by?: string | null; locked_at?: string | null }>(s, `class/${id}`);
  if (!row) return fail(404, "Not found"); // deleted while processing
  const { owner, ...patch } = (await req.json()) as Partial<ClassRow> & { owner?: string };
  // A cloud run names itself. Once a newer run holds a fresh lock, the old run cannot release or overwrite it.
  if (owner && row.locked_by && row.locked_by !== owner && row.locked_at && Date.parse(row.locked_at) > Date.now() - STALE_MS) {
    return fail(409, "This lecture is no longer assigned to this run.");
  }
  await putClass(s, { ...row, ...patch, id });
  return json({ ok: true });
});

/** The window plan lives in `chunks/<id>`; each finished window is its own create-only blob `part/<id>/<idx>`. */
type ChunkPlanRow = { idx: number; start_s: number; end_s: number; done?: boolean; segments?: unknown; provider?: string | null };
/** Join the plan with saved parts. A part counts only when it was made for this exact window. */
async function assembledChunks(s: Store, id: string): Promise<ChunkPlanRow[]> {
  const plan = (await getJSON<ChunkPlanRow[]>(s, `chunks/${id}`)) ?? [];
  const { blobs } = await s.list({ prefix: `part/${id}/` });
  const parts = new Map(
    await Promise.all(blobs.map(async (b) => [Number(b.key.split("/").pop()), await getJSON<ChunkPlanRow>(s, b.key)] as const)),
  );
  return plan.map((r) => {
    const p = parts.get(r.idx);
    return p && p.start_s === r.start_s && p.end_s === r.end_s ? { ...r, segments: p.segments, provider: p.provider, done: true } : r;
  });
}
route("GET", "/worker/classes/:id/chunks", "worker", async (_req, [id], s) => json(await assembledChunks(s, id)));
route("PUT", "/worker/classes/:id/chunks", "worker", async (req, [id], s) => {
  await s.setJSON(`chunks/${id}`, await req.json());
  return json({ ok: true });
});
route("PUT", "/worker/classes/:id/chunks/:idx", "worker", async (req, [id, idx], s) => {
  const { owner, segments, provider } = (await req.json()) as { owner?: string; segments: unknown; provider?: string };
  // Fenced: a run that lost its lock can't write.
  if (owner && (await getJSON<{ locked_by?: string | null }>(s, `class/${id}`))?.locked_by !== owner) return fail(409, "This lecture is no longer assigned to this run.");
  const w = ((await getJSON<ChunkPlanRow[]>(s, `chunks/${id}`)) ?? []).find((r) => r.idx === Number(idx));
  if (!w) return fail(404, "No such part.");
  // Its own blob, created at most once: parallel windows never overwrite each other, and a repeat can't duplicate.
  const res = await s.setJSON(`part/${id}/${idx}`, { start_s: w.start_s, end_s: w.end_s, segments, provider, saved_at: now() }, { onlyIfNew: true });
  return json({ ok: true, already: !!res && res.modified === false });
});

route("GET", "/worker/classes/:id/refine", "worker", async (_req, [id], s) => {
  const { blobs } = await s.list({ prefix: `refine/${id}/` });
  const entries = await Promise.all(blobs.map(async (b) => [b.key.split("/").pop()!, await getJSON(s, b.key)] as const));
  return json(Object.fromEntries(entries));
});
route("PUT", "/worker/classes/:id/refine/:idx", "worker", async (req, [id, idx], s) => {
  await s.setJSON(`refine/${id}/${idx}`, await req.json());
  return json({ ok: true });
});

route("PUT", "/worker/classes/:id/transcript", "worker", async (req, [id], s) => {
  const t = (await req.json()) as { doc: unknown; search_text: string; word_count: number };
  await s.setJSON(`transcript/${id}`, { doc: t.doc, word_count: t.word_count });
  await s.setJSON(`search/${id}`, { class_id: id, search_text: t.search_text });
  // Intermediate state is no longer needed once the transcript is saved.
  const old = [...(await s.list({ prefix: `refine/${id}/` })).blobs, ...(await s.list({ prefix: `part/${id}/` })).blobs];
  await Promise.all([...old.map((b) => s.delete(b.key)), s.delete(`chunks/${id}`)]);
  return json({ ok: true });
});
route("GET", "/worker/classes/:id/transcript", "worker", async (_req, [id], s) => {
  const t = await getJSON<{ doc: unknown }>(s, `transcript/${id}`);
  return t ? json(t.doc) : fail(404, "Not found");
});

route("PATCH", "/worker/study/:id", "worker", async (req, [sid], s) => {
  const [classId, kind] = decodeURIComponent(sid).split(":");
  const key = `study/${classId}/${kind}`;
  const row = await getJSON<StudyRow>(s, key);
  if (!row) return fail(404, "Not found");
  await s.setJSON(key, { ...row, ...((await req.json()) as object), updated_at: now() });
  return json({ ok: true });
});

route("GET", "/worker/uploads/:id", "worker", async (_req, [id], s) => {
  const meta = await getJSON(s, `upload/${id}/meta`);
  return meta ? json(meta) : fail(404, "Not found");
});
route("GET", "/worker/uploads/:id/parts/:n", "worker", async (_req, [id, n], s) => {
  const buf = await s.get(`upload/${id}/part/${n}`, { type: "arrayBuffer" });
  return buf ? new Response(buf, { headers: { "content-type": "application/octet-stream" } }) : fail(404, "Not found");
});

// ───────────────────────── entry point ─────────────────────────
export default async (req: Request): Promise<Response> => {
  const path = new URL(req.url).pathname.replace(/^\/api/, "").replace(/\/$/, "") || "/";
  for (const [method, re, handler, auth] of routes) {
    if (method !== req.method) continue;
    const m = path.match(re);
    if (!m) continue;
    if (auth === "user" && !(await validToken(req))) return fail(401, "Please sign in again.");
    if (auth === "worker" && (!env("WORKER_SECRET") || !safeEqual(req.headers.get("x-worker-secret") ?? "", env("WORKER_SECRET")))) return fail(401, "Bad worker secret");
    try {
      // Only the home computer counts as "online"; the cloud runner says who it is.
      if (auth === "worker" && req.headers.get("x-worker-kind") !== "cloud") await touchWorker(db()).catch(() => {});
      return await handler(req, m.slice(1).map(decodeURIComponent), db());
    } catch (e) {
      console.error(e);
      return fail(500, (e as Error).message);
    }
  }
  return fail(404, "No such endpoint");
};
