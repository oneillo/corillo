// Corillo's own Word style, "clean": the styles Pandoc gives a Word document
// when the person hasn't chosen a Word document of their own to copy styles
// from. Written from scratch (Pandoc's own default style file is under the
// GPL, so Corillo doesn't copy or change it). Pandoc takes the styles, page
// size and margins, and footer from this file and fills in everything else.
//
// The look: one sans-serif (Aptos, Word's current default), comfortable line
// spacing, quiet code blocks, and tables with a light rule under the header
// row. Text has no space before or after it (Orlando, 2026-11-09: "I don't
// love space before or after plain text in Word, except as needed for
// separating headers and other elements like tables"): the space is the
// empty lines the file has, each an empty paragraph (blankLinesForWord in
// export-prep.ts). Headings keep a small separation, the same at every level,
// and tables the room in their cells. No coloured text (Orlando): every word is in Word's automatic colour,
// headings set apart by size and weight. Colour is only in what frames the
// text: the rule beside a quote, a callout's box, code's grey ground.
import { makeZip } from "./zip";

export type Paper = "Letter" | "A4";

// Corillo's palette (Adoquín), in Word's colour notation, for lines and grounds.
const MUTED = "A9B2B8";
const RULE = "D2D8D7";
const HAIRLINE = "E3E7E6";
const SHADE = "F3F5F4";
const ACCENT_LINE = "C3D3DA";
/** Callout colours by name: the box's tint and its edge (the page's --callout-* and --agent-* colours). */
const CALLOUTS: Record<string, [string, string]> = {
  Sky: ["E6EEF4", "B9CEE2"],
  Mint: ["E3F0EA", "B4D7C7"],
  Ochre: ["F6EFDA", "E8D49C"],
  Rose: ["F6E6E6", "E9C0C0"],
  Lilac: ["EEEAF4", "CEC1DF"],
  Stone: ["F3F5F4", "D2D8D7"],
};

const BODY_FONT = "Aptos";
const HEADING_FONT = "Aptos Display";
const CODE_FONT = "Consolas";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const fonts = (name: string) => `<w:rFonts w:ascii="${name}" w:hAnsi="${name}" w:eastAsia="${name}" w:cs="${name}"/>`;
const size = (points: number) => `<w:sz w:val="${points * 2}"/><w:szCs w:val="${points * 2}"/>`;
/** Space before and after, in points. */
const spacing = (before: number, after: number, line?: number) =>
  `<w:spacing w:before="${before * 20}" w:after="${after * 20}"${line ? ` w:line="${Math.round(line * 240)}" w:lineRule="auto"` : ""}/>`;

interface StyleSpec {
  id: string;
  name: string;
  type?: "paragraph" | "character" | "table";
  basedOn?: string;
  next?: string;
  /** Show it in Word's style gallery. */
  quick?: boolean;
  pPr?: string;
  rPr?: string;
  extra?: string;
}

function style(s: StyleSpec): string {
  const type = s.type ?? "paragraph";
  return [
    `<w:style w:type="${type}" w:styleId="${s.id}">`,
    `<w:name w:val="${s.name}"/>`,
    s.basedOn ? `<w:basedOn w:val="${s.basedOn}"/>` : "",
    s.next ? `<w:next w:val="${s.next}"/>` : "",
    s.quick ? "<w:qFormat/>" : "",
    s.pPr ? `<w:pPr>${s.pPr}</w:pPr>` : "",
    s.rPr ? `<w:rPr>${s.rPr}</w:rPr>` : "",
    s.extra ?? "",
    "</w:style>",
  ].join("");
}

function heading(level: number, points: number, extra = ""): string {
  return style({
    id: `Heading${level}`,
    name: `heading ${level}`,
    basedOn: "Normal",
    next: "BodyText",
    quick: true,
    pPr: `<w:keepNext/><w:keepLines/>${spacing(6, 3, 1.15)}<w:outlineLvl w:val="${level - 1}"/>`,
    rPr: `${fonts(HEADING_FONT)}<w:b/><w:bCs/>${extra}${size(points)}`,
  });
}

const border = (side: string, eighths: number, hex: string, space = 0) =>
  `<w:${side} w:val="single" w:sz="${eighths}" w:space="${space}" w:color="${hex}"/>`;

