import fs from "node:fs/promises";
import type { ClassRow, StudyKind, TranscriptDoc } from "@halaqa/shared";
import type { ChunkPlan } from "./chunking.ts";
import type { RefineResult } from "./refine.ts";
import type { RawSegment } from "./segmenting.ts";

export interface ChunkRow {
  idx: number;
  start_s: number;
  end_s: number;
  segments: RawSegment[] | null;
  provider: string | null;
  done: boolean;
}

export interface StudyRow {
  id: string; // "<classId>:<kind>"
  class_id: string;
  kind: StudyKind;
  status: string;
  attempts: number;
}

export interface TranscriptRecord {
  class_id: string;
  doc: TranscriptDoc;
  plain_text: string;
  search_text: string;
  word_count: number;
}

export interface Store {
  claimClass(workerId: string): Promise<ClassRow | null>;
  claimStudy(workerId: string): Promise<StudyRow | null>;
  getClass(id: string): Promise<ClassRow | null>;
  updateClass(id: string, patch: Record<string, unknown>): Promise<void>;
  listChunks(classId: string): Promise<ChunkRow[]>;
  createChunks(classId: string, plan: ChunkPlan[]): Promise<void>;
  /** `owner`: refuse the save unless this run still holds the lecture's lock (cloud runs). */
  saveChunk(classId: string, idx: number, segments: RawSegment[], provider: string, owner?: string): Promise<void>;
  listRefineBatches(classId: string): Promise<Map<number, RefineResult>>;
  saveRefineBatch(classId: string, idx: number, result: RefineResult): Promise<void>;
  saveTranscript(t: TranscriptRecord): Promise<void>;
  getTranscript(classId: string): Promise<TranscriptDoc | null>;
  updateStudy(id: string, patch: Record<string, unknown>): Promise<void>;
  /** Download an uploaded recording to `dest`. */
  downloadUpload(uploadId: string, dest: string): Promise<void>;
}

/** Talks to the site's /api/worker endpoints (Netlify Functions + Netlify Blobs). */
export class HttpStore implements Store {
  constructor(
    private baseUrl: string,
    private secret: string,
    private extraHeaders: Record<string, string> = {},
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const res = await fetch(`${this.baseUrl}/api/worker${path}`, {
          method,
          headers: { "x-worker-secret": this.secret, ...this.extraHeaders, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(60_000),
        });
        if (res.status === 404 && method === "GET") return null as T;
        if (!res.ok) {
          const text = await res.text();
          if (res.status < 500 && res.status !== 429) throw Object.assign(new Error(`API ${method} ${path}: ${res.status} ${text.slice(0, 300)}`), { fatal: true });
          throw new Error(`API ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
        }
        const text = await res.text();
        return (text ? JSON.parse(text) : null) as T;
      } catch (e) {
        lastErr = e;
        if ((e as { fatal?: boolean }).fatal) throw e;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    throw lastErr;
  }

  /** Cloud runner only: nothing claimable now; let the site schedule the next run. */
  cloudIdle() {
    return this.call<{ next: string | null }>("POST", "/cloud-idle", {});
  }
  /** Cloud runner only: one run at a time (acquire), and report its running time when done (release). */
  cloudLease(runner: string, release = false, seconds = 0) {
    return this.call<{ ok: boolean; reason?: string }>("POST", "/cloud-lease", { runner, release, seconds });
  }
  claimClass(workerId: string) {
    return this.call<ClassRow | null>("POST", "/claim-class", { workerId });
  }
  claimStudy(workerId: string) {
    return this.call<StudyRow | null>("POST", "/claim-study", { workerId });
  }
  getClass(id: string) {
    return this.call<ClassRow | null>("GET", `/classes/${id}`);
  }
  async updateClass(id: string, patch: Record<string, unknown>) {
    await this.call("PATCH", `/classes/${id}`, patch);
  }
  async listChunks(classId: string) {
    const rows = (await this.call<ChunkRow[] | null>("GET", `/classes/${classId}/chunks`)) ?? [];
    return rows.map((r) => ({ ...r }));
  }
  async createChunks(classId: string, plan: ChunkPlan[]) {
    const rows = plan.map((p) => ({ idx: p.idx, start_s: p.start, end_s: p.end, segments: null, provider: null, done: false }));
    await this.call("PUT", `/classes/${classId}/chunks`, rows);
  }
  async saveChunk(classId: string, idx: number, segments: RawSegment[], provider: string, owner?: string) {
    await this.call("PUT", `/classes/${classId}/chunks/${idx}`, { segments, provider, done: true, ...(owner ? { owner } : {}) });
  }
  async listRefineBatches(classId: string) {
    const obj = (await this.call<Record<string, RefineResult> | null>("GET", `/classes/${classId}/refine`)) ?? {};
    return new Map(Object.entries(obj).map(([k, v]) => [Number(k), v]));
  }
  async saveRefineBatch(classId: string, idx: number, result: RefineResult) {
    await this.call("PUT", `/classes/${classId}/refine/${idx}`, result);
  }
  async saveTranscript(t: TranscriptRecord) {
    await this.call("PUT", `/classes/${t.class_id}/transcript`, t);
  }
  async getTranscript(classId: string) {
    return this.call<TranscriptDoc | null>("GET", `/classes/${classId}/transcript`);
  }
  async updateStudy(id: string, patch: Record<string, unknown>) {
    await this.call("PATCH", `/study/${encodeURIComponent(id)}`, patch);
  }
  /** Uploads are stored in ~4 MB parts; fetch them in order and append to one file. */
  async downloadUpload(uploadId: string, dest: string) {
    const meta = await this.call<{ parts: number } | null>("GET", `/uploads/${uploadId}`);
    if (!meta) throw new Error("Upload not found");
    const tmp = dest + ".part";
    await fs.writeFile(tmp, "");
    for (let i = 0; i < meta.parts; i++) {
      let buf: ArrayBuffer | null = null;
      for (let attempt = 1; !buf; attempt++) {
        const res = await fetch(`${this.baseUrl}/api/worker/uploads/${uploadId}/parts/${i}`, { headers: { "x-worker-secret": this.secret, ...this.extraHeaders } });
        if (res.ok) buf = await res.arrayBuffer();
        else if (attempt >= 5) throw new Error(`Could not download upload part ${i}: ${res.status}`);
        else await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
      await fs.appendFile(tmp, Buffer.from(buf));
    }
    await fs.rename(tmp, dest);
  }
}
