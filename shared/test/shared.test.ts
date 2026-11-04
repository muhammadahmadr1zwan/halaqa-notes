import { describe, expect, it } from "vitest";
import { Packer } from "docx";
import {
  buildParagraphs,
  findMatches,
  formatHms,
  formatSrtTime,
  formatTimestamp,
  normalizeForSearch,
  parseTimestamp,
  parseYouTubeId,
  splitBidiRuns,
  toSrt,
  toTxt,
  type TranscriptDoc,
} from "../src/index.ts";
import { buildTranscriptDocx } from "../src/docx.ts";

const doc: TranscriptDoc = {
  segments: [
    { id: 0, start: 0, end: 4.2, speaker: "S1", text: "Bismillah. Today we study patience.", raw: "", para: true },
    { id: 1, start: 4.2, end: 9, speaker: "S1", text: "Allah says إِنَّ اللَّهَ مَعَ الصَّابِرِينَ, indeed Allah is with the patient.", raw: "" },
    { id: 2, start: 9.5, end: 12, speaker: "S2", text: "What is sabr exactly?", raw: "" },
    { id: 3, start: 3725.25, end: 3730, speaker: "S1", text: "الصبر is restraint.", raw: "", para: true },
  ],
  sections: [{ segmentId: 3, title: "Defining Sabr" }],
};

describe("youtube ids", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?si=abc", "dQw4w9WgXcQ"],
    ["youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://m.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://vimeo.com/123", null],
    ["not a link", null],
  ])("%s", (url, id) => expect(parseYouTubeId(url)).toBe(id));
});

describe("time", () => {
  it("formats", () => {
    expect(formatTimestamp(75)).toBe("1:15");
    expect(formatTimestamp(3725)).toBe("1:02:05");
    expect(formatHms(3725)).toBe("01:02:05");
    expect(formatSrtTime(3725.25)).toBe("01:02:05,250");
    expect(parseTimestamp("1:02:05")).toBe(3725);
    expect(parseTimestamp("02:05")).toBe(125);
    expect(parseTimestamp("x")).toBeNull();
  });
});

describe("arabic", () => {
  it("splits bidi runs keeping multi-word Arabic phrases together", () => {
    const runs = splitBidiRuns("Allah says إِنَّ اللَّهَ مَعَ الصَّابِرِينَ, indeed");
    expect(runs.map((r) => r.rtl)).toEqual([false, true, false]);
    expect(runs[1].text).toBe("إِنَّ اللَّهَ مَعَ الصَّابِرِينَ");
  });

  it("search ignores tashkeel, hamza forms and case", () => {
    expect(normalizeForSearch("إِنَّ اللَّهَ")).toBe("ان الله");
    const text = "Allah says إِنَّ اللَّهَ مَعَ الصَّابِرِينَ";
    const [m] = findMatches(text, "الصابرين");
    expect(text.slice(m[0], m[1])).toBe("الصَّابِرِينَ");
    expect(findMatches("Sabr and SABR", "sabr")).toHaveLength(2);
    expect(findMatches("The Qurʾān", "quran")).toHaveLength(1);
  });
});

describe("exports", () => {
  it("builds paragraphs with headings and speaker changes", () => {
    const ps = buildParagraphs(doc);
    expect(ps.map((p) => p.key)).toEqual([0, 2, 3]);
    expect(ps[2].heading).toBe("Defining Sabr");
  });

  it("txt keeps every sentence, timestamps and Arabic", () => {
    const txt = toTxt(doc, { title: "Class 1", speakerNames: { S2: "Student" } });
    for (const s of doc.segments) expect(txt).toContain(s.text);
    expect(txt).toContain("[01:02:05] Teacher:");
    expect(txt).toContain("Student:");
    expect(txt).toContain("## Defining Sabr");
  });

  it("srt is well formed", () => {
    const srt = toSrt(doc);
    expect(srt.startsWith("1\n00:00:00,000 --> 00:00:04,200\n")).toBe(true);
    expect(srt.match(/-->/g)).toHaveLength(4);
  });

  it("docx packs and contains right-to-left runs", async () => {
    const buf = await Packer.toBuffer(buildTranscriptDocx(doc, { title: "Class 1" }));
    expect(buf.length).toBeGreaterThan(1000);
    const JSZip = (await import("jszip")).default;
    const xml = await (await JSZip.loadAsync(buf)).file("word/document.xml")!.async("string");
    expect(xml).toContain("<w:rtl/>");
    expect(xml).toContain("الصَّابِرِينَ");
  });
});
