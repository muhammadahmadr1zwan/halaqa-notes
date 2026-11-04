import { countArabicWords } from "@halaqa/shared";

/** Latin-script words, lowercased, punctuation stripped. */
function latinWords(text: string): string[] {
  return (text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[a-z0-9']+/g) ?? []).map((w) => w.replace(/^'+|'+$/g, "")).filter(Boolean);
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

/** Count how many words of `from` can be matched (exactly or as a close spelling fix) in `to`. */
function matched(from: string[], to: string[]): number {
  const pool = new Map<string, number>();
  for (const w of to) pool.set(w, (pool.get(w) ?? 0) + 1);
  let n = 0;
  const leftovers: string[] = [];
  for (const w of from) {
    const c = pool.get(w) ?? 0;
    if (c > 0) {
      pool.set(w, c - 1);
      n++;
    } else leftovers.push(w);
  }
  // spelling corrections ("sabur" -> "sabr", "allahs" -> "allah's")
  for (const w of leftovers) {
    if (w.length < 3) continue;
    for (const [cand, c] of pool) {
      if (c > 0 && cand.length >= 3 && editDistance(w, cand) <= (w.length >= 6 ? 2 : 1)) {
        pool.set(cand, c - 1);
        n++;
        break;
      }
    }
  }
  return n;
}

export interface GuardVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * Decide whether an AI-edited segment is a faithful edit of what was heard.
 * The editor may fix punctuation/spelling and turn transliterated Arabic into Arabic script,
 * but must not drop speech, paraphrase, or add words (e.g. "complete" a Quran verse).
 */
const NEGATIONS = new Set(["not", "no", "never", "don't", "dont", "doesn't", "didn't", "isn't", "aren't", "wasn't", "can't", "cannot", "won't", "shouldn't", "nor"]);

/** Honorific ligatures stand for whole phrases; count them as the words they replace. */
function expandLigatures(text: string): string {
  return text
    .replace(/ﷺ/g, " صلى الله عليه وسلم ")
    .replace(/ﷻ/g, " جل جلاله ")
    .replace(/﷽/g, " بسم الله الرحمن الرحيم ");
}

export function checkRefinement(original: string, refinedInput: string): GuardVerdict {
  const o = original.trim();
  const r = refinedInput.trim();
  if (!o) return r ? { ok: false, reason: "added text to empty segment" } : { ok: true };
  if (!r) return { ok: false, reason: "dropped all text" };
  if (r.length > o.length * 1.6 + 25) return { ok: false, reason: "much longer than original" };

  const oLat = latinWords(o);
  const rLat = latinWords(r);
  const oAr = countArabicWords(expandLigatures(o));
  const rAr = countArabicWords(expandLigatures(r));

  // 1) Precision: refined English must come from the original (no invented sentences/translations).
  //    One corrected word (a misheard homophone) is allowed per segment, more for long segments.
  const newWords = rLat.length - matched(rLat, oLat);
  if (newWords > Math.max(1, Math.floor(rLat.length * 0.2))) return { ok: false, reason: `${newWords} new English words` };
  // ...but never a new negation, which would flip the meaning.
  const oNeg = oLat.filter((w) => NEGATIONS.has(w)).length;
  if (rLat.filter((w) => NEGATIONS.has(w)).length > oNeg) return { ok: false, reason: "added a negation" };

  // 2) Recall: original English words must survive, unless they became Arabic script.
  const kept = oLat.length ? matched(oLat, rLat) : 0;
  const dropped = oLat.length - kept;
  const arabicAdded = Math.max(0, rAr - oAr);
  if (oLat.length >= 3 && kept / oLat.length < 0.6 && arabicAdded < dropped * 0.4) {
    return { ok: false, reason: `dropped English words (recall ${(kept / oLat.length).toFixed(2)})` };
  }

  // 3) Arabic inflation: new Arabic words must be explained by transliterated words that were replaced.
  if (arabicAdded > dropped * 1.5 + 2) return { ok: false, reason: `added ${arabicAdded} Arabic words for ${dropped} replaced` };

  // 4) Arabic that was already in Arabic script must not disappear.
  if (oAr >= 2 && rAr < oAr * 0.7) return { ok: false, reason: "dropped Arabic words" };

  return { ok: true };
}
