import os from "node:os";
import path from "node:path";

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
}

export function loadConfig(env = process.env) {
  const required = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`Missing required setting ${k} (see .env.example)`);
    return v;
  };
  return {
    workerId: env.WORKER_ID || `${os.hostname()}-${process.pid}`,
    /** Your Netlify site, e.g. https://halaqa-notes.netlify.app */
    apiUrl: required("API_URL").replace(/\/$/, ""),
    workerSecret: required("WORKER_SECRET"),

    /** Speech-to-text: "local" (free, on this computer), "groq" (free key), "elevenlabs" (paid). */
    sttProvider: (env.STT_PROVIDER || "local") as "local" | "groq" | "elevenlabs",
    pythonPath: env.PYTHON_PATH || (process.platform === "win32" ? "python" : "python3"),
    whisperLocalModel: env.WHISPER_LOCAL_MODEL || "large-v3-turbo",
    groqApiKey: env.GROQ_API_KEY || "",
    groqWhisperModel: env.GROQ_WHISPER_MODEL || "whisper-large-v3",
    elevenlabsApiKey: env.ELEVENLABS_API_KEY || "",
    elevenlabsModel: env.ELEVENLABS_MODEL || "scribe_v2",
    elevenlabsLanguage: env.ELEVENLABS_LANGUAGE || "",

    /** AI cleanup + study notes: "auto" picks the first configured: anthropic, gemini, groq, github. */
    llmProvider: env.LLM_PROVIDER || "auto",
    geminiApiKey: env.GEMINI_API_KEY || "",
    geminiModel: env.GEMINI_MODEL || "gemini-flash-latest",
    groqLlmModel: env.GROQ_LLM_MODEL || "llama-3.3-70b-versatile",
    githubModelsToken: env.GITHUB_MODELS_TOKEN || "",
    githubModelsModel: env.GITHUB_MODELS_MODEL || "openai/gpt-4.1-mini",
    anthropicApiKey: env.ANTHROPIC_API_KEY || "",
    claudeModel: env.CLAUDE_MODEL || "claude-opus-5-5",
    refineEffort: (env.REFINE_EFFORT || "low") as "low" | "medium" | "high",
    refineConcurrency: num(env.REFINE_CONCURRENCY, 2),

    ffmpegPath: env.FFMPEG_PATH || "",
    ytdlpPath: env.YTDLP_PATH || "yt-dlp",
    ytdlpCookiesB64: env.YTDLP_COOKIES_B64 || "",
    ytdlpProxy: env.YTDLP_PROXY || "",

    chunkSeconds: num(env.CHUNK_MINUTES, 20) * 60,
    maxDurationHours: num(env.MAX_DURATION_HOURS, 12),
    maxAttempts: num(env.MAX_ATTEMPTS, 5),
    pollSeconds: num(env.POLL_SECONDS, 10),
    workDir: env.WORK_DIR || path.join(os.tmpdir(), "halaqa-worker"),
  };
}

export type Config = ReturnType<typeof loadConfig>;
