/** Cloud runner with a fake Google/YouTube (no network): exact end, busy handling without sleeping, resume, study waiting. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClassRow, TranscriptDoc } from "@halaqa/shared";
import { planWindows, runCloud } from "../src/cloud.ts";
import type { ChunkPlan } from "../src/chunking.ts";
import type { RawSegment } from "../src/segmenting.ts";
import type { ChunkRow, Store, StudyRow, TranscriptRecord } from "../src/store.ts";

class MemStore implements Store {
  chunks: ChunkRow[] = [];
  transcript: TranscriptRecord | null = null;
  study: Record<string, unknown> = {};
  queue: ClassRow[];
  studies: StudyRow[];
  lostLock = false;
  constructor(public cls: ClassRow, studies: StudyRow[] = []) {
    this.queue = [cls];
    this.studies = studies;
  }
  async claimClass() {
    return this.queue.shift() ?? null;
  }
  async claimStudy() {
    return this.studies.shift() ?? null;
  }
  async getClass() {
    return this.cls;
  }
  async updateClass(_id: string, patch: Record<string, unknown>) {
    Object.assign(this.cls, patch);
  }
  async listChunks() {
    return this.chunks.map((c) => ({ ...c }));
  }
  async createChunks(_id: string, plan: ChunkPlan[]) {
    this.chunks = plan.map((p) => ({ idx: p.idx, start_s: p.start, end_s: p.end, segments: null, provider: null, done: false }));
  }
  async saveChunk(_id: string, idx: number, segments: RawSegment[], provider: string) {
    if (this.lostLock) throw new Error("API PUT /classes/x/chunks/0: 409 This lecture is no longer assigned to this run.");
    Object.assign(this.chunks[idx], { segments, provider, done: true });
  }
  async listRefineBatches() {
    return new Map();
  }
  async saveRefineBatch() {}
  async saveTranscript(t: TranscriptRecord) {
    this.transcript = t;
  }
  async getTranscript(): Promise<TranscriptDoc | null> {
    return this.transcript?.doc ?? null;
  }
  async updateStudy(_id: string, patch: Record<string, unknown>) {
    Object.assign(this.study, patch);
  }
  async downloadUpload() {}
}

const cls = (): ClassRow => ({ id: "c1", youtube_id: "CEavXmACmiU", title: null, status: "processing", attempts: 1, engine: "cloud" }) as unknown as ClassRow;
const ok = (text: string) => new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }] }));
const busy = () => new Response(JSON.stringify({ error: { message: "This model is currently experiencing high demand." } }), { status: 503 });
const words = (n: number, at = "00:05") => `[${at}] ` + Array.from({ length: n }, (_, i) => (i % 3 ? "word" : "الله")).join(" ") + "\n[16:00] and the lesson continues";
/** An answer that stops 4 minutes into the window (seen for real). */
const early = () => ok("[00:05] " + "word ".repeat(40) + "\n[03:58] then it just stops");

/** Fake network. `gemini` decides each Gemini answer from (call number, end_offset). Concurrent windows interleave
 * their calls, so a test that cares which WINDOW got which answer should key off `start`, not the call number. */
function fakeNet(gemini: (n: number, end: string, start?: string, model?: string) => Response) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
    if (url.includes("oembed")) return new Response(JSON.stringify({ title: "Tafsir", author_name: "Masjid" }));
    if (url.includes("youtube.com/watch")) return new Response('"lengthSeconds":"3643" "approxDurationMs":"3642792" "approxDurationMs":"3642566"');
    if (url.includes("generateContent")) {
      const vm = JSON.parse(init!.body!).contents[0].parts[0].video_metadata;
      calls.push(vm.end_offset as string);
      return gemini(calls.length, vm.end_offset, vm.start_offset, url.match(/models\/([^:]+):/)?.[1]);
    }
    if (url.includes("chat/completions")) return new Response("{}", { status: 429, headers: { "retry-after": "3600" } });
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}
const opts = (store: Store) => ({ store, apiKey: "k", workerId: "cloud-1", deadline: Date.now() + 14 * 60_000, windowSeconds: 1200, log: () => {} });

