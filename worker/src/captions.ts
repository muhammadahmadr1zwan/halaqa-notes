import type { RawSegment } from "./segmenting.ts";

interface Json3 {
  events?: Array<{ tStartMs?: number; dDurationMs?: number; segs?: Array<{ utf8?: string }> }>;
}

const NOISE_ONLY = /^\s*\[(music|applause|laughter|silence|inaudible|موسيقى)\]\s*$/i;

/** Parse YouTube json3 captions into segments of roughly sentence length. */
export function parseJson3(json: Json3 | string): RawSegment[] {
  const data: Json3 = typeof json === "string" ? JSON.parse(json) : json;
  const cues: RawSegment[] = [];
  for (const ev of data.events ?? []) {
    if (!ev.segs) continue;
    const text = ev.segs.map((s) => s.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
    if (!text || NOISE_ONLY.test(text)) continue;
    const start = (ev.tStartMs ?? 0) / 1000;
    const end = ((ev.tStartMs ?? 0) + (ev.dDurationMs ?? 0)) / 1000;
    cues.push({ start, end, text, speaker: "S1" });
  }
  // Auto-caption cues overlap in time; clamp each end to the next start.
  for (let i = 0; i < cues.length - 1; i++) cues[i].end = Math.min(cues[i].end, cues[i + 1].start);

  // Merge short cues into segments (break on pauses, sentence ends, or ~30 words).
  const out: RawSegment[] = [];
  for (const c of cues) {
    const last = out[out.length - 1];
    const words = last ? last.text.split(" ").length : 0;
    if (last && c.start - last.end < 1.5 && words < 30 && !/[.?!؟]$/.test(last.text)) {
      last.text = `${last.text} ${c.text}`;
      last.end = Math.max(last.end, c.end);
    } else {
      out.push({ ...c });
    }
  }
  return out;
}

export interface CaptionTrack {
  lang: string;
  auto: boolean;
}

/**
 * Pick the best caption track: human captions in English/Arabic first, then the
 * ORIGINAL-language auto captions (never YouTube's machine-translated tracks).
 */
export function pickCaptionTrack(meta: {
  language?: string | null;
  subtitles?: Record<string, unknown> | null;
  automatic_captions?: Record<string, unknown> | null;
}): CaptionTrack | null {
  const manual = Object.keys(meta.subtitles ?? {}).filter((k) => k !== "live_chat");
  for (const pref of ["en", "ar"]) {
    const hit = manual.find((k) => k === pref || k.startsWith(`${pref}-`));
    if (hit) return { lang: hit, auto: false };
  }
  const auto = Object.keys(meta.automatic_captions ?? {});
  const orig = auto.find((k) => k.endsWith("-orig"));
  if (orig) return { lang: orig, auto: true };
  if (meta.language && auto.includes(meta.language)) return { lang: meta.language, auto: true };
  // Unknown spoken language: these classes are taught mainly in English.
  if (!meta.language && auto.includes("en")) return { lang: "en", auto: true };
  return null;
}
