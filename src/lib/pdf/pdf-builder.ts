import "server-only";

import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import { prisma } from "@/lib/prisma";
import { amountInWords as amountInWordsHelper } from "@/lib/money";
import { formatDate, formatTime } from "@/lib/dates";

// Traditional, print-safe business-document palette — pure white page, black
// body text, Technic forest green for the accents (table headers, the
// document title, the separator rule, and the highlighted total row).
export const COLORS = {
  primary: "#123524", // Technic forest green — matches the app's --brand token
  primaryDark: "#0b2417",
  accent: "#e31e2d", // Technic signal red — used sparingly (cancelled stamp)
  ink: "#000000",
  muted: "#3f3f3f",
  border: "#9aa39c",
  white: "#ffffff",
};

// PDFKit's 14 built-in base fonts (Helvetica, etc.) use WinAnsiEncoding,
// which has no glyph for the Rupee sign (U+20B9) — every ₹ prints as a
// broken glyph. DejaVu Sans has the glyph and is bundled below.
const FONT_REGULAR = "DejaVuSans";
const FONT_BOLD = "DejaVuSans-Bold";

import type { CompanyProfile } from "./types";
export type { CompanyProfile };

export interface BranchProfile {
  name: string;
  addressLine?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  phone?: string | null;
  email?: string | null;
}

/**
 * Every PDF must reflect only the firm it was generated for — never
 * whichever firm's settings happened to be read first. Callers always pass
 * the firmId straight from the record the document is for.
 */
export async function getCompanyProfile(firmId: string): Promise<CompanyProfile> {
  const settings = await prisma.setting.findMany({
    where: {
      firmId,
      category: { in: ["company", "documents", "general"] },
    },
  });

  const map = new Map(settings.map((s) => [s.key, s.value]));
  const firm = await prisma.firm.findUnique({
    where: { id: firmId },
    select: {
      name: true,
      legalName: true,
      displayName: true,
      gstin: true,
      pan: true,
      addressLine: true,
      city: true,
      state: true,
      pincode: true,
      phone: true,
      email: true,
      website: true,
    },
  });

  const pick = (settingKey: string, firmValue: string | null | undefined) =>
    map.get(settingKey) || firmValue || "";

  return {
    name:
      map.get("company_name") ||
      firm?.displayName ||
      firm?.name ||
      "Technic Technologies",
    address:
      map.get("company_address") ||
      [firm?.addressLine, firm?.city, firm?.state, firm?.pincode].filter(Boolean).join(", "),
    phone: pick("company_phone", firm?.phone),
    email: pick("company_email", firm?.email),
    website: pick("company_website", firm?.website),
    // The firm record is the single source of truth for the company GSTIN — the same
    // value the ERP shows (Firms page, Settings). A "company_gstin" settings row is
    // not editable anywhere in the app (the seed once wrote a placeholder), so it must
    // never override the firm's real GSTIN on a printed document.
    gstin: firm?.gstin || "",
    pan: firm?.pan || "",
    state: firm?.state || "",
    logoUrl: map.get("company_logo") || "/logo.png",
    footerText:
      map.get("document_footer_text") ||
      "Thank you for your business. Goods once sold are subject to the warranty terms of the respective manufacturer.",
    termsConditions:
      map.get("document_terms") ||
"1. Goods once sold will not be taken back.\n2. Subject to Mangalore Jurisdiction.",
    invoicePrefix: map.get("invoice_prefix") || "INV",
    quotationPrefix: map.get("quotation_prefix") || "QT",
    purchasePrefix: map.get("purchase_prefix") || "PO",
    bankDetails: map.get("company_bank_details") || "",
  };
}

export interface PDFTableColumn {
  id: string;
  header: string;
  width: number; // percentage of content width
  align?: "left" | "center" | "right";
}

export interface PDFTableRow {
  [key: string]: string | number;
}

export interface InfoColumn {
  heading: string;
  lines: string[];
}

export interface SummaryLine {
  label: string;
  value: string;
  bold?: boolean;
  highlight?: boolean; // green background, white text — the document's headline figure
}

/**
 * Shared PDFKit document-assembly system for every Technic Technologies
 * business document (Tax Invoice, Bill, Quotation, Purchase Order,
 * Payment Receipt). One component per visual block (header, title, info
 * columns, items table, financial summary, signature) so each template
 * configures the same building blocks.
 */
