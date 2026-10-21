import "server-only";

import { prisma } from "@/lib/prisma";
import { BusinessRuleError } from "@/lib/action-result";
import { num, round2 } from "@/lib/money";
import { toInputDate, formatDate } from "@/lib/dates";
import { hasPermission, taxModeWhere, type SessionUser } from "@/lib/session";
import { PERMISSIONS } from "@/lib/rbac";
import { buildZip } from "@/lib/zip";
import { buildXlsx, type Sheet } from "@/lib/xlsx";
import { getCompanyProfile, PDFDocumentBuilder } from "@/lib/pdf/pdf-builder";
import {
  generateInvoicePDF,
  generatePurchaseInvoicePDF,
  generatePurchaseReturnPDF,
  generateExpenseReceiptPDF,
} from "@/lib/pdf/pdf-templates";

/**
 * "Send to CA" export. Everything here is a READ of existing records — the
 * same invoice / purchase / return / expense rows the ERP already holds, the
 * same stored tax figures, and the same PDF generators the Download PDF buttons
 * use. Nothing is recalculated or written.
 */

export const CA_ITEMS = [
  "salesInvoices",
  "purchaseBills",
  "creditNotes",
  "debitNotes",
  "expenses",
  "salesRegister",
  "purchaseRegister",
  "gstSummary",
  "summaryReport",
] as const;
export type CaItem = (typeof CA_ITEMS)[number];

export const CA_ITEM_LABELS: Record<CaItem, { label: string; kind: "PDFs" | "Register" | "Report"; hint: string }> = {
  salesInvoices: { label: "Sales invoices", kind: "PDFs", hint: "Invoice PDFs (tax invoices and non-tax invoices)" },
  purchaseBills: { label: "Purchase bills", kind: "PDFs", hint: "Supplier bill PDFs" },
  creditNotes: { label: "Credit notes (sales returns)", kind: "Register", hint: "Register only — no PDF template exists for sales returns" },
  debitNotes: { label: "Debit notes (purchase returns)", kind: "PDFs", hint: "Purchase return PDFs and register" },
  expenses: { label: "Expense records", kind: "PDFs", hint: "Expense vouchers and register" },
  salesRegister: { label: "Sales register", kind: "Register", hint: "Excel sheet of every sales invoice with tax split" },
  purchaseRegister: { label: "Purchase register", kind: "Register", hint: "Excel sheet of every purchase bill with tax split" },
  gstSummary: { label: "GST summary & tax breakdown", kind: "Register", hint: "Rate-wise output tax, input tax totals" },
  summaryReport: { label: "Summary report (PDF)", kind: "Report", hint: "Period totals: taxable value, GST and totals" },
};

/** Permission needed to export each item (on top of reports.export). */
const ITEM_PERMISSION: Record<CaItem, string[]> = {
  salesInvoices: [PERMISSIONS.INVOICE_VIEW],
  purchaseBills: [PERMISSIONS.PURCHASE_VIEW],
  creditNotes: [PERMISSIONS.SALES_VIEW, PERMISSIONS.INVOICE_VIEW],
  debitNotes: [PERMISSIONS.PURCHASE_VIEW],
  expenses: [PERMISSIONS.EXPENSES_VIEW],
  salesRegister: [PERMISSIONS.INVOICE_VIEW],
  purchaseRegister: [PERMISSIONS.PURCHASE_VIEW],
  gstSummary: [PERMISSIONS.INVOICE_VIEW, PERMISSIONS.PURCHASE_VIEW],
  summaryReport: [],
};

export const MAX_PDFS = 400;

export interface CaRequest {
  from: Date;
  to: Date;
  items: CaItem[];
}

type Actor = Pick<SessionUser, "id" | "role" | "permissions" | "activeFirmId" | "accessView">;

export function allowedItems(user: Pick<SessionUser, "permissions">): CaItem[] {
  return CA_ITEMS.filter((item) => {
    const needs = ITEM_PERMISSION[item];
    return needs.length === 0 || hasPermission(user, needs as never);
  });
}

