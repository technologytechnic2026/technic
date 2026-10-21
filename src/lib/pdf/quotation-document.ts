import "server-only";

import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";

import { amountInWords } from "@/lib/money";
import type { BranchProfile } from "./pdf-builder";
import type { CompanyProfile } from "./types";

/**
 * QUOTATION PDF TEMPLATE — the original bordered Technic quotation layout,
 * restored verbatim from 97fde9c (before the monospaced redesign) with two
 * requested changes only: no "Disc %" item column, and the summary row under
 * Discount is labelled "Taxable Value". Invoices use ./sales-document.ts.
 *
 * Technic Technology sales-document layout — a faithful reproduction of the
 * firm's existing printed Tax Invoice: one bordered A4 sheet, monochrome,
 * logo left / company details right, "To" block beside a label-value grid
 * (Invoice No., Date, Type, Despatched Through, E-Way No.), an items table
 * (Sl No · Description · Hsn · Quantity · Gst% · Rate · Amount), a GST slab
 * summary, bank details, amount in words, terms, and the totals panel with
 * "For <company> / Authorised Signatory".
 *
 * Nothing is hardcoded: every value is supplied by the caller from the saved
 * record. The same renderer prints Quotations.
 */

// Only bundled TTFs (public/fonts) are used: PDFKit's built-in Helvetica reads
// .afm files from disk at runtime, which breaks in a bundled production build.
// DejaVu also carries the ₹ glyph.
const FONT = "DejaVuSans";
const FONT_BOLD = "DejaVuSans-Bold";
const FONT_SYMBOL = "DejaVuSans-Bold";

const INK = "#000000";
const LINE = "#333333";
const ACCENT = "#c1121f";

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
const W = A4.w - M * 2;
const PANEL_W = 170; // right-hand panel (Gst% + Rate + Amount columns)
const PAD = 4;

const grouped = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
export const money = (v: number) => grouped.format(r2(v));
export const rupees = (v: number) => `₹ ${money(v)}`;
const plain = (v: number) => r2(v).toFixed(2);
const group = (v: number) => grouped.format(r2(v));

type Doc = InstanceType<typeof PDFDocument>;
interface T { w: number; size?: number; bold?: boolean; align?: "left" | "center" | "right"; color?: string }

const hOf = (doc: Doc, s: string, o: T) =>
  doc.font(o.bold ? FONT_BOLD : FONT).fontSize(o.size ?? 8).heightOfString(s, { width: o.w, align: o.align });

function put(doc: Doc, s: string, x: number, y: number, o: T): number {
  doc.font(o.bold ? FONT_BOLD : FONT).fontSize(o.size ?? 8).fillColor(o.color ?? INK)
    .text(s, x, y, { width: o.w, align: o.align, lineBreak: true });
  return hOf(doc, s, o);
}
const hline = (doc: Doc, x1: number, x2: number, y: number, lw = 0.7) =>
  void doc.lineWidth(lw).strokeColor(LINE).moveTo(x1, y).lineTo(x2, y).stroke();
const vline = (doc: Doc, x: number, y1: number, y2: number, lw = 0.7) =>
  void doc.lineWidth(lw).strokeColor(LINE).moveTo(x, y1).lineTo(x, y2).stroke();
const box = (doc: Doc, x: number, y: number, w: number, h: number, lw = 0.7) =>
  void doc.lineWidth(lw).strokeColor(LINE).rect(x, y, w, h).stroke();

function rupeeSymbol(doc: Doc, x: number, y: number, size: number) {
  doc.font(FONT_SYMBOL).fontSize(size).fillColor(INK).text("₹", x, y, { lineBreak: false });
}

