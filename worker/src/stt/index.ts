import type { Config } from "../config.ts";
import { elevenLabsProvider } from "./elevenlabs.ts";
import { localWhisperProvider } from "./local.ts";
import type { SttProvider } from "./types.ts";
import { whisperProvider } from "./whisper.ts";

export function createSttProvider(cfg: Config, which = cfg.sttProvider): SttProvider {
  if (which === "groq") return whisperProvider({ baseUrl: "https://api.groq.com/openai/v1", apiKey: cfg.groqApiKey, model: cfg.groqWhisperModel });
  if (which === "elevenlabs") return elevenLabsProvider({ apiKey: cfg.elevenlabsApiKey, model: cfg.elevenlabsModel, language: cfg.elevenlabsLanguage });
  return localWhisperProvider({ python: cfg.pythonPath, model: cfg.whisperLocalModel });
}

export * from "./types.ts";
