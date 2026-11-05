/**
 * Cloud path (runs inside a Netlify Background Function): public YouTube lectures are transcribed by Gemini
 * window by window, so neither the home computer nor the iPad needs to be on. Each finished window is saved
 * at once (resumable). When Google is busy or out of quota the job records WHEN to try again and the run
 * ends — no paid compute is spent sleeping; the scheduled `cloud-kick` starts a new run when it's due.
 */
import type { ClassRow } from "@halaqa/shared";
import { JobError } from "./errors.ts";
import { GEMINI_YT_MODELS, GeminiError, geminiYouTubeWindow, youTubeInfo } from "./gemini.ts";
import { openAICompatLlm, QuotaError } from "./llm.ts";
import { finishTranscript } from "./pipeline.ts";
import type { RawSegment } from "./segmenting.ts";
import type { Store, StudyRow } from "./store.ts";
import { generateStudy } from "./study.ts";

export interface CloudOpts {
  store: Store;
  apiKey: string;
  workerId: string;
  /** Epoch ms when this run must have released its job (background functions stop at 15 min). */
  deadline: number;
  windowSeconds: number;
  log: (msg: string) => void;
}

const MAX_HOURS = 12;
/** After a run can't get through, the job waits this long (minutes). The scheduler checks every 10 minutes. */
const LATER_MIN = [10, 10, 20, 30, 60];
const GIVE_UP_AFTER = 30; // ≈ a day of hourly retries
/** Never start a Gemini call that could outlive the run (a 20-minute window takes ~1-2 min; cap 6). */
const MIN_CALL_MS = 3 * 60_000;
const MAX_CALL_MS = 6 * 60_000;
/** Study notes: give up only after ~4 days of "quota used up" (hourly retries); other errors after a few tries. */
const STUDY_QUOTA_TRIES = 100;
const STUDY_OTHER_TRIES = 5;

const nowIso = () => new Date().toISOString();
const left = (o: CloudOpts) => o.deadline - Date.now();

