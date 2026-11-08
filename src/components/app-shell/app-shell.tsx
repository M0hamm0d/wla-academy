"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * THE ACADEMY APPLICATION SHELL — LMS brief §3, §26, §27.
 *
 * Structure follows the reference sketches: a persistent left sidebar, the
 * wordmark top-left, identity context top-right, content to the right of the
 * nav. The LOOK is WLA's own — warm cream, Fraunces for the wordmark, Karla
 * for navigation, restrained radii, olive reserved for the active item.
 *
 * DELIBERATELY NOT A SAAS ADMIN TEMPLATE (§26): no dense icon rail, no
 * collapsed-to-glyphs mode, no dark chrome, no cards for navigation. The
 * sidebar reads as a list of places, because that is what it is.
 *
 * RESPONSIVE (§27): the sidebar is a real sidebar from `lg` up and a
 * disclosure below it. It is NOT forced onto narrow screens — on mobile the
 * nav collapses behind one button and the content takes the full width, so a
 * mission card never has to compete with chrome for space.
 */

export type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
  /** Match this item for any nested path beneath it, not just an exact hit. */
  prefix?: boolean;
};

export type ShellIdentity = {
  /** What is shown in the top-right chip. */
  label: string;
  /** Optional secondary line, e.g. "Parent" or "Admin". */
  meta?: string;
  /** Rendered beside the chip — the child switcher, when there is one. */
  action?: ReactNode;
};

function isActive(pathname: string, item: NavItem) {
  if (item.prefix) return pathname === item.href || pathname.startsWith(`${item.href}/`);
  return pathname === item.href;
}

function NavList({
  items,
  pathname,
  onNavigate,
}: {
  items: NavItem[];
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <ul className="flex flex-col gap-[2px]">
      {items.map((item) => {
        const active = isActive(pathname, item);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              onClick={onNavigate}
              // aria-current is what actually announces the active item.
              // Colour and weight alone would not (Architecture §20).
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-[var(--target-min)] items-center gap-[var(--space-s)]",
                "rounded-[var(--radius-control)] px-[var(--space-m)] py-[10px]",
                "text-[length:var(--text-label)]",
                "transition-colors duration-[var(--duration-fast)]",
                active
                  ? "bg-[var(--color-surface-sage)] font-medium text-[color:var(--color-text)]"
                  : "text-[color:var(--color-text-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[color:var(--color-text)]",
              )}
            >
              {item.icon}
              <span>{item.label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function AppShell({
  nav,
  utility,
  identity,
  children,
}: {
  nav: NavItem[];
  utility?: NavItem[];
  identity?: ShellIdentity;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <div className="min-h-dvh bg-[var(--color-background)]">
      {/* ---------------------------------------------------------- header */}
      <header className="sticky top-0 z-30 print:hidden border-b border-[var(--color-border)] bg-[var(--color-background)]">
        {/* flex-wrap: at 200% text on a phone the child switcher drops to its own line instead of widening the page (WCAG 1.4.4). */}
        <div className="flex min-h-[64px] flex-wrap items-center gap-x-[var(--space-m)] gap-y-[var(--space-xs)] px-[var(--space-m)] py-[var(--space-xs)] lg:px-[var(--space-l)]">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="shell-nav"
            className={cn(
              "inline-flex size-[var(--target-min)] items-center justify-center lg:hidden",
              "rounded-[var(--radius-control)] border border-[var(--color-border)]",
              "hover:bg-[var(--color-surface)]",
            )}
          >
            <span className="sr-only">{open ? "Close menu" : "Open menu"}</span>
            <svg viewBox="0 0 24 24" className="size-[20px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              {open ? <path d="m6 6 12 12M18 6 6 18" /> : <><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></>}
            </svg>
          </button>

          <Link
            href="/academy/my-missions"
            className="font-[family-name:var(--font-serif)] text-[length:var(--text-h3)] text-[color:var(--color-text)]"
          >
            WLA Academy
          </Link>

          {identity && (
            <div className="ml-auto flex min-w-0 max-w-full items-center gap-[var(--space-s)]">
              {identity.action}
              {identity.label && (
                <span className="hidden items-center gap-[var(--space-xs)] text-[length:var(--text-small)] text-[var(--color-text-muted)] sm:inline-flex">
                  {identity.meta && (
                    <span className="rounded-[var(--radius-control)] border border-[var(--color-border)] px-[var(--space-xs)] py-[2px]">
                      {identity.meta}
                    </span>
                  )}
                  <span className="text-[color:var(--color-text)]">{identity.label}</span>
                </span>
              )}
            </div>
          )}
        </div>
      </header>

      <div className="lg:flex">
        {/* ------------------------------------------------------- sidebar */}
        <nav
          id="shell-nav"
          aria-label="Academy"
          className={cn(
            "border-[var(--color-border)] lg:w-[248px] lg:shrink-0 lg:border-r",
            "lg:sticky lg:top-[64px] lg:h-[calc(100dvh-64px)] lg:overflow-y-auto scrollbar-hidden",
            "flex-col justify-between p-[var(--space-m)] lg:flex print:!hidden",
            open ? "flex border-b" : "hidden",
          )}
        >
          <NavList items={nav} pathname={pathname} onNavigate={close} />
          {utility && utility.length > 0 && (
            <div className="mt-[var(--space-l)] border-t border-[var(--color-border)] pt-[var(--space-m)]">
              <NavList items={utility} pathname={pathname} onNavigate={close} />
            </div>
          )}
        </nav>

        {/* ------------------------------------------------------- content */}
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