export function stylesXml(): string {
  const styles = [
    // The defaults every paragraph and run starts from.
    `<w:docDefaults><w:rPrDefault><w:rPr>${fonts(BODY_FONT)}${size(11)}</w:rPr></w:rPrDefault>` +
      `<w:pPrDefault><w:pPr>${spacing(0, 0, 1.25)}</w:pPr></w:pPrDefault></w:docDefaults>`,
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>`,
    `<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>`,
    `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/>` +
      `<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>`,

    // Text
    style({ id: "BodyText", name: "Body Text", basedOn: "Normal", quick: true }),
    style({ id: "FirstParagraph", name: "First Paragraph", basedOn: "BodyText", next: "BodyText", quick: true }),
    // Tight lists and table cells.
    style({ id: "Compact", name: "Compact", basedOn: "BodyText", quick: true, pPr: spacing(0, 0) }),

    // Title block (from a document's front matter)
    style({
      id: "Title",
      name: "Title",
      basedOn: "Normal",
      next: "BodyText",
      quick: true,
      pPr: `<w:keepNext/><w:keepLines/>${spacing(0, 6, 1.05)}`,
      rPr: `${fonts(HEADING_FONT)}<w:b/><w:bCs/><w:kern w:val="28"/>${size(26)}`,
    }),
    style({
      id: "Subtitle",
      name: "Subtitle",
      basedOn: "Title",
      next: "BodyText",
      quick: true,
      pPr: spacing(0, 12),
      rPr: `<w:b w:val="0"/><w:bCs w:val="0"/>${size(14)}`,
    }),
    style({ id: "Author", name: "Author", basedOn: "Normal", next: "BodyText", pPr: `<w:keepNext/>${spacing(0, 2)}` }),
    style({ id: "Date", name: "Date", basedOn: "Normal", next: "BodyText", pPr: `<w:keepNext/>${spacing(0, 18)}` }),
    style({ id: "AbstractTitle", name: "Abstract Title", basedOn: "Normal", next: "Abstract", pPr: `<w:keepNext/>${spacing(12, 4)}`, rPr: `<w:b/><w:bCs/>${size(10)}` }),
    style({ id: "Abstract", name: "Abstract", basedOn: "Normal", next: "BodyText", pPr: spacing(0, 18), rPr: size(10) }),

    // Headings
    heading(1, 18),
    heading(2, 14),
    heading(3, 12),
    heading(4, 11),
    heading(5, 11, "<w:i/><w:iCs/>"),
    heading(6, 10),
    heading(7, 10, "<w:i/><w:iCs/>"),
    heading(8, 10),
    heading(9, 10, "<w:i/><w:iCs/>"),
    style({ id: "TOCHeading", name: "TOC Heading", basedOn: "Heading1", next: "BodyText", quick: true, pPr: '<w:outlineLvl w:val="9"/>' }),

    // Quotes: indented, with a quiet rule on the left, as on the page. A quote
    // inside a quote is set further in (Corillo's Lua filter picks these).
    style({
      id: "BlockText",
      name: "Block Text",
      basedOn: "BodyText",
      next: "BodyText",
      quick: true,
      pPr: `<w:pBdr>${border("left", 18, ACCENT_LINE, 10)}</w:pBdr>${spacing(0, 0)}<w:ind w:left="300" w:right="300"/>`,
    }),
    style({ id: "BlockText2", name: "Block Text 2", basedOn: "BlockText", next: "BodyText", pPr: '<w:ind w:left="660" w:right="300"/>' }),
    style({ id: "BlockText3", name: "Block Text 3", basedOn: "BlockText", next: "BodyText", pPr: '<w:ind w:left="1020" w:right="300"/>' }),
    // Obsidian's callouts: a soft coloured box edged on the left, as on the page.
    ...Object.entries(CALLOUTS).map(([colour, [tint, line]]) =>
      style({
        id: `Callout${colour}`,
        name: `Callout ${colour}`,
        basedOn: "BodyText",
        next: "BodyText",
        pPr:
          `<w:pBdr>${border("top", 4, tint, 6)}${border("left", 18, line, 12)}${border("bottom", 4, tint, 6)}${border("right", 4, tint, 12)}</w:pBdr>` +
          `<w:shd w:val="clear" w:color="auto" w:fill="${tint}"/>${spacing(0, 0)}<w:ind w:left="260" w:right="260"/>`,
      }),
    ),

    // Code
    style({
      id: "SourceCode",
      name: "Source Code",
      basedOn: "Normal",
      pPr:
        `<w:pBdr>${["top", "left", "bottom", "right"].map((s) => border(s, 4, SHADE, 6)).join("")}</w:pBdr>` +
        `<w:shd w:val="clear" w:color="auto" w:fill="${SHADE}"/>${spacing(0, 0, 1.1)}<w:ind w:left="120" w:right="120"/>`,
      rPr: `${fonts(CODE_FONT)}${size(9.5)}`,
    }),
    style({
      id: "VerbatimChar",
      name: "Verbatim Char",
      type: "character",
      basedOn: "DefaultParagraphFont",
      rPr: `${fonts(CODE_FONT)}${size(10)}<w:shd w:val="clear" w:color="auto" w:fill="${SHADE}"/>`,
    }),

    // Links and footnotes
    style({
      id: "Hyperlink",
      name: "Hyperlink",
      type: "character",
      basedOn: "DefaultParagraphFont",
      rPr: `<w:u w:val="single" w:color="${MUTED}"/>`,
    }),
    style({ id: "FootnoteText", name: "footnote text", basedOn: "Normal", quick: true, pPr: spacing(0, 3, 1.15), rPr: size(9) }),
    style({ id: "FootnoteBlockText", name: "Footnote Block Text", basedOn: "FootnoteText", pPr: `<w:pBdr>${border("left", 12, MUTED, 8)}</w:pBdr><w:ind w:left="240"/>` }),
    style({ id: "FootnoteReference", name: "footnote reference", type: "character", basedOn: "DefaultParagraphFont", rPr: `<w:vertAlign w:val="superscript"/>` }),

    // Pictures, diagrams and captions
    style({ id: "Figure", name: "Figure", basedOn: "Normal", pPr: `<w:keepNext/>${spacing(0, 0)}` }),
    style({ id: "CaptionedFigure", name: "Captioned Figure", basedOn: "Figure", pPr: "<w:keepNext/>" }),
    style({ id: "Diagram", name: "Diagram", basedOn: "Normal", next: "BodyText", pPr: `<w:keepLines/>${spacing(0, 0, 1)}<w:jc w:val="center"/>` }),
    style({ id: "Caption", name: "caption", basedOn: "Normal", pPr: spacing(3, 0), rPr: `<w:i/><w:iCs/>${size(9)}` }),
    style({ id: "ImageCaption", name: "Image Caption", basedOn: "Caption" }),
    style({ id: "TableCaption", name: "Table Caption", basedOn: "Caption", pPr: "<w:keepNext/>" }),

    // Definition lists and references
    style({ id: "DefinitionTerm", name: "Definition Term", basedOn: "Normal", next: "Definition", pPr: `<w:keepNext/>${spacing(6, 1)}`, rPr: "<w:b/><w:bCs/>" }),
    style({ id: "Definition", name: "Definition", basedOn: "Normal", pPr: '<w:ind w:left="360"/>' }),
    style({ id: "Bibliography", name: "Bibliography", basedOn: "Normal", pPr: '<w:ind w:left="360" w:hanging="360"/>' }),
    style({ id: "SectionNumber", name: "Section Number", type: "character", basedOn: "DefaultParagraphFont" }),

    // Tables: no vertical lines, a light rule under the header row, hairlines between rows.
    style({
      id: "Table",
      name: "Table",
      type: "table",
      basedOn: "TableNormal",
      rPr: size(10),
      extra:
        `<w:tblPr><w:tblBorders>${border("bottom", 4, RULE)}${border("insideH", 4, HAIRLINE)}</w:tblBorders>` +
        `<w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="115" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="115" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
        `<w:tblStylePr w:type="firstRow"><w:rPr><w:b/><w:bCs/></w:rPr>` +
        `<w:tcPr><w:tcBorders>${border("bottom", 8, MUTED)}</w:tcBorders></w:tcPr></w:tblStylePr>`,
    }),
  ];
  return `${XML}<w:styles xmlns:w="${W}">${styles.join("")}</w:styles>`;
}

