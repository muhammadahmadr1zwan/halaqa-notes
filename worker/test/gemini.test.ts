import { describe, expect, it } from "vitest";
import { parseTimedLines } from "../src/gemini.ts";

describe("parseTimedLines", () => {
  it("offsets clip-relative timestamps, keeps Arabic, drops lines past the clip", () => {
    const text = "[00:00] بسم الله الرحمن الرحيم.\nnoise line\n[02:24] And then he said صلى الله عليه وسلم\n[1:00:00] past the end\n[19:58] last words";
    const segs = parseTimedLines(text, 1200, 2400);
    expect(segs.map((s) => s.start)).toEqual([1200, 1344, 2398]);
    expect(segs[0].text).toBe("بسم الله الرحمن الرحيم.");
    expect(segs[0].end).toBe(1344);
    expect(segs[2].end).toBe(2400);
  });

  it("accepts timestamps on the video's own clock", () => {
    const segs = parseTimedLines("[20:05] first\n[39:59] last\n[41:00] beyond", 1200, 2400);
    expect(segs.map((s) => s.start)).toEqual([1205, 2399]);
  });
});
