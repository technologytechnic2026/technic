import "server-only";

import { prisma } from "@/lib/prisma";
import { formatCurrency, amountInWords, num } from "@/lib/money";
import { formatDate } from "@/lib/dates";
import {
  getCompanyProfile,
  PDFDocumentBuilder,
  type BranchProfile,
  type PDFTableColumn,
  type PDFTableRow,
  type SummaryLine,
} from "./pdf-builder";
import { renderSalesDocument } from "./sales-document";

/**
 * Technic Technologies document templates. One generator per business
 * document, all assembled from the shared PDFDocumentBuilder blocks:
 *  - Tax Invoice / Bill, keyed on invoice.kind
 *  - Quotation
 *  - Purchase Order
 *  - Purchase Invoice (supplier bill)
 *  - Payment Receipt (customer receipt)
 *  - Expense Voucher
 */

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  CASH: "Cash",
  UPI: "UPI",
  CARD: "Card",
  BANK_TRANSFER: "Bank Transfer",
  CHEQUE: "Cheque",
  OTHER: "Other",
};

function branchProfile(branch: {
  name: string;
  addressLine?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  phone?: string | null;
  email?: string | null;
} | null | undefined): BranchProfile {
  return {
    name: branch?.name || "Head Office",
    addressLine: branch?.addressLine,
    city: branch?.city,
    state: branch?.state,
    pincode: branch?.pincode,
    phone: branch?.phone,
    email: branch?.email,
  };
}

function serialSuffix(serialNumbers: string[] | string | null): string {
  if (!serialNumbers) return "";
  const serials = Array.isArray(serialNumbers)
    ? serialNumbers.filter(Boolean)
    : serialNumbers.split("\n").filter(Boolean);
  if (serials.length === 0) return "";
  return `\nSN: ${serials.join(", ")}`;
}

type Numericish = number | string | { toNumber: () => number };

interface LineLike {
  description: string;
  product?: { subName?: string | null } | null;
  hsnCode?: string | null;
  serialNumbers?: string[] | string | null;
  quantity: Numericish;
  unitPrice: Numericish;
  discountPercent?: Numericish;
  gstRate?: Numericish;
  taxableValue?: Numericish;
  cgstAmount?: Numericish | null;
  sgstAmount?: Numericish | null;
  igstAmount?: Numericish | null;
  lineTotal: Numericish;
}

interface TaxTotals {
  taxableAmount: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
}

/**
 * The line-items table. GST documents expose taxable value + CGST/SGST/IGST
 * columns per the tax-invoice format; bills omit the tax columns.
 */
function invoiceTableRows(lines: LineLike[], withTaxColumns: boolean) {
  let totalQty = 0;
  const rows: PDFTableRow[] = lines.map((line, idx) => {
    const qty = typeof line.quantity === "number" ? line.quantity : (typeof line.quantity === "string" ? Number(line.quantity) : line.quantity.toNumber());
    totalQty += qty;
    const serials = serialSuffix(line.serialNumbers ?? null);
    const unitPrice = typeof line.unitPrice === "number" ? line.unitPrice : (typeof line.unitPrice === "string" ? Number(line.unitPrice) : line.unitPrice.toNumber());
    const lineTotal = typeof line.lineTotal === "number" ? line.lineTotal : (typeof line.lineTotal === "string" ? Number(line.lineTotal) : line.lineTotal.toNumber());
    const rate = formatCurrency(unitPrice);
    const amount = formatCurrency(lineTotal);
    const base: PDFTableRow = {
      sl: idx + 1,
      item: `${line.description}${line.product?.subName ? `\n${line.product.subName}` : ""}${serials}`,
      hsn: line.hsnCode || "—",
      qty,
      rate,
      amount,
    };
    if (withTaxColumns) {
      return {
        ...base,
        disc: `${num(line.discountPercent as number)}%`,
        taxable: formatCurrency(num((line.taxableValue ?? line.lineTotal) as number)),
        gst: formatCurrency(
          num((line.cgstAmount ?? 0) as number) +
            num((line.sgstAmount ?? 0) as number) +
            num((line.igstAmount ?? 0) as number),
        ),
      };
    }
    return base;
  });

  return { rows, totalQty };
}

