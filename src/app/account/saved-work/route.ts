import { NextResponse } from "next/server";
import { buildSavedWork } from "@/features/privacy/saved-work";
import { AccessError } from "@/lib/permissions";
import { logError } from "@/lib/observability/logger";

/**
 * The family's saved work as a file to keep (D-148). A GET that changes
 * nothing. `?child=<id>` for one child, which must be this parent's: checked by
 * requireOwnedChild inside, never trusted from the address.
 */
export async function GET(request: Request) {
  const child = new URL(request.url).searchParams.get("child");
  try {
    const { filename, html } = await buildSavedWork(child && /^[0-9a-f-]{36}$/i.test(child) ? child : null);
    return new NextResponse(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof AccessError) {
      if (error.reason === "unauthenticated") {
        return NextResponse.redirect(new URL("/login?next=/account/close", request.url));
      }
      // Another family's child, or none: the same answer as no such page.
      return new NextResponse("Not found.", { status: 404 });
    }
    logError("saved_work_failed", error);
    return new NextResponse("We couldn't prepare your saved work just now. Please try again.", { status: 500 });
  }
}
