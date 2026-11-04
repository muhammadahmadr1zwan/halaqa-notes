import fs from "node:fs/promises";
import path from "node:path";
import { sleep } from "../retry.ts";
import { httpError, SttError, type SttProvider } from "./types.ts";

/**
 * Any OpenAI-compatible /audio/transcriptions endpoint that returns verbose_json segments
 * (Groq whisper-large-v3 is the cheapest). No diarization: everything is attributed to the teacher.
 * Files must be under the provider's upload limit (20-minute 48 kbps chunks are ~7 MB).
 */
export function whisperProvider(opts: { baseUrl: string; apiKey: string; model: string }): SttProvider {
  if (!opts.apiKey) throw new Error("WHISPER_API_KEY is required when STT_PROVIDER=whisper");
  return {
    name: `whisper:${opts.model}`,
    async transcribe(file: string) {
      const form = new FormData();
      form.set("model", opts.model);
      form.set("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "segment");
      form.set("temperature", "0");
      // A style prompt nudges Whisper to keep Arabic in Arabic script instead of transliterating.
      form.set("prompt", "An Islamic class in English. Quran verses, hadith and duas are recited in Arabic: بسم الله الرحمن الرحيم. الحمد لله رب العالمين.");
      form.set("file", new Blob([await fs.readFile(file)], { type: "audio/mpeg" }), path.basename(file));
      let res: Response;
      for (let attempt = 1; ; attempt++) {
        try {
          res = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
            method: "POST",
            headers: { Authorization: `Bearer ${opts.apiKey}` },
            body: form,
            signal: AbortSignal.timeout(15 * 60_000),
          });
        } catch (e) {
          throw new SttError(`Whisper network error: ${(e as Error).message}`, true);
        }
        // Free tiers cap audio per hour: wait it out (up to 20 min) instead of failing.
        if (res.status === 429 && attempt <= 6) {
          const after = Number(res.headers.get("retry-after"));
          const waitMs = Number.isFinite(after) && after > 0 ? after * 1000 : 60_000 * attempt;
          if (waitMs <= 20 * 60_000) {
            await sleep(waitMs + 1000);
            continue;
          }
        }
        break;
      }
      if (!res.ok) throw httpError("Whisper", res.status, await res.text());
      const j = (await res.json()) as { language?: string; segments?: Array<{ start: number; end: number; text: string; no_speech_prob?: number }> };
      const segments = (j.segments ?? [])
        // Whisper hallucinates text over silence; drop segments it is confident contain no speech.
        .filter((s) => s.text.trim() && (s.no_speech_prob ?? 0) < 0.8)
        .map((s) => ({ start: s.start, end: s.end, text: s.text.trim(), speaker: "S1" }));
      return { segments, language: j.language };
    },
  };
}