afterEach(() => vi.unstubAllGlobals());

describe("cloud runner", () => {
  it("plans contiguous windows to the exact end, folding a short tail", () => {
    expect(planWindows(3642.316, 1200).map((w) => [w.start, w.end])).toEqual([[0, 1200], [1200, 2400], [2400, 3642.316]]);
    expect(planWindows(2460, 1200).map((w) => [w.start, w.end])).toEqual([[0, 1200], [1200, 2460]]);
  });

  it("reads to the video's exact end; an empty last answer steps back 1 s instead of dropping seconds up front", async () => {
    const calls = fakeNet((_n, end) => (end === "3642.316s" ? ok("") : ok(words(60) + "\n[19:00] closing dua وصلى الله على نبينا محمد")));
    const store = new MemStore(cls());
    expect(await runCloud(opts(store))).toBe("idle");
    expect(calls).toEqual(["1200s", "2400s", "3642.316s", "3641.316s"]);
    expect(store.cls.status).toBe("completed");
    const segs = store.transcript!.doc.segments;
    expect(segs.at(-1)!.text).toContain("وصلى الله على نبينا محمد");
    expect(segs.every((s, i) => i === 0 || s.start >= segs[i - 1].start)).toBe(true); // in order, no repeated window
  });

  it("when both models are busy: no sleeping, finished parts kept, retry time saved; the next run resumes without redoing parts", async () => {
    // Window 1 succeeds, then both models are busy for window 2.
    fakeNet((n) => (n === 1 ? ok(words(60)) : busy()));
    const store = new MemStore(cls());
    const t = Date.now();
    await runCloud(opts(store));
    expect(Date.now() - t).toBeLessThan(2000); // ended at once instead of waiting minutes on paid compute
    expect(store.cls).toMatchObject({ status: "queued", locked_by: null, cloud_failures: 1 });
    expect(Date.parse((store.cls as unknown as { next_attempt_at: string }).next_attempt_at) - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(store.cls.status_message).toMatch(/1 of 3 parts are saved/);
    expect(store.chunks.filter((c) => c.done).map((c) => c.idx)).toEqual([0]);

    // Scheduled restart: only parts 2 and 3 are sent to Gemini.
    const calls = fakeNet(() => ok(words(60)));
    store.queue = [store.cls];
    await runCloud(opts(store));
    expect(calls).toEqual(["2400s", "3642.316s"]);
    expect(store.cls).toMatchObject({ status: "completed", cloud_failures: 0 });
  });

  it("runs windows 2 at a time: a window that fails doesn't block the other window in its batch from saving", async () => {
    // 4 windows (short windowSeconds): batch 1 = [0,1] both succeed; batch 2 = [2,3] — 2 stays busy, 3 succeeds.
    // Sequential processing could never reach window 3 after window 2 fails — only concurrency does.
    fakeNet((_n, _end, start) => (start === "2000s" ? busy() : ok(words(60)))); // window 2 (starts at 2000s) stays busy
    const store = new MemStore(cls());
    await runCloud({ ...opts(store), windowSeconds: 1000 });
    expect(store.chunks.map((c) => c.start_s)).toEqual([0, 1000, 2000, 3000]);
    expect(store.chunks.filter((c) => c.done).map((c) => c.idx)).toEqual([0, 1, 3]); // 3 saved despite 2 failing alongside it
    expect(store.cls).toMatchObject({ status: "queued", cloud_failures: 1 });
    expect(store.cls.status_message).toMatch(/3 of 4 parts are saved/);
  });

  it("a window answer that stops early is checked with the other model, and the complete one is kept", async () => {
    fakeNet((_n, _e, start, model) => (start === "1200s" && model === "gemini-3.8-flash" ? early() : ok(words(60))));
    const store = new MemStore(cls());
    await runCloud(opts(store));
    expect(store.cls.status).toBe("completed");
    expect(store.chunks[1].provider).toBe("gemini:gemini-3.5-flash");
  });

  it("the last window is not exempt: one early stop is retried, and a complete re-check is kept", async () => {
    fakeNet((_n, _e, start, model) => {
      if (start !== "2400s") return ok(words(60));
      return model === "gemini-3.8-flash" ? early() : ok(words(60) + "\n[19:00] closing dua وصلى الله على نبينا محمد");
    });
    const store = new MemStore(cls());
    await runCloud(opts(store));
    expect(store.cls.status).toBe("completed");
    expect(store.chunks[2].provider).toBe("gemini:gemini-3.5-flash");
    expect(store.transcript!.doc.segments.at(-1)!.text).toContain("وصلى الله على نبينا محمد");

    fakeNet((_n, _e, start, model) => (start !== "2400s" ? ok(words(60)) : model === "gemini-3.8-flash" ? early() : busy()));
    const again = new MemStore(cls());
    await runCloud(opts(again));
    expect(again.chunks.find((c) => c.idx === 2)!.done).toBe(false);
    expect(again.cls).toMatchObject({ status: "queued", cloud_failures: 1 });
  });

  it("one early-stopping answer is never saved as done: the window is retried later", async () => {
    fakeNet((_n, _e, start, model) => (start !== "1200s" ? ok(words(60)) : model === "gemini-3.8-flash" ? early() : busy()));
    const store = new MemStore(cls());
    await runCloud(opts(store));
    expect(store.chunks.find((c) => c.idx === 1)!.done).toBe(false);
    expect(store.cls).toMatchObject({ status: "queued", cloud_failures: 1 });
  });

  it("two models stopping early is not treated as silence: the rest of that window is retried smaller", async () => {
    const calls = fakeNet((_n, _e, start) => (start === "1200s" ? early() : ok(words(60))));
    const store = new MemStore(cls());
    await runCloud(opts(store));
    expect(store.cls.status).toBe("completed");
    const text = (store.chunks[1].segments ?? []).map((s) => s.text).join(" ");
    expect(text).toContain("then it just stops");
    expect(text).toContain("and the lesson continues");
    expect(calls.filter((c) => c === "2400s").length).toBeGreaterThan(2);
  });

  it("a tail that is still short after smaller retries is flagged instead of saved as silence", async () => {
    fakeNet((_n, _e, start) => {
      const at = Number(String(start).replace("s", ""));
      return at >= 1200 && at < 2400 ? early() : ok(words(60));
    });
    const store = new MemStore(cls());
    await runCloud(opts(store));
    expect(store.cls.status).toBe("completed");
    const text = (store.chunks[1].segments ?? []).map((s) => s.text).join(" ");
    expect(text).toContain("[unclear — this part of the lecture was not fully captured]");
  });

  it("a run that lost its lock stops without touching the lecture", async () => {
    fakeNet(() => ok(words(60)));
    const store = new MemStore(cls());
    store.lostLock = true;
    await runCloud(opts(store));
    expect(store.cls.status).toBe("processing"); // not released or failed by the stale run
    expect((store.cls as unknown as { locked_by?: string }).locked_by).toBeUndefined();
  });

  it("study notes out of quota: marked 'Waiting to generate', transcript untouched, retried later", async () => {
    fakeNet(() => ok(""));
    const store = new MemStore(cls(), [{ id: "c1:summary", class_id: "c1", kind: "summary", attempts: 1 } as unknown as StudyRow]);
    store.queue = [];
    store.transcript = { class_id: "c1", doc: { segments: [{ id: 0, start: 0, end: 5, text: "In the name of Allah", speaker: "S1" }], sections: [] } } as unknown as TranscriptRecord;
    await runCloud(opts(store));
    expect(store.study).toMatchObject({ status: "queued", error: null });
    expect(String(store.study.status_message)).toMatch(/^Waiting to generate/);
    expect(String(store.study.status_message)).toMatch(/transcript is ready/);
    expect(Date.parse(String(store.study.next_attempt_at)) - Date.now()).toBeGreaterThan(50 * 60_000);
    expect(store.transcript!.doc.segments).toHaveLength(1);
  });
});