function taxInvoiceColumns(): PDFTableColumn[] {
  return [
    { id: "sl", header: "#", width: 4, align: "center" },
    { id: "item", header: "Item", width: 28 },
    { id: "hsn", header: "HSN", width: 9, align: "center" },
    { id: "qty", header: "Qty", width: 5, align: "center" },
    { id: "rate", header: "Rate", width: 11, align: "right" },
    { id: "disc", header: "Disc", width: 6, align: "center" },
    { id: "taxable", header: "Taxable", width: 12, align: "right" },
    { id: "gst", header: "GST", width: 10, align: "right" },
    { id: "amount", header: "Amount", width: 15, align: "right" },
  ];
}

function simpleInvoiceColumns(): PDFTableColumn[] {
  return [
    { id: "sl", header: "#", width: 5, align: "center" },
    { id: "item", header: "Item", width: 44 },
    { id: "hsn", header: "HSN", width: 10, align: "center" },
    { id: "qty", header: "Qty", width: 7, align: "center" },
    { id: "rate", header: "Rate", width: 14, align: "right" },
    { id: "amount", header: "Amount", width: 20, align: "right" },
  ];
}

// ---------------------------------------------------------------------------
// Sales invoice (Tax Invoice / Non-Tax Invoice) and Quotation — one shared
// bordered A4 layout, see ./sales-document.ts
// ---------------------------------------------------------------------------

interface SalesLineSource {
  description: string;
  hsnCode?: string | null;
  serialNumbers?: string[] | string | null;
  quantity: number;
  unitPrice: Numericish;
  discountPercent: Numericish;
  gstRate: Numericish;
  taxableValue?: Numericish | null;
  lineTotal: Numericish;
  product?: { name: string; subName: string | null } | null;
}

/**
 * Maps saved lines to document lines. Matching the printed form, GST
 * documents show the ex-tax Rate and Amount = Qty x Rate; the discount is
 * taken once in the totals panel, and `taxable` (after discount) feeds the
 * GST slab summary.
 */
function salesDocLines(lines: SalesLineSource[], isGst: boolean, asSaved = false) {
  return lines.map((line) => {
    if (asSaved) {
      // Quotations print exactly what was saved from the form: the entered
      // rate, qty x rate as the amount, and the line's own tax. Nothing is
      // re-derived (no ex-tax rate, no second discount).
      const gst = isGst ? num(line.gstRate as number) : 0;
      const unit = num(line.unitPrice as number);
      const net = num(line.lineTotal as number); // after discount, incl. GST
      const taxable = gst > 0 ? Math.round((net / (1 + gst / 100) + Number.EPSILON) * 100) / 100 : net;
      const serials = Array.isArray(line.serialNumbers) ? line.serialNumbers : (line.serialNumbers ?? "").split("\n");
      return {
        name: line.product?.name ?? line.description,
        subName: line.product?.subName ?? null,
        serials: serials.filter(Boolean),
        hsn: line.hsnCode,
        quantity: line.quantity,
        rate: unit,
        discountPercent: num(line.discountPercent as number),
        taxable,
        tax: Math.round((net - taxable + Number.EPSILON) * 100) / 100,
        gstRate: gst,
        // qty x rate as saved (the form's "gross" for the line). The discount is shown
        // once, in the summary, so the item amounts add up to the Gross Amount.
        amount: Math.round((unit * line.quantity + Number.EPSILON) * 100) / 100,
      };
    }
    const gst = isGst ? num(line.gstRate as number) : 0;
    const unit = num(line.unitPrice as number);
    const lineTotal = num(line.lineTotal as number);
    const rateExTax = gst > 0 ? unit / (1 + gst / 100) : unit;
    const taxable =
      line.taxableValue != null ? num(line.taxableValue as number) : gst > 0 ? lineTotal / (1 + gst / 100) : lineTotal;
    const serials = Array.isArray(line.serialNumbers) ? line.serialNumbers : (line.serialNumbers ?? "").split("\n");
    return {
      // Prefer the live product name/sub name; fall back to the saved snapshot.
      name: line.product?.name ?? line.description,
      subName: line.product?.subName ?? null,
      serials: serials.filter(Boolean),
      hsn: line.hsnCode,
      quantity: line.quantity,
      rate: rateExTax,
      discountPercent: num(line.discountPercent as number),
      taxable,
      gstRate: gst,
      amount: rateExTax * line.quantity,
    };
  });
}

