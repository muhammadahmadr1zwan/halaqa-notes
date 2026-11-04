import Anthropic from "@anthropic-ai/sdk";
import type { BetaTextBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";

export class RefusalError extends Error {}

export interface ClaudeCallOptions {
  model: string;
  effort: "low" | "medium" | "high";
  system: BetaTextBlockParam[];
  user: string;
  maxTokens?: number;
  /** JSON schema for structured output; when set the parsed object is returned. */
  schema?: Record<string, unknown>;
}

/**
 * One streamed Claude request with server-side refusal fallback.
 * Streaming avoids HTTP timeouts on long inputs/outputs; the SDK retries 429/5xx itself.
 */
export async function callClaude(client: Anthropic, o: ClaudeCallOptions): Promise<string> {
  const stream = client.beta.messages.stream({
    model: o.model,
    max_tokens: o.maxTokens ?? 32000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: o.effort,
      ...(o.schema ? { format: { type: "json_schema" as const, schema: o.schema } } : {}),
    },
    system: o.system,
    messages: [{ role: "user", content: o.user }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new RefusalError("Claude declined this request");
  if (msg.stop_reason === "max_tokens") throw new Error("Claude output hit max_tokens");
  return msg.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("");
}

export function createClaude(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, maxRetries: 4 });
}