/** "Rupees Thirty Two Thousand … only", as printed on the firm's invoice. */
function wordsLine(total: number): string {
  const full = amountInWords(total); // "X Rupees Only" / "X Rupees And Y Paise Only"
  const m = /^(.*?) Rupees?(?: And (.*) Paise)? Only$/.exec(full);
  if (!m) return full;
  return `Rupees ${m[1]}${m[2] ? ` and ${m[2]} Paise` : ""} only`;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

interface Col { id: string; header: string; w: number; align: "left" | "center" | "right" }

function columns(isGst: boolean): Col[] {
  return isGst
    ? [
        { id: "sl", header: "Sl\nNo", w: 20, align: "center" },
        { id: "desc", header: "Description of Goods", w: 242, align: "center" },
        { id: "hsn", header: "Hsn", w: 49, align: "center" },
        { id: "qty", header: "Quantity", w: 65, align: "center" },
        { id: "gst", header: "Gst%", w: 30, align: "center" },
        { id: "rate", header: "Rate", w: 65, align: "center" },
        { id: "amount", header: "Amount", w: 75, align: "center" },
      ]
    : [
        { id: "sl", header: "Sl\nNo", w: 20, align: "center" },
        { id: "desc", header: "Description of Goods", w: 242, align: "center" },
        { id: "hsn", header: "Hsn", w: 49, align: "center" },
        { id: "qty", header: "Quantity", w: 65, align: "center" },
        { id: "rate", header: "Rate", w: 95, align: "center" },
        { id: "amount", header: "Amount", w: 75, align: "center" },
      ];
}

function cell(col: Col, line: SalesDocLine, i: number): string {
  switch (col.id) {
    case "sl": return String(i + 1);
    case "hsn": return line.hsn || "";
    case "qty": return String(line.quantity);
    case "gst": return plain(line.gstRate);
    case "rate": return plain(line.rate);
    case "amount": return plain(line.amount);
    default: return "";
  }
}

// ---------------------------------------------------------------------------
// Header: title bar, logo | company, To | grid
// ---------------------------------------------------------------------------

function drawHeader(doc: Doc, d: SalesDocData): number {
  let y = M;
  const titleH = 17;
  box(doc, M, y, W, titleH);
  put(doc, d.title, M, y + 4.5, { w: W, size: 8.5, bold: true, align: "center" });
  y += titleH;

  // Logo | company
  const logoW = 268;
  const c = d.company;
  const tx = M + logoW + 6;
  const tw = W - logoW - 10;
  const addr = c.address || [d.branch.addressLine, d.branch.city, d.branch.state, d.branch.pincode].filter(Boolean).join(", ");
  const phone = d.branch.phone || c.phone;
  const email = d.branch.email || c.email;
  const parts: { s: string; bold?: boolean; size: number }[] = [
    { s: c.name.toUpperCase(), bold: true, size: 10.5 },
    ...(addr ? [{ s: addr, size: 8.5 }] : []),
    ...(phone ? [{ s: `Phone No : ${phone}`, size: 8.5 }] : []),
    ...(email ? [{ s: `Email : ${email}`, size: 8.5 }] : []),
    ...(c.gstin ? [{ s: `GSTIN : ${c.gstin}`, bold: true, size: 8.5 }] : []),
  ];
  const textH = parts.reduce((s, p) => s + hOf(doc, p.s, { w: tw, size: p.size, bold: p.bold }) + 1.5, 0);
  const rowH = Math.max(textH + 10, 70);
  box(doc, M, y, W, rowH);
  vline(doc, M + logoW, y, y + rowH);
  const logo = ["logo-pdf.png", "logo.png"].map((f) => path.join(process.cwd(), "public", f)).find((p) => fs.existsSync(p));
  if (logo) {
    try { doc.image(logo, M + 8, y + 6, { fit: [logoW - 16, rowH - 12], align: "center", valign: "center" }); } catch { /* render without logo */ }
  }
  let ty = y + 5;
  for (const p of parts) ty += put(doc, p.s, tx, ty, { w: tw, size: p.size, bold: p.bold }) + 1.5;
  y += rowH;

  // To | label-value grid
  const leftW = W - PANEL_W;
  const labelW = 95;
  const gridRow = 19;
  const rows = d.meta;
  const toLines = d.to.lines;
  const toH = 6 + 10 + hOf(doc, d.to.name, { w: leftW - 12, size: 8.5, bold: true }) + 3 +
    toLines.reduce((s, l) => s + hOf(doc, l, { w: leftW - 12, size: 8 }) + 2, 0) + 6;
  const blockH = Math.max(toH, rows.length * gridRow, 90);
  box(doc, M, y, W, blockH);
  vline(doc, M + leftW, y, y + blockH);
  put(doc, d.toHeading ?? "To", M + 8, y + 4, { w: leftW - 16, size: 7.5, bold: true });
  let ly = y + 15;
  ly += put(doc, d.to.name, M + 8, ly, { w: leftW - 16, size: 8.5, bold: true }) + 3;
  for (const l of toLines) ly += put(doc, l, M + 8, ly, { w: leftW - 16, size: 8 }) + 2;

  // Grid occupies its rows then the remaining height stays blank (as in the form).
  const gx = M + leftW;
  const gridH = blockH / Math.max(rows.length, 1) > gridRow * 1.4 ? gridRow : blockH / rows.length;
  rows.forEach(([label, value], i) => {
    const ry = y + i * gridH;
    if (i > 0) hline(doc, gx, M + W, ry);
    put(doc, label, gx + PAD, ry + (gridH - 8) / 2 - 0.5, { w: labelW - PAD, size: 7.5 });
    put(doc, value || "", gx + labelW + PAD, ry + (gridH - 8) / 2 - 0.5, { w: PANEL_W - labelW - PAD * 2, size: 7.5, bold: i === 0 });
  });
  vline(doc, gx + labelW, y, y + Math.min(blockH, rows.length * gridH));
  y += blockH;
  return y;
}

// ---------------------------------------------------------------------------
// Footer: slab summary / bank / words / terms  |  totals panel + signatory
// ---------------------------------------------------------------------------

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

function bankRows(raw: string): { k: string | null; v: string }[] {
  return raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((line) => {
    const m = /^([^:]{2,30}?)\s*:\s*(.+)$/.exec(line);
    return m ? { k: m[1], v: m[2] } : { k: null, v: line };
  });
}

function footer(doc: Doc, d: SalesDocData, y: number, draw: boolean): number {
  const t = d.totals;
  const leftW = W - PANEL_W;
  const px = M + leftW;
  const inter = t.igst > 0;

  // Left blocks --------------------------------------------------------------
  const sl = d.isGst ? slabs(d) : [];
  const sumHead = 14;
  const sumRow = 13;
  const sumH = d.isGst ? sumHead + sumRow * sl.length : 0;

  const bank = d.bankDetails?.trim() ? bankRows(d.bankDetails.trim()) : [];
  const bankH = bank.length ? 14 + bank.reduce((s, r) => s + hOf(doc, r.v, { w: leftW - 118, size: 8 }) + 1.5, 0) + 4 : 0;
  const words = wordsLine(t.total);
  const wordsH = Math.max(18, hOf(doc, words, { w: leftW - 100, size: 7.5, bold: true }) + 8);
  const terms = d.terms?.trim();
  const notes = [d.discountRemarks?.trim() ? `Discount reason: ${d.discountRemarks.trim()}` : "", d.notes?.trim() ?? ""].filter(Boolean).join("\n");
  const termsH = terms ? 14 + hOf(doc, terms, { w: leftW - 16, size: 7.5 }) + 6 : 0;
  const notesH = notes ? 12 + hOf(doc, notes, { w: leftW - 16, size: 7.5 }) + 4 : 0;
  const leftH = sumH + bankH + wordsH + termsH + notesH;

  // Right panel --------------------------------------------------------------
  const lines: [string, string][] = [["Gross Amount", group(t.gross)]];
  if (t.discount > 0) {
    const pcts = [...new Set(d.lines.map((l) => l.discountPercent))];
    // Show a % only when it really is the uniform rate that produced the discount (not a flat amount).
    const uniform = pcts.length === 1 && pcts[0] > 0 && Math.abs((t.gross * pcts[0]) / 100 - t.discount) <= 0.05;
    const pct = uniform ? ` ${+pcts[0].toFixed(2)}%` : "";
    lines.push([`Discount (-)${pct}`, group(t.discount)]);
  }
  lines.push(["Taxable Value", group(t.taxable)]);
  if (d.isGst) {
    if (t.cgst > 0) lines.push(["ADD CGST", group(t.cgst)]);
    if (t.sgst > 0) lines.push(["ADD SGST", group(t.sgst)]);
    if (t.igst > 0) lines.push(["ADD IGST", group(t.igst)]);
  }
  if (t.roundOff !== 0) lines.push(["Round Up", plain(t.roundOff)]);
  const rowH = 17;
  const billH = 22;
  const sigH = 62;
  const rightH = lines.length * rowH + billH + sigH;
  const H = Math.max(leftH, rightH);
  if (!draw) return H;

  box(doc, M, y, W, H);
  vline(doc, px, y, y + H);

  // Left
  let ly = y;
  if (d.isGst) {
    const cw = inter ? [0.2, 0.3, 0.2, 0.3] : [0.14, 0.22, 0.14, 0.18, 0.14, 0.18];
    const heads = inter ? ["GST%", "Taxable Value", "IGST %", "IGST Amt"] : ["GST%", "Taxable Value", "SGST %", "SGST Amt", "CGST %", "CGST Amt"];
    let x = M;
    heads.forEach((h, i) => {
      const w = cw[i] * leftW;
      put(doc, h, x, ly + 3.5, { w, size: 7, bold: true, align: "center" });
      x += w;
    });
    ly += sumHead;
    for (const s of sl) {
      const half = s.half;
      const vals = inter
        ? [`${s.rate.toFixed(1)}%`, plain(s.taxable), `${s.rate.toFixed(1)}%`, plain(s.tax)]
        : [`${s.rate.toFixed(1)}%`, plain(s.taxable), `${(s.rate / 2).toFixed(1)}%`, plain(half), `${(s.rate / 2).toFixed(1)}%`, plain(half)];
      x = M;
      vals.forEach((v, i) => {
        const w = cw[i] * leftW;
        put(doc, v, x, ly + 2.5, { w, size: 7, align: "center" });
        x += w;
      });
      ly += sumRow;
    }
    hline(doc, M, px, ly);
  }
  if (bank.length) {
    put(doc, "BANK DETAILS", M + 4, ly + 3, { w: 120, size: 7.5, bold: true });
    doc.lineWidth(0.6).strokeColor(INK).moveTo(M + 4, ly + 12).lineTo(M + 62, ly + 12).stroke();
    let by = ly + 15;
    for (const r of bank) {
      if (r.k) {
        put(doc, r.k, M + 4, by, { w: 108, size: 8 });
        put(doc, `: ${r.v}`, M + 112, by, { w: leftW - 118, size: 8 });
        by += hOf(doc, r.v, { w: leftW - 118, size: 8 }) + 1.5;
      } else {
        by += put(doc, r.v, M + 4, by, { w: leftW - 10, size: 8 }) + 1.5;
      }
    }
    ly += bankH;
    hline(doc, M, px, ly);
  }
  put(doc, "Amount in Words :", M + 4, ly + 5, { w: 80, size: 7.5 });
  put(doc, words, M + 88, ly + 5, { w: leftW - 94, size: 7.5, bold: true });
  ly += wordsH;
  hline(doc, M, px, ly);
  if (terms) {
    put(doc, "Terms & Condition", M + 4, ly + 4, { w: leftW - 8, size: 8, bold: true });
    ly += 14 + put(doc, terms, M + 8, ly + 14, { w: leftW - 16, size: 7.5 }) + 2;
  }
  if (notes) {
    put(doc, "Notes", M + 4, ly + 2, { w: leftW - 8, size: 7.5, bold: true });
    put(doc, notes, M + 8, ly + 12, { w: leftW - 16, size: 7.5 });
  }

  // Right
  let ry = y;
  const labelW = 95;
  lines.forEach(([label, value]) => {
    put(doc, label, px + PAD, ry + 5, { w: labelW - PAD, size: 7.5 });
    vline(doc, px + labelW, ry, ry + rowH);
    put(doc, value, px + labelW, ry + 5, { w: PANEL_W - labelW - PAD, size: 7.5, align: "right" });
    ry += rowH;
    hline(doc, px, M + W, ry);
  });
  // Bill Amount
  put(doc, "Bill Amount", px + PAD, ry + 7, { w: 60, size: 8.5 });
  rupeeSymbol(doc, px + 62, ry + 5.5, 10);
  put(doc, group(t.total), px + 72, ry + 5.5, { w: PANEL_W - 72 - PAD, size: 10, bold: true, align: "right" });
  ry += billH;
  hline(doc, px, M + W, ry);
  put(doc, `For ${d.signatoryFor}`, px, ry + 8, { w: PANEL_W, size: 8.5, bold: true, align: "center" });
  put(doc, "Authorised Signatory", px, y + H - 12, { w: PANEL_W, size: 7, align: "center" });
  return H;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function renderQuotationDocument(d: SalesDocData, title: string): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margin: 0, // every position is explicit — no implicit page breaks
    bufferPages: true,
    info: { Title: title, Author: d.company.name, Creator: "Technic Technologies ERP" },
  });
  doc.registerFont(FONT, path.join(process.cwd(), "public", "fonts", "DejaVuSans.ttf"));
  doc.registerFont(FONT_BOLD, path.join(process.cwd(), "public", "fonts", "DejaVuSans-Bold.ttf"));

  const cols = columns(d.isGst);
  const descIdx = cols.findIndex((c) => c.id === "desc");
  const maxY = A4.h - M;
  const headH = 24;

  const tableHeader = (y: number) => {
    box(doc, M, y, W, headH);
    let x = M;
    cols.forEach((c, i) => {
      if (i > 0) vline(doc, x, y, y + headH);
      const lines = c.header.split("\n").length;
      put(doc, c.header, x, y + (headH - lines * 8.5) / 2 + (lines > 1 ? 0 : 0.5), { w: c.w, size: 7.5, align: "center" });
      x += c.w;
    });
    return y + headH;
  };
  const rules = (from: number, to: number) => {
    let x = M;
    cols.forEach((c, i) => {
      if (i > 0) vline(doc, x, from, to);
      x += c.w;
    });
    vline(doc, M, from, to);
    vline(doc, M + W, from, to);
  };

  let y = drawHeader(doc, d);
  const footerH = footer(doc, d, 0, false);
  y = tableHeader(y);
  let bodyStart = y;

  d.lines.forEach((line, i) => {
    const dw = cols[descIdx].w - PAD * 2;
    const h =
      hOf(doc, line.name, { w: dw, size: 8, bold: true }) +
      (line.subName ? hOf(doc, line.subName, { w: dw, size: 7.5 }) : 0) +
      (line.serials?.length ? hOf(doc, `SN: ${line.serials.join(", ")}`, { w: dw, size: 7 }) : 0) +
      8;
    const rh = Math.max(h, 16);
    if (y + rh > maxY - 30) {
      rules(bodyStart, y);
      hline(doc, M, M + W, y);
      doc.addPage();
      let ny = M;
      put(doc, `${d.title} — ${d.meta[0]?.[1] ?? ""} (continued)`, M, ny + 2, { w: W, size: 8.5, bold: true });
      ny += 16;
      y = tableHeader(ny);
      bodyStart = y;
    }
    let x = M;
    cols.forEach((c) => {
      if (c.id === "desc") {
        let dy = y + 4;
        dy += put(doc, line.name, x + PAD, dy, { w: dw, size: 8, bold: true });
        if (line.subName) dy += put(doc, line.subName, x + PAD, dy, { w: dw, size: 7.5 });
        if (line.serials?.length) put(doc, `SN: ${line.serials.join(", ")}`, x + PAD, dy, { w: dw, size: 7 });
      } else {
        const align = c.id === "rate" || c.id === "amount" ? "right" : "center";
        put(doc, cell(c, line, i), x + 2, y + 4, { w: c.w - 4 - (align === "right" ? 2 : 0), size: 8, bold: c.id === "qty" || c.id === "sl" ? false : false, align });
      }
      x += c.w;
    });
    y += rh;
  });

  // Extend the blank item area so the footer sits at the foot of the sheet.
  let bodyEnd = y;
  if (y + footerH <= maxY) bodyEnd = maxY - footerH;
  else {
    rules(bodyStart, y);
    hline(doc, M, M + W, y);
    doc.addPage();
    bodyStart = M;
    bodyEnd = M;
    y = M;
  }
  if (bodyEnd > bodyStart) rules(bodyStart, bodyEnd);
  y = bodyEnd;
  hline(doc, M, M + W, y);
  footer(doc, d, y, true);

  if (d.cancelledReason !== undefined && d.cancelledReason !== null) {
    doc.save();
    doc.opacity(0.15).font(FONT_BOLD).fontSize(60).fillColor(ACCENT);
    doc.rotate(-30, { origin: [A4.w / 2, A4.h / 2] });
    doc.text("CANCELLED", A4.w / 2 - 190, A4.h / 2 - 30, { width: 380, align: "center", lineBreak: false });
    doc.restore();
    doc.opacity(1);
  }

  const range = doc.bufferedPageRange();
  if (range.count > 1) {
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      put(doc, `Page ${i + 1} of ${range.count}`, M, A4.h - 18, { w: W, size: 7, align: "right" });
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