function salesTotals(
  lines: ReturnType<typeof salesDocLines>,
  taxable: number,
  tax: { cgst: number; sgst: number; igst: number },
  roundOff: number,
  total: number,
) {
  const gross = lines.reduce((sum, line) => sum + line.amount, 0);
  return { gross, discount: Math.max(0, gross - taxable), taxable, ...tax, roundOff, total };
}

const addressLines = (c: { addressLine?: string | null; city?: string | null; state?: string | null; pincode?: string | null }) => {
  const joined = [c.addressLine, c.city, c.state, c.pincode].filter(Boolean).join(", ");
  return joined ? [joined] : [];
};

export async function generateInvoicePDF(invoiceId: string): Promise<{ buffer: Buffer; fileName: string }> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      customer: true,
      branch: true,
      lines: { include: { product: { select: { name: true, subName: true } } } },
    },
  });

  if (!invoice) throw new Error(`Invoice #${invoiceId} not found.`);

  const isGst = invoice.kind === "TAX_INVOICE";
  const company = await getCompanyProfile(invoice.firmId);
  const lines = salesDocLines(invoice.lines, isGst);
  const totals = salesTotals(
    lines,
    isGst ? num(invoice.taxableAmount) : num(invoice.totalAmount) - num(invoice.roundOff),
    { cgst: num(invoice.cgstAmount), sgst: num(invoice.sgstAmount), igst: num(invoice.igstAmount) },
    num(invoice.roundOff),
    num(invoice.totalAmount),
  );

  const meta: [string, string][] = [
    ["Invoice No. :", invoice.invoiceNumber],
    ["Invoice Date :", formatDate(invoice.invoiceDate)],
    // Credit when money is still owed, otherwise a cash/settled sale.
    ["Invoice Type :", num(invoice.amountDue) > 0 ? "CREDIT" : "CASH"],
    ["Despatched Through", invoice.dispatchThrough || ""],
    ["E - Way No.", invoice.ewayBillNumber || ""],
  ];
  if (invoice.vehicleNumber) meta.push(["Vehicle No.", invoice.vehicleNumber]);
  if (invoice.buyerOrderNo) meta.push(["Buyer's Order No.", invoice.buyerOrderNo]);

  const buffer = await renderSalesDocument(
    {
      title: isGst ? "TAX INVOICE" : "NON-TAX INVOICE",
      isGst,
      company,
      branch: branchProfile(invoice.branch),
      meta,
      to: {
        name: invoice.billToName.toUpperCase(),
        lines: [
          ...(invoice.billToAddress ? [invoice.billToAddress] : []),
          ...(invoice.billToGstin ? [`GSTIN : ${invoice.billToGstin}`] : []),
          ...(invoice.billToPhone ? [`PHONE : ${invoice.billToPhone}`] : []),
        ],
      },
      lines,
      totals,
      bankDetails: company.bankDetails || undefined,
      terms: invoice.terms || company.termsConditions,
      notes: invoice.notes,
      discountRemarks: invoice.discountRemarks,
      signatoryFor: company.name,
      cancelledReason: invoice.status === "CANCELLED" ? invoice.cancellationReason || "Cancelled" : null,
    },
    `${isGst ? "Tax Invoice" : "Invoice"} ${invoice.invoiceNumber}`,
  );

  const kindLabel = isGst ? "Tax-Invoice" : "Invoice";
  return { buffer, fileName: `TECHNIC-${kindLabel}-${invoice.invoiceNumber.replace(/\//g, "-")}.pdf` };
}

