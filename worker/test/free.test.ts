import { describe, expect, it } from "vitest";
import type { TranscriptDoc } from "@halaqa/shared";
import { createLlm, estimateTokens, parseJsonLoose, type Llm } from "../src/llm.ts";
import { batchWordsFor, llmRefiner } from "../src/refine.ts";
import { generateStudy, splitLines } from "../src/study.ts";

/** A fake model with a small free-tier-like context window that records every prompt. */
function fakeLlm(maxInputTokens: number, answer: (user: string) => string): Llm & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    name: "fake",
    maxInputTokens,
    maxOutputTokens: 2000,
    prompts,
    async complete({ system, user }) {
      expect(estimateTokens(system + user)).toBeLessThanOrEqual(maxInputTokens + 200);
      prompts.push(user);
      return answer(user);
    },
  };
}

// ~6 hours of class: 1,000 paragraphs, ~40 words each.
const longDoc: TranscriptDoc = {
  segments: Array.from({ length: 1000 }, (_, i) => ({
    id: i,
    start: i * 21.6,
    end: i * 21.6 + 20,
    speaker: "S1",
    text: `Point ${i}: the teacher explains صبر and patience in hardship with an example from the Seerah and practical advice for daily life today.`,
    raw: "",
    para: true,
  })),
  sections: [],
};

describe("free AI providers", () => {
  it("parses JSON wrapped in code fences or chatter", () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('Here you go: {"a":[1,2]} hope it helps')).toEqual({ a: [1, 2] });
  });

  it("picks the first configured free provider and Claude only when its key is set", () => {
    const base = { llmProvider: "auto", anthropicApiKey: "", claudeModel: "m", refineEffort: "low" as const, geminiApiKey: "", geminiModel: "g", groqApiKey: "", groqLlmModel: "q", githubModelsToken: "", githubModelsModel: "h" };
    expect(createLlm(base)).toBeNull();
    expect(createLlm({ ...base, groqApiKey: "k" })!.name).toBe("groq:q");
    expect(createLlm({ ...base, groqApiKey: "k", geminiApiKey: "k" })!.name).toBe("gemini:g");
    expect(createLlm({ ...base, geminiApiKey: "k", llmProvider: "groq" })).toBeNull();
    expect(createLlm({ ...base, githubModelsToken: "t" })!.name).toBe("github-models:h");
  });

  it("sizes cleanup batches to fit small free limits", () => {
    expect(batchWordsFor({ maxInputTokens: 6000, maxOutputTokens: 3500 })).toBeLessThan(1100);
    expect(batchWordsFor({ maxInputTokens: 120_000, maxOutputTokens: 8000 })).toBe(2000);
  });

  it("refiner retries once on malformed JSON", async () => {
    let calls = 0;
    const llm = fakeLlm(6000, () => (++calls === 1 ? "sorry, not json" : '{"segments":[{"id":0,"text":"Hi."}],"paragraph_starts":[0],"headings":[]}'));
    const r = await llmRefiner(llm).refineBatch([{ id: 0, start: 0, end: 1, speaker: "S1", text: "", raw: "hi" }], []);
    expect(r.segments[0].text).toBe("Hi.");
    expect(calls).toBe(2);
  });
});

describe("study notes on a small free context window (map-reduce)", () => {
  it("splits long transcripts, reuses per-part notes, and stays within the limit", async () => {
    const llm = fakeLlm(6000, (user) => (user.includes("Condense") ? "- condensed [00:10:00]" : user.includes("one part of a longer class") ? "## Part notes [00:00:00]\n- point" : "FINAL"));
    const notes = await generateStudy(llm, "notes", "Class", "c1", longDoc, {});
    const mapCalls = llm.prompts.length;
    expect(mapCalls).toBeGreaterThan(3);
    expect(notes.content).toContain("## Part notes");
    const summary = await generateStudy(llm, "summary", "Class", "c1", longDoc, {});
    expect(summary.content).toBe("FINAL");
    // per-part notes were reused: summary only added the final call (no condense needed here)
    expect(llm.prompts.length).toBe(mapCalls + 1);
  });

  it("merges the glossary across parts, keeping first appearance and the teacher's explanation", async () => {
    let part = 0;
    const llm = fakeLlm(6000, () => {
      part++;
      return JSON.stringify({
        entries: [
          { term: "صبر", transliteration: "sabr", meaning: part === 1 ? "patience" : "restraint as the teacher defined it", explained_in_class: part !== 1, first_timestamp: part === 1 ? "00:01:00" : "02:00:00" },
          ...(part === 2 ? [{ term: "تقوى", transliteration: "taqwa", meaning: "God-consciousness", explained_in_class: false, first_timestamp: "02:10:00" }] : []),
        ],
      });
    });
    const { data } = await generateStudy(llm, "glossary", "Class", "c2", longDoc, {});
    expect(data!.map((e) => e.term)).toEqual(["صبر", "تقوى"]);
    expect(data![0]).toMatchObject({ explainedInClass: true, firstTimestamp: 60 });
  });

  it("uses one pass when the transcript fits", async () => {
    const llm = fakeLlm(200_000, () => "ONE");
    const r = await generateStudy(llm, "takeaways", "Class", "c3", longDoc, {});
    expect(r.content).toBe("ONE");
    expect(llm.prompts).toHaveLength(1);
    expect(splitLines(["a", "b"], 100)).toEqual(["a\nb"]);
  });
});
