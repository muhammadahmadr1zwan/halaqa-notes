/**
 * Gemini reads a public YouTube video directly (no download), one time window at a time.
 * Measured on a 1-hour English/Arabic tafsir: ~12-15x real time, all hadith phrases kept, timestamps within ~1 s.
 */
import { youTubeWatchUrl } from "@halaqa/shared";
import type { RawSegment } from "./segmenting.ts";

export class GeminiError extends Error {
  constructor(
    message: string,
    public status: number,
    /** 429/5xx/network: try again later. Anything else: Gemini can't read this video. */
    public retryable: boolean,
    public perDay = false,
    /** Gemini answered with (almost) nothing — also what it does when the clip ends past the video's real end. */
    public empty = false,
  ) {
    super(message);
  }
}

const FPS = Number(process.env.GEMINI_FPS) || 0;

export const GEMINI_YT_MODELS =(process.env.GEMINI_YT_MODELS || "gemini-3.8-flash,gemini-3.5-flash").split(",").map((s) => s.trim()).filter(Boolean);

const PROMPT =
  "Transcribe the speech in this video clip VERBATIM. It is an Islamic class in English; Qur'an verses, hadith and duas are " +
  "recited in Arabic. Write every Arabic word in Arabic script exactly as spoken (no transliteration, no translation). " +
  "Do not summarize, paraphrase, correct, complete or add anything; if a word is unclear write [unclear]. " +
  "Output one line per sentence (start a new line at least every 20 seconds) in the form [MM:SS] text. " +
  "Timestamps count from the start of this clip, so the first line is near [00:00]. " +
  "If there is no speech, output nothing.";

/** Transcribe [start, end) seconds of a public YouTube video. Returns segments in absolute seconds. */
export async function geminiYouTubeWindow(apiKey: string, model: string, youtubeId: string, start: number, end: number, timeoutMs = 6 * 60_000): Promise<RawSegment[]> {
  let res: Response;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                file_data: { file_uri: youTubeWatchUrl(youtubeId) },
                // Opt-in (GEMINI_FPS=0.5): on a 5-min clip it cut video tokens ~36% with the same words, but the first
                // 20-min window run at 0.5 fps came back covering only 4 of its 20 minutes. Not proven safe yet.
                video_metadata: { start_offset: `${start}s`, end_offset: `${+end.toFixed(3)}s`, ...(FPS ? { fps: FPS } : {}) },
              },
              { text: PROMPT },
            ],
          },
        ],
        generationConfig: { temperature: 0, mediaResolution: "MEDIA_RESOLUTION_LOW", maxOutputTokens: 60_000 },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new GeminiError(`network: ${(e as Error).message}`, 0, true);
  }
  const body = await res.text();
  if (!res.ok) {
    // Never include the request (it carries the key header) — only Google's error message.
    let msg = body.slice(0, 400);
    try {
      msg = JSON.parse(body).error?.message ?? msg;
    } catch {}
    const retryable = res.status === 429 || res.status >= 500;
    throw new GeminiError(`${model} ${res.status}: ${msg}`, res.status, retryable, res.status === 429 && /per ?day|PerDay|daily/i.test(body));
  }
  const data = JSON.parse(body) as {
    candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
    promptFeedback?: { blockReason?: string };
  };
  const cand = data.candidates?.[0];
  if (!cand) throw new GeminiError(`${model}: no answer (${data.promptFeedback?.blockReason ?? "unknown"})`, 200, false);
  if (cand.finishReason && cand.finishReason !== "STOP") throw new GeminiError(`${model}: answer cut off (${cand.finishReason})`, 200, true);
  const text = (cand.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("");
  const segs = parseTimedLines(text, start, end);
  // Never accept an answer we couldn't read properly: that would silently drop part of the lecture.
  const answered = countWords(text.replace(/\[[\d:.]+\]/g, ""));
  const kept = segs.reduce((n, s) => n + countWords(s.text), 0);
  // A lecture window with (almost) no words is far more likely a failed read than silence: retry, never save it as done.
  if (end - start >= 120 && kept < 5) throw new GeminiError(`${model}: empty answer for ${Math.round(end - start)} s of video`, 200, true, false, true);
  if (answered > 30 && kept < answered * 0.9) throw new GeminiError(`${model}: only ${kept} of ${answered} words had usable timestamps`, 200, true);
  return segs;
}

const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * "[MM:SS] text" (or [H:MM:SS]) lines → absolute segments. Gemini usually counts from the start of the clip,
 * but sometimes uses the video's own clock; whichever reading puts the lines inside the clip wins.
 */
export function parseTimedLines(text: string, start: number, end: number): RawSegment[] {
  const parsed: Array<{ t: number; text: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^\[(?:(\d+):)?(\d{1,3}):(\d{2})(?:\.\d+)?\]\s*(.*)$/);
    if (!m || !m[4].trim()) continue;
    parsed.push({ t: Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]), text: m[4].trim() });
  }
  if (!parsed.length) return [];
  const sorted = parsed.map((p) => p.t).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const offset = start > 0 && median >= start ? 0 : start; // already on the video's clock?
  const rows = parsed
    .map((p) => ({ t: p.t + offset, text: p.text }))
    .filter((r) => r.t >= start - 5 && r.t <= end + 5) // outside the clip: not trustworthy
    .map((r) => ({ t: Math.min(Math.max(r.t, start), end), text: r.text }));
  rows.sort((a, b) => a.t - b.t);
  return rows.map((r, i) => ({ start: r.t, end: Math.max(r.t + 0.5, Math.min(rows[i + 1]?.t ?? end, end)), text: r.text, speaker: "S1" }));
}

/**
 * Title/channel/thumbnail (oEmbed) and duration (watch page) without downloading anything.
 * `exactEnd`: the shortest stream's precise length (approxDurationMs). Gemini returns an empty answer if a clip
 * ends even slightly past the real end, and the listed length is rounded UP (3643 vs 3642.57 s measured).
 */
export async function youTubeInfo(
  youtubeId: string,
): Promise<{ title: string | null; channel: string | null; thumbnail: string | null; duration: number | null; exactEnd: number | null }> {
  const url = youTubeWatchUrl(youtubeId);
  const [o, page] = await Promise.all([
    fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(20_000) })
      .then((r) => (r.ok ? (r.json() as Promise<{ title?: string; author_name?: string; thumbnail_url?: string }>) : null))
      .catch(() => null),
    fetch(url, { headers: { "accept-language": "en" }, signal: AbortSignal.timeout(20_000) })
      .then((r) => (r.ok ? r.text() : ""))
      .catch(() => ""),
  ]);
  const len = page.match(/"lengthSeconds":"(\d+)"/)?.[1] ?? page.match(/itemprop="duration" content="PT(?:(\d+)H)?(\d+)M(\d+)S"/)?.slice(1).join(":");
  let duration: number | null = null;
  if (len && /^\d+$/.test(len)) duration = Number(len);
  else if (len) {
    const [h, m, s] = len.split(":").map((x) => Number(x || 0));
    duration = h * 3600 + m * 60 + s;
  }
  const ms = [...page.matchAll(/"approxDurationMs":"(\d+)"/g)].map((m) => Number(m[1])).filter((n) => n > 0);
  const exactEnd = ms.length ? Math.min(...ms) / 1000 : null;
  return { title: o?.title ?? null, channel: o?.author_name ?? null, thumbnail: o?.thumbnail_url ?? null, duration: duration || null, exactEnd };
}