const PAGE: Record<Paper, { w: number; h: number }> = {
  Letter: { w: 12240, h: 15840 }, // 8.5 by 11 inches, in twentieths of a point
  A4: { w: 11906, h: 16838 },
};

function documentXml(paper: Paper): string {
  const { w, h } = PAGE[paper];
  return (
    `${XML}<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body><w:p/>` +
    `<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="${w}" w:h="${h}"/>` +
    `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="600" w:gutter="0"/></w:sectPr>` +
    `</w:body></w:document>`
  );
}

// A page number, small and centred at the foot of each page.
const FOOTER =
  `${XML}<w:ftr xmlns:w="${W}"><w:p><w:pPr><w:spacing w:before="0" w:after="0"/><w:jc w:val="center"/></w:pPr>` +
  `<w:fldSimple w:instr=" PAGE "><w:r><w:rPr>${size(9)}</w:rPr><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`;

const CONTENT_TYPES =
  `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
  `<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>` +
  `</Types>`;

const PACKAGE_RELS =
  `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`;

const DOCUMENT_RELS =
  `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rIdStyles" Type="${R}/styles" Target="styles.xml"/>` +
  `<Relationship Id="rIdFooter" Type="${R}/footer" Target="footer1.xml"/></Relationships>`;

/** Corillo's clean style, as a Word document for Pandoc to copy styles from. */
export function buildReferenceDocx(paper: Paper): Buffer {
  return makeZip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES },
    { name: "_rels/.rels", data: PACKAGE_RELS },
    { name: "word/document.xml", data: documentXml(paper) },
    { name: "word/_rels/document.xml.rels", data: DOCUMENT_RELS },
    { name: "word/styles.xml", data: stylesXml() },
    { name: "word/footer1.xml", data: FOOTER },
  ]);
}