export class PDFDocumentBuilder {
  doc: InstanceType<typeof PDFDocument>;
  company: CompanyProfile;
  pageWidth = 595.28; // A4 pt (210mm)
  pageHeight = 841.89; // A4 pt (297mm)
  margin = 32;
  contentWidth: number;
  currentY: number;

  readonly maxY: number;
  private static readonly BOTTOM_SAFETY = 20;

  private onNewPage: (() => void) | null = null;

  constructor(company: CompanyProfile) {
    this.company = company;
    this.contentWidth = this.pageWidth - this.margin * 2;
    this.maxY = this.pageHeight - this.margin - PDFDocumentBuilder.BOTTOM_SAFETY;
    this.doc = new PDFDocument({
      size: "A4",
      margin: this.margin,
      bufferPages: true,
      info: {
        Title: "Technic Technologies Document",
        Author: company.name,
        Creator: "Technic Technologies ERP",
      },
    });
    this.currentY = this.margin;

    this.doc.registerFont(FONT_REGULAR, path.join(process.cwd(), "public", "fonts", "DejaVuSans.ttf"));
    this.doc.registerFont(FONT_BOLD, path.join(process.cwd(), "public", "fonts", "DejaVuSans-Bold.ttf"));
    this.doc.font(FONT_REGULAR);
  }

  private text(
    value: string,
    x: number,
    y: number,
    opts: PDFKit.Mixins.TextOptions & { bold?: boolean; size?: number; color?: string } = {},
  ) {
    const { bold, size, color, ...rest } = opts;
    this.doc
      .font(bold ? FONT_BOLD : FONT_REGULAR)
      .fontSize(size ?? 9)
      .fillColor(color ?? COLORS.ink)
      .text(value, x, y, rest);
  }

  private hr(y: number, color: string = COLORS.border, width = 0.75) {
    this.doc
      .moveTo(this.margin, y)
      .lineTo(this.pageWidth - this.margin, y)
      .strokeColor(color)
      .lineWidth(width)
      .stroke();
  }

  private ensureSpace(height: number, y?: number): boolean {
    const at = y ?? this.currentY;
    if (at + height <= this.maxY) return false;
    this.doc.addPage();
    this.currentY = this.margin;
    if (this.onNewPage) this.onNewPage();
    return true;
  }

  /**
   * Company details top-left, logo top-right (aspect ratio always
   * preserved), then a thin green rule.
   */
  renderCompanyHeader(branch: BranchProfile) {
    const startY = this.currentY;
    const rightColWidth = 96;
    const leftColWidth = this.contentWidth - rightColWidth - 12;

    this.text(this.company.name, this.margin, startY, {
      bold: true,
      size: 12.5,
      width: leftColWidth,
    });

    let y = startY + 16;
    const firmLines = [
      this.company.address || branch.addressLine,
      branch.addressLine && this.company.address ? branch.name : null,
    ].filter(Boolean);
    if (firmLines.length > 0) {
      this.text(firmLines.join(" · "), this.margin, y, { size: 8.5, color: COLORS.muted, width: leftColWidth });
      y += 12;
    }

    const gstinLine = this.company.gstin ? `GSTIN: ${this.company.gstin}` : "";
    const contactParts = [branch.phone || this.company.phone, branch.email || this.company.email].filter(Boolean);
    if (gstinLine) {
      this.text(gstinLine, this.margin, y, { size: 8.5, color: COLORS.muted, width: leftColWidth });
      y += 12;
    }
    if (contactParts.length > 0) {
      this.text(contactParts.join("  ·  "), this.margin, y, { size: 8.5, color: COLORS.muted, width: leftColWidth });
      y += 12;
    }

    // Logo, top-right, aspect-ratio preserved and never stretched.
    const logoBox = { w: rightColWidth, h: 34 };
    const logoX = this.pageWidth - this.margin - logoBox.w;
    let logoPath = path.join(process.cwd(), "public", "logo-pdf.png");
    if (!fs.existsSync(logoPath)) {
      logoPath = path.join(process.cwd(), "public", "logo.png");
    }
    if (fs.existsSync(logoPath)) {
      try {
        this.doc.image(logoPath, logoX, startY, { fit: [logoBox.w, logoBox.h], align: "right" });
      } catch {
        // Malformed logo file — the rest of the document still renders.
      }
    }

    this.currentY = Math.max(y, startY + logoBox.h) + 8;
    this.hr(this.currentY, COLORS.primary, 1.5);
    this.currentY += 16;
  }

