import { describe, expect, it } from "vitest";
import { parseJson3, pickCaptionTrack } from "../src/captions.ts";
import { parseFfmpegDuration, parseSilences, planChunks } from "../src/chunking.ts";
import { classifyYtDlpError } from "../src/errors.ts";
import { applyRefinement, makeBatches } from "../src/refine.ts";
import { checkRefinement } from "../src/refineGuard.ts";
import { mapSpeakersDominant, offsetSegments, wordsToSegments } from "../src/segmenting.ts";
import { scribeToResult } from "../src/stt/elevenlabs.ts";
import type { Segment } from "@halaqa/shared";

describe("chunk planning", () => {
  it("cuts inside the longest pause near each 20-minute mark", () => {
    const silences = [
      { start: 1150, end: 1150.5 },
      { start: 1210, end: 1212 }, // longest within window -> chosen
      { start: 2390, end: 2391 },
    ];
    const plan = planChunks(3000, silences, 1200, 120);
    expect(plan.map((c) => [c.start, c.end])).toEqual([
      [0, 1211],
      [1211, 2390.5],
      [2390.5, 3000],
    ]);
  });

  it("falls back to a hard cut without pauses and covers the whole recording", () => {
    const plan = planChunks(8 * 3600, [], 1200, 120);
    expect(plan[0]).toEqual({ idx: 0, start: 0, end: 1200 });
    expect(plan.at(-1)!.end).toBe(8 * 3600);
    for (let i = 1; i < plan.length; i++) expect(plan[i].start).toBe(plan[i - 1].end);
  });

  it("keeps short recordings as one chunk", () => {
    expect(planChunks(1400, [], 1200)).toEqual([{ idx: 0, start: 0, end: 1400 }]);
  });

  it("parses ffmpeg output", () => {
    const err = "[silencedetect @ 0x1] silence_start: 8.0012\n[silencedetect @ 0x1] silence_end: 10.002 | silence_duration: 2\n  Duration: 05:12:03.50, start: 0";
    expect(parseSilences(err)).toEqual([{ start: 8.0012, end: 10.002 }]);
    expect(parseFfmpegDuration(err)).toBeCloseTo(5 * 3600 + 12 * 60 + 3.5);
  });
});

describe("segmenting", () => {
  it("groups words by sentence, pause and speaker", () => {
    const w = (text: string, start: number, speaker = "a") => ({ text, start, end: start + 0.3, speaker });
    const words = [
      ...["Today", "we", "will", "talk", "about", "the", "meaning", "of", "patience."].map((t, i) => w(t, i * 0.4)),
      w("Sabr", 3.7),
      w("is", 4.1),
      w("Question?", 9, "b"),
    ];
    const segs = wordsToSegments(words);
    expect(segs.map((s) => s.text)).toEqual(["Today we will talk about the meaning of patience.", "Sabr is", "Question?"]);
    const mapped = mapSpeakersDominant(segs);
    expect(mapped.map((s) => s.speaker)).toEqual(["S1", "S1", "S2"]);
    expect(offsetSegments(mapped, 1200)[2].start).toBe(1209);
  });

  it("reads ElevenLabs Scribe responses (skipping spacing tokens)", () => {
    const r = scribeToResult({
      language_code: "en",
      words: [
        { text: "Bismillah", start: 0, end: 0.6, type: "word", speaker_id: "speaker_0" },
        { text: " ", start: 0.6, end: 0.7, type: "spacing", speaker_id: "speaker_0" },
        { text: "الرحمن", start: 0.7, end: 1.2, type: "word", speaker_id: "speaker_0" },
      ],
    });
    expect(r.segments).toEqual([{ start: 0, end: 1.2, text: "Bismillah الرحمن", speaker: "speaker_0" }]);
  });
});

describe("youtube captions", () => {
  it("parses json3 and merges cues", () => {
    const json = {
      events: [
        { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: "[Music]" }] },
        { tStartMs: 2000, dDurationMs: 3000, segs: [{ utf8: "assalamu alaikum" }, { utf8: " everyone" }] },
        { tStartMs: 4000, dDurationMs: 3000, segs: [{ utf8: "today we begin" }] },
        { tStartMs: 4500 },
        { tStartMs: 20000, dDurationMs: 2000, segs: [{ utf8: "next part" }] },
      ],
    };
    const segs = parseJson3(json);
    expect(segs.map((s) => s.text)).toEqual(["assalamu alaikum everyone today we begin", "next part"]);
    expect(segs[0].start).toBe(2);
  });

  it("never picks machine-translated tracks", () => {
    expect(pickCaptionTrack({ subtitles: { ar: [] }, automatic_captions: { "en-orig": [] } })).toEqual({ lang: "ar", auto: false });
    expect(pickCaptionTrack({ subtitles: {}, automatic_captions: { "en-orig": [], ar: [], fr: [] } })).toEqual({ lang: "en-orig", auto: true });
    expect(pickCaptionTrack({ language: "en", automatic_captions: { en: [], ar: [] } })).toEqual({ lang: "en", auto: true });
    expect(pickCaptionTrack({ subtitles: { live_chat: [] }, automatic_captions: {} })).toBeNull();
  });
});

