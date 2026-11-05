/**
 * Cloud path (runs inside a Netlify Background Function): public YouTube lectures are transcribed by Gemini
 * window by window, so neither the home computer nor the iPad needs to be on. Each finished window is saved
 * at once (resumable); Google "busy"/quota errors wait and retry later instead of giving up.
 */
import type { ClassRow } from "@halaqa/shared";
import { JobError } from "./errors.ts";
import { GEMINI_YT_MODELS, GeminiError, geminiYouTubeWindow, youTubeInfo } from "./gemini.ts";
import { createLlm, QuotaError } from "./llm.ts";
import { finishTranscript } from "./pipeline.ts";
import { sleep } from "./retry.ts";
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
/** Waits inside one run between tries; the model alternates each try (3.8 Flash ↔ 3.5 Flash). */
const TRY_WAIT_S = [20, 60, 120];
/** If a run still can't get through, the job waits this long (minutes) before the next run. */
const LATER_MIN = [2, 5, 15, 30, 60];
const GIVE_UP_AFTER = 30; // ≈ a day of hourly retries
const SAFETY_MS = 4 * 60_000; // one window + retries must fit before the 15-minute limit

const nowIso = () => new Date().toISOString();

/** Process cloud jobs until there are none or time runs out. "more" = call again to continue. */
export async function runCloud(o: CloudOpts): Promise<"idle" | "more"> {
  while (Date.now() < o.deadline - SAFETY_MS) {
    const row = await o.store.claimClass(o.workerId);
    if (row) {
      if ((await cloudClass(row, o)) === "more") return "more";
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
      const W = o.windowSeconds;
      // Gemini returns an EMPTY answer if the clip ends at/after the video's real end (YouTube rounds the
      // listed length up), so the last window stops 3 s early — measured on the 1-hour test lecture.
      const usable = Math.max(1, info.duration - 3);
      const plan = [];
      for (let s = 0, i = 0; s < usable; s += W, i++) plan.push({ idx: i, start: s, end: Math.min(usable, s + W) });
      // Fold a tiny tail (< 2 min) into the previous window.
      if (plan.length > 1 && plan[plan.length - 1].end - plan[plan.length - 1].start < 120) plan[plan.length - 2].end = plan.pop()!.end;
      await store.createChunks(row.id, plan);
      chunks = await store.listChunks(row.id);
    }

    const total = chunks.length;
    let done = chunks.filter((c) => c.done).length;
    for (const c of chunks) {
      if (c.done) continue;
      if (Date.now() > o.deadline - SAFETY_MS) {
        await release({ status_message: `Transcribing… ${done} of ${total} parts done.` });
        return "more";
      }
      await report("transcribing", 0.05 + (0.9 * done) / total, total > 1 ? `Transcribing part ${done + 1} of ${total}…` : "Transcribing…");
      const { segments, model } = await windowWithRetries(row, c.start_s, c.end_s, o, log);
      await store.saveChunk(row.id, c.idx, segments, `gemini:${model}`);
      c.segments = segments;
      c.provider = `gemini:${model}`;
      c.done = true;
      done++;
      if (failures) await store.updateClass(row.id, { cloud_failures: 0 });
    }

    const raw = chunks.flatMap((c) => c.segments ?? []);
    const provider = [...new Set(chunks.map((c) => c.provider).filter(Boolean))].join(",") || "gemini";
    // Gemini's text already has punctuation and Arabic script, so no extra AI polish pass.
    await finishTranscript(row, raw, "ai", provider, {
      store,
      refiner: null,
      refineConcurrency: 1,
      log,
      report: (s, p, m) => report(s, p, m),
    });
    log("completed");
    return "done";
  } catch (e) {
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
        error: "Google's free transcription service kept refusing for about a day. Press “Try again” to restart.",
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
        ? "Today's free transcription allowance is used up. It will continue automatically (checking every hour) — nothing to do."
        : `Google's free service is busy. Finished parts are saved; it will continue automatically in ${mins} minute${mins > 1 ? "s" : ""}.`,
    });
    return "done";
  }
}

/** One window: alternate models, bounded exponential waits, keep the job's lock fresh while waiting. */
async function windowWithRetries(row: ClassRow, start: number, end: number, o: CloudOpts, log: (m: string) => void) {
  const models = GEMINI_YT_MODELS;
  for (let i = 0; ; i++) {
    const model = models[i % models.length];
    const t = Date.now();
    try {
      const segments = await geminiYouTubeWindow(o.apiKey, model, row.youtube_id!, start, end);
      log(`window ${start}-${end}s: ${model} ${((Date.now() - t) / 1000).toFixed(1)}s, ${segments.length} lines`);
      return { segments, model };
    } catch (e) {
      const ge = e as GeminiError;
      const wait = TRY_WAIT_S[i];
      log(`window ${start}-${end}s: ${ge.message.slice(0, 200)}`);
      if (!(e instanceof GeminiError) || !ge.retryable || ge.perDay || wait === undefined || Date.now() + wait * 1000 > o.deadline - SAFETY_MS / 2) throw e;
      await o.store.updateClass(row.id, { locked_at: nowIso() });
      await sleep(wait * 1000 * (0.8 + Math.random() * 0.4));
    }
  }
}

/** Study notes in the cloud too (same code as the home worker), so they work with the PC off. */
async function cloudStudy(row: StudyRow, o: CloudOpts) {
  const { store } = o;
  const llm = createLlm({
    llmProvider: "gemini",
    geminiApiKey: o.apiKey,
    geminiModel: process.env.GEMINI_MODEL || "gemini-flash-latest",
    anthropicApiKey: "",
    claudeModel: "",
    refineEffort: "low",
    groqApiKey: "",
    groqLlmModel: "",
    githubModelsToken: "",
    githubModelsModel: "",
  })!;
  try {
    const [cls, doc] = await Promise.all([store.getClass(row.class_id), store.getTranscript(row.class_id)]);
    if (!cls || !doc) throw new Error("The transcript isn't ready yet.");
    if (cls.ai_opt_out) throw Object.assign(new Error("This lecture is marked private, so study notes (which use an online AI service) are turned off for it."), { permanent: true });
    const { content, data } = await generateStudy(llm, row.kind, cls.title ?? "Class", cls.id, doc, cls.speaker_names ?? {});
    await store.updateStudy(row.id, { status: "completed", content, data, error: null, locked_by: null, locked_at: null });
  } catch (e) {
    const quota = e instanceof QuotaError;
    const permanent = !!(e as { permanent?: boolean }).permanent;
    const retry = !permanent && row.attempts < (quota ? 10 : 3);
    o.log(`study ${row.id}: failed (${(e as Error).message.slice(0, 200)})`);
    await store.updateStudy(row.id, {
      status: retry ? "queued" : "failed",
      error: retry ? null : (e as Error).message.slice(0, 500),
      status_message: retry ? (quota ? "The free AI quota is used up for now. It will try again automatically." : (e as Error).message.slice(0, 300)) : null,
      next_attempt_at: new Date(Date.now() + (quota ? 60 : 2) * 60_000).toISOString(),
      locked_by: null,
      locked_at: null,
    });
  }
}