  /** Large centered bold green document title, e.g. "TAX INVOICE". */
  renderDocumentTitle(title: string) {
    this.text(title.toUpperCase(), this.margin, this.currentY, {
      bold: true,
      size: 17,
      color: COLORS.primary,
      width: this.contentWidth,
      align: "center",
      characterSpacing: 0.5,
    });
    this.currentY += 26;
  }

  renderInfoColumns(columns: InfoColumn[]) {
    const gap = 10;
    const colWidth = (this.contentWidth - gap * (columns.length - 1)) / columns.length;
    const startY = this.currentY;

    const lineHeight = (line: string, bold: boolean) =>
      this.doc
        .font(bold ? FONT_BOLD : FONT_REGULAR)
        .fontSize(8.5)
        .heightOfString(line, { width: colWidth });

    const headingHeight = (heading: string) => lineHeight(heading.toUpperCase(), true) + 5;

    const blockHeights = columns.map((col) => {
      const linesHeight = col.lines.reduce(
        (sum, line, idx) => sum + lineHeight(line, idx === 0) + 3,
        0,
      );
      return headingHeight(col.heading) + linesHeight;
    });
    const blockHeight = Math.max(...blockHeights, 30);
    const broke = this.ensureSpace(blockHeight, startY);
    const y0 = broke ? this.currentY : startY;

    columns.forEach((col, idx) => {
      const x = this.margin + idx * (colWidth + gap);
      this.text(col.heading.toUpperCase(), x, y0, { bold: true, size: 8.5, width: colWidth });
      let ly = y0 + headingHeight(col.heading);
      col.lines.forEach((line, lineIdx) => {
        const bold = lineIdx === 0;
        this.text(line, x, ly, { size: 8.5, bold, width: colWidth });
        ly += lineHeight(line, bold) + 3;
      });
    });

    this.currentY = y0 + blockHeight;

    const dividerY = this.currentY + 4;
    this.hr(dividerY, COLORS.border, 0.5);
    this.currentY = dividerY + 12;
  }

  renderItemsTable(columns: PDFTableColumn[], rows: PDFTableRow[], totalRow?: PDFTableRow) {
    const widths = columns.map((col) => (col.width / 100) * this.contentWidth);
    const headerHeight = 20;

    const renderHeaderRow = (y: number) => {
      this.doc.rect(this.margin, y, this.contentWidth, headerHeight).fill(COLORS.primary);
      let x = this.margin;
      columns.forEach((col, idx) => {
        this.text(col.header.toUpperCase(), x + 6, y + 6, {
          bold: true,
          size: 8.5,
          color: COLORS.white,
          width: widths[idx] - 12,
          align: col.align || "left",
        });
        x += widths[idx];
      });
    };

    this.onNewPage = () => {
      renderHeaderRow(this.margin);
      this.currentY = this.margin + headerHeight;
    };

    const brokeAtStart = this.ensureSpace(headerHeight, this.currentY);
    if (!brokeAtStart) {
      renderHeaderRow(this.currentY);
      this.currentY += headerHeight;
    }
    let y = this.currentY;

    const rowHeight = (row: PDFTableRow, bold = false) => {
      const itemColIdx = columns.findIndex((c) => c.id === "item" || c.id === "description");
      const col = itemColIdx >= 0 ? columns[itemColIdx] : columns[0];
      const w = itemColIdx >= 0 ? widths[itemColIdx] : widths[0];
      const val = row[col.id] !== undefined ? String(row[col.id]) : "";
      const textHeight = this.doc
        .font(bold ? FONT_BOLD : FONT_REGULAR)
        .fontSize(8.5)
        .heightOfString(val, { width: w - 12 });
      return Math.max(20, textHeight + 9);
    };

    rows.forEach((row) => {
      const rh = rowHeight(row);
      if (this.ensureSpace(rh, y)) {
        y = this.currentY;
      }

      let x = this.margin;
      columns.forEach((col, idx) => {
        const w = widths[idx];
        const val = row[col.id] !== undefined ? String(row[col.id]) : "";
        const isItemCol = idx === 1;
        this.text(val, x + 6, y + 6, {
          bold: isItemCol,
          size: 8.5,
          width: w - 12,
          align: col.align || "left",
          ...(isItemCol ? {} : { height: rh - 9, ellipsis: true }),
        });
        x += w;
      });

      this.doc
        .moveTo(this.margin, y + rh)
        .lineTo(this.margin + this.contentWidth, y + rh)
        .strokeColor(COLORS.border)
        .lineWidth(0.4)
        .stroke();

      y += rh;
    });

    if (totalRow) {
      const rh = rowHeight(totalRow, true) + 4;
      if (this.ensureSpace(rh + 6, y)) {
        y = this.currentY;
      }
      this.hr(y, COLORS.primary, 1);
      y += 6;

      let x = this.margin;
      columns.forEach((col, idx) => {
        const w = widths[idx];
        const val = totalRow[col.id] !== undefined ? String(totalRow[col.id]) : "";
        this.text(val, x + 6, y, {
          bold: true,
          size: 9,
          width: w - 12,
          align: col.align || "left",
        });
        x += w;
      });
      y += 16;
      this.hr(y, COLORS.primary, 1);
      y += 6;
    }

    this.onNewPage = null;
    this.currentY = y + 14;
  }

