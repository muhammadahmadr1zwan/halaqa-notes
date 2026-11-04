import { memo, useEffect, useMemo, useState } from "react";
import { buildParagraphs, findMatches, formatTimestamp, paragraphText, speakerName, type Paragraph, type TranscriptDoc } from "@halaqa/shared";
import { copyText } from "../lib/exports";
import { RichText } from "./RichText";
import { Icon } from "./ui";

export interface MatchInfo {
  /** segment id -> [ranges, global index of first range] */
  bySeg: Map<number, { ranges: Array<[number, number]>; first: number }>;
  total: number;
  /** global match index -> paragraph key */
  paraOf: number[];
}

export function computeMatches(paragraphs: Paragraph[], query: string): MatchInfo {
  const bySeg = new Map<number, { ranges: Array<[number, number]>; first: number }>();
  const paraOf: number[] = [];
  if (query.trim().length < 2) return { bySeg, total: 0, paraOf };
  for (const p of paragraphs) {
    for (const s of p.segments) {
      const ranges = findMatches(s.text, query);
      if (ranges.length) {
        bySeg.set(s.id, { ranges, first: paraOf.length });
        ranges.forEach(() => paraOf.push(p.key));
      }
    }
  }
  return { bySeg, total: paraOf.length, paraOf };
}

interface Props {
  doc: TranscriptDoc;
  speakerNames: Record<string, string>;
  matches: MatchInfo;
  currentMatch: number;
  activeSegId: number | null;
  onSeek: (seconds: number) => void;
}

export function TranscriptView({ doc, speakerNames, matches, currentMatch, activeSegId, onSeek }: Props) {
  const paragraphs = useMemo(() => buildParagraphs(doc), [doc]);
  const multiSpeaker = useMemo(() => new Set(doc.segments.map((s) => s.speaker)).size > 1, [doc]);
  const currentPara = currentMatch >= 0 ? matches.paraOf[currentMatch] : null;

  useEffect(() => {
    if (currentMatch < 0) return;
    requestAnimationFrame(() => document.querySelector("mark.current")?.scrollIntoView({ block: "center", behavior: "smooth" }));
  }, [currentMatch, matches]);

  return (
    <div className="transcript-text">
      {paragraphs.map((p) => {
        const active = activeSegId !== null && activeSegId >= p.key && activeSegId <= p.segments[p.segments.length - 1].id ? activeSegId : null;
        return (
          <ParagraphView
            key={p.key}
            p={p}
            activeSegId={active}
            matches={matches}
            currentMatch={currentPara === p.key ? currentMatch : -1}
            speaker={multiSpeaker ? speakerName(p.speaker, speakerNames) : null}
            onSeek={onSeek}
          />
        );
      })}
    </div>
  );
}

const ParagraphView = memo(function ParagraphView({
  p,
  activeSegId,
  matches,
  currentMatch,
  speaker,
  onSeek,
}: {
  p: Paragraph;
  activeSegId: number | null;
  matches: MatchInfo;
  currentMatch: number;
  speaker: string | null;
  onSeek: (s: number) => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      {p.heading && (
        <h2 id={`topic-${p.key}`} className="mt-10 mb-4 scroll-mt-28 border-b border-line pb-2 font-sans text-[1.25em] font-semibold text-brand first:mt-2">
          <RichText text={p.heading} />
        </h2>
      )}
      <div id={`p-${p.key}`} className="group relative mb-5 scroll-mt-28 print-break-avoid">
        <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-[0.8em]">
          <button
            onClick={() => onSeek(p.start)}
            className="no-print inline-flex items-center gap-1 rounded-lg bg-brand-soft px-2 py-1 font-semibold text-brand tabular-nums hover:bg-brand hover:text-white"
            title="Play from here"
          >
            <Icon name="play" className="size-3.5" />
            {formatTimestamp(p.start)}
          </button>
          {speaker && <span className="font-semibold text-gold">{speaker}</span>}
          <button
            onClick={async () => {
              if (await copyText(`[${formatTimestamp(p.start)}] ${speaker ? speaker + ": " : ""}${paragraphText(p)}`)) {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }
            }}
            className="no-print ms-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-muted opacity-60 hover:bg-brand-soft hover:text-ink group-hover:opacity-100 focus:opacity-100"
            title="Copy paragraph"
          >
            <Icon name={copied ? "check" : "copy"} className="size-4" />
            <span className="sr-only sm:not-sr-only">{copied ? "Copied" : "Copy"}</span>
          </button>
        </div>
        <p className="m-0">
          {p.segments.map((s) => {
            const m = matches.bySeg.get(s.id);
            return (
              <span
                key={s.id}
                data-seg={s.id}
                onDoubleClick={() => onSeek(s.start)}
                className={`rounded transition-colors ${s.id === activeSegId ? "bg-active shadow-[0_0_0_3px_var(--color-active)]" : ""}`}
              >
                <RichText text={s.text} highlights={m?.ranges} currentHighlight={m && currentMatch >= m.first ? currentMatch - m.first : undefined} />{" "}
              </span>
            );
          })}
        </p>
      </div>
    </>
  );
});