// ---------------------------------------------------------------------------
// Quotation — same sheet as the invoice
// ---------------------------------------------------------------------------

export async function generateQuotationPDF(quotationId: string): Promise<{ buffer: Buffer; fileName: string }> {
  const quotation = await prisma.quotation.findUnique({
    where: { id: quotationId },
    include: {
      customer: true,
      branch: true,
      lines: { include: { product: { select: { name: true, subName: true } } } },
    },
  });

  if (!quotation) throw new Error(`Quotation #${quotationId} not found.`);

  const isGst = quotation.taxMode === "GST";
  const company = await getCompanyProfile(quotation.firmId);
  const lines = salesDocLines(quotation.lines, isGst, true);
  // Saved header values, as the form showed them: subtotal, bill discount,
  // taxable value, CGST/SGST/IGST, round-off and total.
  const totals = {
    gross: num(quotation.subtotal),
    discount: num(quotation.discountAmount),
    taxable: isGst ? num(quotation.taxableAmount) : num(quotation.subtotal) - num(quotation.discountAmount),
    cgst: num(quotation.cgstAmount),
    sgst: num(quotation.sgstAmount),
    igst: num(quotation.igstAmount),
    roundOff: num(quotation.roundOff),
    total: num(quotation.totalAmount),
  };

  const customer = quotation.customer;
  const buffer = await renderSalesDocument(
    {
      title: "QUOTATION",
      isGst,
      company,
      branch: branchProfile(quotation.branch),
      meta: [
        ["Quotation No. :", quotation.quotationNumber],
        ["Date :", formatDate(quotation.quotationDate)],
        ["Valid Until :", quotation.validUntil ? formatDate(quotation.validUntil) : ""],
        ["Type :", isGst ? "GST" : "NON-GST"],
      ],
      toHeading: "Quotation For",
      to: {
        name: customer.name.toUpperCase(),
        lines: [
          ...addressLines(customer),
          ...(customer.gstin ? [`GSTIN : ${customer.gstin}`] : []),
          `PHONE : ${customer.phone}`,
        ],
      },
      lines,
      totals,
      bankDetails: company.bankDetails || undefined,
      terms: quotation.terms || company.termsConditions,
      notes: quotation.notes,
      discountRemarks: quotation.discountRemarks,
      signatoryFor: company.name,
    },
    `Quotation ${quotation.quotationNumber}`,
  );

  return { buffer, fileName: `TECHNIC-Quotation-${quotation.quotationNumber.replace(/\//g, "-")}.pdf` };
}

// ---------------------------------------------------------------------------
// Purchase order
// ---------------------------------------------------------------------------

