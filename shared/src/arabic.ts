const AR = "\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF";

export const ARABIC_CHAR = new RegExp(`[${AR}]`);
const ARABIC_WORD = new RegExp(`[${AR}]+`, "g");
/** An Arabic run: Arabic words joined by spaces / Arabic or basic punctuation. */
const ARABIC_RUN = new RegExp(`[${AR}]+(?:[\\s\\u060C\\u061B\\u061F.,:;!()«»"'\\-]*[${AR}]+)*`, "g");

export function hasArabic(text: string): boolean {
  return ARABIC_CHAR.test(text);
}

export function countArabicWords(text: string): number {
  return text.match(ARABIC_WORD)?.length ?? 0;
}

/** Share of letters that are Arabic (0..1). */
export function arabicRatio(text: string): number {
  let ar = 0;
  let letters = 0;
  for (const ch of text) {
    if (/\p{L}/u.test(ch)) {
      letters++;
      if (ARABIC_CHAR.test(ch)) ar++;
    }
  }
  return letters ? ar / letters : 0;
}

export interface BidiRun {
  text: string;
  rtl: boolean;
}

/** Split mixed text into LTR and RTL runs so Arabic can be isolated and styled. */
export function splitBidiRuns(text: string): BidiRun[] {
  const runs: BidiRun[] = [];
  let last = 0;
  for (const m of text.matchAll(ARABIC_RUN)) {
    const i = m.index ?? 0;
    if (i > last) runs.push({ text: text.slice(last, i), rtl: false });
    runs.push({ text: m[0], rtl: true });
    last = i + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), rtl: false });
  return runs;
}

const TASHKEEL = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/;

/** Normalize one character for search; returns "" to drop it. */
function normChar(ch: string): string {
  if (TASHKEEL.test(ch)) return "";
  switch (ch) {
    case "أ":
    case "إ":
    case "آ":
    case "ٱ":
      return "ا";
    case "ى":
      return "ي";
    case "ة":
      return "ه";
    case "ؤ":
      return "و";
    case "ئ":
      return "ي";
  }
  // strip Latin accents (e.g. "Qurʾān" -> "quran")
  const base = ch.normalize("NFKD").replace(/[̀-ͯʾʿʼ]/g, "");
  return base.toLowerCase();
}

/** Diacritic- and case-insensitive text used for search. */
export function normalizeForSearch(text: string): string {
  let out = "";
  for (const ch of text) out += normChar(ch);
  return out;
}

/**
 * Find all matches of `query` in `text`, ignoring case, Arabic tashkeel and hamza/alef variants.
 * Returns [start, end) offsets into the ORIGINAL text so the UI can highlight them.
 */
export function findMatches(text: string, query: string): Array<[number, number]> {
  const q = normalizeForSearch(query).trim();
  if (!q) return [];
  let norm = "";
  const map: number[] = []; // norm index -> original index
  let i = 0;
  for (const ch of text) {
    const n = normChar(ch);
    for (let k = 0; k < n.length; k++) {
      norm += n[k];
      map.push(i);
    }
    i += ch.length;
  }
  map.push(text.length);
  const out: Array<[number, number]> = [];
  let from = 0;
  while (true) {
    const at = norm.indexOf(q, from);
    if (at < 0) break;
    const start = map[at];
    // end = original index just after the last matched char
    const lastOrig = map[at + q.length - 1];
    const lastLen = text.codePointAt(lastOrig)! > 0xffff ? 2 : 1;
    let end = lastOrig + lastLen;
    // include trailing diacritics attached to the last letter
    while (end < text.length && TASHKEEL.test(text[end])) end++;
    out.push([start, end]);
    from = at + q.length;
  }
  return out;
}
