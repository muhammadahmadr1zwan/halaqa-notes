import fs from "node:fs/promises";
import path from "node:path";
import {
  heuristicParagraphs,
  normalizeForSearch,
  youTubeWatchUrl,
  type ClassRow,
  type Section,
  type Segment,
  type TranscriptSource,
} from "@halaqa/shared";
import { parseJson3, pickCaptionTrack } from "./captions.ts";
import { planChunks } from "./chunking.ts";
import { CAPTION_FALLBACK_CODES, JobError, toJobError, UPLOAD_HINT } from "./errors.ts";
import type { Media } from "./media.ts";
import { LlmError, QuotaError } from "./llm.ts";
import { applyRefinement, makeBatches, type Refiner, type RefineResult } from "./refine.ts";
import { mapPool, withRetry } from "./retry.ts";
import { mapSpeakersDominant, offsetSegments, type RawSegment } from "./segmenting.ts";
import type { Store } from "./store.ts";
import { SttError, type SttProvider } from "./stt/types.ts";

export interface PipelineDeps {
  store: Store;
  media: Pick<Media, "youtubeMetadata" | "downloadYouTubeAudio" | "fetchCaptions" | "normalizeAudio" | "duration" | "detectSilences" | "extractChunk">;
  stt: SttProvider;
  refiner: Refiner | null;
  cfg: { chunkSeconds: number; maxDurationHours: number; maxAttempts: number; workDir: string; refineConcurrency: number };
  log: (msg: string) => void;
}

const MIN_HEADING_GAP = 180; // seconds

