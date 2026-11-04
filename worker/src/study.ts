import {
  buildParagraphs,
  formatHms,
  normalizeForSearch,
  paragraphText,
  parseTimestamp,
  speakerName,
  type GlossaryEntry,
  type StudyKind,
  type TranscriptDoc,
} from "@halaqa/shared";
import { z } from "zod";
import { estimateTokens, parseJsonLoose, type Llm } from "./llm.ts";

/** Timestamped transcript lines as the model sees them. */
export function studyLines(doc: TranscriptDoc, names: Record<string, string>): string[] {
  const lines: string[] = [];
  for (const p of buildParagraphs(doc)) {
    if (p.heading) lines.push(`## ${p.heading}`);
    lines.push(`[${formatHms(p.start)}] ${speakerName(p.speaker, names)}: ${paragraphText(p)}`);
  }
  return lines;
}

/** Split lines into parts of at most `maxTokens` each (a single huge line becomes its own part). */
export function splitLines(lines: string[], maxTokens: number): string[] {
  const parts: string[] = [];
  let cur: string[] = [];
  let tokens = 0;
  for (const l of lines) {
    const t = estimateTokens(l) + 1;
    if (cur.length && tokens + t > maxTokens) {
      parts.push(cur.join("\n"));
      cur = [];
      tokens = 0;
    }
    cur.push(l);
    tokens += t;
  }
  if (cur.length) parts.push(cur.join("\n"));
  return parts;
}

export const GROUNDING = `You are helping a student review a recorded Islamic class. Everything you write must be grounded in the class material you are given:
- Only state what the teacher actually said. Do not add outside knowledge, extra evidence, verse numbers, hadith references, or rulings that were not stated in the class.
- When you quote Quran, hadith, or duas, copy the Arabic exactly as it appears in the material. Never complete or correct a quotation from memory.
- Cite the moment in the class for each main point using the timestamp in the form [HH:MM:SS].
- If the material is unclear or incomplete on a point, say so briefly rather than guessing.
- Write in clear, simple English; keep Arabic terms in Arabic script.`;

const PROMPTS: Record<Exclude<StudyKind, "glossary">, string> = {
  summary:
    "Write a summary of the whole class in Markdown: one short opening paragraph on what the class covered, then the main topics in the order they were taught, each as a short paragraph with its timestamp. Scale the length to the class (about 250 words per hour of class, at most 1,500 words). No preamble.",
  notes:
    "Write structured study notes in Markdown that follow the flow of the class. Use `##` headings for the main topics (with the timestamp where the topic starts, e.g. `## Patience in hardship [01:12:30]`), bullet points for the teacher's explanations, examples and stories, and quote the Quran/hadith/duas the teacher recited exactly as they appear. Include the teacher's answers to questions from students. No preamble.",
  takeaways:
    "List the key takeaways a student should remember from this class, as a Markdown bullet list of 8–20 items. Each item is one or two sentences in the teacher's meaning, ending with its timestamp, e.g. `- Patience is ... [00:42:10]`. Include practical advice the teacher gave. No preamble.",
};

const PART_NOTES_PROMPT =
  "This is one part of a longer class. Write detailed study notes for THIS PART ONLY in Markdown: `##` headings for its topics with the timestamp where each starts (e.g. `## Patience in hardship [01:12:30]`), bullet points for the explanations, examples and answers to questions, and Arabic quotations copied exactly. Do not write an introduction or conclusion for the whole class. No preamble.";

const CONDENSE_PROMPT =
  "Condense these class notes to about half their length. Keep every main point, the order, the [HH:MM:SS] timestamps, and Arabic quotations exactly as written. Do not add anything. Markdown, no preamble.";

const GLOSSARY_PROMPT = `List the Arabic and Islamic terms used in this class material (single terms and short set phrases such as صبر, تقوى, إن شاء الله — not full verses or duas).
For each term give: the term in Arabic script, a simple English transliteration, its meaning, whether the teacher explained it, and the [HH:MM:SS] timestamp where it first appears in this material ("" if unsure).
If the teacher explained the term, the meaning must follow the teacher's explanation; otherwise give a short standard meaning and set explained_in_class to false.
Reply with JSON only: {"entries":[{"term":"صبر","transliteration":"sabr","meaning":"…","explained_in_class":true,"first_timestamp":"00:12:30"}]}`;

