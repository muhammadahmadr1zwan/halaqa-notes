import { Fragment, type ReactNode } from "react";
import { splitBidiRuns } from "@halaqa/shared";

/**
 * Render mixed English/Arabic text: Arabic runs are isolated RTL spans in an Arabic font,
 * and optional search highlights ([start, end) offsets into `text`) are drawn as <mark>.
 */
export function RichText({ text, highlights, currentHighlight }: { text: string; highlights?: Array<[number, number]>; currentHighlight?: number }) {
  const runs = splitBidiRuns(text);
  let offset = 0;
  return (
    <>
      {runs.map((run, i) => {
        const start = offset;
        offset += run.text.length;
        const content = highlights?.length ? markRange(run.text, start, highlights, currentHighlight) : run.text;
        return run.rtl ? (
          <span key={i} className="ar" lang="ar" dir="rtl">
            {content}
          </span>
        ) : (
          <Fragment key={i}>{content}</Fragment>
        );
      })}
    </>
  );
}

function markRange(text: string, base: number, highlights: Array<[number, number]>, current?: number): ReactNode {
  const out: ReactNode[] = [];
  let pos = 0;
  highlights.forEach(([s, e], idx) => {
    const a = Math.max(s - base, 0);
    const b = Math.min(e - base, text.length);
    if (b <= a || b <= pos) return;
    if (a > pos) out.push(text.slice(pos, a));
    out.push(
      <mark key={idx} data-match={idx} className={idx === current ? "current" : undefined}>
        {text.slice(Math.max(a, pos), b)}
      </mark>,
    );
    pos = b;
  });
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}
