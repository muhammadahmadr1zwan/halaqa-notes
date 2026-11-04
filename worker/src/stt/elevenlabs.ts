import fs from "node:fs/promises";
import path from "node:path";
import { wordsToSegments, type Word } from "../segmenting.ts";
import { httpError, SttError, type SttProvider, type SttResult } from "./types.ts";

interface ScribeWord {
  text: string;
  start: number | null;
  end: number | null;
  type: "word" | "spacing" | "audio_event";
  speaker_id?: string | null;
}

/** Convert a Scribe response into segments (exported for tests). */
export function scribeToResult(json: { language_code?: string; words?: ScribeWord[] }): SttResult {
  const words: Word[] = [];
  for (const w of json.words ?? []) {
    if (w.type !== "word" || w.start == null || w.end == null) continue;
    words.push({ text: w.text, start: w.start, end: w.end, speaker: w.speaker_id ?? null });
  }
  return { segments: wordsToSegments(words), language: json.language_code };
}

/**
 * ElevenLabs Scribe: multilingual, handles English/Arabic code-switching in one pass,
 * word timestamps + diarization. https://elevenlabs.io/docs/api-reference/speech-to-text/convert
 */
export function elevenLabsProvider(opts: { apiKey: string; model: string; language?: string }): SttProvider {
  if (!opts.apiKey) throw new Error("ELEVENLABS_API_KEY is required when STT_PROVIDER=elevenlabs");
  return {
    name: `elevenlabs:${opts.model}`,
    async transcribe(file: string) {
      const form = new FormData();
      form.set("model_id", opts.model);
      form.set("diarize", "true");
      form.set("timestamps_granularity", "word");
      form.set("tag_audio_events", "false");
      if (opts.language) form.set("language_code", opts.language);
      form.set("file", new Blob([await fs.readFile(file)], { type: "audio/mpeg" }), path.basename(file));
      let res: Response;
      try {
        res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
          method: "POST",
          headers: { "xi-api-key": opts.apiKey },
          body: form,
          signal: AbortSignal.timeout(20 * 60_000),
        });
      } catch (e) {
        throw new SttError(`ElevenLabs network error: ${(e as Error).message}`, true);
      }
      if (!res.ok) throw httpError("ElevenLabs", res.status, await res.text());
      return scribeToResult(await res.json());
    },
  };
}
