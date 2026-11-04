import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { formatTimestamp, parseTimestamp, STUDY_KINDS, type ClassRow, type GlossaryEntry, type StudyKind } from "@halaqa/shared";
import { requestStudy, useStudy, type StudyRow } from "../lib/api";
import { copyText, exportMarkdownDocx } from "../lib/exports";
import { RichText } from "./RichText";
import { Button, Card, Icon, Spinner } from "./ui";

const LABELS: Record<StudyKind, string> = {
  summary: "Summary",
  notes: "Class notes",
  takeaways: "Key takeaways",
  glossary: "Arabic glossary",
};

/** Turn "[01:02:03]" in AI output into links the player can seek to. */
function linkTimestamps(md: string): string {
  return md.replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\](?!\()/g, (m, ts) => {
    const s = parseTimestamp(ts);
    return s === null ? m : `[${ts}](#t=${s})`;
  });
}

function glossaryToMarkdown(entries: GlossaryEntry[]): string {
  return entries
    .map((e) => `- **${e.term}** (${e.transliteration}): ${e.meaning}${e.explainedInClass ? "" : " (general meaning)"}${e.firstTimestamp !== null ? ` [${formatTimestamp(e.firstTimestamp)}]` : ""}`)
    .join("\n");
}

export function StudyPanel({ cls, onSeek }: { cls: ClassRow; onSeek: (s: number) => void }) {
  const study = useStudy(cls.id, true);
  const [tab, setTab] = useState<StudyKind>("summary");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const rows = new Map((study.data ?? []).map((r) => [r.kind, r]));
  const request = async (kinds?: StudyKind[], force = false) => {
    setBusy(true);
    setErr(null);
    try {
      await requestStudy(cls.id, kinds, force);
      await study.refetch();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (study.isLoading) return <Spinner className="size-6 text-brand" />;

  if (!rows.size) {
    return (
      <Card className="p-6 text-center sm:p-10">
        <Icon name="sparkles" className="mx-auto size-10 text-gold" />
        <h2 className="mt-3 text-2xl font-semibold">Study notes</h2>
        <p className="mx-auto mt-2 max-w-xl text-lg text-muted">
          Create a summary, structured class notes, key takeaways and an Arabic glossary. Everything is taken only from what was said in this class, with timestamps you can click.
        </p>
        <Button variant="primary" className="mt-6 px-6 text-lg" disabled={busy} onClick={() => request()}>
          {busy ? <Spinner /> : <Icon name="sparkles" />} Create study notes
        </Button>
        {err && <p className="mt-3 text-danger">{err}</p>}
      </Card>
    );
  }

  const row = rows.get(tab);
  const markdown = row?.status === "completed" ? (tab === "glossary" ? glossaryToMarkdown(row.data ?? []) : row.content ?? "") : "";

  return (
    <div>
      <div className="no-print mb-4 flex gap-2 overflow-x-auto pb-1" role="tablist">
        {STUDY_KINDS.map((k) => {
          const r = rows.get(k);
          return (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={`flex shrink-0 items-center gap-2 rounded-xl px-4 py-2 font-medium ${tab === k ? "bg-brand text-white dark:text-paper" : "bg-card text-ink border border-line hover:bg-brand-soft"}`}
            >
              {LABELS[k]}
              {r && (r.status === "queued" || r.status === "processing") && <Spinner className="size-4" />}
            </button>
          );
        })}
      </div>

      <Card className="p-5 sm:p-8">
        {!row ? (
          <div className="text-center">
            <Button variant="primary" disabled={busy} onClick={() => request([tab])}>
              Create {LABELS[tab].toLowerCase()}
            </Button>
          </div>
        ) : row.status === "queued" || row.status === "processing" ? (
          <div className="flex items-center gap-3 text-lg text-muted">
            <Spinner className="size-6 text-brand" /> {row.status_message || `Writing the ${LABELS[tab].toLowerCase()}… this takes a few minutes.`}
          </div>
        ) : row.status === "failed" ? (
          <div>
            <p className="text-lg text-danger">This couldn't be created: {row.error}</p>
            <Button className="mt-4" disabled={busy} onClick={() => request([tab], true)}>
              <Icon name="refresh" /> Try again
            </Button>
          </div>
        ) : (
          <>
            <div className="no-print mb-5 flex flex-wrap gap-2">
              <Button
                onClick={async () => {
                  if (await copyText(markdown.replace(/\*\*/g, ""))) {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }
                }}
              >
                <Icon name={copied ? "check" : "copy"} /> {copied ? "Copied" : "Copy"}
              </Button>
              <Button onClick={() => exportMarkdownDocx(`${cls.title ?? "Class"} – ${LABELS[tab]}`, markdown)}>
                <Icon name="download" /> Word
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => request([tab], true)} title="Write it again">
                <Icon name="refresh" /> Regenerate
              </Button>
            </div>
            {tab === "glossary" ? <Glossary entries={row.data ?? []} onSeek={onSeek} /> : <StudyMarkdown md={row.content ?? ""} onSeek={onSeek} />}
          </>
        )}
        {err && <p className="mt-3 text-danger">{err}</p>}
      </Card>
      <p className="mt-3 text-sm text-muted">AI-generated from the transcript. Please check important points against the recording.</p>
    </div>
  );
}

function StudyMarkdown({ md, onSeek }: { md: string; onSeek: (s: number) => void }) {
  return (
    <div className="prose-study text-[1.05rem] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const t = href?.startsWith("#t=") ? Number(href.slice(3)) : null;
            return t !== null ? (
              <button onClick={() => onSeek(t)} className="mx-0.5 rounded-md bg-brand-soft px-1.5 py-0.5 text-[0.85em] font-semibold text-brand tabular-nums hover:bg-brand hover:text-white">
                {children}
              </button>
            ) : (
              <a href={href} target="_blank" rel="noreferrer" className="text-brand underline">
                {children}
              </a>
            );
          },
          // Render Arabic runs in the Arabic font inside every text node.
          p: ({ children }) => <p>{withArabic(children)}</p>,
          li: ({ children }) => <li>{withArabic(children)}</li>,
          h2: ({ children }) => <h2>{withArabic(children)}</h2>,
          h3: ({ children }) => <h3>{withArabic(children)}</h3>,
          blockquote: ({ children }) => <blockquote>{children}</blockquote>,
        }}
      >
        {linkTimestamps(md)}
      </ReactMarkdown>
    </div>
  );
}

