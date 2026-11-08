import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { formatDuration, parseYouTubeId, type ClassRow } from "@halaqa/shared";
import { addYouTubeClass, uploadRecording, useClasses, useSearch, useWorkerStatus } from "../lib/api";
import { Header } from "../components/Header";
import { RichText } from "../components/RichText";
import { Button, Card, Icon, ProgressBar, Spinner } from "../components/ui";

export function Home() {
  const nav = useNavigate();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [aiOptOut, setAiOptOut] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);

  const submit = async () => {
    const id = parseYouTubeId(url);
    if (!id) {
      setError("That doesn't look like a YouTube link. Copy the link from the YouTube app (Share → Copy link) and paste it here.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      nav(`/class/${await addYouTubeClass(id, aiOptOut)}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    setError(null);
    setUploadPct(0);
    try {
      nav(`/class/${await uploadRecording(file, setUploadPct)}`);
    } catch (e) {
      setError((e as Error).message);
      setUploadPct(null);
    }
  };

  return (
    <>
      <Header />
      <main className="mx-auto max-w-6xl px-4 pb-20">
        <section className="mx-auto max-w-3xl pt-10 pb-12 text-center sm:pt-16">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Add a Lecture</h1>
          <p className="mt-3 text-lg text-muted">Paste a YouTube link, then tap Transcribe Lecture. You can close this page afterwards.</p>
          <form
            className="mt-8 flex flex-col gap-3 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className="relative flex-1">
              <input
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setError(null);
                }}
                inputMode="url"
                placeholder="Paste a YouTube link"
                aria-label="YouTube link"
                className="min-h-14 w-full rounded-2xl border-2 border-line bg-card pr-24 pl-5 text-lg shadow-sm outline-none focus:border-brand"
              />
              {!url && typeof navigator !== "undefined" && navigator.clipboard?.readText && (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      setUrl((await navigator.clipboard.readText()).trim());
                    } catch {
                      setError("Couldn't read the clipboard. Press and hold in the box, then choose Paste.");
                    }
                  }}
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded-xl bg-brand-soft px-3 py-2 font-medium text-brand hover:bg-brand hover:text-white"
                >
                  Paste
                </button>
              )}
            </div>
            <Button variant="primary" type="submit" disabled={busy || !url.trim()} className="min-h-14 rounded-2xl px-8 text-lg">
              {busy ? <Spinner /> : null} Transcribe Lecture
            </Button>
          </form>
          {error && <p className="mt-4 rounded-xl bg-danger-soft px-4 py-3 text-left text-danger">{error}</p>}

          <label className="mt-4 inline-flex min-h-11 cursor-pointer items-center gap-3 text-left text-muted">
            <input type="checkbox" checked={aiOptOut} onChange={(e) => setAiOptOut(e.target.checked)} className="size-5 accent-[var(--color-brand)]" />
            Private lecture: don't use online AI for its notes
          </label>

          <div className="mt-4">
            {uploadPct === null ? (
              <button onClick={() => fileInput.current?.click()} className="inline-flex min-h-11 items-center gap-2 rounded-xl px-4 text-brand hover:bg-brand-soft">
                <Icon name="upload" /> Or upload a recording (audio or video file)
              </button>
            ) : (
              <Card className="mx-auto max-w-md p-4 text-left">
                <p className="mb-2 font-medium">Uploading… {Math.round(uploadPct * 100)}%</p>
                <ProgressBar value={uploadPct} />
                <p className="mt-2 text-sm text-muted">Keep this page open until the upload finishes. If the connection drops, choose the same file again to continue where it stopped.</p>
              </Card>
            )}
            <input
              ref={fileInput}
              type="file"
              accept="audio/*,video/*,.m4a,.mp3,.wav,.aac,.ogg,.opus,.mp4,.mov,.webm"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void upload(f);
              }}
            />
          </div>
        </section>

        <Library />
      </main>
    </>
  );
}