  renderFinancialSummary(params: {
    amountWordsLabel: string;
    amountWords: string;
    terms?: string;
    lines: SummaryLine[];
    bankDetails?: string;
  }) {
    const leftWidth = this.contentWidth * 0.56;
    const rightWidth = this.contentWidth - leftWidth - 16;
    const rightX = this.margin + leftWidth + 16;

    const lineRowHeight = (line: SummaryLine) => (line.highlight ? 24 : 15);
    const rightHeight = params.lines.reduce((sum, l) => sum + lineRowHeight(l), 0) + 4;

    const amountWordsHeight = this.doc.font(FONT_REGULAR).fontSize(9).heightOfString(params.amountWords, { width: leftWidth });
    const bankHeight = params.bankDetails
      ? this.doc.font(FONT_REGULAR).fontSize(8).heightOfString(params.bankDetails, { width: leftWidth }) + 14
      : 0;
    const termsHeight = params.terms
      ? this.doc.font(FONT_REGULAR).fontSize(7.5).heightOfString(params.terms, { width: leftWidth }) + 24
      : 0;
    const leftHeight = 12 + amountWordsHeight + 8 + bankHeight + termsHeight;

    const blockHeight = Math.max(leftHeight, rightHeight);
    this.ensureSpace(blockHeight);
    const startY = this.currentY;

    this.text(params.amountWordsLabel, this.margin, startY, { bold: true, size: 8.5 });
    this.text(params.amountWords, this.margin, startY + 12, { size: 9, width: leftWidth });

    let leftY = startY + 12 + amountWordsHeight + 8;
    if (params.bankDetails) {
      this.text("Bank Details", this.margin, leftY, { bold: true, size: 8.5 });
      this.text(params.bankDetails, this.margin, leftY + 12, { size: 8, width: leftWidth });
      leftY += bankHeight;
    }

    if (params.terms) {
      this.text("Terms and Conditions", this.margin, leftY, { bold: true, size: 8.5 });
      this.text(params.terms, this.margin, leftY + 12, { size: 7.5, color: COLORS.muted, width: leftWidth });
    }

    let ry = startY;
    params.lines.forEach((line) => {
      const h = lineRowHeight(line);
      if (line.highlight) {
        this.doc.rect(rightX, ry, rightWidth, h).fill(COLORS.primary);
        this.text(line.label.toUpperCase(), rightX + 8, ry + 6, { bold: true, size: 10, color: COLORS.white });
        this.text(line.value, rightX + 8, ry + 6, {
          bold: true,
          size: 10,
          color: COLORS.white,
          width: rightWidth - 16,
          align: "right",
        });
      } else {
        this.text(line.label, rightX + 8, ry + 2, { bold: Boolean(line.bold), size: 9 });
        this.text(line.value, rightX + 8, ry + 2, {
          bold: Boolean(line.bold),
          size: 9,
          width: rightWidth - 16,
          align: "right",
        });
      }
      ry += h;
    });

    this.currentY = startY + blockHeight + 14;
  }

