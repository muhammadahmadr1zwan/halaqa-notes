import { useQuery } from "@tanstack/react-query";
import { normalizeForSearch, type ClassRow, type GlossaryEntry, type StudyKind, type TranscriptDoc } from "@halaqa/shared";
import { api } from "./client";

export interface StudyRow {
  id: string;
  kind: StudyKind;
  status: "queued" | "processing" | "completed" | "failed";
  content: string | null;
  data: GlossaryEntry[] | null;
  error: string | null;
  status_message?: string | null;
  updated_at: string;
}

const isActive = (c: Pick<ClassRow, "status">) => c.status === "queued" || c.status === "processing";

export function useClasses() {
  return useQuery({
    queryKey: ["classes"],
    queryFn: () => api<ClassRow[]>("/classes"),
    refetchInterval: (q) => (q.state.data?.some(isActive) ? 5000 : false),
  });
}

export function useClass(id: string) {
  return useQuery({
    queryKey: ["class", id],
    queryFn: async () => {
      try {
        return await api<ClassRow>(`/classes/${id}`);
      } catch (e) {
        if ((e as { status?: number }).status === 404) return null;
        throw e;
      }
    },
    refetchInterval: (q) => (q.state.data && isActive(q.state.data) ? 4000 : false),
  });
}

export function useTranscript(id: string, enabled: boolean) {
  return useQuery({ queryKey: ["transcript", id], enabled, staleTime: Infinity, queryFn: () => api<TranscriptDoc>(`/classes/${id}/transcript`) });
}

export function useStudy(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ["study", id],
    enabled,
    queryFn: () => api<StudyRow[]>(`/classes/${id}/study`),
    refetchInterval: (q) => (q.state.data?.some(isActive) ? 4000 : false),
  });
}

export function useSearch(query: string) {
  const q = normalizeForSearch(query).trim();
  return useQuery({
    queryKey: ["search", q],
    enabled: q.length >= 2,
    queryFn: () => api<Array<{ class_id: string; snippet: string | null }>>(`/search?q=${encodeURIComponent(q)}`),
  });
}

/** Create (or open the existing) class for a YouTube video. */
export async function addYouTubeClass(youtubeId: string, aiOptOut = true): Promise<string> {
  return (await api<{ id: string }>("/classes", { method: "POST", json: { youtube_id: youtubeId, ai_opt_out: aiOptOut } })).id;
}

/** Is the home computer that does the transcribing switched on? */
export function useWorkerStatus() {
  return useQuery({ queryKey: ["status"], queryFn: () => api<{ workerOnline: boolean; lastSeen: string | null; cloudEnabled?: boolean }>("/status"), refetchInterval: 30_000 });
}

export interface PartialTranscript {
  partsDone: number;
  partsTotal: number;
  segments: Array<{ start: number; end: number; text: string; speaker: string }>;
}

/** The unpolished transcript so far, while a long lecture is processing. */
export function usePartial(id: string, enabled: boolean) {
  return useQuery({ queryKey: ["partial", id], enabled, queryFn: () => api<PartialTranscript>(`/classes/${id}/partial`), refetchInterval: 30_000 });
}

/** Resumable upload in 4 MB parts: choosing the same file again continues where it stopped. */
export async function uploadRecording(file: File, onProgress: (fraction: number) => void): Promise<string> {
  const init = await api<{ existingClassId?: string; uploadId: string; partSize: number; parts: number; received: number[] }>("/uploads", {
    method: "POST",
    json: { name: file.name, size: file.size, type: file.type, lastModified: file.lastModified },
  });
  if (init.existingClassId) return init.existingClassId;
  const have = new Set(init.received);
  let done = have.size;
  onProgress(done / init.parts);
  for (let n = 0; n < init.parts; n++) {
    if (have.has(n)) continue;
    const blob = file.slice(n * init.partSize, Math.min(file.size, (n + 1) * init.partSize));
    for (let attempt = 1; ; attempt++) {
      try {
        await api(`/uploads/${init.uploadId}/parts/${n}`, { method: "PUT", body: blob, headers: { "content-type": "application/octet-stream" } });
        break;
      } catch (e) {
        if (attempt >= 6) throw new Error(`Upload stopped (${(e as Error).message}). Choose the same file again to continue.`);
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    onProgress(++done / init.parts);
  }
  const date = new Date(file.lastModified);
  const { id } = await api<{ id: string }>(`/uploads/${init.uploadId}/complete`, {
    method: "POST",
    json: {
      title: file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim(),
      class_date: Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10),
    },
  });
  return id;
}

export async function retryClass(id: string) {
  await api(`/classes/${id}/retry`, { method: "POST" });
}

export async function requestStudy(id: string, kinds?: StudyKind[], force = false) {
  await api(`/classes/${id}/study`, { method: "POST", json: { kinds, force } });
}

export async function updateClassFields(id: string, patch: Partial<Pick<ClassRow, "title" | "class_date" | "speaker_names">>) {
  await api(`/classes/${id}`, { method: "PATCH", json: patch });
}

export async function deleteClass(c: ClassRow) {
  await api(`/classes/${c.id}`, { method: "DELETE" });
}