/** Every class write from this run names its owner, so a stale run cannot clear a newer lock. */
function owned(o: CloudOpts): CloudOpts {
  const store = new Proxy(o.store, {
    get(target, prop) {
      if (prop === "updateClass") {
        return (id: string, patch: Record<string, unknown>) => target.updateClass(id, { ...patch, owner: o.workerId });
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { ...o, store };
}

/** Process cloud jobs until there are none or time runs out. "more" = call again to continue. */

export async function runCloud(o: CloudOpts): Promise<"idle" | "more"> {
  const ownedOpts = owned(o);
  while (left(o) > MIN_CALL_MS) {
    const row = await ownedOpts.store.claimClass(o.workerId);
    if (row) {
      if ((await cloudClass(row, ownedOpts)) === "more") return "more";
      continue;
    }
    const study = await o.store.claimStudy(o.workerId);
    if (study) {
      await cloudStudy(study, o);
      continue;
    }
    return "idle";
  }
  return "more";
}

/** Plan contiguous windows over [0, end); a tail under 2 minutes joins the previous window. Exported for tests. */
export function planWindows(end: number, W: number) {
  const plan: Array<{ idx: number; start: number; end: number }> = [];
  for (let s = 0, i = 0; s < end; s += W, i++) plan.push({ idx: i, start: s, end: Math.min(end, s + W) });
  if (plan.length > 1 && plan[plan.length - 1].end - plan[plan.length - 1].start < 120) plan[plan.length - 2].end = plan.pop()!.end;
  return plan;
}

class OutOfTime extends Error {}

async function cloudClass(row: ClassRow, o: CloudOpts): Promise<"done" | "more"> {
  const { store } = o;
  const log = (m: string) => o.log(`class ${row.id}: ${m}`);
  const failures = (row as { cloud_failures?: number }).cloud_failures ?? 0;
  const report = async (stage: string, progress: number, message: string) =>
    store.updateClass(row.id, { stage, progress: Math.min(0.99, progress), status_message: message, locked_at: nowIso() });
  const release = (patch: Record<string, unknown>) =>
    store.updateClass(row.id, { status: "queued", stage: "waiting", locked_by: null, locked_at: null, next_attempt_at: nowIso(), ...patch });
  const toHomeComputer = async (why: string) => {
    log(`handing to the home computer: ${why}`);
    await release({ engine: "local", status_message: `${why} It will be transcribed on the home computer next time it's on.` });
    return "done" as const;
  };

  let total = 0;
  let done = 0;
  try {
    let chunks = await store.listChunks(row.id);
    if (!chunks.length) {
      await report("fetching", 0.01, "Looking up the video…");
      const info = await youTubeInfo(row.youtube_id!);
      if (!info.duration) return await toHomeComputer("We couldn't read this video's length online (it may be live, private or age-restricted).");
      if (info.duration > MAX_HOURS * 3600) throw new JobError("TOO_LONG", `This video is longer than the ${MAX_HOURS}-hour limit.`, true);
      await store.updateClass(row.id, {
        title: row.title || info.title,
        channel: info.channel,
        thumbnail_url: info.thumbnail,
        duration_seconds: info.duration,
      });
      // End exactly at the video's real end (measured: up to 3642.3 of 3642.57 s works and keeps the closing dua).
      // Without the precise length, start 1 s inside the rounded-up listed length; an empty last answer steps back.
      const end = info.exactEnd && info.exactEnd <= info.duration + 1 ? info.exactEnd - 0.25 : info.duration - 1;
      await store.createChunks(row.id, planWindows(Math.max(1, end), o.windowSeconds));
      chunks = await store.listChunks(row.id);
    }

    total = chunks.length;
    done = chunks.filter((c) => c.done).length;
    const lastIdx = chunks[chunks.length - 1].idx;
    // Experimental max 2. A lecture that Google pushed back on last time restarts one window at a time.
    let concurrency = failures ? 1 : Math.min(2, Math.max(1, Number(process.env.CLOUD_CONCURRENCY) || 2));
    let pending = chunks.filter((c) => !c.done);
    while (pending.length) {
      if (left(o) < MIN_CALL_MS) throw new OutOfTime();
      const batch = pending.slice(0, concurrency);
      await report(
        "transcribing",
        0.05 + (0.9 * done) / total,
        total > 1 ? `Transcribing part${batch.length > 1 ? "s" : ""} ${done + 1}${batch.length > 1 ? `–${done + batch.length}` : ""} of ${total}…` : "Transcribing…",
      );
      const results = await Promise.allSettled(
        batch.map(async (c) => ({ c, ...(await transcribeWindow(row, c.start_s, c.end_s, c.idx === lastIdx, o, log)) })),
      );
      let firstError: unknown;
      let sawBusy = false;
      for (const r of results) {
        if (r.status === "rejected") {
          firstError ??= r.reason;
          if (r.reason instanceof GeminiError && r.reason.retryable) sawBusy = true;
          continue;
        }
        const { c, segments, model } = r.value;
        await store.saveChunk(row.id, c.idx, segments, `gemini:${model}`, o.workerId);
        c.segments = segments;
        c.provider = `gemini:${model}`;
        c.done = true;
        done++;
        if (failures) await store.updateClass(row.id, { cloud_failures: 0 });
      }
      // Capacity pushed back on at least one window this run: stop asking for more than one at a time.
      if (sawBusy) concurrency = 1;
      if (firstError) throw firstError; // saved windows above stay done; the run backs off and resumes later
      pending = pending.slice(batch.length);
    }

    const raw = chunks.flatMap((c) => c.segments ?? []);
    const provider = [...new Set(chunks.map((c) => c.provider).filter(Boolean))].join(",") || "gemini";
    // Gemini's text already has punctuation and Arabic script, so no extra AI polish pass.
    await finishTranscript(row, raw, "ai", provider, { store, refiner: null, refineConcurrency: 1, log, report: (s, p, m) => report(s, p, m) });
    log("completed");
    return "done";
  } catch (e) {
    if (/no longer assigned/.test((e as Error).message)) {
      log("another run took over this lecture; leaving it alone");
      return "done";
    }
    if (e instanceof OutOfTime) {
      // Not a failure: this run's 15 minutes are nearly up. The next run continues right away.
      await release({ status_message: `Transcribing… ${done} of ${total} parts done.` });
      return "more";
    }
    if (e instanceof GeminiError && !e.retryable) return toHomeComputer("The online service couldn't read this video.");
    if (e instanceof JobError && e.permanent) {
      log(`${e.code} ${e.message}`);
      await store.updateClass(row.id, { status: "failed", error: e.message, error_code: e.code, status_message: null, locked_by: null, locked_at: null });
      return "done";
    }
    const n = failures + 1;
    const perDay = e instanceof GeminiError && e.perDay;
    log(`run failed (${n}): ${(e as Error).message.slice(0, 300)}`);
    if (n >= GIVE_UP_AFTER) {
      await store.updateClass(row.id, {
        status: "failed",
        error: "This lecture could not be finished after many tries. Press “Try again” to restart.",
        error_code: "CLOUD_BUSY",
        status_message: null,
        locked_by: null,
        locked_at: null,
      });
      return "done";
    }
    const mins = perDay ? 60 : LATER_MIN[Math.min(n - 1, LATER_MIN.length - 1)];
    await release({
      cloud_failures: n,
      next_attempt_at: new Date(Date.now() + mins * 60_000).toISOString(),
      status_message: perDay
        ? "Today's transcription limit is reached. It will continue on its own — nothing for you to do."
        : `${done ? `${done} of ${total} parts are saved. ` : ""}It will continue on its own in about ${mins} minutes.`,
    });
    return "done";
  }
}

/**
 * One window: one try per model, back to back (3.8 Flash, then 3.5 Flash). No sleeping — if both are busy the
 * caller schedules a later run. The job's lock is refreshed before every call, and every call ends well before
 * the lock could go stale (10 min) or the run is stopped (15 min). For the LAST window only, an empty answer
 * means the clip ran past the real end: step back 1 s (≤ 3 times) instead of dropping seconds up front.
 * A last window that has speech but stops early is still rejected — a 6-hour lecture's final part is a full window.
 * Two models stopping at the same minute is not treated as silence: the uncovered tail is retried as a smaller clip.
 */
async function transcribeWindow(row: ClassRow, start: number, end: number, last: boolean, o: CloudOpts, log: (m: string) => void, depth = 0): Promise<{ segments: RawSegment[]; model: string }> {
  let lastErr: unknown;
  let e2 = end;
  let stepsBack = 0;
  /**
   * Gemini sometimes stops early while reporting a normal finish (measured: a 20-min window came back covering only
   * 4 minutes). A window whose lines stop before 75% of it is "short": ask the other model too. Two short answers
   * from different models is not proof of silence (both can truncate the same way). The longer prefix is kept and the
   * tail is transcribed again as a smaller clip. A single short answer is never saved — the window is retried later.
   * This includes the last window. After two smaller retries, any still-missing span is marked [unclear].
   */
  let short = null as { segments: Awaited<ReturnType<typeof geminiYouTubeWindow>>; model: string; words: number } | null;
  const isShort = (segs: Array<{ start: number }>) => e2 - start >= 300 && (segs.at(-1)?.start ?? start) < start + 0.75 * (e2 - start);
  const wordCount = (segs: Array<{ text: string }>) => segs.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
  for (let i = 0; i < GEMINI_YT_MODELS.length + 3; i++) {
    const model = GEMINI_YT_MODELS[i % GEMINI_YT_MODELS.length];
    if (left(o) < MIN_CALL_MS) throw new OutOfTime();
    await o.store.updateClass(row.id, { locked_at: nowIso() });
    const t = Date.now();
    try {
      const segments = await geminiYouTubeWindow(o.apiKey, model, row.youtube_id!, start, e2, Math.min(MAX_CALL_MS, left(o) - 60_000));
      log(`window ${start}-${e2}s: ${model} ${((Date.now() - t) / 1000).toFixed(1)}s, ${segments.length} lines`);
      if (!isShort(segments)) return { segments, model };
      const words = wordCount(segments);
      log(`window ${start}-${e2}s: ${model} answer stops at ${Math.round(segments.at(-1)?.start ?? start)}s — checking with another model`);
      if (short && short.model !== model) {
        const best = words > short.words ? { segments, model, words } : short;
        const covered = best.segments.at(-1)?.start ?? start;
        if (depth < 2 && e2 - covered >= 120 && left(o) >= MIN_CALL_MS) {
          log(`window ${start}-${e2}s: both models stop near ${Math.round(covered)}s — retrying the remaining ${Math.round(e2 - covered)}s`);
          const tail = await transcribeWindow(row, covered, e2, last, o, log, depth + 1);
          // Keep the prefix, including the line that starts where coverage stopped. Drop only a repeated boundary line.
          return { segments: [...best.segments, ...tail.segments.filter((s) => s.start > covered)], model: `${best.model}+${tail.model}` };
        }
        log(`window ${start}-${e2}s: still uncovered after a smaller retry — marking the gap`);
        return {
          segments: [
            ...best.segments,
            { start: covered, end: e2, text: "[unclear — this part of the lecture was not fully captured]", speaker: "S1" },
          ],
          model: best.model,
        };
      }
      short = words > (short?.words ?? -1) ? { segments, model, words } : short;
      lastErr = new GeminiError(`${model}: answer covered only part of the window`, 200, true);
      if (i + 1 - stepsBack >= GEMINI_YT_MODELS.length) break;
    } catch (e) {
      lastErr = e;
      const ge = e as GeminiError;
      log(`window ${start}-${e2}s: ${ge.message.slice(0, 200)}`);
      if (!(e instanceof GeminiError) || !ge.retryable || ge.perDay) throw e;
      if (last && ge.empty && stepsBack < 3) {
        e2 -= 1;
        stepsBack++;
        continue;
      }
      if (i + 1 - stepsBack >= GEMINI_YT_MODELS.length) break; // every model tried once
    }
  }
  throw lastErr;
}

/** Study notes run on their own: a finished transcript is never touched; quota/busy just means "waiting". */
async function cloudStudy(row: StudyRow, o: CloudOpts) {
  const { store } = o;
  const llm = openAICompatLlm({
    name: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: o.apiKey,
    model: process.env.GEMINI_MODEL || "gemini-flash-latest",
    maxInputTokens: 120_000,
    maxOutputTokens: 8_000,
    extraBody: { reasoning_effort: "none" },
    maxWaitMs: 30_000, // don't pay for long sleeps: record the next try instead
  });
  try {
    const [cls, doc] = await Promise.all([store.getClass(row.class_id), store.getTranscript(row.class_id)]);
    if (!cls || !doc) throw new Error("The transcript isn't ready yet.");
    if (cls.ai_opt_out) throw Object.assign(new Error("This lecture is marked private, so study notes (which use an online AI service) are turned off for it."), { permanent: true });
    const { content, data } = await generateStudy(llm, row.kind, cls.title ?? "Class", cls.id, doc, cls.speaker_names ?? {});
    await store.updateStudy(row.id, { status: "completed", content, data, error: null, status_message: null, locked_by: null, locked_at: null });
  } catch (e) {
    const msg = (e as Error).message;
    const waiting = e instanceof QuotaError || /\b(429|500|502|503|504)\b|high demand|overloaded|network/i.test(msg);
    const permanent = !!(e as { permanent?: boolean }).permanent;
    const retry = !permanent && row.attempts < (waiting ? STUDY_QUOTA_TRIES : STUDY_OTHER_TRIES);
    o.log(`study ${row.id}: failed (${msg.slice(0, 200)})`);
    await store.updateStudy(row.id, {
      status: retry ? "queued" : "failed",
      error: retry ? null : msg.slice(0, 500),
      status_message: retry
        ? waiting
          ? "Waiting to generate. The transcript is ready to read; notes will be added on their own."
          : "Waiting to generate — it will try again in a few minutes."
        : null,
      next_attempt_at: new Date(Date.now() + (e instanceof QuotaError ? 60 : 10) * 60_000).toISOString(),
      locked_by: null,
      locked_at: null,
    });
  }
}