export function parseCaRequest(params: { from?: string | null; to?: string | null; items?: string | null }): CaRequest {
  const parse = (v: string | null | undefined, end: boolean) => {
    if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new BusinessRuleError("Choose a valid start and end date");
    const d = new Date(`${v}T${end ? "23:59:59.999" : "00:00:00.000"}`);
    if (Number.isNaN(d.getTime())) throw new BusinessRuleError("Choose a valid start and end date");
    return d;
  };
  const from = parse(params.from, false);
  const to = parse(params.to, true);
  if (from > to) throw new BusinessRuleError("The start date must be on or before the end date");
  if (to.getTime() - from.getTime() > 400 * 86_400_000) throw new BusinessRuleError("Choose a period of at most 13 months");
  const requested = (params.items ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const items = requested.filter((i): i is CaItem => (CA_ITEMS as readonly string[]).includes(i));
  if (items.length === 0) throw new BusinessRuleError("Select at least one document or report");
  return { from, to, items };
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function load(user: Actor, req: CaRequest) {
  const firmId = user.activeFirmId!;
  const tm = taxModeWhere(user);
  const want = (...keys: CaItem[]) => keys.some((k) => req.items.includes(k));
  const gstOnly = user.accessView === "GST_ONLY";
  const only = req.items.length === 1 && req.items[0] === "summaryReport";
  const salesNeeded = only || want("salesInvoices", "salesRegister", "gstSummary");
  const purchasesNeeded = only || want("purchaseBills", "purchaseRegister", "gstSummary");
  const creditNeeded = only || want("creditNotes");
  const debitNeeded = only || want("debitNotes");
  const expensesNeeded = (only || want("expenses")) && !gstOnly;
  const within = (field: string) => ({ [field]: { gte: req.from, lte: req.to } });

  const [invoices, bills, salesReturns, purchaseReturns, expenses] = await Promise.all([
    salesNeeded
      ? prisma.invoice.findMany({
          where: { firmId, ...within("invoiceDate"), ...tm },
          orderBy: [{ invoiceDate: "asc" }, { invoiceNumber: "asc" }],
          include: { lines: { select: { gstRate: true, taxableValue: true, cgstAmount: true, sgstAmount: true, igstAmount: true, lineTotal: true } } },
        })
      : [],
    purchasesNeeded
      ? prisma.purchaseInvoice.findMany({
          where: { firmId, ...within("invoiceDate"), ...tm },
          orderBy: [{ invoiceDate: "asc" }, { invoiceNumber: "asc" }],
          include: { supplier: { select: { name: true, gstin: true } } },
        })
      : [],
    creditNeeded
      ? prisma.salesReturn.findMany({
          where: { firmId, ...within("createdAt"), ...tm },
          orderBy: { createdAt: "asc" },
          include: { customer: { select: { name: true, gstin: true } }, invoice: { select: { invoiceNumber: true } } },
        })
      : [],
    debitNeeded
      ? prisma.purchaseReturn.findMany({
          where: { firmId, ...within("returnedAt"), ...tm },
          orderBy: { returnedAt: "asc" },
          include: { supplier: { select: { name: true, gstin: true } }, purchaseInvoice: { select: { invoiceNumber: true } } },
        })
      : [],
    expensesNeeded
      ? prisma.expense.findMany({ where: { firmId, ...within("expenseDate") }, orderBy: { expenseDate: "asc" } })
      : [],
  ]);
  return { invoices, bills, salesReturns, purchaseReturns, expenses, salesNeeded, purchasesNeeded, creditNeeded, debitNeeded, expensesNeeded };
}

type Loaded = Awaited<ReturnType<typeof load>>;

const live = <T extends { status: string }>(rows: T[]) => rows.filter((r) => r.status !== "CANCELLED");

function totals(data: Loaded) {
  const inv = live(data.invoices);
  const gstInv = inv.filter((i) => i.taxMode === "GST");
  const sum = (rows: { [k: string]: unknown }[], key: string) => round2(rows.reduce((s, r) => s + num(r[key] as number), 0));
  const bills = live(data.bills);
  // Input tax and taxable value come from GST bills only; non-GST bills carry no tax.
  const gstBills = bills.filter((b) => b.taxMode === "GST");
  return {
    gstInvoiceCount: gstInv.length,
    gstTaxable: sum(gstInv, "taxableAmount"), gstCgst: sum(gstInv, "cgstAmount"), gstSgst: sum(gstInv, "sgstAmount"), gstIgst: sum(gstInv, "igstAmount"), gstTotal: sum(gstInv, "totalAmount"),
    nonGstCount: inv.length - gstInv.length,
    nonGstTotal: sum(inv.filter((i) => i.taxMode !== "GST"), "totalAmount"),
    cancelledInvoices: data.invoices.length - inv.length,
    billCount: bills.length,
    billTaxable: sum(gstBills, "taxableAmount"), billCgst: sum(gstBills, "cgstAmount"), billSgst: sum(gstBills, "sgstAmount"), billIgst: sum(gstBills, "igstAmount"), billGstTotal: sum(gstBills, "total"), billTotal: sum(bills, "total"),
    cancelledBills: data.bills.length - bills.length,
    creditCount: data.salesReturns.filter((r) => r.status === "APPROVED").length,
    creditTotal: round2(data.salesReturns.filter((r) => r.status === "APPROVED").reduce((s, r) => s + num(r.totalAmount), 0)),
    debitCount: data.purchaseReturns.length,
    debitTotal: round2(data.purchaseReturns.reduce((s, r) => s + num(r.total), 0)),
    expenseCount: data.expenses.filter((e) => e.status !== "REJECTED").length,
    expenseTotal: round2(data.expenses.filter((e) => e.status !== "REJECTED").reduce((s, e) => s + num(e.amount), 0)),
  };
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface CaPreview {
  from: string;
  to: string;
  empty: boolean;
  items: { key: CaItem; label: string; kind: string; count: number | null; note?: string }[];
  warnings: string[];
  pdfCount: number;
}

export async function previewCaPackage(user: Actor, req: CaRequest): Promise<CaPreview> {
  const allowed = new Set(allowedItems(user));
  const items = req.items.filter((i) => allowed.has(i));
  if (items.length === 0) throw new BusinessRuleError("You do not have access to any of the selected items");
  const r = { ...req, items };
  const data = await load(user, r);
  const countOf = (k: CaItem): number | null => {
    switch (k) {
      case "salesInvoices": case "salesRegister": return data.invoices.length;
      case "purchaseBills": case "purchaseRegister": return data.bills.length;
      case "creditNotes": return data.salesReturns.length;
      case "debitNotes": return data.purchaseReturns.length;
      case "expenses": return data.expenses.length;
      case "gstSummary": return data.invoices.filter((i) => i.taxMode === "GST" && i.status !== "CANCELLED").length + data.bills.filter((b) => b.status !== "CANCELLED").length;
      default: return null;
    }
  };
  const list = items.map((key) => ({
    key,
    label: CA_ITEM_LABELS[key].label,
    kind: CA_ITEM_LABELS[key].kind,
    count: countOf(key),
    note: key === "creditNotes" ? "Register only (no PDF template)" : key === "gstSummary" ? "Tax invoices + purchase bills in the period" : undefined,
  }));
  const pdfCount =
    (items.includes("salesInvoices") ? data.invoices.length : 0) +
    (items.includes("purchaseBills") ? data.bills.length : 0) +
    (items.includes("debitNotes") ? data.purchaseReturns.length : 0) +
    (items.includes("expenses") ? data.expenses.length : 0);
  const warnings: string[] = [];
  if (pdfCount > MAX_PDFS) warnings.push(`${pdfCount} PDFs exceed the limit of ${MAX_PDFS} per package — choose a shorter period.`);
  if (req.items.length !== items.length) warnings.push("Some selected items were skipped because your role cannot export them.");
  if (user.accessView === "GST_ONLY") warnings.push("GST view: only GST documents are included; expenses are not available.");
  const dataItems = list.filter((i) => i.count !== null);
  const anyRecords = data.invoices.length + data.bills.length + data.salesReturns.length + data.purchaseReturns.length + data.expenses.length > 0;
  const empty = dataItems.length > 0 ? dataItems.every((i) => i.count === 0) : !anyRecords;
  return { from: toInputDate(req.from), to: toInputDate(req.to), empty, items: list, warnings, pdfCount };
}

// ---------------------------------------------------------------------------
// Package
// ---------------------------------------------------------------------------

const D = (d: Date | null | undefined) => (d ? toInputDate(d) : "");
const clean = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "-").trim();

function registerSheets(data: Loaded, items: CaItem[]): Sheet[] {
  const sheets: Sheet[] = [];
  if (items.includes("salesRegister")) {
    sheets.push({
      name: "Sales Register",
      rows: [
        ["Invoice No", "Date", "Customer", "Customer GSTIN", "Place of Supply", "Type", "Taxable Value", "CGST", "SGST", "IGST", "Round Off", "Invoice Total", "Received", "Balance Due", "Status"],
        ...data.invoices.map((i) => [i.invoiceNumber, D(i.invoiceDate), i.billToName, i.billToGstin ?? "", i.placeOfSupply ?? "", i.taxMode === "GST" ? "Tax Invoice" : "Non-Tax Invoice", num(i.taxableAmount), num(i.cgstAmount), num(i.sgstAmount), num(i.igstAmount), num(i.roundOff), num(i.totalAmount), num(i.amountPaid), num(i.amountDue), i.status]),
      ],
    });
  }
  if (items.includes("purchaseRegister")) {
    sheets.push({
      name: "Purchase Register",
      rows: [
        ["Bill No", "Supplier Bill Ref", "Date", "Supplier", "Supplier GSTIN", "Type", "Taxable Value", "CGST", "SGST", "IGST", "Bill Total", "Paid", "Status"],
        ...data.bills.map((b) => [b.invoiceNumber, b.supplierRef ?? "", D(b.invoiceDate), b.supplier.name, b.supplier.gstin ?? "", b.taxMode === "GST" ? "GST" : "Non-GST", num(b.taxableAmount), num(b.cgstAmount), num(b.sgstAmount), num(b.igstAmount), num(b.total), num(b.amountPaid), b.status]),
      ],
    });
  }
  if (items.includes("creditNotes")) {
    sheets.push({
      name: "Credit Notes",
      rows: [
        ["Return / Credit Note No", "Date", "Customer", "Customer GSTIN", "Against Invoice", "Type", "Reason", "Amount", "Status"],
        ...data.salesReturns.map((r) => [r.returnNumber, D(r.createdAt), r.customer.name, r.customer.gstin ?? "", r.invoice.invoiceNumber, r.taxMode === "GST" ? "GST" : "Non-GST", r.reason, num(r.totalAmount), r.status]),
      ],
    });
  }
  if (items.includes("debitNotes")) {
    sheets.push({
      name: "Debit Notes",
      rows: [
        ["Return / Debit Note No", "Date", "Supplier", "Supplier GSTIN", "Against Bill", "Type", "Reason", "Amount"],
        ...data.purchaseReturns.map((r) => [r.returnNumber, D(r.returnedAt), r.supplier.name, r.supplier.gstin ?? "", r.purchaseInvoice?.invoiceNumber ?? "", r.taxMode === "GST" ? "GST" : "Non-GST", r.reason, num(r.total)]),
      ],
    });
  }
  if (items.includes("expenses")) {
    sheets.push({
      name: "Expenses",
      rows: [
        ["Expense No", "Date", "Category", "Description", "Paid To", "Payment Method", "Reference", "Amount", "Status"],
        ...data.expenses.map((e) => [e.expenseNumber, D(e.expenseDate), e.category, e.description, e.paidTo ?? "", e.paymentMethod, e.reference ?? "", num(e.amount), e.status]),
      ],
    });
  }
  if (items.includes("gstSummary")) {
    const byRate = new Map<number, { taxable: number; cgst: number; sgst: number; igst: number; total: number }>();
    for (const inv of live(data.invoices).filter((i) => i.taxMode === "GST")) {
      for (const l of inv.lines) {
        const r = num(l.gstRate);
        const e = byRate.get(r) ?? { taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 };
        e.taxable += num(l.taxableValue); e.cgst += num(l.cgstAmount); e.sgst += num(l.sgstAmount); e.igst += num(l.igstAmount); e.total += num(l.lineTotal);
        byRate.set(r, e);
      }
    }
    const t = totals(data);
    const rows: (string | number)[][] = [
      ["OUTPUT TAX — sales (tax invoices, cancelled excluded), by GST rate"],
      ["GST %", "Taxable Value", "CGST", "SGST", "IGST", "Total Tax", "Invoice Value"],
      ...[...byRate.entries()].sort((a, b) => a[0] - b[0]).map(([rate, e]) => [rate, round2(e.taxable), round2(e.cgst), round2(e.sgst), round2(e.igst), round2(e.cgst + e.sgst + e.igst), round2(e.total)]),
      ["Total", t.gstTaxable, t.gstCgst, t.gstSgst, t.gstIgst, round2(t.gstCgst + t.gstSgst + t.gstIgst), t.gstTotal],
      [],
      ["INPUT TAX — GST purchase bills (cancelled excluded), totals as recorded"],
      ["", "Taxable Value", "CGST", "SGST", "IGST", "Total Tax", "Bill Value"],
      ["Total", t.billTaxable, t.billCgst, t.billSgst, t.billIgst, round2(t.billCgst + t.billSgst + t.billIgst), t.billGstTotal],
      [],
      ["Output tax less input tax (indicative; before credit/debit-note and ITC adjustments)", "", "", "", "", round2(t.gstCgst + t.gstSgst + t.gstIgst - (t.billCgst + t.billSgst + t.billIgst))],
    ];
    sheets.push({ name: "GST Summary", rows, headerRows: 0, widths: [44, 16, 14, 14, 14, 14, 16] });
  }
  return sheets;
}

async function summaryPdf(firmId: string, data: Loaded, req: CaRequest, items: CaItem[]) {
  const company = await getCompanyProfile(firmId);
  const b = new PDFDocumentBuilder(company);
  const t = totals(data);
  b.renderCompanyHeader({ name: company.name });
  b.renderDocumentTitle("Summary Report for CA");
  b.renderInfoColumns([
    { heading: "Company", lines: [company.name, ...(company.gstin ? [`GSTIN: ${company.gstin}`] : [])] },
    { heading: "Reporting period", lines: [`${formatDate(req.from)} to ${formatDate(req.to)}`] },
    { heading: "Generated on", lines: [formatDate(new Date())] },
  ]);
  const money = (v: number) => v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rows: { item: string; count: string; taxable: string; tax: string; total: string }[] = [];
  const add = (item: string, count: number, taxable: number | null, tax: number | null, total: number) =>
    rows.push({ item, count: String(count), taxable: taxable === null ? "" : money(taxable), tax: tax === null ? "" : money(tax), total: money(total) });
  if (data.salesNeeded) {
    add("Sales - tax invoices", t.gstInvoiceCount, t.gstTaxable, t.gstCgst + t.gstSgst + t.gstIgst, t.gstTotal);
    add("Sales - non-tax invoices", t.nonGstCount, null, null, t.nonGstTotal);
  }
  if (data.creditNeeded) add("Credit notes (approved sales returns)", t.creditCount, null, null, t.creditTotal);
  if (data.purchasesNeeded) add("Purchase bills", t.billCount, t.billTaxable, t.billCgst + t.billSgst + t.billIgst, t.billTotal);
  if (data.debitNeeded) add("Debit notes (purchase returns)", t.debitCount, null, null, t.debitTotal);
  if (data.expensesNeeded) add("Expenses (excl. rejected)", t.expenseCount, null, null, t.expenseTotal);
  b.renderItemsTable(
    [
      { id: "item", header: "Particulars", width: 36 },
      { id: "count", header: "Docs", width: 8, align: "center" },
      { id: "taxable", header: "Taxable value", width: 20, align: "right" },
      { id: "tax", header: "GST amount", width: 17, align: "right" },
      { id: "total", header: "Total", width: 19, align: "right" },
    ],
    rows,
  );
  if (data.salesNeeded || data.purchasesNeeded) {
    const outTax = t.gstCgst + t.gstSgst + t.gstIgst;
    const inTax = t.billCgst + t.billSgst + t.billIgst;
    b.renderInfoColumns([
      { heading: "GST breakdown", lines: [
        `Output CGST ${money(t.gstCgst)}  SGST ${money(t.gstSgst)}  IGST ${money(t.gstIgst)}`,
        `Input  CGST ${money(t.billCgst)}  SGST ${money(t.billSgst)}  IGST ${money(t.billIgst)}`,
        `Output tax less input tax: ${money(round2(outTax - inTax))} (indicative)`,
      ] },
    ]);
  }
  b.renderInfoColumns([{ heading: "Notes", lines: [
    "Figures are the values recorded in the ERP; cancelled documents are excluded from totals.",
    `Included in this package: ${items.filter((i) => i !== "summaryReport").map((i) => CA_ITEM_LABELS[i].label).join(", ") || "summary only"}.`,
  ] }]);
  return b.build();
}

export interface CaPackage { buffer: Buffer; fileName: string; issues: string[] }

export async function buildCaPackage(user: Actor, req: CaRequest): Promise<CaPackage> {
  const allowed = new Set(allowedItems(user));
  const items = req.items.filter((i) => allowed.has(i));
  if (items.length === 0) throw new BusinessRuleError("You do not have access to any of the selected items");
  const firmId = user.activeFirmId!;
  const r = { ...req, items };
  const data = await load(user, r);

  const pdfCount =
    (items.includes("salesInvoices") ? data.invoices.length : 0) +
    (items.includes("purchaseBills") ? data.bills.length : 0) +
    (items.includes("debitNotes") ? data.purchaseReturns.length : 0) +
    (items.includes("expenses") ? data.expenses.length : 0);
  if (pdfCount > MAX_PDFS) throw new BusinessRuleError(`${pdfCount} PDFs exceed the limit of ${MAX_PDFS} per package — choose a shorter period.`);

  const sheets = registerSheets(data, items);
  const hasData =
    (items.includes("salesInvoices") || items.includes("salesRegister") || items.includes("gstSummary")) && (data.invoices.length > 0 || items.includes("gstSummary") && data.bills.length > 0) ||
    ((items.includes("purchaseBills") || items.includes("purchaseRegister")) && data.bills.length > 0) ||
    (items.includes("creditNotes") && data.salesReturns.length > 0) ||
    (items.includes("debitNotes") && data.purchaseReturns.length > 0) ||
    (items.includes("expenses") && data.expenses.length > 0);
  const onlySummary = items.every((i) => i === "summaryReport");
  const anyRecords = data.invoices.length + data.bills.length + data.salesReturns.length + data.purchaseReturns.length + data.expenses.length > 0;
  if (onlySummary ? !anyRecords : !hasData) {
    throw new BusinessRuleError(`No records found between ${formatDate(req.from)} and ${formatDate(req.to)} for the selected items.`);
  }

  const folder = `Technic-CA-Package_${toInputDate(req.from)}_to_${toInputDate(req.to)}`;
  const entries: { name: string; data: Buffer }[] = [];
  const issues: string[] = [];
  const counts: string[] = [];

  const pdfs = async (label: string, dir: string, rows: { id: string; no: string }[], gen: (id: string) => Promise<{ buffer: Buffer; fileName: string }>) => {
    let ok = 0;
    const used = new Set<string>();
    for (const row of rows) {
      try {
        const { buffer, fileName } = await gen(row.id);
        let name = clean(fileName);
        while (used.has(name)) name = name.replace(/\.pdf$/i, "") + "_dup.pdf";
        used.add(name);
        entries.push({ name: `${folder}/${dir}/${name}`, data: buffer });
        ok++;
      } catch (e) {
        issues.push(`${label} ${row.no}: PDF could not be generated (${(e as Error).message})`);
      }
    }
    counts.push(`${label}: ${ok} PDF(s) of ${rows.length} record(s)`);
  };

  if (items.includes("salesInvoices")) await pdfs("Sales invoices", "Sales_Invoices", data.invoices.map((i) => ({ id: i.id, no: i.invoiceNumber })), generateInvoicePDF);
  if (items.includes("purchaseBills")) await pdfs("Purchase bills", "Purchase_Bills", data.bills.map((b) => ({ id: b.id, no: b.invoiceNumber })), generatePurchaseInvoicePDF);
  if (items.includes("debitNotes")) await pdfs("Debit notes", "Debit_Notes", data.purchaseReturns.map((p) => ({ id: p.id, no: p.returnNumber })), generatePurchaseReturnPDF);
  if (items.includes("expenses")) await pdfs("Expenses", "Expenses", data.expenses.map((e) => ({ id: e.id, no: e.expenseNumber })), generateExpenseReceiptPDF);

  if (sheets.length > 0) {
    entries.push({ name: `${folder}/Accounting_Registers.xlsx`, data: buildXlsx(sheets) });
    counts.push(`Registers workbook sheets: ${sheets.map((s) => `${s.name} (${Math.max(0, s.rows.length - 1)} rows)`).join(", ")}`);
  }
  if (items.includes("summaryReport")) {
    entries.push({ name: `${folder}/00_Summary_Report.pdf`, data: await summaryPdf(firmId, data, req, items) });
    counts.push("Summary report: included");
  }
  if (items.includes("creditNotes")) issues.push("Credit notes are exported as a register only - the ERP has no credit-note PDF template.");

  const company = await getCompanyProfile(firmId);
  const readme = [
    `Package for CA - ${company.name}`,
    `Period: ${formatDate(req.from)} to ${formatDate(req.to)}`,
    `Generated: ${formatDate(new Date())}`,
    user.accessView === "GST_ONLY" ? "View: GST documents only" : "",
    "",
    "Contents:",
    ...counts.map((c) => `  - ${c}`),
    "",
    issues.length ? "Notes / issues:" : "No issues.",
    ...issues.map((i) => `  - ${i}`),
    "",
    "All figures are read from the ERP records; nothing was recalculated or changed.",
  ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\r\n");
  entries.push({ name: `${folder}/README.txt`, data: Buffer.from(readme, "utf8") });

  return { buffer: buildZip(entries), fileName: `${folder}.zip`, issues };
}
