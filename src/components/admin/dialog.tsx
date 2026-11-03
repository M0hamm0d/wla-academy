"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * A modal dialog on the native <dialog> element.
 *
 * `showModal()` gives the things a hand-rolled modal gets wrong: focus moves
 * in and is trapped, Escape closes it, the page behind is inert, and focus
 * returns to the opener afterwards. Used for the few decisions that deserve
 * an interruption — publishing, discarding unsaved work — never for help.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  role = "dialog",
  size = "default",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** "alertdialog" when the dialog asks to confirm a consequential action. */
  role?: "dialog" | "alertdialog";
  /** "wide" for a dialog that holds a form to work through. */
  size?: "default" | "wide";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
    } else if (!open && d.open) {
      if (typeof d.close === "function") d.close();
      else d.removeAttribute("open");
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      role={role}
      aria-labelledby={titleId}
      aria-modal="true"
      // Escape: let React own the state rather than the element closing itself.
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      className={`m-auto ${size === "wide" ? "w-[min(44rem,calc(100vw-2*var(--space-m)))]" : "w-[min(34rem,calc(100vw-2*var(--space-m)))]"} rounded-[var(--radius-dialog)] border border-[var(--color-border-strong)] bg-[var(--color-background)] p-[var(--space-l)] text-[var(--color-text)] shadow-[var(--shadow-overlay)] backdrop:bg-[color-mix(in_srgb,var(--color-text)_35%,transparent)]`}
    >
      {open && (
        <>
          <h2 id={titleId} className="text-[length:var(--text-h3)]">{title}</h2>
          <div className="mt-[var(--space-m)]">{children}</div>
        </>
      )}
    </dialog>
  );
}
