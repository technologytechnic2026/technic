import "server-only";

import path from "path";
import PDFDocument from "pdfkit";

import { amountInWords } from "@/lib/money";
import type { BranchProfile } from "./pdf-builder";
import type { CompanyProfile } from "./types";

/**
 * Technic Technology sales documents (Tax Invoice / Invoice / Quotation) in the
 * traditional billing-machine style: a plain black-on-white, monospaced text
 * printout on a fixed 100-column grid, hyphen separators, aligned numeric
 * columns and a text summary block.
 *
 * This is a VISUAL layer only. Every figure arrives pre-computed in
 * `SalesDocData` (built from the saved record in pdf-templates.ts) and is only
 * formatted here — nothing is recalculated.
 *
 * Only the bundled DejaVu Sans Mono TTFs are used: PDFKit's built-in Courier
 * reads .afm files from disk at runtime, which is not available in the
 * production bundle.
 */

const FONT = "DejaVuSansMono";
const FONT_BOLD = "DejaVuSansMono-Bold";
const INK = "#000000";

export interface SalesDocLine {
  name: string;
  subName?: string | null;
  serials?: string[];
  hsn?: string | null;
  quantity: number;
  /** Unit rate, ex-tax on GST documents. */
  rate: number;
  /** Line discount percent (applied in the totals panel, as on the printed form). */
  discountPercent: number;
  /** Amount after discount, ex-tax — feeds the GST slab summary. */
  taxable: number;
  /** Tax on this line after discount, when known exactly (saved documents). */
  tax?: number;
  gstRate: number;
  /** quantity × rate (before discount). */
  amount: number;
}

export interface SalesDocTotals {
  gross: number;
  discount: number;
  /** Gross − discount. */
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  roundOff: number;
  total: number;
}

export interface SalesDocData {
  title: string;
  isGst: boolean;
  company: CompanyProfile & { state?: string | null };
  branch: BranchProfile;
  /** Label/value rows of the grid beside the customer block. Labels carry their own colon. */
  meta: [string, string][];
  toHeading?: string;
  to: { name: string; lines: string[] };
  lines: SalesDocLine[];
  totals: SalesDocTotals;
  bankDetails?: string;
  terms?: string;
  notes?: string | null;
  /** Reason for the discount, printed under the Discount row. */
  discountRemarks?: string | null;
  signatoryFor: string;
  cancelledReason?: string | null;
}

const A4 = { w: 595.28, h: 841.89 };
const M = 24;
const COLS = 100; // characters per line
const CHAR_ADVANCE = 0.602; // DejaVu Sans Mono advance width, em
const FONT_SIZE = (A4.w - M * 2) / COLS / CHAR_ADVANCE;
const LH = 11.4; // line height, pt
const LINES_PER_PAGE = Math.floor((A4.h - M * 2 - 12) / LH);

const grouped = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
export const money = (v: number) => grouped.format(r2(v));
export const rupees = (v: number) => `Rs. ${money(v)}`;
const plain = (v: number) => r2(v).toFixed(2);
const DASH = "-".repeat(COLS);

interface Ln { t: string; b?: boolean }
const L = (t = "", b = false): Ln => ({ t, b });

const padR = (s: string, w: number) => (s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length));
const padL = (s: string, w: number) => (s.length >= w ? s.slice(-w) : " ".repeat(w - s.length) + s);
const center = (s: string, w = COLS) => (s.length >= w ? s : " ".repeat(Math.floor((w - s.length) / 2)) + s);

/** Word-wrap to `w` characters; over-long words are hard-split so nothing overlaps a column. */
function wrap(text: string, w: number): string[] {
  const out: string[] = [];
  for (const para of String(text ?? "").split(/\r?\n/)) {
    let cur = "";
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (word.length > w) {
        if (cur) { out.push(cur); cur = ""; }
        out.push(word.slice(0, w));
        word = word.slice(w);
      }
      if (!cur) cur = word;
      else if (cur.length + 1 + word.length <= w) cur += " " + word;
      else { out.push(cur); cur = word; }
    }
    out.push(cur);
  }
  return out.length ? out : [""];
}

