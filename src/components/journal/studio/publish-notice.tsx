"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import type { PublishNotice } from "@/features/journal/publish-notice";

/**
 * The confirmation on the articles list (D-147). It stays until dismissed, so
 * nobody has to catch it in time, and sits in a corner, so it covers nothing it
 * shouldn't. The address is tidied at once, so reloading doesn't announce it again.
 */
export function PublishNoticeToast({ notice }: { notice: PublishNotice }) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    window.history.replaceState(null, "", window.location.pathname);
  }, []);
  if (!open) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-[var(--space-m)] bottom-[var(--space-m)] z-50 rounded-[var(--radius-input)] border border-[var(--color-border-strong)] bg-[var(--color-surface-sage)] p-[var(--space-m)] shadow-[var(--shadow-overlay)] sm:left-auto sm:w-[26rem]"
    >
      <p className="font-medium">{notice.message}</p>
      <p className="mt-[var(--space-xs)] text-[length:var(--text-small)]">{notice.title}</p>
      <div className="mt-[var(--space-xs)] flex flex-wrap items-center justify-between gap-[var(--space-s)]">
        {notice.link ? (
          notice.link.external ? (
            <a href={notice.link.href} target="_blank" rel="noreferrer" className="inline-flex min-h-[var(--target-min)] items-center underline underline-offset-4">
              {notice.link.label} (new tab)
            </a>
          ) : (
            <Link href={notice.link.href} className="inline-flex min-h-[var(--target-min)] items-center underline underline-offset-4">
              {notice.link.label}
            </Link>
          )
        ) : <span />}
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="min-h-[var(--target-min)] rounded-[var(--radius-control)] px-[var(--space-s)] text-[length:var(--text-small)] hover:bg-[var(--color-surface-raised)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
