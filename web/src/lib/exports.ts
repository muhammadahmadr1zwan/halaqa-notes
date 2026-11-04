import { safeFileName, toSrt, toTxt, type ClassRow, type ExportMeta, type TranscriptDoc } from "@halaqa/shared";

export function metaFor(c: ClassRow): ExportMeta {
  return {
    title: c.title || "Class transcript",
    date: c.class_date,
    durationSeconds: c.duration_seconds,
    sourceUrl: c.source_url,
    speakerNames: c.speaker_names,
  };
}

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const BOM = "﻿"; // helps Windows apps detect UTF-8 so Arabic displays correctly

export function exportTxt(c: ClassRow, doc: TranscriptDoc) {
  downloadBlob(`${safeFileName(metaFor(c).title)}.txt`, new Blob([BOM + toTxt(doc, metaFor(c))], { type: "text/plain;charset=utf-8" }));
}

export function exportSrt(c: ClassRow, doc: TranscriptDoc) {
  downloadBlob(`${safeFileName(metaFor(c).title)}.srt`, new Blob([BOM + toSrt(doc)], { type: "application/x-subrip;charset=utf-8" }));
}

export async function exportDocx(c: ClassRow, doc: TranscriptDoc) {
  const { transcriptDocxBlob } = await import("@halaqa/shared/src/docx.ts");
  downloadBlob(`${safeFileName(metaFor(c).title)}.docx`, await transcriptDocxBlob(doc, metaFor(c)));
}

export async function exportMarkdownDocx(title: string, markdown: string) {
  const { markdownDocxBlob } = await import("@halaqa/shared/src/docx.ts");
  downloadBlob(`${safeFileName(title)}.docx`, await markdownDocxBlob(title, markdown));
}

/** PDF: open the print view; the browser's “Save as PDF” renders Arabic perfectly. */
export function exportPdf(c: ClassRow) {
  window.open(`/class/${c.id}/print`, "_blank");
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}
