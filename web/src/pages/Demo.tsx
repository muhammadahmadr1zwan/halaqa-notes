/** Dev-only preview of the transcript screen with sample data (no Supabase needed): /demo */
import type { ClassRow, TranscriptDoc } from "@halaqa/shared";
import { Header } from "../components/Header";
import { Workspace } from "./ClassPage";

const lines: Array<[number, string, string, boolean?]> = [
  [0, "S1", "بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ. Alhamdulillah, welcome back everyone to our class on the book of patience.", true],
  [9, "S1", "Last week we stopped at the chapter on hardship, and today, إن شاء الله, we continue from there."],
  [17, "S1", "Allah says in Surah al-Baqarah: إِنَّ اللَّهَ مَعَ الصَّابِرِينَ — indeed Allah is with those who are patient."],
  [28, "S1", "Notice that the verse does not only say Allah loves them. It says Allah is with them. This is the meaning of مَعِيَّة, a special closeness.", true],
  [41, "S1", "And the scholars explain that صبر has three parts: patience upon obedience, patience away from disobedience, and patience with the decree of Allah."],
  [55, "S2", "Sheikh, is it still patience if a person cries when something bad happens?", true],
  [61, "S1", "Very good question. Crying is not against صبر. The Prophet ﷺ himself cried when his son Ibrahim passed away, and he said: إِنَّ الْعَيْنَ تَدْمَعُ وَالْقَلْبَ يَحْزَنُ.", true],
  [78, "S1", "What is against patience is complaining against Allah, saying things that show you are unhappy with His decree."],
  [3605, "S1", "Now let us move to the second chapter, which is about gratitude, شُكْر, and how it connects to patience.", true],
  [3614, "S1", "Ibn al-Qayyim says that faith is two halves: one half is صبر and the other half is شُكْر."],
];

const doc: TranscriptDoc = {
  segments: lines.map(([start, speaker, text, para], i) => ({ id: i, start, end: (lines[i + 1]?.[0] ?? start + 12) - 0.5, speaker, text, raw: text, para })),
  sections: [
    { segmentId: 0, title: "Opening and Review" },
    { segmentId: 3, title: "Allah Is With the Patient" },
    { segmentId: 8, title: "Gratitude — شُكْر" },
  ],
};

const cls: ClassRow = {
  id: "demo",
  user_id: "demo",
  source_type: "youtube",
  youtube_id: "jNQXAC9IVRw",
  source_url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  storage_path: null,
  upload_fingerprint: null,
  title: "Kitab al-Sabr — Lesson 12: Patience in Hardship",
  channel: "Masjid Study Circle",
  thumbnail_url: null,
  class_date: "2026-10-28",
  duration_seconds: 5 * 3600 + 42 * 60,
  status: "completed",
  stage: "done",
  progress: 1,
  status_message: null,
  error: null,
  error_code: null,
  transcript_source: "ai",
  provider: "demo",
  attempts: 1,
  speaker_names: {},
  created_at: "",
  updated_at: "",
};

export function Demo() {
  return (
    <>
      <Header />
      <main className="mx-auto max-w-6xl px-4 pb-24">
        <h1 className="mt-6 text-2xl font-semibold sm:text-3xl">{cls.title}</h1>
        <p className="mt-2 text-muted">Tue, 28 October 2026 · 5h 42m · {cls.channel}</p>
        <Workspace c={cls} doc={doc} />
      </main>
    </>
  );
}
