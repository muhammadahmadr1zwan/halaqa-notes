/** One timed piece of speech. `text` is the refined text; `raw` is exactly what the speech model heard. */
export interface Segment {
  id: number;
  start: number; // seconds
  end: number; // seconds
  speaker: string; // "S1" = main teacher, "S2" = other voices (questions, guests)
  text: string;
  raw: string;
  /** true when this segment starts a new paragraph */
  para?: boolean;
}

/** A topic heading inserted before `segmentId`. */
export interface Section {
  segmentId: number;
  title: string;
}

export interface TranscriptDoc {
  segments: Segment[];
  sections: Section[];
}

export type TranscriptSource = "ai" | "youtube_captions" | "youtube_auto_captions";
export type ClassStatus = "queued" | "processing" | "completed" | "failed";
export type Stage = "waiting" | "fetching" | "transcribing" | "refining" | "finishing" | "done";

export const STUDY_KINDS = ["summary", "notes", "takeaways", "glossary"] as const;
export type StudyKind = (typeof STUDY_KINDS)[number];

export interface GlossaryEntry {
  term: string; // Arabic script
  transliteration: string;
  meaning: string;
  explainedInClass: boolean;
  firstTimestamp: number | null; // seconds
}

export interface ClassRow {
  id: string;
  user_id: string;
  source_type: "youtube" | "upload";
  youtube_id: string | null;
  source_url: string | null;
  storage_path: string | null;
  upload_fingerprint: string | null;
  title: string | null;
  channel: string | null;
  thumbnail_url: string | null;
  class_date: string | null;
  duration_seconds: number | null;
  status: ClassStatus;
  stage: Stage;
  progress: number;
  status_message: string | null;
  error: string | null;
  error_code: string | null;
  transcript_source: TranscriptSource | null;
  provider: string | null;
  attempts: number;
  speaker_names: Record<string, string>;
  /** Private lecture: never send its text to online AI services. */
  ai_opt_out?: boolean;
  /** "cloud": a public YouTube lecture transcribed online (works with the home computer off). */
  engine?: "cloud" | "local";
  created_at: string;
  updated_at: string;
}

export const DEFAULT_SPEAKER_NAMES: Record<string, string> = {
  S1: "Teacher",
  S2: "Other speaker",
};

export function speakerName(key: string, names?: Record<string, string> | null): string {
  return names?.[key] || DEFAULT_SPEAKER_NAMES[key] || key;
}
