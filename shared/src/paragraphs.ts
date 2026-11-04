import type { Segment, TranscriptDoc } from "./types.ts";

export interface Paragraph {
  key: number; // id of first segment
  start: number;
  end: number;
  speaker: string;
  heading?: string;
  segments: Segment[];
}

/** Group segments into display paragraphs, attaching topic headings. */
export function buildParagraphs(doc: TranscriptDoc): Paragraph[] {
  const headings = new Map(doc.sections.map((s) => [s.segmentId, s.title]));
  const out: Paragraph[] = [];
  let cur: Paragraph | null = null;
  for (const seg of doc.segments) {
    const heading = headings.get(seg.id);
    if (!cur || seg.para || heading || seg.speaker !== cur.speaker) {
      cur = { key: seg.id, start: seg.start, end: seg.end, speaker: seg.speaker, heading, segments: [] };
      out.push(cur);
    }
    cur.segments.push(seg);
    cur.end = seg.end;
  }
  return out;
}

export function paragraphText(p: Paragraph): string {
  return p.segments
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * Fallback paragraphing when no AI refinement is available:
 * break on long pauses, speaker changes, or every ~8 segments.
 */
export function heuristicParagraphs(segments: Segment[]): Segment[] {
  let sinceBreak = 0;
  return segments.map((s, i) => {
    const prev = segments[i - 1];
    const brk = !prev || prev.speaker !== s.speaker || s.start - prev.end > 2.5 || sinceBreak >= 8;
    sinceBreak = brk ? 1 : sinceBreak + 1;
    return { ...s, para: brk };
  });
}