function withArabic(children: React.ReactNode): React.ReactNode {
  return Array.isArray(children)
    ? children.map((c, i) => (typeof c === "string" ? <RichText key={i} text={c} /> : c))
    : typeof children === "string"
      ? <RichText text={children} />
      : children;
}

function Glossary({ entries, onSeek }: { entries: GlossaryEntry[]; onSeek: (s: number) => void }) {
  if (!entries.length) return <p className="text-muted">No Arabic terms were found in this class.</p>;
  return (
    <ul className="divide-y divide-line">
      {entries.map((e, i) => (
        <li key={i} className="grid gap-1 py-4 sm:grid-cols-[minmax(9rem,auto)_1fr] sm:gap-6">
          <div>
            <div className="ar text-[1.6rem] leading-snug" dir="rtl" lang="ar">
              {e.term}
            </div>
            <div className="text-sm italic text-muted">{e.transliteration}</div>
          </div>
          <div className="text-[1.05rem] leading-relaxed">
            {e.meaning}
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
              {e.explainedInClass ? (
                <span className="rounded-full bg-brand-soft px-2 py-0.5 text-brand">Explained in class</span>
              ) : (
                <span className="rounded-full bg-gold-soft px-2 py-0.5 text-gold">General meaning</span>
              )}
              {e.firstTimestamp !== null && (
                <button onClick={() => onSeek(e.firstTimestamp!)} className="rounded-md bg-brand-soft px-1.5 py-0.5 font-semibold text-brand tabular-nums hover:bg-brand hover:text-white">
                  {formatTimestamp(e.firstTimestamp)}
                </button>
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export type { StudyRow };
