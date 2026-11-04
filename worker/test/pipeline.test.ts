/**
 * End-to-end test of the transcription pipeline with REAL ffmpeg (audio conversion, silence
 * detection, chunk extraction) and fake network services (speech-to-text, AI refinement, database).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { beforeAll, describe, expect, it } from "vitest";
import type { ClassRow, TranscriptDoc } from "@halaqa/shared";
import { createMedia, run } from "../src/media.ts";
import { processClass, type PipelineDeps } from "../src/pipeline.ts";
import type { RefineResult, Refiner } from "../src/refine.ts";
import type { ChunkRow, Store, TranscriptRecord } from "../src/store.ts";
import { SttError, type SttProvider } from "../src/stt/types.ts";
import type { ChunkPlan } from "../src/chunking.ts";
import type { RawSegment } from "../src/segmenting.ts";

const FF = ffmpegPath as unknown as string;
let tmp: string;
let sourceAudio: string;

// 70 s of audio: 8 s tone / 2 s silence, repeated. Pauses fall at 8–10, 18–20, …
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "halaqa-test-"));
  sourceAudio = path.join(tmp, "class.wav");
  const r = await run(FF, ["-y", "-f", "lavfi", "-i", "aevalsrc='if(lt(mod(t\\,10)\\,8)\\,0.5*sin(2*PI*440*t)\\,0)':s=16000:d=70", sourceAudio]);
  expect(r.code).toBe(0);
});

class MemoryStore implements Store {
  cls: ClassRow;
  chunks: ChunkRow[] = [];
  batches = new Map<number, RefineResult>();
  transcript: TranscriptRecord | null = null;
  updates: Record<string, unknown>[] = [];
  constructor(cls: ClassRow) {
    this.cls = cls;
  }
  async claimClass() {
    return null;
  }
  async claimStudy() {
    return null;
  }
  async getClass() {
    return this.cls;
  }
  async updateClass(_id: string, patch: Record<string, unknown>) {
    this.updates.push(patch);
    Object.assign(this.cls, patch);
  }
  async listChunks() {
    return this.chunks.map((c) => ({ ...c }));
  }
  async createChunks(_id: string, plan: ChunkPlan[]) {
    this.chunks = plan.map((p) => ({ idx: p.idx, start_s: p.start, end_s: p.end, segments: null, provider: null, done: false }));
  }
  async saveChunk(_id: string, idx: number, segments: RawSegment[], provider: string) {
    Object.assign(this.chunks[idx], { segments, provider, done: true });
  }
  async listRefineBatches() {
    return new Map(this.batches);
  }
  async saveRefineBatch(_id: string, idx: number, r: RefineResult) {
    this.batches.set(idx, r);
  }
  async saveTranscript(t: TranscriptRecord) {
    this.transcript = t;
  }
  async getTranscript(): Promise<TranscriptDoc | null> {
    return this.transcript?.doc ?? null;
  }
  async updateStudy() {}
  async downloadUpload(_p: string, dest: string) {
    await fs.copyFile(sourceAudio, dest);
  }
}

/** Fake STT: reports one sentence per tone burst, relative to the chunk, using the chunk's real duration. */
function fakeStt(media: ReturnType<typeof createMedia>, failChunkOnce?: number): SttProvider & { calls: string[] } {
  const calls: string[] = [];
  let failed = false;
  return {
    name: "fake-stt",
    calls,
    async transcribe(file) {
      const idx = Number(path.basename(file).match(/chunk-(\d+)/)![1]);
      if (idx === failChunkOnce && !failed) {
        failed = true;
        throw new SttError("simulated provider outage", false);
      }
      calls.push(path.basename(file));
      const dur = await media.duration(file);
      const segments = [];
      for (let t = 0.2; t < dur - 1; t += 10) {
        segments.push({ start: t, end: Math.min(t + 7, dur), text: `inna allaha ma'a as-sabireen chunk ${idx} at ${Math.round(t)}`, speaker: "speaker_0" });
      }
      return { segments };
    },
  };
}

/** Fake refiner: converts the transliteration to Arabic; also tries to sneak in an invented sentence once. */
const fakeRefiner: Refiner = {
  async refineBatch(batch) {
    return {
      segments: batch.map((s, i) => ({
        id: s.id,
        text:
          i === 1
            ? `${s.raw} And Allah also says, وَلَنَبْلُوَنَّكُم بِشَيْءٍ مِّنَ الْخَوْفِ وَالْجُوعِ وَنَقْصٍ مِّنَ الْأَمْوَالِ.` // must be rejected
            : s.raw.replace("inna allaha ma'a as-sabireen", "إِنَّ اللَّهَ مَعَ الصَّابِرِينَ"),
      })),
      paragraph_starts: [batch[0].id],
      headings: [{ id: batch[0].id, title: "Patience" }],
    };
  },
};

function makeRow(id: string): ClassRow {
  return {
    id,
    user_id: "u1",
    source_type: "upload",
    youtube_id: null,
    source_url: null,
    storage_path: "u1/class.wav",
    upload_fingerprint: "fp",
    title: "Test class",
    channel: null,
    thumbnail_url: null,
    class_date: null,
    duration_seconds: null,
    status: "processing",
    stage: "waiting",
    progress: 0,
    status_message: null,
    error: null,
    error_code: null,
    transcript_source: null,
    provider: null,
    attempts: 1,
    speaker_names: {},
    created_at: "",
    updated_at: "",
  };
}

