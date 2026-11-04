import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import { arabicRatio, splitBidiRuns } from "./arabic.ts";
import { usesMultipleSpeakers, type ExportMeta } from "./exporters.ts";
import { buildParagraphs, paragraphText } from "./paragraphs.ts";
import { formatDuration, formatHms } from "./time.ts";
import { speakerName, type TranscriptDoc } from "./types.ts";

const LATIN_FONT = "Calibri";
const ARABIC_FONT = "Traditional Arabic";
const FONT = { ascii: LATIN_FONT, hAnsi: LATIN_FONT, cs: ARABIC_FONT };

/** Text runs where Arabic segments are marked right-to-left with a complex-script font. */
export function bidiRuns(text: string, size = 24): TextRun[] {
  return splitBidiRuns(text).map(
    (r) =>
      new TextRun({
        text: r.text,
        font: FONT,
        size,
        sizeComplexScript: r.rtl ? size + 6 : size,
        rightToLeft: r.rtl,
      }),
  );
}

function para(text: string, opts: { prefix?: TextRun[] } = {}): Paragraph {
  const rtl = arabicRatio(text) > 0.6;
  return new Paragraph({
    children: [...(opts.prefix ?? []), ...bidiRuns(text)],
    bidirectional: rtl,
    alignment: rtl ? AlignmentType.RIGHT : AlignmentType.LEFT,
    spacing: { after: 160, line: 320 },
  });
}

export function buildTranscriptDocx(doc: TranscriptDoc, meta: ExportMeta): Document {
  const showSpeakers = meta.showSpeakers ?? usesMultipleSpeakers(doc);
  const children: Paragraph[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: bidiRuns(meta.title, 40) }),
  ];
  const info = [meta.date, formatDuration(meta.durationSeconds), meta.sourceUrl].filter(Boolean).join(" · ");
  if (info) children.push(new Paragraph({ children: [new TextRun({ text: info, color: "666666", font: FONT })] }));

  for (const p of buildParagraphs(doc)) {
    if (p.heading) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: bidiRuns(p.heading, 30), spacing: { before: 320 } }));
    }
    const prefix = [new TextRun({ text: `[${formatHms(p.start)}] `, color: "0F766E", font: FONT, size: 20 })];
    if (showSpeakers) prefix.push(new TextRun({ text: `${speakerName(p.speaker, meta.speakerNames)}: `, bold: true, font: FONT, size: 24 }));
    children.push(para(paragraphText(p), { prefix }));
  }

  return new Document({
    creator: "Halaqa Notes",
    title: meta.title,
    styles: { default: { document: { run: { font: FONT, size: 24 } } } },
    sections: [{ children }],
  });
}

/** Simple Markdown-ish study material (headings, bullets, paragraphs) to DOCX. */
export function buildMarkdownDocx(title: string, markdown: string): Document {
  const children: Paragraph[] = [new Paragraph({ heading: HeadingLevel.TITLE, children: bidiRuns(title, 40) })];
  for (const line of markdown.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const h = t.match(/^(#{1,3})\s+(.*)$/);
    const clean = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]\([^)]*\)/g, "[$1]");
    if (h) {
      const level = h[1].length === 1 ? HeadingLevel.HEADING_1 : h[1].length === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
      children.push(new Paragraph({ heading: level, children: bidiRuns(clean(h[2]), 28) }));
    } else if (/^[-*]\s+/.test(t)) {
      const text = clean(t.replace(/^[-*]\s+/, ""));
      children.push(new Paragraph({ bullet: { level: 0 }, children: bidiRuns(text), bidirectional: arabicRatio(text) > 0.6 }));
    } else {
      children.push(para(clean(t)));
    }
  }
  return new Document({ creator: "Halaqa Notes", title, sections: [{ children }] });
}

export function transcriptDocxBlob(doc: TranscriptDoc, meta: ExportMeta): Promise<Blob> {
  return Packer.toBlob(buildTranscriptDocx(doc, meta));
}

export function markdownDocxBlob(title: string, markdown: string): Promise<Blob> {
  return Packer.toBlob(buildMarkdownDocx(title, markdown));
}
