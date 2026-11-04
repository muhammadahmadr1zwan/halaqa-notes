export interface Word {
  text: string;
  start: number;
  end: number;
  speaker?: string | null;
}

/** A timed piece of text before refinement. Speaker is the provider's raw id until mapped. */
export interface RawSegment {
  start: number;
  end: number;
  text: string;
  speaker: string;
}

const SENTENCE_END = /[.?!؟。…]["')\]]*$/;

/**
 * Group word timings into readable segments: break on speaker change, long pause,
 * sentence end (once a segment has some length), or a hard word limit.
 */
export function wordsToSegments(words: Word[], opts: { maxWords?: number; minWordsForSentenceBreak?: number; pause?: number } = {}): RawSegment[] {
  const { maxWords = 40, minWordsForSentenceBreak = 8, pause = 1.0 } = opts;
  const out: RawSegment[] = [];
  let cur: { words: Word[]; speaker: string } | null = null;
  const flush = () => {
    if (cur && cur.words.length) {
      out.push({
        start: cur.words[0].start,
        end: cur.words[cur.words.length - 1].end,
        text: joinWords(cur.words.map((w) => w.text)),
        speaker: cur.speaker,
      });
    }
    cur = null;
  };
  for (const w of words) {
    const text = w.text.trim();
    if (!text) continue;
    const speaker = w.speaker ?? "S1";
    if (cur) {
      const c: { words: Word[]; speaker: string } = cur;
      const prev = c.words[c.words.length - 1];
      const brk =
        speaker !== c.speaker ||
        w.start - prev.end > pause ||
        c.words.length >= maxWords ||
        (c.words.length >= minWordsForSentenceBreak && SENTENCE_END.test(prev.text.trim()));
      if (brk) flush();
    }
    if (!cur) cur = { words: [], speaker };
    (cur as { words: Word[] }).words.push({ ...w, text });
  }
  flush();
  return out;
}

function joinWords(words: string[]): string {
  return words
    .join(" ")
    .replace(/\s+([,.;:!?،؛؟])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Speaker ids from diarization are only consistent within one chunk.
 * For a class, the person who talks most in each chunk is the teacher ("S1");
 * everyone else (questions, guests) becomes "S2".
 */
export function mapSpeakersDominant(segments: RawSegment[]): RawSegment[] {
  const talk = new Map<string, number>();
  for (const s of segments) talk.set(s.speaker, (talk.get(s.speaker) ?? 0) + (s.end - s.start));
  let main: string | null = null;
  for (const [k, v] of talk) if (main === null || v > (talk.get(main) ?? 0)) main = k;
  return segments.map((s) => ({ ...s, speaker: s.speaker === main ? "S1" : "S2" }));
}

/** Shift chunk-relative times to absolute recording times. */
export function offsetSegments(segments: RawSegment[], offset: number): RawSegment[] {
  const r = (n: number) => Math.round((n + offset) * 1000) / 1000;
  return segments.map((s) => ({ ...s, start: r(s.start), end: r(s.end) }));
}

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/**
 * Whisper sometimes repeats the last word(s) of a segment at the start of the next
 * ("…daily prayers." / "prayers. Now…"). Remove the repeat when it is clearly an artifact:
 * back-to-back segments and either 2+ repeated words, or one long word that ended a sentence.
 */
export function dropBoundaryRepeats(segments: RawSegment[]): RawSegment[] {
  const out: RawSegment[] = [];
  for (const seg of segments) {
    const prev = out[out.length - 1];
    if (prev && seg.start - prev.end < 1.5) {
      const a = prev.text.split(/\s+/);
      const b = seg.text.split(/\s+/);
      for (let k = Math.min(6, a.length, b.length - 1); k >= 1; k--) {
        const same = a.slice(-k).every((w, i) => norm(w) && norm(w) === norm(b[i]));
        const strong = k >= 2 || (/[.?!؟]$/.test(a[a.length - 1]) && norm(b[0]).length >= 4);
        if (same && strong) {
          const rest = b.slice(k).join(" ");
          out.push({ ...seg, text: rest.charAt(0).toUpperCase() + rest.slice(1) });
          break;
        }
        if (k === 1) out.push(seg);
      }
      if (Math.min(6, a.length, b.length - 1) < 1) out.push(seg);
      continue;
    }
    out.push(seg);
  }
  return out;
}