/** "Rupees Thirty Two Thousand … only" */
function wordsLine(total: number): string {
  const full = amountInWords(total);
  const m = /^(.*?) Rupees?(?: And (.*) Paise)? Only$/.exec(full);
  if (!m) return full;
  return `Rupees ${m[1]}${m[2] ? ` and ${m[2]} Paise` : ""} only`;
}

interface Slab { rate: number; taxable: number; tax: number; half: number }
function slabs(d: SalesDocData): Slab[] {
  const map = new Map<number, Slab>();
  for (const l of d.lines) {
    const s = map.get(l.gstRate) ?? { rate: l.gstRate, taxable: 0, tax: 0, half: 0 };
    s.taxable += l.taxable;
    const lineTax = l.tax ?? (l.taxable * l.gstRate) / 100;
    s.tax += lineTax;
    s.half += r2(lineTax / 2); // same per-line halving as the saved CGST/SGST
    map.set(l.gstRate, s);
  }
  return [...map.values()].sort((a, b) => a.rate - b.rate);
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

interface Table { head: string; widths: { desc: number } }

function tableLayout(d: SalesDocData) {
  // SLNO | DESCRIPTION | HSN | QUANTITY | GST% | RATE | AMOUNT  (GST% only on GST documents)
  const cols: { id: string; h: string; w: number; right: boolean }[] = [
    { id: "sl", h: "SLNO", w: 4, right: true },
    { id: "desc", h: "DESCRIPTION", w: 0, right: false },
    { id: "hsn", h: "HSN", w: 8, right: false },
    { id: "qty", h: "QUANTITY", w: 8, right: true },
    ...(d.isGst ? [{ id: "gst", h: "GST%", w: 6, right: true }] : []),
    { id: "rate", h: "RATE", w: 11, right: true },
    { id: "amount", h: "AMOUNT", w: 13, right: true },
  ];
  const fixed = cols.reduce((s, c) => s + c.w, 0) + (cols.length - 1);
  cols.find((c) => c.id === "desc")!.w = COLS - fixed;
  const head = cols.map((c) => (c.right ? padL(c.h, c.w) : padR(c.h, c.w))).join(" ");
  return { cols, head };
}

function headerLines(d: SalesDocData): Ln[] {
  const c = d.company;
  const out: Ln[] = [L(center(c.name.toUpperCase()), true)];
  const addr = c.address || [d.branch.addressLine, d.branch.city, d.branch.state, d.branch.pincode].filter(Boolean).join(", ");
  if (addr) for (const l of wrap(addr, COLS - 10)) out.push(L(center(l)));
  const phone = d.branch.phone || c.phone;
  const email = d.branch.email || c.email;
  const contact = [phone ? `Phone: ${phone}` : "", email ? `Email: ${email}` : ""].filter(Boolean).join("   ");
  if (contact) for (const l of wrap(contact, COLS - 4)) out.push(L(center(l)));
  if (c.gstin) out.push(L(center(`GSTIN : ${c.gstin}${c.state ? `   State: ${c.state}` : ""}`), true));
  out.push(L(DASH), L(center(d.title), true), L(DASH));

  // To (left) | document details (right)
  const LEFT = 54;
  const left: Ln[] = [L(`${d.toHeading ?? "To"} : ${d.to.name}`.slice(0, LEFT), true)];
  for (const l of d.to.lines) for (const w of wrap(l, LEFT - 5)) left.push(L("     " + w));
  const right: Ln[] = d.meta.map(([k, v]) => L(padR(k, 18) + (v || "")));
  const rows = Math.max(left.length, right.length);
  for (let i = 0; i < rows; i++) {
    const a = left[i] ?? L();
    const b = right[i] ?? L();
    out.push(L(padR(a.t, LEFT + 2) + b.t, false));
    // keep the customer name bold without re-rendering the whole row
    if (i === 0 && a.b) out[out.length - 1].b = true;
  }
  out.push(L(DASH));
  return out;
}

function rowLines(d: SalesDocData, cols: ReturnType<typeof tableLayout>["cols"]): Ln[] {
  const descW = cols.find((c) => c.id === "desc")!.w;
  const out: Ln[] = [];
  d.lines.forEach((line, i) => {
    const desc = wrap(line.name, descW);
    const extra: string[] = [];
    if (line.subName) extra.push(...wrap(line.subName, descW - 2).map((x) => "  " + x));
    if (line.serials?.length) extra.push(...wrap(`SN: ${line.serials.join(", ")}`, descW - 2).map((x) => "  " + x));
    const all = [...desc, ...extra];
    const cell = (id: string): string => {
      switch (id) {
        case "sl": return String(i + 1);
        case "hsn": return line.hsn ?? "";
        case "qty": return String(line.quantity);
        case "rate": return plain(line.rate);
        case "gst": return plain(line.gstRate);
        case "amount": return plain(line.amount);
        default: return "";
      }
    };
    all.forEach((text, k) => {
      out.push(L(cols.map((c) => {
        if (c.id === "desc") return padR(text, c.w);
        const v = k === 0 ? cell(c.id) : "";
        return c.right ? padL(v, c.w) : padR(v, c.w);
      }).join(" ")));
    });
  });
  return out;
}

function footerLines(d: SalesDocData): Ln[] {
  const t = d.totals;
  const out: Ln[] = [];
  const LEFT = 54;
  const RIGHT = COLS - LEFT - 2;
  const inter = t.igst > 0;

  // GST-wise taxable sales (left)
  const left: Ln[] = [];
  if (d.isGst) {
    const sl = slabs(d);
    const head = inter
      ? `${padL("GST%", 6)} ${padL("TAXABLE", 13)} ${padL("IGST%", 6)} ${padL("IGST AMT", 12)}`
      : `${padL("GST%", 5)} ${padL("TAXABLE", 12)} ${padL("SGST%", 6)} ${padL("SGST AMT", 10)} ${padL("CGST%", 6)} ${padL("CGST AMT", 10)}`;
    left.push(L(padR("GST-WISE TAXABLE SALES", LEFT), true), L(head, true));
    for (const s of sl) {
      left.push(L(inter
        ? `${padL(s.rate.toFixed(1), 6)} ${padL(plain(s.taxable), 13)} ${padL(s.rate.toFixed(1), 6)} ${padL(plain(s.tax), 12)}`
        : `${padL(s.rate.toFixed(1), 5)} ${padL(plain(s.taxable), 12)} ${padL((s.rate / 2).toFixed(1), 6)} ${padL(plain(s.half), 10)} ${padL((s.rate / 2).toFixed(1), 6)} ${padL(plain(s.half), 10)}`));
    }
  }

  // Totals (right)
  const right: Ln[] = [];
  const row = (label: string, value: string, b = false) => right.push(L(padR(label, RIGHT - value.length) + value, b));
  const pcts = [...new Set(d.lines.map((l) => l.discountPercent))];
  const uniform = pcts.length === 1 && pcts[0] > 0 && Math.abs((t.gross * pcts[0]) / 100 - t.discount) <= 0.05;
  row("Gross Amount", padL(money(t.gross), 14));
  if (t.discount > 0) row(`Discount (-)${uniform ? ` ${+pcts[0].toFixed(2)}%` : ""}`, padL(money(t.discount), 14));
  if (d.isGst) {
    row("Taxable Value", padL(money(t.taxable), 14));
    if (t.cgst > 0) row("Add CGST", padL(money(t.cgst), 14));
    if (t.sgst > 0) row("Add SGST", padL(money(t.sgst), 14));
    if (t.igst > 0) row("Add IGST", padL(money(t.igst), 14));
  } else {
    row("Taxable Value", padL(money(t.taxable), 14));
  }
  if (t.roundOff !== 0) row("Round Off", padL(`${t.roundOff < 0 ? "-" : "+"}${money(Math.abs(t.roundOff))}`, 14));
  right.push(L("=".repeat(RIGHT)));
  row("BILL AMOUNT", padL(money(t.total), 14), true);
  right.push(L("=".repeat(RIGHT)));

  const rows = Math.max(left.length, right.length);
  for (let i = 0; i < rows; i++) {
    const a = left[i] ?? L();
    const b = right[i] ?? L();
    // The totals column carries the bold NET line; the left side is bold only on its two heading rows.
    out.push({ t: padR(a.t, LEFT + 2) + b.t, b: Boolean(b.b || (i < 2 && a.b)) });
  }
  out.push(L(DASH));
  out.push(L(padR("Amount in Words :", 18) + wrap(wordsLine(t.total), COLS - 18)[0], true));
  for (const w of wrap(wordsLine(t.total), COLS - 18).slice(1)) out.push(L(" ".repeat(18) + w, true));
  out.push(L(DASH));

  const bank = d.bankDetails?.trim();
  if (bank) {
    out.push(L("BANK DETAILS", true));
    for (const line of bank.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) for (const w of wrap(line, COLS)) out.push(L(w));
    out.push(L());
  }
  const terms = d.terms?.trim();
  if (terms) {
    out.push(L("TERMS & CONDITIONS", true));
    for (const line of terms.split(/\r?\n/)) for (const w of wrap(line, COLS)) out.push(L(w));
    out.push(L());
  }
  if (d.discountRemarks?.trim()) for (const w of wrap(`Discount reason: ${d.discountRemarks.trim()}`, COLS)) out.push(L(w));
  if (d.notes?.trim()) for (const w of wrap(`Notes: ${d.notes.trim()}`, COLS)) out.push(L(w));
  out.push(L(), L(padL(`For ${d.signatoryFor.toUpperCase()}`, COLS), true), L(), L(), L(padL("Authorised Signatory", COLS)));
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function renderSalesDocument(d: SalesDocData, title: string): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margin: 0, // every position is explicit — no implicit page breaks
    bufferPages: true,
    info: { Title: title, Author: d.company.name, Creator: "Technic Technologies ERP" },
  });
  doc.registerFont(FONT, path.join(process.cwd(), "public", "fonts", "DejaVuSansMono.ttf"));
  doc.registerFont(FONT_BOLD, path.join(process.cwd(), "public", "fonts", "DejaVuSansMono-Bold.ttf"));

  const { cols, head } = tableLayout(d);
  const first = headerLines(d);
  const tableHead = [L(head, true), L(DASH)];
  const rows = rowLines(d, cols);
  const foot = footerLines(d);

  // Paginate: header + column heading on page 1; a compact heading on later pages;
  // the summary/footer block is kept together.
  const pages: Ln[][] = [];
  let cur: Ln[] = [...first, ...tableHead];
  const contHead = () => [L(`${d.title} - ${d.meta[0]?.[1] ?? ""} (continued)`, true), L(DASH), ...tableHead];
  for (const r of rows) {
    if (cur.length + 1 > LINES_PER_PAGE - 2) { pages.push(cur); cur = contHead(); }
    cur.push(r);
  }
  cur.push(L(DASH));
  if (cur.length + foot.length > LINES_PER_PAGE) { pages.push(cur); cur = []; }
  cur.push(...foot);
  pages.push(cur);

  pages.forEach((lines, pi) => {
    if (pi > 0) doc.addPage();
    lines.forEach((ln, i) => {
      doc.font(ln.b ? FONT_BOLD : FONT).fontSize(FONT_SIZE).fillColor(INK)
        .text(ln.t, M, M + i * LH, { lineBreak: false, characterSpacing: 0 });
    });
  });

  if (d.cancelledReason !== undefined && d.cancelledReason !== null) {
    doc.switchToPage(0);
    doc.save();
    doc.opacity(0.15).font(FONT_BOLD).fontSize(60).fillColor("#000000");
    doc.rotate(-30, { origin: [A4.w / 2, A4.h / 2] });
    doc.text("CANCELLED", A4.w / 2 - 190, A4.h / 2 - 30, { width: 380, align: "center", lineBreak: false });
    doc.restore();
    doc.opacity(1);
  }

  const range = doc.bufferedPageRange();
  if (range.count > 1) {
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc.font(FONT).fontSize(FONT_SIZE).fillColor(INK)
        .text(`Page ${i + 1} of ${range.count}`, M, A4.h - M - 8, { lineBreak: false });
    }
  }

  doc.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}
