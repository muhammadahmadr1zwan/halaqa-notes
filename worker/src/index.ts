import fs from "node:fs/promises";
import path from "node:path";
import type { ClassRow } from "@halaqa/shared";
import { loadConfig } from "./config.ts";
import { RefusalError } from "./claude.ts";
import { toJobError } from "./errors.ts";
import { createLlm, QuotaError } from "./llm.ts";
import { createMedia } from "./media.ts";
import { processClass } from "./pipeline.ts";
import { llmRefiner } from "./refine.ts";
import { sleep } from "./retry.ts";
import { HttpStore, type StudyRow } from "./store.ts";
import { generateStudy } from "./study.ts";
import { createSttProvider } from "./stt/index.ts";

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../../.env"));
} catch {}

const cfg = loadConfig();
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

await fs.mkdir(cfg.workDir, { recursive: true });
let cookiesFile: string | null = null;
if (cfg.ytdlpCookiesB64) {
  cookiesFile = path.join(cfg.workDir, "cookies.txt");
  await fs.writeFile(cookiesFile, Buffer.from(cfg.ytdlpCookiesB64, "base64"));
}

let ffmpegPath = cfg.ffmpegPath;
if (!ffmpegPath) {
  try {
    ffmpegPath = ((await import("ffmpeg-static")).default as unknown as string) || "ffmpeg";
  } catch {
    ffmpegPath = "ffmpeg";
  }
}

const store = new HttpStore(cfg.apiUrl, cfg.workerSecret);
const media = createMedia({ ffmpegPath, ytdlpPath: cfg.ytdlpPath, cookiesFile, proxy: cfg.ytdlpProxy || null });
const stt = createSttProvider(cfg);
const llm = createLlm(cfg);
const refiner = llm ? llmRefiner(llm) : null;
if (!llm) log("No AI text model configured (set GEMINI_API_KEY or GROQ_API_KEY, both free): transcripts are saved without AI polish and study notes are disabled.");

let current: { kind: "class" | "study"; id: string } | null = null;
let stopping = false;

// Heartbeat so a crashed worker's job is picked up again (locks older than 10 min are stale).
setInterval(() => {
  if (!current) return;
  const at = { locked_at: new Date().toISOString() };
  void (current.kind === "class" ? store.updateClass(current.id, at) : store.updateStudy(current.id, at)).catch(() => {});
}, 60_000).unref();

async function shutdown() {
  if (stopping) return;
  stopping = true;
  log("shutting down; releasing current job so it resumes next time");
  const release = { status: "queued", locked_by: null, locked_at: null };
  if (current) await (current.kind === "class" ? store.updateClass(current.id, release) : store.updateStudy(current.id, release)).catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

/** Backoff before an automatic retry: 1, 5, 15, 30, 60 minutes. */
const retryDelayMinutes = (attempts: number) => [1, 5, 15, 30, 60][Math.min(attempts - 1, 4)];

async function runClass(row: ClassRow) {
  log(`class ${row.id}: start (attempt ${row.attempts}, ${row.source_type})`);
  const started = Date.now();
  try {
    await processClass(row, { store, media, stt, refiner, cfg, log: (m) => log(`class ${row.id}: ${m}`) });
    log(`class ${row.id}: completed in ${Math.round((Date.now() - started) / 60000)} min`);
  } catch (e) {
    const je = toJobError(e);
    log(`class ${row.id}: ${je.code} ${je.message} ${je.detail ?? ""}`);
    const willRetry = !je.permanent && row.attempts < cfg.maxAttempts;
    const base = je.message.replace(/ We'll retry automatically\.?/, "");
    if (willRetry) {
      const mins = retryDelayMinutes(row.attempts);
      await store.updateClass(row.id, {
        status: "queued",
        stage: "waiting",
        status_message: `${base} Retrying automatically in ${mins} minute${mins > 1 ? "s" : ""}.`,
        next_attempt_at: new Date(Date.now() + mins * 60_000).toISOString(),
        locked_by: null,
        locked_at: null,
      });
    } else {
      await store.updateClass(row.id, {
        status: "failed",
        error: je.permanent ? je.message : `${base} We tried ${row.attempts} times. Press “Try again” to retry.`,
        error_code: je.code,
        status_message: null,
        locked_by: null,
        locked_at: null,
      });
      if (je.permanent) await fs.rm(path.join(cfg.workDir, row.id), { recursive: true, force: true });
    }
  }
}

async function runStudy(row: StudyRow) {
  log(`study ${row.id}`);
  try {
    if (!llm) throw new Error("AI study notes aren't set up yet. Add a free GEMINI_API_KEY or GROQ_API_KEY to the worker settings.");
    const [cls, doc] = await Promise.all([store.getClass(row.class_id), store.getTranscript(row.class_id)]);
    if (!cls || !doc) throw new Error("The transcript isn't ready yet.");
    const { content, data } = await generateStudy(llm, row.kind, cls.title ?? "Class", cls.id, doc, cls.speaker_names ?? {});
    await store.updateStudy(row.id, { status: "completed", content, data, error: null, locked_by: null, locked_at: null });
  } catch (e) {
    const quota = e instanceof QuotaError;
    const msg = e instanceof RefusalError ? "The AI declined to generate this." : quota ? "The free AI quota is used up for today. It will try again automatically later." : (e as Error).message;
    const retry = (quota || !(e instanceof RefusalError)) && row.attempts < (quota ? 10 : 3) && !!llm;
    log(`study ${row.id}: failed (${(e as Error).message.slice(0, 300)})`);
    await store.updateStudy(row.id, {
      status: retry ? "queued" : "failed",
      error: retry ? null : msg.slice(0, 500),
      status_message: retry ? msg : null,
      next_attempt_at: new Date(Date.now() + (quota ? 60 : 2) * 60_000).toISOString(),
      locked_by: null,
      locked_at: null,
    });
  }
}

log(`worker ${cfg.workerId} started — site ${cfg.apiUrl}, speech-to-text ${stt.name}, AI ${llm?.name ?? "off"}`);
while (!stopping) {
  try {
    const cls = await store.claimClass(cfg.workerId);
    if (cls) {
      current = { kind: "class", id: cls.id };
      await runClass(cls);
      current = null;
      continue;
    }
    const study = await store.claimStudy(cfg.workerId);
    if (study) {
      current = { kind: "study", id: study.id };
      await runStudy(study);
      current = null;
      continue;
    }
  } catch (e) {
    current = null;
    log(`loop error: ${(e as Error).message}`);
  }
  await sleep(cfg.pollSeconds * 1000);
}
