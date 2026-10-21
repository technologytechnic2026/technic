import Link from "next/link";

import { PageHeader } from "@/components/shared/page-header";
import { StatCard } from "@/components/shared/stat-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FilterBar } from "@/components/shared/filter-bar";
import {
  salesReport,
  purchaseReport,
  gstSummaryReport,
  productSalesReport,
  financialSummary,
  type ReportPreset,
} from "@/lib/services/reports";
import { requirePermissionInFirm } from "@/lib/session";
import { canBillGst } from "@/lib/access-mode";
import { formatCurrency, num } from "@/lib/money";
import { formatDate } from "@/lib/dates";
import { Lock } from "lucide-react";

export const metadata = { title: "Reports — Technic Technologies" };

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requirePermissionInFirm("reports.view");
  const params = await searchParams;
  const preset = (params.preset ?? "this_month") as ReportPreset;
  const options = { preset, from: params.from, to: params.to };
  const gstReports = canBillGst(user);

  const [sales, purchases, products, financial, gst] = await Promise.all([
    salesReport(user, options),
    purchaseReport(user, options),
    productSalesReport(user, options),
    financialSummary(user, options),
    gstReports ? gstSummaryReport(user, options) : Promise.resolve(null),
  ]);

  const exportQs = new URLSearchParams({ preset, ...(params.from ? { from: params.from } : {}), ...(params.to ? { to: params.to } : {}) });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Reports"
        description={`${formatDate(sales.range.from)} → ${formatDate(sales.range.to)}`}
        actions={
          <>
            {user.permissions.includes("reports.export") ? (
              <Button asChild variant="outline">
                <Link href="/reports/send-to-ca">Send to CA</Link>
              </Button>
            ) : null}
            <Button asChild variant="outline">
              <a href={`/api/export?type=sales&${exportQs.toString()}`}>Export sales CSV</a>
            </Button>
          </>
        }
      />

      <FilterBar
        showSearch={false}
        filters={[
          {
            name: "preset",
            label: "Period",
            options: [
              { value: "today", label: "Today" },
              { value: "yesterday", label: "Yesterday" },
              { value: "this_week", label: "This week" },
              { value: "this_month", label: "This month" },
              { value: "previous_month", label: "Previous month" },
              { value: "this_fy", label: "This FY" },
              { value: "previous_fy", label: "Previous FY" },
              { value: "all", label: "All time" },
            ],
          },
        ]}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Revenue" value={formatCurrency(financial.revenue)} tone="success" />
        <StatCard label="Purchases" value={formatCurrency(financial.purchases)} />
        <StatCard label="Expenses" value={formatCurrency(financial.expenses)} tone="warning" />
        <StatCard label="Gross margin" value={formatCurrency(financial.grossMargin)} tone={financial.grossMargin >= 0 ? "success" : "danger"} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between text-base">
              Sales
              <Badge tone="outline">{sales.rows.length} invoices</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <div className="max-h-80 overflow-auto scrollbar-thin">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Invoice</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="pr-4 text-right">Due</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sales.rows.slice(0, 15).map((row) => (
                    <TableRow key={row.invoiceNumber}>
                      <TableCell className="pl-4 font-medium">{row.invoiceNumber}</TableCell>
                      <TableCell className="numeric">{formatDate(row.invoiceDate)}</TableCell>
                      <TableCell className="text-right numeric">{formatCurrency(row.total)}</TableCell>
                      <TableCell className="pr-4 text-right numeric">{row.due > 0 ? formatCurrency(row.due) : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between text-base">
              GST summary
              {gstReports ? (
                <Badge tone="info">{num(gst?.totals.cgst ?? 0) + num(gst?.totals.sgst ?? 0) + num(gst?.totals.igst ?? 0) > 0 ? "Tax collected" : "No tax"}</Badge>
              ) : (
                <Badge tone="neutral"><Lock className="mr-1 size-3" /> GST mode required</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            {!gstReports || !gst ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                GST summaries require the GST reporting permission.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Rate</TableHead>
                    <TableHead className="text-right">Taxable</TableHead>
                    <TableHead className="text-right">CGST</TableHead>
                    <TableHead className="text-right">SGST</TableHead>
                    <TableHead className="pr-4 text-right">IGST</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {gst.byRate.length === 0 ? (
                    <TableRow><TableCell colSpan={5} className="pl-4 text-muted-foreground">No GST invoices in this period.</TableCell></TableRow>
                  ) : (
                    gst.byRate.map((row) => (
                      <TableRow key={row.gstRate}>
                        <TableCell className="pl-4 font-medium">{row.gstRate}%</TableCell>
                        <TableCell className="text-right numeric">{formatCurrency(row.taxableAmount)}</TableCell>
                        <TableCell className="text-right numeric">{formatCurrency(row.cgst)}</TableCell>
                        <TableCell className="text-right numeric">{formatCurrency(row.sgst)}</TableCell>
                        <TableCell className="pr-4 text-right numeric">{formatCurrency(row.igst)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Top products</CardTitle></CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Product</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="pr-4 text-right">Revenue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.slice(0, 10).map((row) => (
                  <TableRow key={row.sku}>
                    <TableCell className="pl-4">
                      <span className="font-medium">{row.name}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{row.sku}</span>
                    </TableCell>
                    <TableCell className="text-right numeric">{row.quantity}</TableCell>
                    <TableCell className="pr-4 text-right numeric">{formatCurrency(row.revenue)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Purchases</CardTitle></CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Bill</TableHead>
                  <TableHead>Supplier</TableHead>
                  <TableHead className="pr-4 text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {purchases.rows.slice(0, 10).map((row) => (
                  <TableRow key={row.invoiceNumber}>
                    <TableCell className="pl-4 font-medium">{row.invoiceNumber}</TableCell>
                    <TableCell>{row.supplierName}</TableCell>
                    <TableCell className="pr-4 text-right numeric">{formatCurrency(row.total)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="px-4 pt-3 text-xs text-muted-foreground">
              Purchases total {formatCurrency(purchases.totals.total)} · paid {formatCurrency(purchases.totals.paid)}
            </p>
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground">
        Looking for outstanding balances? See <Link href="/payments" className="text-primary hover:underline">Payments</Link>.
      </p>
    </div>
  );
}
