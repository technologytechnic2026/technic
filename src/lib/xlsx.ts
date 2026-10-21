import { buildZip } from "@/lib/zip";

/**
 * Minimal .xlsx (Office Open XML) writer: multiple sheets, text and numeric
 * cells, bold header row, frozen header, sensible column widths. No dependency.
 */

export type Cell = string | number | null | undefined;
export interface Sheet {
  name: string;
  rows: Cell[][];
  /** Number of leading rows styled as headings (default 1). */
  headerRows?: number;
  /** Per-column widths in characters (default: auto from content, max 60). */
  widths?: number[];
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)
   // strip characters XML 1.0 forbids
   .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

function colName(i: number): string {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function sheetName(name: string, used: Set<string>): string {
  let base = name.replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31) || "Sheet";
  let out = base;
  let i = 2;
  while (used.has(out.toLowerCase())) out = `${base.slice(0, 28)} ${i++}`;
  used.add(out.toLowerCase());
  return out;
}

function sheetXml(sheet: Sheet): string {
  const headerRows = sheet.headerRows ?? 1;
  const widths =
    sheet.widths ??
    (() => {
      const w: number[] = [];
      for (const row of sheet.rows) row.forEach((c, i) => { w[i] = Math.min(60, Math.max(w[i] ?? 8, String(c ?? "").length + 2)); });
      return w;
    })();
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  const rows = sheet.rows
    .map((row, r) => {
      const cells = row
        .map((c, i) => {
          if (c === null || c === undefined || c === "") return "";
          const ref = `${colName(i)}${r + 1}`;
          const head = r < headerRows;
          if (typeof c === "number" && Number.isFinite(c)) return `<c r="${ref}" s="${head ? 1 : 2}"><v>${c}</v></c>`;
          return `<c r="${ref}" s="${head ? 1 : 0}" t="inlineStr"><is><t xml:space="preserve">${esc(String(c))}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  const pane = headerRows > 0
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRows}" topLeftCell="A${headerRows + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}<cols>${cols}</cols><sheetData>${rows}</sheetData></worksheet>`;
}

export function buildXlsx(sheets: Sheet[]): Buffer {
  const used = new Set<string>();
  const named = sheets.map((s) => ({ ...s, name: sheetName(s.name, used) }));
  const files: { name: string; data: Buffer }[] = [];
  const add = (name: string, xml: string) => files.push({ name, data: Buffer.from(xml, "utf8") });

  add("[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`);
  add("_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  add("xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${named.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`);
  add("xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  // styles: 0 normal, 1 bold header, 2 number 0.00
  add("xl/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`);
  named.forEach((s, i) => add(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)));
  return buildZip(files);
}
