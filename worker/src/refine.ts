import { formatHms, type Section, type Segment } from "@halaqa/shared";
import { z } from "zod";
import { parseJsonLoose, type Llm } from "./llm.ts";
import { checkRefinement } from "./refineGuard.ts";

export interface RefineResult {
  segments: Array<{ id: number; text: string }>;
  paragraph_starts: number[];
  headings: Array<{ id: number; title: string }>;
}

/** Anything that can refine one batch (Claude in production, a fake in tests). */
export interface Refiner {
  /** Words per batch that fit this model's limits. */
  batchWords?: number;
  refineBatch(batch: Segment[], context: Segment[]): Promise<RefineResult>;
}

const ResultSchema = z.object({
  segments: z.array(z.object({ id: z.number().int(), text: z.string() })),
  paragraph_starts: z.array(z.number().int()),
  headings: z.array(z.object({ id: z.number().int(), title: z.string() })),
});

export const REFINE_SYSTEM = `You are a meticulous transcript editor for Islamic classes. The teacher speaks mostly English and often recites or quotes Arabic: Quran verses, hadith, duas, and Islamic terms. You receive machine speech-recognition output split into numbered segments and return a cleaned version of every segment.

Your job is faithful cleanup, not rewriting. The reader must be able to trust that every sentence is what the teacher actually said.

Rules:
1. Keep the speaker's own words, word order, and meaning. Fix only clear recognition errors (misheard words that are obvious from context), punctuation, capitalization, and sentence boundaries. Keep filler words out only when they are pure disfluency ("um", "uh"); keep repetitions that carry meaning.
2. Never add content that is not in the segment. Never summarize, shorten, translate, or paraphrase. Never complete a Quran verse, hadith, or dua beyond the words that are actually present, and never insert a verse the teacher only referred to.
3. Arabic script: when the segment contains Arabic speech written as Latin transliteration or as garbled English (e.g. "bismillah ir rahman ir raheem", "inna lillahi wa inna ilayhi rajioon", "subhanAllah"), write those exact words in correct Arabic script with standard spelling (e.g. "بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ"). Add full tashkeel only for Quran text you are certain of; otherwise use plain Arabic spelling. Islamic terms used inside English sentences (sabr, taqwa, tawakkul, ikhlas, salah) should also be written in Arabic script (صبر، تقوى). Keep very common English-usage names as English: Allah, Muhammad, Quran, Islam, Muslim, Prophet, Ramadan.
4. If Arabic already appears in Arabic script, keep it; only fix obvious spelling errors.
5. If you are not confident what was said, leave the text exactly as given. It is better to keep an imperfect transcription than to guess.
6. Every input id must appear exactly once in your output with its own text. Never move words between segments — each segment's text is tied to its timestamp.
7. paragraph_starts: ids where a new paragraph should begin (a new thought, example, or speaker), typically every 3–8 segments.
8. headings: short topic headings (3–8 words, English, may include an Arabic term) placed at ids where the class moves to a clearly new topic — roughly every 5–20 minutes of speech, and only at genuine topic changes. Do not put a heading on the first id unless the class clearly begins a new topic there. Headings are labels, not content: no verses, no claims.

Reply with JSON only, exactly in this shape:
{"segments":[{"id":12,"text":"cleaned text"}],"paragraph_starts":[12,17],"headings":[{"id":17,"title":"Short topic heading"}]}`;

function formatLines(segs: Segment[]): string {
  return segs.map((s) => `${s.id} [${formatHms(s.start)}] ${s.speaker}: ${s.raw}`).join("\n");
}

export function llmRefiner(llm: Llm): Refiner {
  return {
    batchWords: batchWordsFor(llm),
    async refineBatch(batch, context) {
      const user =
        (context.length ? `Earlier context (read-only, do not return):
${formatLines(context)}

` : "") +
        `Segments to clean (return all ${batch.length}, ids ${batch[0].id}–${batch[batch.length - 1].id}):
${formatLines(batch)}`;
      let lastErr: unknown;
      for (let i = 0; i < 2; i++) {
        const text = await llm.complete({ system: REFINE_SYSTEM, user, json: true });
        try {
          return ResultSchema.parse(parseJsonLoose(text));
        } catch (e) {
          lastErr = e; // malformed JSON: ask once more
        }
      }
      throw new Error(`AI returned malformed JSON: ${(lastErr as Error).message}`);
    },
  };
}

/** Words per batch that fit the model's input and output limits (output repeats the text as JSON). */
export function batchWordsFor(llm: Pick<Llm, "maxInputTokens" | "maxOutputTokens">): number {
  const budget = Math.min((llm.maxInputTokens - 1200) * 0.6, llm.maxOutputTokens * 0.55);
  return Math.max(250, Math.min(2000, Math.floor(budget / 1.8)));
}

/** Split segments into batches of about `maxWords` words. Deterministic so batches can be resumed. */
export function makeBatches(segments: Segment[], maxWords = 2000): Segment[][] {
  const out: Segment[][] = [];
  let cur: Segment[] = [];
  let words = 0;
  for (const s of segments) {
    const w = s.raw.split(/\s+/).length;
    if (cur.length && words + w > maxWords) {
      out.push(cur);
      cur = [];
      words = 0;
    }
    cur.push(s);
    words += w;
  }
  if (cur.length) out.push(cur);
  return out;
}

export interface ApplyStats {
  accepted: number;
  rejected: number;
  missing: number;
}

/** Merge a batch result into segments, keeping the raw text wherever the edit fails the guard. */
export function applyRefinement(batch: Segment[], result: RefineResult | null, stats: ApplyStats): { segments: Segment[]; sections: Section[] } {
  const ids = new Set(batch.map((s) => s.id));
  const byId = new Map<number, string>();
  for (const r of result?.segments ?? []) if (ids.has(r.id) && !byId.has(r.id)) byId.set(r.id, r.text);
  const paraStarts = new Set((result?.paragraph_starts ?? []).filter((id) => ids.has(id)));
  const segments = batch.map((s) => {
    const refined = byId.get(s.id);
    let text = s.raw;
    if (refined === undefined) stats.missing++;
    else if (checkRefinement(s.raw, refined).ok) {
      text = refined.trim();
      stats.accepted++;
    } else stats.rejected++;
    // With an AI result, its paragraphing replaces the pause-based heuristic.
    return { ...s, text, para: result ? paraStarts.has(s.id) : s.para };
  });
  const sections = (result?.headings ?? [])
    .filter((h) => ids.has(h.id) && h.title.trim())
    .map((h) => ({ segmentId: h.id, title: h.title.trim().slice(0, 120) }));
  return { segments, sections };
}
