import type Anthropic from "@anthropic-ai/sdk";
import { callClaude, createClaude } from "./claude.ts";
import { sleep } from "./retry.ts";

/** A text model the worker can use for transcript cleanup and study notes. */
export interface Llm {
  name: string;
  /** Largest prompt (system + user) we will send, in tokens. Free tiers are small. */
  maxInputTokens: number;
  /** Largest answer we will ask for, in tokens. */
  maxOutputTokens: number;
  complete(o: { system: string; user: string; json?: boolean; maxTokens?: number }): Promise<string>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
  ) {
    super(message);
  }
}

/** The provider's free quota is used up for now (e.g. per-day limit). */
export class QuotaError extends LlmError {
  constructor(message: string) {
    super(message, false);
  }
}

/** Rough token estimate for mixed English/Arabic text. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3.2);

/** Strip ```json fences and parse. */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  return JSON.parse(start >= 0 && end > start ? t.slice(start, end + 1) : t);
}

function retryAfterMs(res: Response, body: string): number | null {
  const h = res.headers.get("retry-after");
  if (h && !Number.isNaN(Number(h))) return Number(h) * 1000;
  for (const k of ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
    const v = res.headers.get(k); // e.g. "2m59.56s", "7.66s"
    const m = v?.match(/(?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)s)?/);
    if (m && (m[1] || m[2] || m[3])) return ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000;
  }
  const g = body.match(/retry in ([\d.]+)s/i) ?? body.match(/"retryDelay":\s*"(\d+)s"/);
  return g ? Number(g[1]) * 1000 : null;
}

/** Any OpenAI-compatible chat endpoint: Gemini, Groq, GitHub Models, OpenRouter… */
export function openAICompatLlm(o: {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  extraBody?: Record<string, unknown>;
  /** Longest we'll wait on a rate limit before calling the quota exhausted. */
  maxWaitMs?: number;
}): Llm {
  const maxWait = o.maxWaitMs ?? 3 * 60_000;
  return {
    name: `${o.name}:${o.model}`,
    maxInputTokens: o.maxInputTokens,
    maxOutputTokens: o.maxOutputTokens,
    async complete({ system, user, json, maxTokens }) {
      for (let attempt = 1; ; attempt++) {
        let res: Response;
        try {
          res = await fetch(`${o.baseUrl.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: o.model,
              messages: [
                { role: "system", content: system },
                { role: "user", content: user },
              ],
              max_tokens: Math.min(maxTokens ?? o.maxOutputTokens, o.maxOutputTokens),
              temperature: 0.2,
              ...(json ? { response_format: { type: "json_object" } } : {}),
              ...o.extraBody,
            }),
            signal: AbortSignal.timeout(5 * 60_000),
          });
        } catch (e) {
          if (attempt >= 4) throw new LlmError(`${o.name} network error: ${(e as Error).message}`, true);
          await sleep(5000 * attempt);
          continue;
        }
        const body = await res.text();
        if (res.ok) {
          const j = JSON.parse(body) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
          const choice = j.choices?.[0];
          if (choice?.finish_reason === "length") throw new LlmError(`${o.name}: answer was cut off (too long)`, false);
          const content = choice?.message?.content;
          if (!content) throw new LlmError(`${o.name}: empty answer`, true);
          return content;
        }
        if (res.status === 429) {
          const wait = retryAfterMs(res, body) ?? 20_000 * attempt;
          if (wait > maxWait || attempt >= 8) throw new QuotaError(`${o.name} free quota reached (try again later): ${body.slice(0, 200)}`);
          await sleep(wait + 500);
          continue;
        }
        const retryable = res.status >= 500 || res.status === 408;
        if (retryable && attempt < 4) {
          await sleep(5000 * attempt);
          continue;
        }
        throw new LlmError(`${o.name} HTTP ${res.status}: ${body.slice(0, 400)}`, retryable);
      }
    },
  };
}

/** Claude (paid, optional). Large context; structured output enforced by the prompt + parser. */
export function anthropicLlm(client: Anthropic, model: string, effort: "low" | "medium" | "high"): Llm {
  return {
    name: `anthropic:${model}`,
    maxInputTokens: 400_000,
    maxOutputTokens: 32_000,
    async complete({ system, user, maxTokens }) {
      return callClaude(client, { model, effort, system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }], user, maxTokens: maxTokens ?? 32_000 });
    },
  };
}

export interface LlmConfig {
  llmProvider: string;
  anthropicApiKey: string;
  claudeModel: string;
  refineEffort: "low" | "medium" | "high";
  geminiApiKey: string;
  geminiModel: string;
  groqApiKey: string;
  groqLlmModel: string;
  githubModelsToken: string;
  githubModelsModel: string;
}

/**
 * Pick the AI text model. Free options first: Gemini (largest free context), then Groq,
 * then GitHub Models. Claude only if its (paid) key is set or chosen explicitly.
 */
export function createLlm(c: LlmConfig): Llm | null {
  const choice = c.llmProvider || "auto";
  const make: Record<string, () => Llm | null> = {
    anthropic: () => (c.anthropicApiKey ? anthropicLlm(createClaude(c.anthropicApiKey), c.claudeModel, c.refineEffort) : null),
    gemini: () =>
      c.geminiApiKey
        ? openAICompatLlm({
            name: "gemini",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
            apiKey: c.geminiApiKey,
            model: c.geminiModel,
            maxInputTokens: 120_000,
            maxOutputTokens: 8_000,
            extraBody: { reasoning_effort: "none" },
          })
        : null,
    groq: () =>
      c.groqApiKey
        ? openAICompatLlm({ name: "groq", baseUrl: "https://api.groq.com/openai/v1", apiKey: c.groqApiKey, model: c.groqLlmModel, maxInputTokens: 5_000, maxOutputTokens: 4_000 })
        : null,
    github: () =>
      c.githubModelsToken
        ? openAICompatLlm({ name: "github-models", baseUrl: "https://models.github.ai/inference", apiKey: c.githubModelsToken, model: c.githubModelsModel, maxInputTokens: 6_000, maxOutputTokens: 3_500 })
        : null,
  };
  if (choice === "none") return null;
  if (choice !== "auto") return make[choice]?.() ?? null;
  for (const k of ["anthropic", "gemini", "groq", "github"]) {
    const llm = make[k]();
    if (llm) return llm;
  }
  return null;
}