export async function generatePurchaseOrderPDF(poId: string): Promise<{ buffer: Buffer; fileName: string }> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: {
      supplier: true,
      branch: true,
      items: { include: { product: { select: { subName: true } } } },
      createdBy: { select: { name: true } },
    },
  });

  if (!po) throw new Error(`Purchase order #${poId} not found.`);

  const company = await getCompanyProfile(po.firmId);
  const builder = new PDFDocumentBuilder(company);

  builder.renderCompanyHeader(branchProfile(po.branch));
  builder.renderDocumentTitle("Purchase Order");

  builder.renderInfoColumns([
    {
      heading: "Supplier",
      lines: [
        po.supplier.name,
        ...(po.supplier.gstin ? [`GSTIN: ${po.supplier.gstin}`] : []),
        `Ph: ${po.supplier.phone || "—"}`,
      ],
    },
    {
      heading: "Delivery To",
      lines: [po.branch.name, po.branch.city || company.address],
    },
    {
      heading: "Order Details",
      lines: [
        po.poNumber,
        `Date: ${formatDate(po.orderDate)}`,
        ...(po.expectedDate ? [`Expected: ${formatDate(po.expectedDate)}`] : []),
        `Status: ${po.status.replace(/_/g, " ")}`,
      ],
    },
  ]);

  let totalQty = 0;
  const rows: PDFTableRow[] = po.items.map((item, idx) => {
    totalQty += item.quantity;
    return {
      sl: idx + 1,
      item: item.description,
      hsn: item.hsnCode || "—",
      qty: item.quantity,
      rate: formatCurrency(item.unitPrice),
      amount: formatCurrency(item.lineTotal),
    };
  });

  builder.renderItemsTable(simpleInvoiceColumns(), rows, {
    sl: "",
    item: "TOTAL",
    hsn: "",
    qty: totalQty,
    rate: "",
    amount: formatCurrency(po.total),
  });

  const summaryLines: SummaryLine[] = [{ label: "Sub Total", value: formatCurrency(po.subtotal) }];
  if (num(po.discountAmount) > 0) {
    summaryLines.push({ label: "Discount", value: `-${formatCurrency(po.discountAmount)}` });
  }
  if (num(po.cgstAmount) > 0) summaryLines.push({ label: "CGST", value: formatCurrency(po.cgstAmount) });
  if (num(po.sgstAmount) > 0) summaryLines.push({ label: "SGST", value: formatCurrency(po.sgstAmount) });
  if (num(po.igstAmount) > 0) summaryLines.push({ label: "IGST", value: formatCurrency(po.igstAmount) });
  summaryLines.push({ label: "TOTAL", value: formatCurrency(po.total), highlight: true });

  builder.renderFinancialSummary({
    amountWordsLabel: "Amount In Words",
    amountWords: amountInWords(po.total),
    terms: po.notes || undefined,
    lines: summaryLines,
  });

  builder.renderSignatureBlock(
    [
      { title: "Prepared By", name: po.createdBy?.name },
      { title: `For ${company.name}` },
    ],
    "spread",
  );

  const buffer = await builder.build();
  return { buffer, fileName: `TECHNIC-PO-${po.poNumber.replace(/\//g, "-")}.pdf` };
}

// ---------------------------------------------------------------------------
// Purchase invoice (supplier bill)
// ---------------------------------------------------------------------------

