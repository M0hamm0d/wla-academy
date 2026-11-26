"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useActionState, useState, type ReactNode } from "react";
import { Dialog } from "@/components/admin/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import Image from "next/image";


export type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
  prefix?: boolean;
};

export type ShellIdentity = {
  label: string;
  meta?: string;
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
  onLogout,
}: {
  items: NavItem[];
  pathname: string;
  onNavigate?: () => void;
  onLogout?: () => void;
}) {
  return (
    <ul className="flex flex-col gap-[2px]">
      {items.map((item) => {
        const active = isActive(pathname, item);
        const isLogoutItem = item.href === "/logout" || item.href === "/child/logout";
        return (
          <li key={item.href}>
            {isLogoutItem && onLogout ? (
              <button
                type="button"
                onClick={() => { onNavigate?.(); onLogout(); }}
                className={cn(
                  "flex min-h-[var(--target-min)] w-full items-center gap-[var(--space-s)]",
                  "rounded-[var(--radius-control)] px-[var(--space-m)] py-[10px]",
                  "text-left text-[length:var(--text-label)]",
                  "transition-colors duration-[var(--duration-fast)]",
                  "text-[color:var(--color-text-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[color:var(--color-text)]",
                )}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ) : (
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
            )}
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
  logoutAction,
  logoutMessage,
  children,
}: {
  nav: NavItem[];
  utility?: NavItem[];
  identity?: ShellIdentity;
  logoutAction?: () => Promise<void>;
  logoutMessage?: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [, logoutFormAction, isLoggingOut] = useActionState(
    async (_previousState: null, _formData: FormData): Promise<null> => {
      if (logoutAction) await logoutAction();
      return null;
    },
    null,
  );
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
            <Image src="/logo-transparent.png" alt="Wordmark: WLA" width={120} height={32} priority />
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
              <NavList
                items={utility}
                pathname={pathname}
                onNavigate={close}
                onLogout={logoutAction ? () => setLogoutOpen(true) : undefined}
              />
            </div>
          )}
        </nav>

        {/* ------------------------------------------------------- content */}
        <div className="min-w-0 flex-1">{children}</div>
      </div>
      {logoutAction && (
        <Dialog
          open={logoutOpen}
          onClose={() => {
            if (!isLoggingOut) setLogoutOpen(false);
          }}
          title="Log out?"
          role="alertdialog"
        >
          <form action={logoutFormAction} className="mt-[var(--space-l)] flex justify-end gap-[var(--space-s)]">
            <Button type="button" variant="secondary" disabled={isLoggingOut} onClick={() => setLogoutOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" isLoading={isLoggingOut} loadingLabel="Logging out…">
              Log out
            </Button>
          </form>
        </Dialog>
      )}
    </div>
  );
}