/** Run (or resume) the full transcription of one class. Throws JobError on failure. */
export async function processClass(row: ClassRow, d: PipelineDeps): Promise<void> {
  const { store, media, stt, cfg, log } = d;
  const dir = path.join(cfg.workDir, row.id);
  await fs.mkdir(dir, { recursive: true });
  const maxSeconds = cfg.maxDurationHours * 3600;

  let lastReport = 0;
  const report = async (stage: string, progress: number, message: string, force = true) => {
    const now = Date.now();
    if (!force && now - lastReport < 10_000) return;
    lastReport = now;
    await store.updateClass(row.id, { stage, progress: Math.min(0.99, progress), status_message: message, locked_at: new Date().toISOString() });
  };

  let raw: RawSegment[] | null = null;
  let source: TranscriptSource = "ai";
  let provider = stt.name;
  let srcFile: string | null = null;

  // 1) Get the audio (or, if YouTube blocks the audio, its captions).
  if (row.source_type === "youtube") {
    const url = row.source_url || youTubeWatchUrl(row.youtube_id!);
    await report("fetching", 0.01, "Looking up the video…");
    const meta = await media.youtubeMetadata(url);
    if (meta.liveStatus === "is_live" || meta.liveStatus === "is_upcoming") {
      throw new JobError("NOT_STARTED", "This class is still live (or hasn't started). Try again after the stream ends.", true);
    }
    if (meta.duration && meta.duration > maxSeconds) {
      throw new JobError("TOO_LONG", `This video is longer than the ${cfg.maxDurationHours}-hour limit.`, true);
    }
    await store.updateClass(row.id, {
      title: row.title || meta.title,
      channel: meta.channel,
      thumbnail_url: meta.thumbnail,
      class_date: row.class_date || meta.uploadDate,
      duration_seconds: meta.duration ? Math.round(meta.duration) : null,
    });
    try {
      await report("fetching", 0.02, "Downloading the audio…");
      srcFile = await media.downloadYouTubeAudio(url, dir, (pct) => void report("fetching", 0.02 + 0.06 * pct, `Downloading the audio… ${Math.round(pct * 100)}%`, false));
    } catch (e) {
      const je = toJobError(e);
      if (!CAPTION_FALLBACK_CODES.has(je.code)) throw je;
      // Transient download problems get the normal retries before we settle for captions.
      if (!je.permanent && row.attempts < cfg.maxAttempts) throw je;
      log(`audio unavailable (${je.code}); trying YouTube captions`);
      const track = pickCaptionTrack(meta);
      const content = track ? await media.fetchCaptions(url, dir, track).catch(() => null) : null;
      const segs = content ? parseJson3(content) : [];
      if (!track || !segs.length) {
        throw new JobError(je.code, `${je.message} This video also has no captions we could use. ${UPLOAD_HINT}`, true, je.detail);
      }
      raw = segs;
      source = track.auto ? "youtube_auto_captions" : "youtube_captions";
      provider = `youtube-captions:${track.lang}`;
    }
  } else {
    if (!row.storage_path) throw new JobError("NO_FILE", "The uploaded file is missing. Please upload it again.", true);
    srcFile = path.join(dir, "upload" + (path.extname(row.storage_path) || ".bin"));
    const have = await fs.stat(srcFile).then((s) => s.size > 0, () => false);
    if (!have) {
      await report("fetching", 0.02, "Preparing your recording…");
      await store.downloadUpload(row.storage_path, srcFile);
    }
  }

  // 2) Transcribe in resumable chunks.
  if (!raw) {
    await report("fetching", 0.08, "Preparing the audio…");
    const audio = await media.normalizeAudio(srcFile!, path.join(dir, "audio.mp3"));
    const duration = await media.duration(audio);
    if (duration > maxSeconds) throw new JobError("TOO_LONG", `This recording is longer than the ${cfg.maxDurationHours}-hour limit.`, true);
    await store.updateClass(row.id, { duration_seconds: Math.round(duration) });

    let chunks = await store.listChunks(row.id);
    if (!chunks.length) {
      await report("fetching", 0.09, "Finding natural pauses to split the recording…");
      const plan = planChunks(duration, await media.detectSilences(audio), cfg.chunkSeconds);
      await store.createChunks(row.id, plan);
      chunks = await store.listChunks(row.id);
    }
    const total = chunks.length;
    let done = chunks.filter((c) => c.done).length;
    for (const c of chunks) {
      if (c.done) continue;
      await report("transcribing", 0.1 + (0.7 * done) / total, total > 1 ? `Transcribing part ${done + 1} of ${total}…` : "Transcribing…");
      const file = await media.extractChunk(audio, c.start_s, c.end_s, path.join(dir, `chunk-${c.idx}.mp3`));
      let result;
      try {
        result = await withRetry(() => stt.transcribe(file), {
          attempts: 4,
          isRetryable: (e) => !(e instanceof SttError) || e.retryable,
          onRetry: (e, i, ms) => log(`chunk ${c.idx}: attempt ${i} failed (${(e as Error).message}); retrying in ${Math.round(ms / 1000)}s`),
        });
      } catch (e) {
        throw new JobError("STT_FAILED", "The transcription service had a problem. We'll retry automatically.", false, (e as Error).message);
      }
      const segs = offsetSegments(mapSpeakersDominant(result.segments), c.start_s);
      await store.saveChunk(row.id, c.idx, segs, stt.name);
      c.segments = segs;
      c.done = true;
      done++;
      await fs.rm(file, { force: true });
    }
    raw = chunks.flatMap((c) => c.segments ?? []);
  }

  if (!raw.some((s) => s.text.trim())) throw new JobError("NO_SPEECH", "We couldn't hear any speech in this recording.", true);

  // 3) Refine with AI (punctuation, Arabic script, paragraphs, headings), guarded against hallucination.
  let segments: Segment[] = heuristicParagraphs(
    [...raw].sort((a, b) => a.start - b.start).map((s, i) => ({ id: i, start: s.start, end: s.end, speaker: s.speaker, text: s.text, raw: s.text })),
  );
  let sections: Section[] = [];
  if (d.refiner) {
    const refiner = d.refiner;
    await report("refining", 0.8, "Adding punctuation, paragraphs and Arabic script…");
    const batches = makeBatches(segments, refiner.batchWords);
    let quotaHit = false;
    const saved = await store.listRefineBatches(row.id);
    let finished = saved.size;
    const results = await mapPool(batches, cfg.refineConcurrency, async (batch, i): Promise<RefineResult | null> => {
      const cached = saved.get(i);
      // Ignore a cached result if the batch boundaries changed (e.g. a different chunk plan).
      if (cached && cached.segments.some((s) => s.id === batch[0].id)) return cached;
      if (quotaHit) return null;
      try {
        const r = await withRetry(() => refiner.refineBatch(batch, batches[i - 1]?.slice(-3) ?? []), {
          attempts: 3,
          baseMs: 5000,
          isRetryable: (e) => !(e instanceof LlmError) || e.retryable,
        });
        await store.saveRefineBatch(row.id, i, r);
        return r;
      } catch (e) {
        if (e instanceof QuotaError) quotaHit = true;
        log(`refine batch ${i} failed, keeping the original wording: ${(e as Error).message}`);
        return null;
      } finally {
        finished++;
        await report("refining", 0.8 + (0.17 * Math.min(finished, batches.length)) / batches.length, `Polishing the transcript (${Math.min(finished, batches.length)} of ${batches.length})…`, false);
      }
    });
    const stats = { accepted: 0, rejected: 0, missing: 0 };
    const merged = batches.map((b, i) => applyRefinement(b, results[i], stats));
    segments = merged.flatMap((m) => m.segments);
    sections = spaceHeadings(merged.flatMap((m) => m.sections), segments);
    log(`refinement: ${stats.accepted} edited, ${stats.rejected} kept original (guard), ${stats.missing} missing`);
  }

  // 4) Save.
  await report("finishing", 0.98, "Saving…");
  const plain = segments.map((s) => s.text).join(" ");
  await store.saveTranscript({
    class_id: row.id,
    doc: { segments, sections },
    plain_text: plain,
    search_text: normalizeForSearch(plain),
    word_count: plain.split(/\s+/).filter(Boolean).length,
  });
  await store.updateClass(row.id, {
    status: "completed",
    stage: "done",
    progress: 1,
    status_message: null,
    error: null,
    error_code: null,
    transcript_source: source,
    provider,
    locked_by: null,
    locked_at: null,
    completed_at: new Date().toISOString(),
  });
  await fs.rm(dir, { recursive: true, force: true });
}

/** Drop headings that come too soon after the previous one. */
function spaceHeadings(sections: Section[], segments: Segment[]): Section[] {
  const startOf = new Map(segments.map((s) => [s.id, s.start]));
  const out: Section[] = [];
  let last = -Infinity;
  for (const s of [...sections].sort((a, b) => a.segmentId - b.segmentId)) {
    const t = startOf.get(s.segmentId) ?? 0;
    if (t - last < MIN_HEADING_GAP && out.length) continue;
    out.push(s);
    last = t;
  }
  return out;
}
