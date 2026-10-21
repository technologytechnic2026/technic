import { NextResponse } from "next/server";

import { getCurrentUser, hasPermission } from "@/lib/session";
import { PERMISSIONS } from "@/lib/rbac";
import { RATE_LIMITS, rateLimit } from "@/lib/rate-limit";
import { errorStatus } from "@/lib/action-result";
import { buildCaPackage, parseCaRequest, previewCaPackage } from "@/lib/services/ca-export";

/**
 * GET /api/ca-package?from=YYYY-MM-DD&to=YYYY-MM-DD&items=a,b,c[&preview=1]
 * preview=1 returns JSON counts; otherwise the ZIP package. Requires the
 * reports.export permission plus the view permission of each selected item.
 */
export async function GET(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Your session has expired — please sign in again" }, { status: 401 });
    if (!user.activeFirmId) return NextResponse.json({ error: "Select a firm first" }, { status: 403 });
    if (!hasPermission(user, PERMISSIONS.REPORTS_EXPORT)) {
      return NextResponse.json({ error: "You do not have permission to export reports" }, { status: 403 });
    }

    const url = new URL(request.url);
    const req = parseCaRequest({
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to"),
      items: url.searchParams.get("items"),
    });

    if (url.searchParams.get("preview")) {
      return NextResponse.json(await previewCaPackage(user, req), { headers: { "Cache-Control": "no-store" } });
    }

    const limit = rateLimit(`ca-package:${user.id}`, RATE_LIMITS.EXPORT.limit, RATE_LIMITS.EXPORT.windowMs);
    if (!limit.success) {
      return NextResponse.json({ error: `Too many exports. Retry in ${limit.retryAfterSeconds}s.` }, { status: 429 });
    }

    const pkg = await buildCaPackage(user, req);
    return new NextResponse(new Uint8Array(pkg.buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${pkg.fileName}"`,
        "Cache-Control": "no-store",
        "X-Package-Issues": String(pkg.issues.length),
      },
    });
  } catch (error) {
    console.error("[ca-package]", error);
    const status = errorStatus(error);
    const message = status === 500 ? "The export failed. Please try again, or choose a shorter period." : (error as Error).message;
    return NextResponse.json({ error: message }, { status });
  }
}