const GlossarySchema = z.object({
  entries: z.array(
    z.object({
      term: z.string(),
      transliteration: z.string().default(""),
      meaning: z.string().default(""),
      explained_in_class: z.boolean().default(false),
      first_timestamp: z.string().nullable().default(""),
    }),
  ),
});

const PROMPT_OVERHEAD = 1_200;

/** Per-part notes are reused across summary / notes / takeaways of the same class within a run. */
const partNotesCache = new Map<string, string[]>();

export async function generateStudy(
  llm: Llm,
  kind: StudyKind,
  title: string,
  classKey: string,
  doc: TranscriptDoc,
  names: Record<string, string>,
): Promise<{ content: string | null; data: GlossaryEntry[] | null }> {
  const lines = [`Class title: ${title}`, "", ...studyLines(doc, names)];
  const budget = llm.maxInputTokens - PROMPT_OVERHEAD;
  const parts = splitLines(lines, budget);

  if (kind === "glossary") return { content: null, data: await glossary(llm, parts) };

  if (parts.length === 1) {
    const content = await llm.complete({ system: GROUNDING, user: `<transcript>\n${parts[0]}\n</transcript>\n\n${PROMPTS[kind]}` });
    return { content: content.trim(), data: null };
  }

  // Map: notes for each part (cached for the other kinds).
  const cacheKey = `${classKey}:${doc.segments.length}`;
  let partNotes = partNotesCache.get(cacheKey);
  if (!partNotes) {
    partNotes = [];
    for (let i = 0; i < parts.length; i++) {
      const out = await llm.complete({
        system: GROUNDING,
        user: `<transcript part="${i + 1} of ${parts.length}">\n${parts[i]}\n</transcript>\n\n${PART_NOTES_PROMPT}`,
        maxTokens: Math.min(llm.maxOutputTokens, 2_000),
      });
      partNotes.push(out.trim());
    }
    partNotesCache.clear();
    partNotesCache.set(cacheKey, partNotes);
  }
  if (kind === "notes") return { content: partNotes.join("\n\n"), data: null };

  // Reduce: condense until the notes fit in one request, then write the summary / takeaways.
  let notes = partNotes;
  for (let round = 0; estimateTokens(notes.join("\n\n")) > budget && round < 4; round++) {
    const groups = splitLines(notes, budget);
    notes = [];
    for (const g of groups) notes.push((await llm.complete({ system: GROUNDING, user: `<notes>\n${g}\n</notes>\n\n${CONDENSE_PROMPT}` })).trim());
  }
  const content = await llm.complete({
    system: GROUNDING,
    user: `These are detailed notes of the whole class "${title}", in order, with timestamps:\n<notes>\n${notes.join("\n\n")}\n</notes>\n\n${PROMPTS[kind]}`,
  });
  return { content: content.trim(), data: null };
}

async function glossary(llm: Llm, parts: string[]): Promise<GlossaryEntry[]> {
  const byTerm = new Map<string, GlossaryEntry>();
  for (const part of parts) {
    const text = await llm.complete({ system: GROUNDING, user: `<transcript>\n${part}\n</transcript>\n\n${GLOSSARY_PROMPT}`, json: true });
    let parsed: z.infer<typeof GlossarySchema>;
    try {
      parsed = GlossarySchema.parse(parseJsonLoose(text));
    } catch {
      continue; // one malformed part shouldn't sink the glossary
    }
    for (const e of parsed.entries) {
      const term = e.term.trim();
      if (!term) continue;
      const key = normalizeForSearch(term).replace(/^ال/, "").replace(/\s+/g, " ");
      const entry: GlossaryEntry = {
        term,
        transliteration: e.transliteration.trim(),
        meaning: e.meaning.trim(),
        explainedInClass: e.explained_in_class,
        firstTimestamp: e.first_timestamp ? parseTimestamp(e.first_timestamp.replace(/[[\]]/g, "")) : null,
      };
      const prev = byTerm.get(key);
      // Keep the first appearance, but prefer the teacher's own explanation if a later part has it.
      if (!prev) byTerm.set(key, entry);
      else if (!prev.explainedInClass && entry.explainedInClass) byTerm.set(key, { ...entry, firstTimestamp: prev.firstTimestamp ?? entry.firstTimestamp });
    }
  }
  return [...byTerm.values()].sort((a, b) => (a.firstTimestamp ?? Infinity) - (b.firstTimestamp ?? Infinity));
}
