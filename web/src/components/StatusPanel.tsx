import { useState } from "react";
import type { ClassRow } from "@halaqa/shared";
import { retryClass } from "../lib/api";
import { Button, Card, Icon, ProgressBar, Spinner } from "./ui";

const STEPS = [
  { key: "fetching", label: "Getting the audio" },
  { key: "transcribing", label: "Transcribing" },
  { key: "refining", label: "Polishing & Arabic" },
  { key: "finishing", label: "Saving" },
];

export function StatusPanel({ cls, onRetried, workerOnline }: { cls: ClassRow; onRetried: () => void; workerOnline?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (cls.status === "failed") {
    return (
      <Card className="border-danger/30 bg-danger-soft p-6">
        <h2 className="text-xl font-semibold text-danger">We couldn't finish this class</h2>
        <p className="mt-2 text-lg leading-relaxed">{cls.error || "Something went wrong."}</p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await retryClass(cls.id);
                onRetried();
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Spinner /> : <Icon name="refresh" />} Try again
          </Button>
        </div>
        {err && <p className="mt-3 text-danger">{err}</p>}
        <p className="mt-4 text-sm text-muted">Any parts that were already transcribed are kept, so trying again won't cost extra for those parts.</p>
      </Card>
    );
  }

  const stepIdx = Math.max(0, STEPS.findIndex((s) => s.key === cls.stage));
  const waiting = cls.status === "queued";
  const cloud = cls.engine === "cloud";
  // Cloud lectures don't need the home computer, so never show "switched off" for them.
  const offline = workerOnline === false && !cloud;
  const headline = offline
    ? waiting
      ? "Your lecture is in the queue"
      : "Paused for now"
    : waiting && cls.attempts === 0
      ? "Added! Waiting to start…"
      : "Processing your lecture…";
  const detail = offline
    ? "The home computer that prepares transcripts is switched off. Nothing is lost: it will continue automatically when the computer is turned on."
    : cls.status_message || (waiting ? "It will start in a moment." : "Starting…");
  const closeNote = cloud ? "You can close the app — this keeps going online and will be ready when you come back." : null;
  return (
    <Card className="p-6">
      <div className="flex items-center gap-3">
        {offline ? <Icon name="refresh" className="size-6 text-gold" /> : <Spinner className="size-6 text-brand" />}
        <h2 className="text-xl font-semibold">{headline}</h2>
      </div>
      <ProgressBar value={cls.progress} className="mt-5" />
      <p className="mt-3 text-lg">{detail}</p>
      {closeNote && <p className="mt-2 text-muted">{closeNote}</p>}
      <ol className="mt-6 grid gap-2 sm:grid-cols-4">
        {STEPS.map((s, i) => {
          const done = !waiting && i < stepIdx;
          const now = !waiting && i === stepIdx;
          return (
            <li key={s.key} className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm ${now ? "bg-brand-soft font-semibold text-brand" : done ? "text-ink" : "text-muted"}`}>
              <span className={`grid size-6 place-items-center rounded-full text-xs ${done ? "bg-brand text-white" : now ? "border-2 border-brand" : "border border-line"}`}>
                {done ? <Icon name="check" className="size-4" /> : i + 1}
              </span>
              {s.label}
            </li>
          );
        })}
      </ol>
      <p className="mt-6 rounded-xl bg-gold-soft px-4 py-3 text-base">
        {cloud
          ? "You can close this page and come back later. What is already transcribed is saved, and the lecture will be in your library when it is ready. A very long one may continue the next day."
          : "You can close this page. Long classes take a while: transcription runs at roughly 2–3× the speed of the recording, so a 6-hour class takes about 2–3 hours. It will be waiting in your library when it's done."}
      </p>
    </Card>
  );
}