export async function generatePurchaseInvoicePDF(invoiceId: string): Promise<{ buffer: Buffer; fileName: string }> {
  const invoice = await prisma.purchaseInvoice.findUnique({
    where: { id: invoiceId },
    include: {
      supplier: true,
      branch: true,
      lines: { include: { product: { select: { subName: true } } } },
      po: { select: { poNumber: true } },
      createdBy: { select: { name: true } },
    },
  });

  if (!invoice) throw new Error(`Purchase invoice #${invoiceId} not found.`);

  const company = await getCompanyProfile(invoice.firmId);
  const builder = new PDFDocumentBuilder(company);

  builder.renderCompanyHeader(branchProfile(invoice.branch));
  builder.renderDocumentTitle("Purchase Bill");

  builder.renderInfoColumns([
    {
      heading: "Supplier",
      lines: [
        invoice.supplier.name,
        ...(invoice.supplier.gstin ? [`GSTIN: ${invoice.supplier.gstin}`] : []),
        `Ph: ${invoice.supplier.phone || "—"}`,
      ],
    },
    {
      heading: "Bill Details",
      lines: [
        invoice.invoiceNumber,
        `Date: ${formatDate(invoice.invoiceDate)}`,
        ...(invoice.supplierRef ? [`Supplier Ref: ${invoice.supplierRef}`] : []),
        ...(invoice.po ? [`PO: ${invoice.po.poNumber}`] : []),
        ...(invoice.dueDate ? [`Due: ${formatDate(invoice.dueDate)}`] : []),
      ],
    },
  ]);

  let totalQty = 0;
  const rows: PDFTableRow[] = invoice.lines.map((line, idx) => {
    totalQty += line.quantity;
    return {
      sl: idx + 1,
      item: `${line.description}${serialSuffix(line.serialNumbers)}`,
      hsn: line.hsnCode || "—",
      qty: line.quantity,
      rate: formatCurrency(line.unitPrice),
      amount: formatCurrency(line.lineTotal),
    };
  });

  builder.renderItemsTable(simpleInvoiceColumns(), rows, {
    sl: "",
    item: "TOTAL",
    hsn: "",
    qty: totalQty,
    rate: "",
    amount: formatCurrency(invoice.total),
  });

  const summaryLines: SummaryLine[] = [{ label: "Sub Total", value: formatCurrency(invoice.subtotal) }];
  if (num(invoice.discountAmount) > 0) {
    summaryLines.push({ label: "Discount", value: `-${formatCurrency(invoice.discountAmount)}` });
  }
  if (num(invoice.cgstAmount) > 0) summaryLines.push({ label: "CGST", value: formatCurrency(invoice.cgstAmount) });
  if (num(invoice.sgstAmount) > 0) summaryLines.push({ label: "SGST", value: formatCurrency(invoice.sgstAmount) });
  if (num(invoice.igstAmount) > 0) summaryLines.push({ label: "IGST", value: formatCurrency(invoice.igstAmount) });
  summaryLines.push(
    { label: "TOTAL", value: formatCurrency(invoice.total), highlight: true },
    { label: "Paid", value: formatCurrency(invoice.amountPaid) },
    {
      label: "Balance",
      value: formatCurrency(Math.max(0, num(invoice.total) - num(invoice.amountPaid))),
      bold: true,
    },
  );

  builder.renderFinancialSummary({
    amountWordsLabel: "Amount In Words",
    amountWords: amountInWords(invoice.total),
    terms: invoice.notes || undefined,
    lines: summaryLines,
    bankDetails: company.bankDetails || undefined,
  });

  builder.renderSignatureBlock([{ title: `For ${company.name}`, name: invoice.createdBy?.name }]);

  const buffer = await builder.build();
  return { buffer, fileName: `TECHNIC-Purchase-Bill-${invoice.invoiceNumber.replace(/\//g, "-")}.pdf` };
}

// ---------------------------------------------------------------------------
// Payment receipt
// ---------------------------------------------------------------------------

export async function generatePaymentReceiptPDF(paymentId: string): Promise<{ buffer: Buffer; fileName: string }> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      customer: true,
      invoice: true,
      branch: true,
      receivedBy: { select: { name: true } },
    },
  });

  if (!payment) throw new Error(`Payment #${paymentId} not found.`);

  const company = await getCompanyProfile(payment.firmId);
  const builder = new PDFDocumentBuilder(company);

  builder.renderCompanyHeader(branchProfile(payment.branch));
  builder.renderDocumentTitle("Payment Receipt");

  builder.renderInfoColumns([
    {
      heading: "Received From",
      lines: [payment.customer?.name || "Walk-in Customer", `Ph: ${payment.customer?.phone || "—"}`],
    },
    {
      heading: "Receipt Details",
      lines: [
        payment.paymentNumber,
        `Date: ${formatDate(payment.paidAt)}`,
        ...(payment.invoice ? [`Invoice: ${payment.invoice.invoiceNumber}`] : ["Advance / on account"]),
      ],
    },
  ]);

  const summaryLines: SummaryLine[] = [
    { label: "Amount Received", value: formatCurrency(payment.amount), highlight: true },
    { label: "Payment Method", value: PAYMENT_METHOD_LABEL[payment.method] || payment.method },
  ];
  if (payment.reference) {
    summaryLines.push({ label: "Reference", value: payment.reference });
  }
  if (payment.invoice) {
    summaryLines.push(
      { label: "Invoice Total", value: formatCurrency(payment.invoice.totalAmount) },
      { label: "Balance After This Receipt", value: formatCurrency(payment.invoice.amountDue), bold: true },
    );
  }

  builder.renderFinancialSummary({
    amountWordsLabel: "Amount In Words",
    amountWords: amountInWords(payment.amount),
    terms: "This is a computer-generated receipt issued by Technic Technologies.",
    lines: summaryLines,
  });

  builder.renderSignatureBlock([{ title: `For ${company.name}`, name: payment.receivedBy?.name }]);

  const buffer = await builder.build();
  return { buffer, fileName: `TECHNIC-Receipt-${payment.paymentNumber.replace(/\//g, "-")}.pdf` };
}

