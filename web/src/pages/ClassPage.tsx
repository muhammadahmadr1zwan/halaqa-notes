import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { buildParagraphs, formatDuration, speakerName, toTxt, type ClassRow, type TranscriptDoc } from "@halaqa/shared";
import { deleteClass, updateClassFields, useClass, useTranscript } from "../lib/api";
import { copyText, exportDocx, exportPdf, exportSrt, exportTxt, metaFor } from "../lib/exports";
import { Header } from "../components/Header";
import { Player, type PlayerHandle } from "../components/Player";
import { RichText } from "../components/RichText";
import { StatusPanel } from "../components/StatusPanel";
import { computeMatches, TranscriptView } from "../components/TranscriptView";
import { Button, Card, Icon, Spinner } from "../components/ui";

// Markdown rendering is only needed for study notes; load it on demand.
const StudyPanel = lazy(() => import("../components/StudyPanel").then((m) => ({ default: m.StudyPanel })));

const FONT_SIZES = [0.9, 1, 1.12, 1.25, 1.4, 1.6];
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

export function ClassPage() {
  const { id = "" } = useParams();
  const cls = useClass(id);
  const qc = useQueryClient();
  const c = cls.data;
  const transcript = useTranscript(id, c?.status === "completed");

  return (
    <>
      <Header />
      <main className="mx-auto max-w-6xl px-4 pb-24">
        <Link to="/" className="no-print mt-4 inline-flex min-h-11 items-center gap-1 rounded-xl px-2 text-muted hover:text-ink">
          <Icon name="back" /> All classes
        </Link>
        {cls.isLoading ? (
          <Spinner className="mt-10 size-8 text-brand" />
        ) : !c ? (
          <p className="mt-10 text-lg">This class wasn't found.</p>
        ) : (
          <>
            <TitleBlock c={c} />
            {c.status !== "completed" ? (
              <div className="mt-6">
                <StatusPanel cls={c} onRetried={() => qc.invalidateQueries({ queryKey: ["class", id] })} />
              </div>
            ) : transcript.isLoading ? (
              <Spinner className="mt-10 size-8 text-brand" />
            ) : transcript.data ? (
              <Workspace c={c} doc={transcript.data} />
            ) : (
              <p className="mt-10 text-danger">The transcript couldn't be loaded. Please refresh the page.</p>
            )}
          </>
        )}
      </main>
    </>
  );
}

function TitleBlock({ c }: { c: ClassRow }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(c.title ?? "");
  const date = c.class_date ? new Date(c.class_date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "long", year: "numeric" }) : null;

  return (
    <div className="mt-2">
      {editing ? (
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={async (e) => {
            e.preventDefault();
            await updateClassFields(c.id, { title: title.trim() || c.title });
            await qc.invalidateQueries({ queryKey: ["class", c.id] });
            setEditing(false);
          }}
        >
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} className="min-h-12 flex-1 rounded-xl border-2 border-brand bg-card px-4 text-xl outline-none" />
          <Button variant="primary" type="submit">
            Save
          </Button>
          <Button type="button" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <h1 className="text-2xl leading-tight font-semibold sm:text-3xl">
          <RichText text={c.title || "Getting video details…"} />
          <button onClick={() => setEditing(true)} className="no-print ms-2 inline-flex rounded-lg p-1.5 align-middle text-muted hover:bg-brand-soft hover:text-ink" title="Rename">
            <Icon name="pencil" className="size-5" />
          </button>
        </h1>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-muted">
        {date && <span>{date}</span>}
        {c.duration_seconds ? <span>{formatDuration(c.duration_seconds)}</span> : null}
        {c.channel && <span>{c.channel}</span>}
        {c.source_url && (
          <a href={c.source_url} target="_blank" rel="noreferrer" className="no-print text-brand hover:underline">
            Open on YouTube
          </a>
        )}
        <button
          className="no-print ms-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm hover:bg-danger-soft hover:text-danger"
          onClick={async () => {
            if (!confirm("Delete this class and its transcript? This can't be undone.")) return;
            await deleteClass(c);
            await qc.invalidateQueries({ queryKey: ["classes"] });
            nav("/");
          }}
        >
          <Icon name="trash" className="size-4" /> Delete
        </button>
      </div>
    </div>
  );
}

