// For tests: a small Word document, written the way Word writes one (the
// WordprocessingML inside a zip), with what a person's real document has:
// a title, headings, bold, a bulleted list, a table, a picture, a tracked
// change (a word added and a word taken out) and a Word comment. Made here
// rather than kept as a file, so what's in it is plain to read.
import { makeZip } from "../../src/main/zip";
import { makePng } from "./make-png";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const DRAWING =
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const run = (text: string, bold = false) => `<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const para = (inner: string, style?: string, extra = "") =>
  `<w:p>${style || extra ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${extra}</w:pPr>` : ""}${inner}</w:p>`;
const bullet = (text: string) => para(run(text), "ListParagraph", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>');
const cell = (text: string) => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>${para(run(text))}</w:tc>`;
const row = (...cells: string[]) => `<w:tr>${cells.map(cell).join("")}</w:tr>`;

const picture = (rel: string, descr = "Venue map") =>
  `<w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><wp:docPr id="1" name="Picture 1" descr="${descr}"/>` +
  `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>` +
  `<pic:nvPicPr><pic:cNvPr id="1" name="map.png" descr="${descr}"/><pic:cNvPicPr/></pic:nvPicPr>` +
  `<pic:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
  `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="476250"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
  `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

export interface DocxOptions {
  /** Word comments in it (each on a word of the opening paragraph). */
  comments?: number;
  /** Leave out the tracked change. */
  noChanges?: boolean;
  /** Leave out the picture. */
  noPicture?: boolean;
  /** More pictures (PNG), each in a paragraph of its own after the first. */
  morePictures?: number;
  /** A chart pasted from Excel as a Windows drawing (EMF), which the page can't show. */
  drawing?: boolean;
  /** A table with merged cells, and a cell holding two paragraphs. */
  merged?: boolean;
  /** Paragraphs of filler after the rest, to make a long document. */
  filler?: number;
  /** Saved with Track Changes on and editing restricted (read only), as a reviewed document often is. */
  locked?: boolean;
  /** A header with the organisation's logo (a picture of its own) on every page. */
  header?: boolean;
}

/** The header's logo: a picture no other part of the document has. */
export const LOGO = makePng(64, 16);

/** A Word document (.docx) as bytes. */
export function makeDocx(options: DocxOptions = {}): Buffer {
  const comments = options.comments ?? 1;
  const commented = Array.from({ length: comments }, (_, i) => i);
  const opening =
    run("The offsite is in ") +
    run("March", true) +
    run(", ") +
    (options.noChanges
      ? run("at the lake house")
      : `<w:del w:id="101" w:author="Ana" w:date="2026-11-01T10:00:00Z"><w:r><w:delText xml:space="preserve">downtown</w:delText></w:r></w:del>` +
        `<w:ins w:id="102" w:author="Ana" w:date="2026-11-01T10:00:00Z"><w:r><w:t xml:space="preserve">at the lake house</w:t></w:r></w:ins>`) +
    run(". ") +
    commented.map((i) => `<w:commentRangeStart w:id="${i}"/>${run(`Budget${i ? ` ${i + 1}` : ""}`)}<w:commentRangeEnd w:id="${i}"/><w:r><w:commentReference w:id="${i}"/></w:r>`).join(run(" ")) +
    run(" is set.");
  const body = [
    para(run("Offsite notes"), "Title"),
    para(run("Plan"), "Heading1"),
    para(opening),
    bullet("Book the venue"),
    bullet("Send the agenda"),
    para(run("Who"), "Heading2"),
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>${row("Name", "Role")}${row("Ana", "Host")}${row("Ben", "Notes")}</w:tbl>`,
    ...(options.noPicture ? [] : [para(picture("rIdMap"))]),
    ...Array.from({ length: options.morePictures ?? 0 }, (_, i) => para(picture(`rIdMore${i}`, `Photo ${i + 2}`))),
    ...(options.drawing ? [para(picture("rIdChart", "Sales chart"))] : []),
    ...(options.merged
      ? [
          `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>` +
            `<w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${para(run("Budget"))}</w:tc></w:tr>` +
            `<w:tr><w:tc>${para(run("Travel"))}</w:tc><w:tc>${para(run("Flights"))}${para(run("Hotel"))}</w:tc></w:tr></w:tbl>`,
        ]
      : []),
    para(run("Questions to the team.")),
    ...Array.from({ length: options.filler ?? 0 }, (_, i) => para(run(`Filler paragraph ${i + 1} with a few words in it to make the document longer.`))),
  ].join("");
  const headerRef = options.header ? '<w:headerReference w:type="default" r:id="rIdHeader"/>' : "";
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W} ${DRAWING}><w:body>${body}<w:sectPr>${headerRef}<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  const style = (id: string, name: string, extra = "") => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${extra}</w:style>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}>${[
    style("Normal", "Normal"),
    style("Title", "Title", '<w:basedOn w:val="Normal"/>'),
    style("Heading1", "heading 1", '<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:color w:val="8A2BE2"/></w:rPr>'),
    style("Heading2", "heading 2", '<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr>'),
    style("ListParagraph", "List Paragraph", '<w:basedOn w:val="Normal"/>'),
  ].join("")}</w:styles>`;
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  const commentsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${W}>${commented
    .map((i) => `<w:comment w:id="${i}" w:author="Ana" w:date="2026-11-01T10:00:00Z" w:initials="A">${para(run(`Is this the final budget${i ? ` ${i + 1}` : ""}?`))}</w:comment>`)
    .join("")}</w:comments>`;

  const rels = [
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>',
    ...(comments ? ['<Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>'] : []),
    ...(options.noPicture ? [] : ['<Relationship Id="rIdMap" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>']),
    ...Array.from(
      { length: options.morePictures ?? 0 },
      (_, i) => `<Relationship Id="rIdMore${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i + 2}.png"/>`,
    ),
    ...(options.drawing ? ['<Relationship Id="rIdChart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/chart.emf"/>'] : []),
    ...(options.locked ? ['<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>'] : []),
    ...(options.header ? ['<Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>'] : []),
  ];
  const settings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings ${W}><w:writeProtection w:recommended="1"/><w:trackRevisions/><w:documentProtection w:edit="readOnly" w:enforcement="1"/><w:defaultTabStop w:val="720"/><w:docVars><w:docVar w:name="Client" w:val="Lakeside"/></w:docVars></w:settings>`;
  const header = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${W} ${DRAWING}>${para(run("Offsite notes, draft") + picture("rIdLogo", "Logo"))}</w:hdr>`;
  const headerRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdLogo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logo.png"/></Relationships>';
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="emf" ContentType="image/x-emf"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>${comments ? '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>' : ""}${options.locked ? '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' : ""}${options.header ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ""}</Types>`;

  return makeZip([
    { name: "[Content_Types].xml", data: types },
    {
      name: "_rels/.rels",
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    { name: "word/document.xml", data: document },
    { name: "word/_rels/document.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>` },
    { name: "word/styles.xml", data: styles },
    { name: "word/numbering.xml", data: numbering },
    ...(comments ? [{ name: "word/comments.xml", data: commentsXml }] : []),
    ...(options.noPicture ? [] : [{ name: "word/media/image1.png", data: makePng(100, 50) }]),
    ...Array.from({ length: options.morePictures ?? 0 }, (_, i) => ({ name: `word/media/image${i + 2}.png`, data: makePng(40 + i, 30) })),
    // (An EMF drawing starts with its header record, type 1; the rest doesn't matter here.)
    ...(options.drawing ? [{ name: "word/media/chart.emf", data: new Uint8Array([1, 0, 0, 0, 108, 0, 0, 0, ...new Array(100).fill(0)]) }] : []),
    ...(options.locked ? [{ name: "word/settings.xml", data: settings }] : []),
    ...(options.header
      ? [
          { name: "word/header1.xml", data: header },
          { name: "word/_rels/header1.xml.rels", data: headerRels },
          { name: "word/media/logo.png", data: LOGO },
        ]
      : []),
  ]);
}