// ---------------------------------------------------------------------------
// Expense voucher
// ---------------------------------------------------------------------------

export async function generateExpenseReceiptPDF(expenseId: string): Promise<{ buffer: Buffer; fileName: string }> {
  const expense = await prisma.expense.findUnique({
    where: { id: expenseId },
    include: { branch: true, createdBy: { select: { name: true } }, approvedBy: { select: { name: true } } },
  });

  if (!expense) throw new Error(`Expense #${expenseId} not found.`);

  const company = await getCompanyProfile(expense.firmId);
  const builder = new PDFDocumentBuilder(company);

  builder.renderCompanyHeader(branchProfile(expense.branch));
  builder.renderDocumentTitle("Expense Voucher");

  builder.renderInfoColumns([
    {
      heading: "Paid To",
      lines: [expense.paidTo || "Operational Expense", `Category: ${expense.category.replace(/_/g, " ")}`],
    },
    {
      heading: "Voucher Details",
      lines: [
        expense.expenseNumber,
        `Date: ${formatDate(expense.expenseDate)}`,
        `Method: ${PAYMENT_METHOD_LABEL[expense.paymentMethod] || expense.paymentMethod}`,
        `Status: ${expense.status}`,
      ],
    },
  ]);

  const rows: PDFTableRow[] = [
    { sl: 1, item: expense.description, hsn: "—", qty: 1, rate: formatCurrency(expense.amount), amount: formatCurrency(expense.amount) },
  ];

  builder.renderItemsTable(simpleInvoiceColumns(), rows, {
    sl: "",
    item: "TOTAL",
    hsn: "",
    qty: 1,
    rate: "",
    amount: formatCurrency(expense.amount),
  });

  builder.renderFinancialSummary({
    amountWordsLabel: "Amount In Words",
    amountWords: amountInWords(expense.amount),
    lines: [{ label: "Amount", value: formatCurrency(expense.amount), highlight: true }],
  });

  builder.renderSignatureBlock(
    [
      { title: "Prepared By", name: expense.createdBy?.name || company.name },
      { title: "Approved By", name: expense.approvedBy?.name },
      { title: `For ${company.name}` },
    ],
    "spread",
  );

  const buffer = await builder.build();
  return { buffer, fileName: `TECHNIC-Expense-${expense.expenseNumber.replace(/\//g, "-")}.pdf` };
}

// ---------------------------------------------------------------------------
// Purchase return
// ---------------------------------------------------------------------------