describe("pipeline (real ffmpeg)", () => {
  it("chunks at pauses, survives a crash mid-way, resumes without re-transcribing, and guards refinement", async () => {
    const media = createMedia({ ffmpegPath: FF, ytdlpPath: "yt-dlp" });
    const store = new MemoryStore(makeRow("class-1"));
    const stt = fakeStt(media, 2);
    const deps: PipelineDeps = {
      store,
      media,
      stt,
      refiner: fakeRefiner,
      cfg: { chunkSeconds: 20, maxDurationHours: 12, maxAttempts: 5, workDir: path.join(tmp, "work"), refineConcurrency: 2 },
      log: () => {},
    };

    // Run 1: chunk 2 fails permanently at the provider -> job error, chunks 0-1 saved.
    await expect(processClass(store.cls, deps)).rejects.toMatchObject({ code: "STT_FAILED", permanent: false });
    expect(store.chunks.length).toBeGreaterThanOrEqual(3);
    // every cut lands inside a pause (between 8 and 10 s mod 10)
    for (const c of store.chunks.slice(1)) expect(c.start_s % 10).toBeGreaterThanOrEqual(7.9);
    expect(store.chunks.filter((c) => c.done).map((c) => c.idx)).toEqual([0, 1]);
    expect(store.cls.duration_seconds).toBe(70);

    // Run 2: resumes from chunk 2; chunks 0 and 1 are not sent to the provider again.
    const before = stt.calls.length;
    await processClass(store.cls, deps);
    const resumed = stt.calls.slice(before);
    expect(resumed).not.toContain("chunk-0.mp3");
    expect(resumed).not.toContain("chunk-1.mp3");
    expect(resumed[0]).toBe("chunk-2.mp3");

    expect(store.cls.status).toBe("completed");
    const doc = store.transcript!.doc;
    // Timestamps are absolute and increasing; every tone burst produced one segment.
    const starts = doc.segments.map((s) => s.start);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(doc.segments.length).toBe(7);
    expect(doc.segments.at(-1)!.start).toBeGreaterThan(59);
    // Arabic script conversion accepted; the invented verse rejected -> original kept.
    expect(doc.segments[0].text).toContain("إِنَّ اللَّهَ مَعَ الصَّابِرِينَ");
    expect(doc.segments.some((s) => s.text.includes("وَلَنَبْلُوَنَّكُم"))).toBe(false);
    expect(doc.segments.every((s) => s.raw.includes("inna allaha"))).toBe(true);
    expect(doc.sections.length).toBeGreaterThanOrEqual(1);
    expect(store.transcript!.search_text).toContain("ان الله مع الصابرين");
    // work directory cleaned up
    await expect(fs.access(path.join(tmp, "work", "class-1"))).rejects.toThrow();
  });

  it("falls back to YouTube captions when the audio download is blocked", async () => {
    const media = createMedia({ ffmpegPath: FF, ytdlpPath: "yt-dlp" });
    const row = { ...makeRow("class-2"), title: null, source_type: "youtube" as const, youtube_id: "dQw4w9WgXcQ", storage_path: null };
    const store = new MemoryStore(row);
    const { JobError } = await import("../src/errors.ts");
    const fakeMedia: PipelineDeps["media"] = {
      ...media,
      youtubeMetadata: async () => ({
        id: "dQw4w9WgXcQ",
        title: "Tafsir class",
        duration: 3600,
        uploadDate: "2026-10-01",
        channel: "Masjid",
        thumbnail: null,
        liveStatus: "was_live",
        language: "en",
        subtitles: {},
        automatic_captions: { "en-orig": [], ar: [] },
      }),
      downloadYouTubeAudio: async () => {
        throw new JobError("BOT_CHECK", "YouTube blocked the download.", true);
      },
      fetchCaptions: async (_u, _d, track) => {
        expect(track).toEqual({ lang: "en-orig", auto: true });
        return JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: "welcome to the class" }] }] });
      },
    };
    await processClass(row, { store, media: fakeMedia, stt: fakeStt(media), refiner: null, cfg: { chunkSeconds: 1200, maxDurationHours: 12, maxAttempts: 5, workDir: path.join(tmp, "work"), refineConcurrency: 1 }, log: () => {} });
    expect(store.cls.status).toBe("completed");
    expect(store.cls.transcript_source).toBe("youtube_auto_captions");
    expect(store.cls.title).toBe("Tafsir class");
    expect(store.cls.class_date).toBe("2026-10-01");
    expect(store.transcript!.doc.segments[0]).toMatchObject({ start: 1, text: "welcome to the class" });
  });

  it("gives a clear permanent error for private videos", async () => {
    const media = createMedia({ ffmpegPath: FF, ytdlpPath: "yt-dlp" });
    const row = { ...makeRow("class-3"), source_type: "youtube" as const, youtube_id: "dQw4w9WgXcQ", storage_path: null };
    const { classifyYtDlpError } = await import("../src/errors.ts");
    const fakeMedia: PipelineDeps["media"] = {
      ...media,
      youtubeMetadata: async () => {
        throw classifyYtDlpError("ERROR: [youtube] dQw4w9WgXcQ: Private video");
      },
    };
    await expect(
      processClass(row, { store: new MemoryStore(row), media: fakeMedia, stt: fakeStt(media), refiner: null, cfg: { chunkSeconds: 1200, maxDurationHours: 12, maxAttempts: 5, workDir: path.join(tmp, "work"), refineConcurrency: 1 }, log: () => {} }),
    ).rejects.toMatchObject({ code: "PRIVATE", permanent: true });
  });
});
