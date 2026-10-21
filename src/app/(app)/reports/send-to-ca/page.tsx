import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { requirePermissionInFirm } from "@/lib/session";
import { allowedItems, CA_ITEM_LABELS } from "@/lib/services/ca-export";
import { recentFinancialYears } from "@/lib/ledger/types";
import { CaExportForm } from "./ca-export-form";

export const metadata = { title: "Send to CA — Technic Technologies" };

export default async function SendToCaPage() {
  const user = await requirePermissionInFirm("reports.export");
  const allowed = allowedItems(user);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Send to CA"
        description="Pick a period and what your CA needs, then download one ZIP to send by email or WhatsApp."
        backButton={
          <Button asChild variant="ghost" size="sm">
            <Link href="/reports"><ArrowLeft className="mr-2 h-4 w-4" /> Reports</Link>
          </Button>
        }
      />
      <CaExportForm
        items={allowed.map((key) => ({ key, ...CA_ITEM_LABELS[key] }))}
        financialYears={recentFinancialYears()}
        gstView={user.accessView === "GST_ONLY"}
      />
    </div>
  );
}