export async function generatePurchaseReturnPDF(returnId: string): Promise<{ buffer: Buffer; fileName: string }> {
  const purchaseReturn = await prisma.purchaseReturn.findUnique({
    where: { id: returnId },
    include: {
      supplier: true,
      branch: true,
      items: {
        include: {
          product: { select: { name: true } },
        },
      },
      createdBy: { select: { name: true } },
    },
  });

  if (!purchaseReturn) throw new Error(`Purchase return #${returnId} not found.`);

  const company = await getCompanyProfile(purchaseReturn.firmId);
  const builder = new PDFDocumentBuilder(company);

  builder.renderCompanyHeader(branchProfile(purchaseReturn.branch));
  builder.renderDocumentTitle("Purchase Return");

  builder.renderInfoColumns([
    {
      heading: "Supplier",
      lines: [
        purchaseReturn.supplier.name,
        ...(purchaseReturn.supplier.gstin ? [`GSTIN: ${purchaseReturn.supplier.gstin}`] : []),
        `Ph: ${purchaseReturn.supplier.phone || "—"}`,
      ],
    },
    {
      heading: "Return Details",
      lines: [
        purchaseReturn.returnNumber,
        `Date: ${formatDate(purchaseReturn.returnedAt)}`,
        `Reason: ${purchaseReturn.reason}`,
      ],
    },
  ]);

  let totalQty = 0;
  const rows: PDFTableRow[] = purchaseReturn.items.map((line, idx) => {
    totalQty += line.quantity;
    return {
      sl: idx + 1,
      item: `${line.description}${serialSuffix(line.serialNumbers)}`,
      hsn: "—",
      qty: line.quantity,
      rate: formatCurrency(line.unitPrice),
      amount: formatCurrency(line.lineTotal),
    };
  });

  builder.renderItemsTable(simpleInvoiceColumns(), rows, {
    sl: "",
    item: "TOTAL",
    hsn: "",
    qty: totalQty,
    rate: "",
    amount: formatCurrency(purchaseReturn.total),
  });

  const summaryLines: SummaryLine[] = [{ label: "Total Return", value: formatCurrency(purchaseReturn.total), highlight: true }];

  builder.renderFinancialSummary({
    amountWordsLabel: "Amount In Words",
    amountWords: amountInWords(purchaseReturn.total),
    lines: summaryLines,
  });

  builder.renderSignatureBlock([{ title: `For ${company.name}`, name: purchaseReturn.createdBy?.name }]);

  const buffer = await builder.build();
  return { buffer, fileName: `TECHNIC-Purchase-Return-${purchaseReturn.returnNumber.replace(/\//g, "-")}.pdf` };
}

// ---------------------------------------------------------------------------
// Ledger statement (any ledger, same shared engine as the on-screen view)
// ---------------------------------------------------------------------------

export async function generateLedgerPDF(
  firmId: string,
  ledger: import("@/lib/ledger/types").LedgerResult,
): Promise<{ buffer: Buffer; fileName: string }> {
  const company = await getCompanyProfile(firmId);
  const builder = new PDFDocumentBuilder(company);
  const isQty = ledger.unit === "qty";
  const fmt = (value: number) => (isQty ? String(value) : formatCurrency(value));

  builder.renderCompanyHeader(branchProfile(null));
  builder.renderDocumentTitle(ledger.title);
  builder.renderInfoColumns([
    {
      heading: ledger.subject ? "Account" : "Ledger",
      lines: [ledger.subject ?? ledger.title],
    },
    {
      heading: "Period",
      lines: [
        `${ledger.from ? formatDate(ledger.from) : "Beginning"} to ${ledger.to ? formatDate(ledger.to) : "Today"}`,
        `Printed: ${formatDate(new Date())}`,
      ],
    },
  ]);

  const rows: PDFTableRow[] = ledger.rows.map((row) => ({
    date: row.date ? formatDate(row.date) : "",
    description: row.particulars,
    ref: row.reference,
    debit: row.debit ? fmt(row.debit) : "",
    credit: row.credit ? fmt(row.credit) : "",
    balance: `${fmt(Math.abs(row.balance))} ${row.side}`,
  }));

  builder.renderItemsTable(
    [
      { id: "date", header: "Date", width: 12 },
      { id: "description", header: "Particulars", width: 34 },
      { id: "ref", header: "Reference", width: 16 },
      { id: "debit", header: ledger.debitLabel, width: 12, align: "right" },
      { id: "credit", header: ledger.creditLabel, width: 12, align: "right" },
      { id: "balance", header: "Balance", width: 14, align: "right" },
    ],
    rows,
    {
      date: "",
      description: "TOTAL",
      ref: "",
      debit: fmt(ledger.totalDebit),
      credit: fmt(ledger.totalCredit),
      balance: `${fmt(Math.abs(ledger.closingBalance))} ${ledger.closingSide}`,
    },
  );

  const buffer = await builder.build();
  const slug = ledger.title.replace(/[^A-Za-z0-9]+/g, "-");
  return { buffer, fileName: `TECHNIC-${slug}.pdf` };
}
