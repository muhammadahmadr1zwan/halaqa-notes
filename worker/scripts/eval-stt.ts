/**
 * Compare speech-to-text providers on a real class recording before choosing one.
 *
 *   npm run eval:stt -- --audio clip.mp3 --reference clip.txt [--providers elevenlabs,elevenlabs:en,whisper] [--refine]
 *
 * --reference is a carefully corrected transcript of the same clip (Arabic in Arabic script).
 * Reports: English word error rate, Arabic character error rate, and whether Arabic came out
 * in Arabic script or as transliteration. Outputs are saved to worker/eval-out/ for reading.
 */
import fs from "node:fs/promises";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { countArabicWords, normalizeForSearch } from "@halaqa/shared";
import { loadConfig } from "../src/config.ts";
import { createLlm } from "../src/llm.ts";
import { createMedia } from "../src/media.ts";
import { applyRefinement, llmRefiner, makeBatches } from "../src/refine.ts";
import { elevenLabsProvider } from "../src/stt/elevenlabs.ts";
import { whisperProvider } from "../src/stt/whisper.ts";
import { localWhisperProvider } from "../src/stt/local.ts";
import type { SttProvider } from "../src/stt/types.ts";

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../../.env"));
} catch {}

const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const audio = arg("audio");
const reference = arg("reference");
if (!audio || !reference) {
  console.error("Usage: npm run eval:stt -- --audio clip.mp3 --reference clip.txt [--providers local,local:large-v3,groq,elevenlabs] [--refine]");
  process.exit(1);
}

const cfg = loadConfig({ API_URL: "-", WORKER_SECRET: "-", ...process.env });
const providers: SttProvider[] = (arg("providers") ?? "local").split(",").map((p) => {
  const [name, opt] = p.split(":");
  if (name === "local") return localWhisperProvider({ python: cfg.pythonPath, model: opt || cfg.whisperLocalModel });
  if (name === "groq") return whisperProvider({ baseUrl: "https://api.groq.com/openai/v1", apiKey: cfg.groqApiKey, model: opt || cfg.groqWhisperModel });
  const prov = elevenLabsProvider({ apiKey: cfg.elevenlabsApiKey, model: cfg.elevenlabsModel, language: opt });
  return { ...prov, name: prov.name + (opt ? `[lang=${opt}]` : "[auto]") };
});

// ── metrics ──
const AR_LETTER = /[ء-يٱ-ۓ]/;
const latinTokens = (t: string) => normalizeForSearch(t).match(/[a-z0-9']+/g) ?? [];
const arabicChars = (t: string) => [...normalizeForSearch(t)].filter((c) => AR_LETTER.test(c));

function editDistance<T>(a: T[], b: T[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

function score(ref: string, hyp: string) {
  const rl = latinTokens(ref);
  const ra = arabicChars(ref);
  return {
    englishWER: rl.length ? editDistance(rl, latinTokens(hyp)) / rl.length : 0,
    arabicCER: ra.length ? editDistance(ra, arabicChars(hyp)) / ra.length : 0,
    arabicWords: `${countArabicWords(hyp)} / ${countArabicWords(ref)} expected`,
  };
}

// ── run ──
const ff = cfg.ffmpegPath === "ffmpeg" && ffmpegStatic ? (ffmpegStatic as unknown as string) : cfg.ffmpegPath;
const media = createMedia({ ffmpegPath: ff, ytdlpPath: cfg.ytdlpPath });
const outDir = path.resolve(import.meta.dirname, "../eval-out");
await fs.mkdir(outDir, { recursive: true });
const normalized = await media.normalizeAudio(path.resolve(audio), path.join(outDir, "clip.mp3"));
const minutes = (await media.duration(normalized)) / 60;
const refText = await fs.readFile(reference, "utf8");
console.log(`Clip: ${minutes.toFixed(1)} min, reference: ${latinTokens(refText).length} English words, ${countArabicWords(refText)} Arabic words\n`);

const rows: Record<string, unknown>[] = [];
for (const p of providers) {
  const t0 = Date.now();
  try {
    const res = await p.transcribe(normalized);
    const text = res.segments.map((s) => s.text).join(" ");
    const file = path.join(outDir, `${p.name.replace(/[^\w.-]+/g, "_")}.txt`);
    await fs.writeFile(file, res.segments.map((s) => `[${s.start.toFixed(1)}] ${s.speaker}: ${s.text}`).join("\n"));
    rows.push({ provider: p.name, ...pct(score(refText, text)), seconds: Math.round((Date.now() - t0) / 1000) });

    const llm = args.includes("--refine") ? createLlm(cfg) : null;
    if (llm) {
      const refiner = llmRefiner(llm);
      const segs = res.segments.map((s, i) => ({ id: i, start: s.start, end: s.end, speaker: "S1", text: s.text, raw: s.text }));
      const stats = { accepted: 0, rejected: 0, missing: 0 };
      const refined = [];
      for (const b of makeBatches(segs, refiner.batchWords)) refined.push(...applyRefinement(b, await refiner.refineBatch(b, []), stats).segments);
      const rtext = refined.map((s) => s.text).join(" ");
      await fs.writeFile(file.replace(/\.txt$/, ".refined.txt"), refined.map((s) => s.text).join("\n"));
      rows.push({ provider: `${p.name} + ${llm.name}`, ...pct(score(refText, rtext)), seconds: `guard kept ${stats.rejected} originals` });
    }
  } catch (e) {
    rows.push({ provider: p.name, error: (e as Error).message.slice(0, 120) });
  }
}

function pct(s: ReturnType<typeof score>) {
  return { englishWER: `${(s.englishWER * 100).toFixed(1)}%`, arabicCER: `${(s.arabicCER * 100).toFixed(1)}%`, arabicWords: s.arabicWords };
}

console.table(rows);
console.log(`\nLower is better for WER/CER. Full outputs: ${outDir}`);
