import { redirect } from "next/navigation";
import { requireAdmin, AccessError } from "@/lib/permissions";
import { logAccessDenied } from "@/lib/observability/logger";
import { AppShell, type NavItem } from "@/components/app-shell/app-shell";
import {
  IconOverview, IconMission, IconBuilder, IconParents, IconChildren,
  IconOrders, IconActivity, IconAnalytics, IconSettings, IconHelp, IconLogout,
  IconBoard, IconJournal, IconPrivacy,
} from "@/components/app-shell/icons";

export const metadata = { title: "Academy admin" };

/**
 * THE INTERNAL ADMIN — CMS-01, extended by the LMS brief (§3, §18–§24).
 *
 * Still the simplest suitable mechanism (Tech Spec §39): forms over ordinary
 * Postgres tables. What the LMS brief added is breadth — nine destinations
 * instead of one — and the Mission Builder, which is authoring rather than
 * editing and is the reason D-56 was needed.
 *
 * Gated HERE and at the database. This layout refuses a non-admin before any
 * child route renders; every admin function additionally begins with
 * `is_admin()`, so a request that reached a server action directly would still
 * be refused. Neither is a substitute for the other.
 *
 * Deliberately NOT a SaaS admin template (§26): same canvas, typefaces and
 * restraint as the Academy, because a tool used weekly should feel like the
 * product it edits.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let profile;
  try {
    ({ profile } = await requireAdmin());
  } catch (error) {
    if (error instanceof AccessError) {
      /*
       * A refused admin page is a security-relevant event, not an error. It is
       * logged without the account's identity and answered with a redirect
       * rather than a message — an interface that says "you are not an admin"
       * confirms the route exists.
       */
      logAccessDenied("admin_route", { reason: error.reason });
      redirect("/academy/my-missions");
    }
    throw error;
  }

  const nav: NavItem[] = [
    { href: "/admin", label: "Overview", icon: <IconOverview /> },
    { href: "/admin/missions", label: "Missions", icon: <IconMission />, prefix: true },
    { href: "/admin/builder", label: "Mission Builder", icon: <IconBuilder />, prefix: true },
    { href: "/admin/parents", label: "Parents", icon: <IconParents />, prefix: true },
    { href: "/admin/children", label: "Children", icon: <IconChildren />, prefix: true },
    { href: "/admin/orders", label: "Orders", icon: <IconOrders /> },
    { href: "/admin/activity", label: "Activity", icon: <IconActivity /> },
    { href: "/admin/analytics", label: "Analytics", icon: <IconAnalytics /> },
    { href: "/admin/board", label: "Mission Board", icon: <IconBoard /> },
    { href: "/admin/privacy", label: "Privacy", icon: <IconPrivacy /> },
    // The Journal studio has its own gate (D-124): staff who are not admins use it too.
    { href: "/editorial", label: "Journal", icon: <IconJournal /> },
    { href: "/admin/settings", label: "Settings", icon: <IconSettings /> },
  ];

  const utility: NavItem[] = [
    { href: "/admin/help", label: "Help", icon: <IconHelp /> },
    { href: "/logout", label: "Log out", icon: <IconLogout /> },
  ];

  return (
    <AppShell
      nav={nav}
      utility={utility}
      identity={{ label: profile.email, meta: "Admin" }}
    >
      {children}
    </AppShell>
  );
}
