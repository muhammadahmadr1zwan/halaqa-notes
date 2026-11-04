import { buildParagraphs, paragraphText } from "./paragraphs.ts";
import { formatHms, formatSrtTime, formatDuration } from "./time.ts";
import { speakerName, type TranscriptDoc } from "./types.ts";

export interface ExportMeta {
  title: string;
  date?: string | null;
  durationSeconds?: number | null;
  sourceUrl?: string | null;
  speakerNames?: Record<string, string> | null;
  /** Hide speaker labels when only one person speaks. */
  showSpeakers?: boolean;
}

export function usesMultipleSpeakers(doc: TranscriptDoc): boolean {
  return new Set(doc.segments.map((s) => s.speaker)).size > 1;
}

export function toTxt(doc: TranscriptDoc, meta: ExportMeta): string {
  const showSpeakers = meta.showSpeakers ?? usesMultipleSpeakers(doc);
  const lines: string[] = [meta.title];
  const info = [meta.date, formatDuration(meta.durationSeconds), meta.sourceUrl].filter(Boolean);
  if (info.length) lines.push(info.join(" · "));
  lines.push("");
  for (const p of buildParagraphs(doc)) {
    if (p.heading) lines.push("", `## ${p.heading}`, "");
    const who = showSpeakers ? ` ${speakerName(p.speaker, meta.speakerNames)}:` : "";
    lines.push(`[${formatHms(p.start)}]${who} ${paragraphText(p)}`, "");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** Standard UTF-8 SRT, one cue per segment. Players apply the Unicode bidi algorithm to Arabic. */
export function toSrt(doc: TranscriptDoc): string {
  const blocks: string[] = [];
  let n = 1;
  for (const s of doc.segments) {
    const text = s.text.trim();
    if (!text) continue;
    const end = Math.max(s.end, s.start + 0.5);
    blocks.push(`${n++}\n${formatSrtTime(s.start)} --> ${formatSrtTime(end)}\n${wrapLines(text, 84)}\n`);
  }
  return blocks.join("\n");
}

function wrapLines(text: string, max: number): string {
  if (text.length <= max) return text;
  const words = text.split(/\s+/);
  const mid = Math.ceil(text.length / 2);
  let line = "";
  let i = 0;
  while (i < words.length && line.length + words[i].length < mid) line += (line ? " " : "") + words[i++];
  return `${line}\n${words.slice(i).join(" ")}`;
}

export function safeFileName(title: string): string {
  return (title || "transcript").replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim().slice(0, 120) || "transcript";
}