  renderNotesBlock(terms?: string) {
    if (!terms) return;
    const width = this.contentWidth;
    const height = this.doc.font(FONT_REGULAR).fontSize(7.5).heightOfString(terms, { width }) + 24;
    this.ensureSpace(height);
    const y = this.currentY;
    this.text("Terms and Conditions", this.margin, y, { bold: true, size: 8.5 });
    this.text(terms, this.margin, y + 12, { size: 7.5, color: COLORS.muted, width });
    this.currentY = y + height;
  }

  renderSignatureBlock(signers: Array<{ title: string; name?: string }>, align: "right" | "spread" = "right") {
    if (align === "right" && signers.length === 1) {
      const boxWidth = 220;
      const signer = signers[0];
      const nameText = signer.name ? `For: ${signer.name}` : "";
      const nameHeight = nameText
        ? this.doc.font(FONT_BOLD).fontSize(9).heightOfString(nameText, { width: boxWidth })
        : 0;
      const lineOffset = nameHeight + 8;
      const blockHeight = lineOffset + 22;

      this.ensureSpace(blockHeight);
      const y = this.currentY;
      const x = this.margin + this.contentWidth - boxWidth;

      if (nameText) {
        this.text(nameText, x, y, { bold: true, size: 9, width: boxWidth, align: "center" });
      }
      this.doc
        .moveTo(x, y + lineOffset)
        .lineTo(x + boxWidth, y + lineOffset)
        .strokeColor(COLORS.border)
        .lineWidth(0.75)
        .stroke();
      this.text(signer.title, x, y + lineOffset + 6, { bold: true, size: 8.5, width: boxWidth, align: "center" });
      this.currentY = y + blockHeight;
      return;
    }

    const itemWidth = this.contentWidth / signers.length;
    const slotWidth = itemWidth - 10;

    const nameHeight = (name?: string) =>
      name ? this.doc.font(FONT_BOLD).fontSize(8).heightOfString(name, { width: slotWidth }) : 0;
    const maxNameHeight = Math.max(...signers.map((s) => nameHeight(s.name)), 0);
    const lineOffset = maxNameHeight + 6;
    const blockHeight = lineOffset + 24;

    this.ensureSpace(blockHeight);
    const y = this.currentY;

    signers.forEach((s, idx) => {
      const sx = this.margin + idx * itemWidth;
      const lineY = y + lineOffset;
      if (s.name) {
        this.text(s.name, sx + 5, y, { bold: true, size: 8, width: slotWidth, align: "center" });
      }
      this.doc
        .moveTo(sx + 10, lineY)
        .lineTo(sx + itemWidth - 10, lineY)
        .strokeColor(COLORS.border)
        .lineWidth(0.75)
        .stroke();
      this.text(s.title, sx + 5, lineY + 5, { bold: true, size: 8, width: slotWidth, align: "center" });
    });

    this.currentY = y + blockHeight;
  }

  /** A red CANCELLED stamp across the page body. */
  renderCancelledStamp(reason: string) {
    const page = this.doc.bufferedPageRange().count - 1;
    this.doc.switchToPage(page);
    const cx = this.pageWidth / 2;
    const cy = this.pageHeight / 2;
    this.doc
      .font(FONT_BOLD)
      .fontSize(48)
      .fillColor(COLORS.accent)
      .opacity(0.16)
      .text("CANCELLED", cx - 160, cy - 30, { characterSpacing: 4, lineBreak: false });
    this.doc
      .font(FONT_BOLD)
      .fontSize(10)
      .opacity(0.16)
      .text(reason, cx - 160, cy + 24, { width: 320, align: "center", lineBreak: true });
    this.doc.opacity(1);
  }

  async build(): Promise<Buffer> {
    const pages = this.doc.bufferedPageRange();

    if (pages.count > 1) {
      for (let i = 0; i < pages.count; i++) {
        this.doc.switchToPage(i);
        this.text(`Page ${i + 1} of ${pages.count}`, this.margin, this.pageHeight - this.margin - 14, {
          size: 7.5,
          color: COLORS.muted,
          width: this.contentWidth,
          align: "right",
          lineBreak: false,
        });
      }
    }

    this.doc.end();

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      this.doc.on("data", (chunk) => chunks.push(chunk));
      this.doc.on("end", () => resolve(Buffer.concat(chunks)));
      this.doc.on("error", (err) => reject(err));
    });
  }
}

export { amountInWordsHelper as amountInWords };