describe("yt-dlp error classification", () => {
  it.each([
    ["ERROR: [youtube] abc: Private video. Sign in if you've been granted access", "PRIVATE", true],
    ["ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies", "BOT_CHECK", true],
    ["ERROR: [youtube] abc: Join this channel to get access to members-only content", "MEMBERS_ONLY", true],
    ["ERROR: [youtube] abc: Video unavailable", "UNAVAILABLE", true],
    ["ERROR: unable to download video data: HTTP Error 429: Too Many Requests", "RATE_LIMITED", false],
    ["ERROR: something odd", "DOWNLOAD_FAILED", false],
  ])("%s", (stderr, code, permanent) => {
    const e = classifyYtDlpError(stderr);
    expect(e.code).toBe(code);
    expect(e.permanent).toBe(permanent);
  });
});

describe("hallucination guard", () => {
  it.each([
    ["punctuation + spelling fixes", "so today inshallah we will talk about sabur and how", "So today, إن شاء الله, we will talk about صبر and how", true],
    ["transliterated verse -> Arabic script", "inna allaha ma'a as-sabireen", "إِنَّ اللَّهَ مَعَ الصَّابِرِينَ", true],
    ["misheard word fixed", "the prophet sallallahu alaihi wasallam set", "The Prophet ﷺ said", true],
    ["completing a verse that was not recited", "and Allah says in the Quran", "And Allah says in the Quran: وَلَنَبْلُوَنَّكُم بِشَيْءٍ مِّنَ الْخَوْفِ وَالْجُوعِ", false],
    ["paraphrasing", "you have to be patient when things get hard for you", "Patience is required in hardship.", false],
    ["dropping speech", "and this is something that a lot of people forget about", "And this.", false],
    ["adding a translation", "subhanallah", "سبحان الله, which means glory be to Allah", false],
    ["inserting a negation", "you should pray on time", "You should not pray on time.", false],
    ["dropping existing Arabic", "he said الحمد لله رب العالمين then continued", "He said then continued.", false],
  ])("%s", (_name, original, refined, ok) => {
    expect(checkRefinement(original, refined).ok).toBe(ok);
  });
});

describe("applying refinements", () => {
  const segs: Segment[] = [
    { id: 0, start: 0, end: 3, speaker: "S1", text: "", raw: "bismillah today we start" },
    { id: 1, start: 3, end: 6, speaker: "S1", text: "", raw: "the topic is sabr" },
    { id: 2, start: 6, end: 9, speaker: "S1", text: "", raw: "allah says in the quran" },
  ];
  it("keeps raw text for missing or rejected segments and only valid headings", () => {
    const stats = { accepted: 0, rejected: 0, missing: 0 };
    const { segments, sections } = applyRefinement(
      segs,
      {
        segments: [
          { id: 0, text: "بسم الله. Today we start." },
          { id: 2, text: "Allah says in the Quran: إِنَّ اللَّهَ مَعَ الصَّابِرِينَ وَالْمُتَّقِينَ" },
          { id: 99, text: "invented" },
        ],
        paragraph_starts: [0, 2],
        headings: [{ id: 1, title: "The Topic of Sabr" }, { id: 42, title: "Nope" }],
      },
      stats,
    );
    expect(segments.map((s) => s.text)).toEqual(["بسم الله. Today we start.", "the topic is sabr", "allah says in the quran"]);
    expect(stats).toEqual({ accepted: 1, rejected: 1, missing: 1 });
    expect(sections).toEqual([{ segmentId: 1, title: "The Topic of Sabr" }]);
    expect(segments.map((s) => s.para)).toEqual([true, false, true]);
  });

  it("batches are deterministic and cover every segment once", () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ id: i, start: i, end: i + 1, speaker: "S1", text: "", raw: "one two three four five six seven eight nine ten" }));
    const b = makeBatches(many, 2000);
    expect(b.flat().map((s) => s.id)).toEqual(many.map((s) => s.id));
    expect(b.every((x) => x.length <= 200)).toBe(true);
    expect(makeBatches(many, 2000).map((x) => x[0].id)).toEqual(b.map((x) => x[0].id));
  });
});