function Library() {
  const classes = useClasses();
  const status = useWorkerStatus();
  // Only lectures that need the home computer (uploads, private ones) wait for it.
  const waitingCount = (classes.data ?? []).filter((c) => (c.status === "queued" || c.status === "processing") && c.engine !== "cloud").length;
  const [q, setQ] = useState("");
  const search = useSearch(q);
  const searching = q.trim().length >= 2;
  const snippets = new Map((search.data ?? []).map((r) => [r.class_id, r.snippet]));
  const list = (classes.data ?? []).filter((c) => !searching || snippets.has(c.id));

  return (
    <section>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-2xl font-semibold">My Lectures</h2>
        {(classes.data?.length ?? 0) > 0 && (
          <label className="relative block sm:w-80">
            <Icon name="search" className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-muted" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search all classes…"
              className="min-h-12 w-full rounded-xl border border-line bg-card pr-4 pl-11 outline-none focus:border-brand"
            />
          </label>
        )}
      </div>

      {waitingCount > 0 && status.data && !status.data.workerOnline && (
        <p className="mb-5 rounded-xl border border-gold/40 bg-gold-soft px-4 py-3 text-lg">
          The home computer that prepares transcripts is switched off right now. Your lectures are safely in the queue and will start automatically when it is turned on.
        </p>
      )}
      {classes.isLoading ? (
        <Spinner className="size-7 text-brand" />
      ) : classes.error ? (
        <p className="text-danger">Couldn't load your classes: {(classes.error as Error).message}</p>
      ) : !classes.data?.length ? (
        <Card className="p-8 text-center text-lg text-muted">Your transcribed classes will appear here.</Card>
      ) : searching && search.isLoading ? (
        <Spinner className="size-6 text-brand" />
      ) : searching && !list.length ? (
        <p className="text-lg text-muted">Nothing found for “{q}”.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((c) => (
            <ClassCard key={c.id} c={c} snippet={searching ? snippets.get(c.id) ?? null : null} query={searching ? q : ""} />
          ))}
        </div>
      )}
    </section>
  );
}

function ClassCard({ c, snippet, query }: { c: ClassRow; snippet: string | null; query: string }) {
  const working = c.status === "queued" || c.status === "processing";
  const date = c.class_date ? new Date(c.class_date + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : null;
  return (
    <Link to={`/class/${c.id}${query ? `?q=${encodeURIComponent(query)}` : ""}`} className="group block">
      <Card className="h-full overflow-hidden transition group-hover:border-brand/50 group-hover:shadow-md">
        <div className="relative aspect-video bg-brand-soft">
          {c.thumbnail_url ? (
            <img src={c.thumbnail_url} alt="" loading="lazy" className="size-full object-cover" />
          ) : (
            <div className="grid size-full place-items-center text-brand/50">
              <Icon name={c.source_type === "upload" ? "upload" : "video"} className="size-12" />
            </div>
          )}
          {c.duration_seconds ? <span className="absolute right-2 bottom-2 rounded-md bg-black/75 px-2 py-0.5 text-sm text-white">{formatDuration(c.duration_seconds)}</span> : null}
        </div>
        <div className="p-4">
          <h3 className="line-clamp-2 text-lg leading-snug font-semibold">
            <RichText text={c.title || "Getting video details…"} />
          </h3>
          <p className="mt-1 text-sm text-muted">{[date, c.channel].filter(Boolean).join(" · ")}</p>
          {working && (
            <div className="mt-3">
              <ProgressBar value={c.progress} />
              <p className="mt-1.5 truncate text-sm text-muted">{c.status === "queued" ? "In the queue" : "Processing"}{c.status_message ? ` · ${c.status_message}` : ""}</p>
            </div>
          )}
          {c.status === "completed" && (
            <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-3 py-1 text-sm font-semibold text-brand">
              <Icon name="check" className="size-4" /> Ready to Read
            </p>
          )}
          {c.status === "failed" && <p className="mt-3 text-sm font-medium text-danger">Couldn't finish – tap for details</p>}
          {snippet && (
            <p className="mt-3 line-clamp-3 rounded-lg bg-gold-soft px-3 py-2 text-sm">
              <RichText text={snippet} />
            </p>
          )}
        </div>
      </Card>
    </Link>
  );
}
