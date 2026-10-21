"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface Item { key: string; label: string; kind: string; hint: string }
interface Preview {
  from: string;
  to: string;
  empty: boolean;
  items: { key: string; label: string; kind: string; count: number | null; note?: string }[];
  warnings: string[];
  pdfCount: number;
}

type Mode = "month" | "quarter" | "custom";
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const lastDay = (y: number, m: number) => new Date(y, m, 0).getDate(); // m is 1-12

/** Indian FY quarters: Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar. */
function quarterRange(fy: string, q: number): { from: string; to: string } {
  const start = Number(fy.slice(0, 4));
  const months: [number, number, number][] = [[start, 4, 6], [start, 7, 9], [start, 10, 12], [start + 1, 1, 3]];
  const [y, a, b] = months[q - 1];
  return { from: `${y}-${pad(a)}-01`, to: `${y}-${pad(b)}-${pad(lastDay(y, b))}` };
}

export function CaExportForm({ items, financialYears, gstView }: { items: Item[]; financialYears: string[]; gstView: boolean }) {
  const now = new Date();
  const [mode, setMode] = useState<Mode>("month");
  const [month, setMonth] = useState(`${now.getFullYear()}-${pad(now.getMonth() + 1)}`);
  const [fy, setFy] = useState(financialYears[0]);
  const [quarter, setQuarter] = useState(String(Math.floor(((now.getMonth() + 9) % 12) / 3) + 1));
  const [from, setFrom] = useState(ymd(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [to, setTo] = useState(ymd(now));
  const [selected, setSelected] = useState<Set<string>>(new Set(items.map((i) => i.key)));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const range = useMemo(() => {
    if (mode === "month") {
      const [y, m] = month.split("-").map(Number);
      if (!y || !m) return null;
      return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay(y, m))}` };
    }
    if (mode === "quarter") return quarterRange(fy, Number(quarter));
    return from && to ? { from, to } : null;
  }, [mode, month, fy, quarter, from, to]);

  const itemsParam = useMemo(() => items.filter((i) => selected.has(i.key)).map((i) => i.key).join(","), [items, selected]);
  const query = range && itemsParam ? new URLSearchParams({ from: range.from, to: range.to, items: itemsParam }) : null;

  // Live preview of what the package will contain (read-only counts).
  useEffect(() => {
    if (!query) { setLoading(false); setPreview(null); setError(range ? "Select at least one document or report" : "Choose a period"); return; }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/ca-package?${query.toString()}&preview=1`, { cache: "no-store" });
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) { setPreview(null); setError(body.error ?? "Could not load the preview"); }
        else { setPreview(body as Preview); setError(null); }
      } catch {
        if (!cancelled) { setPreview(null); setError("Could not reach the server. Check your connection and try again."); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query?.toString()]); // eslint-disable-line react-hooks/exhaustive-deps

  const allSelected = items.length > 0 && items.every((i) => selected.has(i.key));
  const toggle = (key: string, on: boolean) =>
    setSelected((cur) => { const n = new Set(cur); if (on) n.add(key); else n.delete(key); return n; });

  const download = async () => {
    if (!query) return;
    setDownloading(true);
    try {
      const res = await fetch(`/api/ca-package?${query.toString()}`, { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? "The export failed. Please try again.");
        return;
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "CA-package.zip";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.success(`${name} downloaded${res.headers.get("X-Package-Issues") !== "0" ? " — see README.txt inside for notes" : ""}`);
    } catch {
      toast.error("The download was interrupted. Please try again.");
    } finally {
      setDownloading(false);
    }
  };

  const canDownload = Boolean(query) && !loading && !error && preview !== null && !preview.empty && !downloading
    && !preview.warnings.some((w) => w.includes("exceed the limit"));

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <div className="space-y-4 lg:col-span-3">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">1. Reporting period</CardTitle></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Period type</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as Mode)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="month">Monthly</SelectItem>
                  <SelectItem value="quarter">Quarterly</SelectItem>
                  <SelectItem value="custom">Custom range</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {mode === "month" ? (
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="ca-month">Month</Label>
                <Input id="ca-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
              </div>
            ) : null}
            {mode === "quarter" ? (
              <>
                <div className="space-y-1.5">
                  <Label>Financial year</Label>
                  <Select value={fy} onValueChange={setFy}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{financialYears.map((y) => <SelectItem key={y} value={y}>FY {y}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Quarter</Label>
                  <Select value={quarter} onValueChange={setQuarter}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">Q1 (Apr – Jun)</SelectItem>
                      <SelectItem value="2">Q2 (Jul – Sep)</SelectItem>
                      <SelectItem value="3">Q3 (Oct – Dec)</SelectItem>
                      <SelectItem value="4">Q4 (Jan – Mar)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </>
            ) : null}
            {mode === "custom" ? (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="ca-from">From</Label>
                  <Input id="ca-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ca-to">To</Label>
                  <Input id="ca-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                </div>
              </>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between pb-2">
            <CardTitle className="text-base">2. What to include</CardTitle>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={allSelected}
                onCheckedChange={(v) => setSelected(v ? new Set(items.map((i) => i.key)) : new Set())}
                aria-label="Select all"
              />
              Select all
            </label>
          </CardHeader>
          <CardContent className="space-y-1">
            {items.map((item) => (
              <label key={item.key} className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-muted/50">
                <Checkbox className="mt-0.5" checked={selected.has(item.key)} onCheckedChange={(v) => toggle(item.key, Boolean(v))} />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{item.label} <span className="text-xs font-normal text-muted-foreground">· {item.kind}</span></span>
                  <span className="block text-xs text-muted-foreground">{item.hint}</span>
                </span>
              </label>
            ))}
            {gstView ? <p className="px-2 pt-2 text-xs text-muted-foreground">GST view: only GST documents are included; expenses are not available.</p> : null}
          </CardContent>
        </Card>
      </div>

      <Card className="h-fit lg:col-span-2">
        <CardHeader className="pb-2"><CardTitle className="text-base">3. Preview &amp; download</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          {range ? <p className="text-muted-foreground">Period: <span className="font-medium text-foreground">{range.from} to {range.to}</span></p> : null}
          {loading ? <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Checking records…</p> : null}
          {error && !loading ? (
            <p className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-destructive"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{error}</p>
          ) : null}
          {preview && !loading ? (
            <>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {preview.items.map((it) => (
                  <li key={it.key} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="min-w-0">
                      <span className="block truncate">{it.label}</span>
                      {it.note ? <span className="block text-xs text-muted-foreground">{it.note}</span> : null}
                    </span>
                    <span className="numeric shrink-0 font-medium">{it.count === null ? "included" : `${it.count} record${it.count === 1 ? "" : "s"}`}</span>
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground">PDFs in package: <span className="font-medium text-foreground">{preview.pdfCount}</span></p>
              {preview.empty ? (
                <p className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2"><AlertTriangle className="mt-0.5 size-4 shrink-0" />No records found in this period for the selected items. Choose another period.</p>
              ) : null}
              {preview.warnings.map((w) => (
                <p key={w} className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-xs"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{w}</p>
              ))}
            </>
          ) : null}
          <Button className="w-full" size="lg" onClick={download} disabled={!canDownload}>
            {downloading ? <><Loader2 className="animate-spin" /> Preparing package…</> : <><Download /> Download Package (ZIP)</>}
          </Button>
          <p className="text-xs text-muted-foreground">The ZIP is downloaded to your device — send it to your CA yourself. Nothing is emailed or shared automatically.</p>
        </CardContent>
      </Card>
    </div>
  );
}