export function Workspace({ c, doc }: { c: ClassRow; doc: TranscriptDoc }) {
  const [params] = useSearchParams();
  const [tab, setTab] = useState<"transcript" | "study">("transcript");
  const [query, setQuery] = useState(params.get("q") ?? "");
  const deferredQuery = useDeferredValue(query);
  const [currentMatch, setCurrentMatch] = useState(-1);
  const [fontIdx, setFontIdx] = useState(() => Number(store.get("fontIdx") ?? 2));
  const [showPlayer, setShowPlayer] = useState(() => window.matchMedia("(min-width: 1024px)").matches);
  const [follow, setFollow] = useState(true);
  const [activeSeg, setActiveSeg] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const player = useRef<PlayerHandle>(null);
  const pendingSeek = useRef<number | null>(null);

  const paragraphs = useMemo(() => buildParagraphs(doc), [doc]);
  const matches = useMemo(() => computeMatches(paragraphs, deferredQuery), [paragraphs, deferredQuery]);
  useEffect(() => setCurrentMatch(matches.total ? 0 : -1), [matches]);
  useEffect(() => store.set("fontIdx", String(fontIdx)), [fontIdx]);

  const onSeek = useCallback((s: number) => {
    if (player.current) player.current.seek(s);
    else pendingSeek.current = s;
    setShowPlayer(true);
    setTab("transcript");
  }, []);

  // Seek once the player mounts after being opened by a timestamp click.
  useEffect(() => {
    if (showPlayer && pendingSeek.current !== null && player.current) {
      player.current.seek(pendingSeek.current);
      pendingSeek.current = null;
    }
  }, [showPlayer]);

  // Follow along: highlight the segment being played.
  useEffect(() => {
    if (!showPlayer) return;
    const starts = doc.segments.map((s) => s.start);
    const t = setInterval(() => {
      const now = player.current?.currentTime();
      if (now == null) return;
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= now + 0.15) lo = mid;
        else hi = mid - 1;
      }
      setActiveSeg(doc.segments[lo]?.id ?? null);
    }, 500);
    return () => clearInterval(t);
  }, [showPlayer, doc]);

  useEffect(() => {
    if (!follow || activeSeg === null) return;
    const el = document.querySelector(`[data-seg="${activeSeg}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < 140 || r.bottom > window.innerHeight - 40) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeSeg, follow]);

  const step = (d: number) => matches.total && setCurrentMatch((i) => (i + d + matches.total) % matches.total);
  const fromCaptions = c.transcript_source?.startsWith("youtube");
  const speakers = useMemo(() => [...new Set(doc.segments.map((s) => s.speaker))].sort(), [doc]);

  return (
    <div className="mt-6">
      {fromCaptions && (
        <div className="no-print mb-5 rounded-xl border border-gold/40 bg-gold-soft px-4 py-3">
          <strong>Made from YouTube's captions.</strong> YouTube didn't allow the audio to be downloaded, so this transcript comes from its {c.transcript_source === "youtube_auto_captions" ? "automatic " : ""}captions and may be less accurate, especially for Arabic. For the best transcript, download the recording and upload it.
        </div>
      )}

      <div className="no-print mb-5 flex gap-2" role="tablist">
        {(["transcript", "study"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`min-h-12 rounded-xl px-5 text-lg font-medium ${tab === t ? "bg-ink text-paper" : "bg-card border border-line hover:bg-brand-soft"}`}
          >
            {t === "transcript" ? "Transcript" : "Study notes"}
          </button>
        ))}
      </div>

      <div className={showPlayer ? "lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-8" : ""}>
        {showPlayer && (
          <aside className="no-print sticky top-16 z-20 -mx-4 mb-4 bg-paper px-4 pt-2 pb-3 lg:top-20 lg:mx-0 lg:self-start lg:px-0">
            <Player ref={player} youtubeId={c.youtube_id} />
            <div className="mt-2 flex items-center justify-between text-sm">
              <label className="inline-flex items-center gap-2 text-muted">
                <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="size-4 accent-[var(--color-brand)]" />
                Follow along
              </label>
              <button onClick={() => setShowPlayer(false)} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-muted hover:bg-brand-soft hover:text-ink">
                <Icon name="close" className="size-4" /> Hide {c.youtube_id ? "video" : "player"}
              </button>
            </div>
          </aside>
        )}

        <div className="min-w-0">
          {tab === "study" ? (
            <Suspense fallback={<Spinner className="size-6 text-brand" />}>
              <StudyPanel cls={c} onSeek={onSeek} />
            </Suspense>
          ) : (
            <>
              {/* Toolbar */}
              <div className={`no-print sticky z-10 -mx-4 mb-4 flex flex-wrap items-center gap-2 border-b border-line bg-paper/95 px-4 py-2 backdrop-blur ${showPlayer ? "top-16 max-lg:static lg:top-16" : "top-16"}`}>
                <div className="relative min-w-0 flex-1 basis-56">
                  <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") step(e.shiftKey ? -1 : 1);
                    }}
                    placeholder="Search this class"
                    className="min-h-11 w-full rounded-xl border border-line bg-card pr-24 pl-10 outline-none focus:border-brand"
                  />
                  {query.trim().length >= 2 && (
                    <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-0.5 text-sm text-muted">
                      <span className="tabular-nums">{matches.total ? `${currentMatch + 1}/${matches.total}` : "0"}</span>
                      <button onClick={() => step(-1)} className="rounded p-1 hover:bg-brand-soft" aria-label="Previous match">
                        <Icon name="up" className="size-4" />
                      </button>
                      <button onClick={() => step(1)} className="rounded p-1 hover:bg-brand-soft" aria-label="Next match">
                        <Icon name="down" className="size-4" />
                      </button>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => setFontIdx((i) => Math.max(0, i - 1))} className="min-h-11 rounded-xl px-3 text-base hover:bg-brand-soft" aria-label="Smaller text">
                    A−
                  </button>
                  <button onClick={() => setFontIdx((i) => Math.min(FONT_SIZES.length - 1, i + 1))} className="min-h-11 rounded-xl px-3 text-xl hover:bg-brand-soft" aria-label="Larger text">
                    A+
                  </button>
                </div>
                {!showPlayer && (
                  <Button variant="ghost" onClick={() => setShowPlayer(true)}>
                    <Icon name="video" /> <span className="hidden sm:inline">{c.youtube_id ? "Video" : "Audio"}</span>
                  </Button>
                )}
                <Button
                  variant="ghost"
                  onClick={async () => {
                    if (await copyText(toTxt(doc, metaFor(c)))) {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }
                  }}
                >
                  <Icon name={copied ? "check" : "copy"} /> <span className="hidden sm:inline">{copied ? "Copied" : "Copy all"}</span>
                </Button>
                <ExportMenu c={c} doc={doc} />
              </div>

              {doc.sections.length > 1 && <Topics doc={doc} />}
              {speakers.length > 1 && <SpeakerNames c={c} speakers={speakers} />}

              <article style={{ fontSize: `${FONT_SIZES[fontIdx]}rem` }}>
                <TranscriptView doc={doc} speakerNames={c.speaker_names} matches={matches} currentMatch={currentMatch} activeSegId={showPlayer ? activeSeg : null} onSeek={onSeek} />
              </article>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ExportMenu({ c, doc }: { c: ClassRow; doc: TranscriptDoc }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const item = (label: string, hint: string, fn: () => unknown) => (
    <button
      role="menuitem"
      onClick={async () => {
        setBusy(true);
        try {
          await fn();
        } finally {
          setBusy(false);
          setOpen(false);
        }
      }}
      className="flex w-full flex-col items-start rounded-lg px-3 py-2 text-left hover:bg-brand-soft"
    >
      <span className="font-medium">{label}</span>
      <span className="text-sm text-muted">{hint}</span>
    </button>
  );
  return (
    <div className="relative" ref={ref}>
      <Button variant="primary" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        {busy ? <Spinner /> : <Icon name="download" />} Download
      </Button>
      {open && (
        <div role="menu" className="absolute right-0 z-40 mt-2 w-64 rounded-xl border border-line bg-card p-1.5 shadow-lg">
          {item("Word (.docx)", "Best for reading & printing", () => exportDocx(c, doc))}
          {item("PDF", "Opens print view → Save as PDF", () => exportPdf(c))}
          {item("Text (.txt)", "Plain text with timestamps", () => exportTxt(c, doc))}
          {item("Subtitles (.srt)", "For video players", () => exportSrt(c, doc))}
        </div>
      )}
    </div>
  );
}

function Topics({ doc }: { doc: TranscriptDoc }) {
  const starts = new Map(doc.segments.map((s) => [s.id, s.start]));
  return (
    <details className="no-print mb-6 rounded-xl border border-line bg-card px-4 py-2">
      <summary className="flex min-h-10 cursor-pointer items-center gap-2 font-medium">
        <Icon name="list" /> Topics in this class ({doc.sections.length})
      </summary>
      <ol className="mt-2 mb-2 grid gap-1">
        {doc.sections.map((s) => (
          <li key={s.segmentId}>
            <button
              onClick={() => document.getElementById(`topic-${s.segmentId}`)?.scrollIntoView({ behavior: "smooth" })}
              className="flex w-full items-baseline gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-brand-soft"
            >
              <span className="w-16 shrink-0 text-sm text-muted tabular-nums">{fmt(starts.get(s.segmentId) ?? 0)}</span>
              <RichText text={s.title} />
            </button>
          </li>
        ))}
      </ol>
    </details>
  );
}

const fmt = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}` : `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

function SpeakerNames({ c, speakers }: { c: ClassRow; speakers: string[] }) {
  const qc = useQueryClient();
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries(speakers.map((s) => [s, speakerName(s, c.speaker_names)])));
  const [saved, setSaved] = useState(false);
  return (
    <details className="no-print mb-6 rounded-xl border border-line bg-card px-4 py-2">
      <summary className="flex min-h-10 cursor-pointer items-center gap-2 font-medium">
        <Icon name="pencil" /> Speaker names
      </summary>
      <form
        className="mt-2 mb-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        onSubmit={async (e) => {
          e.preventDefault();
          await updateClassFields(c.id, { speaker_names: names });
          await qc.invalidateQueries({ queryKey: ["class", c.id] });
          setSaved(true);
          setTimeout(() => setSaved(false), 1500);
        }}
      >
        {speakers.map((s) => (
          <label key={s} className="grid gap-1 text-sm">
            <span className="text-muted">{s === "S1" ? "Main speaker" : "Other voices"}</span>
            <input value={names[s] ?? ""} onChange={(e) => setNames({ ...names, [s]: e.target.value })} className="min-h-11 rounded-lg border border-line bg-paper px-3 text-base outline-none focus:border-brand" />
          </label>
        ))}
        <Button type="submit" variant="primary">
          {saved ? <Icon name="check" /> : null} Save
        </Button>
      </form>
    </details>
  );
}

export function PrintPage() {
  const { id = "" } = useParams();
  const cls = useClass(id);
  const transcript = useTranscript(id, cls.data?.status === "completed");
  const doc = transcript.data;
  const c = cls.data;

  useEffect(() => {
    if (!doc || !c) return;
    document.title = c.title ?? "Transcript";
    document.fonts.ready.then(() => setTimeout(() => window.print(), 300));
  }, [doc, c]);

  if (!c || !doc) return <Spinner className="m-10 size-8 text-brand" />;
  const multi = new Set(doc.segments.map((s) => s.speaker)).size > 1;
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <p className="no-print mb-6 rounded-xl bg-gold-soft px-4 py-3">
        In the print window, choose <strong>Save as PDF</strong> as the printer. <button className="font-semibold text-brand underline" onClick={() => window.print()}>Open print window again</button>
      </p>
      <h1 className="text-2xl font-semibold">
        <RichText text={c.title ?? "Transcript"} />
      </h1>
      <p className="mt-1 mb-8 text-muted">{[c.class_date, formatDuration(c.duration_seconds), c.source_url].filter(Boolean).join(" · ")}</p>
      <div className="transcript-text">
        {buildParagraphs(doc).map((p) => (
          <div key={p.key}>
            {p.heading && (
              <h2 className="mt-8 mb-3 border-b border-line pb-1 text-lg font-semibold print-break-avoid">
                <RichText text={p.heading} />
              </h2>
            )}
            <p className="mb-4">
              <span className="me-2 font-sans text-sm text-muted tabular-nums">[{fmt(p.start)}]</span>
              {multi && <strong className="me-1 font-sans text-sm">{speakerName(p.speaker, c.speaker_names)}:</strong>}
              <RichText text={p.segments.map((s) => s.text).join(" ")} />
            </p>
          </div>
        ))}
      </div>
    </main>
  );
}
