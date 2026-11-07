"use client";

import { useTransition } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";
import { deleteChildAction } from "@/features/children/actions";
import { cn } from "@/lib/utils";

/**
 * Removing a child profile is destructive: their progress, responses, Mission
 * Trail and its files, Board contributions and code all go (D-148). The family
 * can download the child's saved work first.
 *
 * UI/UX §52 permits modals for confirmation. The copy names exactly what is
 * lost rather than asking a vague "are you sure?" — Mission Trail is the
 * child's record of their own practice, and Architecture §15 treats it as
 * theirs.
 */
export function RemoveChild({
  childId,
  displayName,
}: {
  childId: string;
  displayName: string;
}) {
  const [isPending, startTransition] = useTransition();

  return (
    <Dialog.Root>
      <Dialog.Trigger
        className={cn(
          "inline-flex min-h-[var(--target-min)] items-center",
          "text-[length:var(--text-small)] text-[var(--color-text-muted)]",
          "underline decoration-[var(--color-border-strong)] underline-offset-4",
          "hover:text-[var(--color-error)]",
        )}
      >
        Remove
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-[rgb(58_47_42/0.32)]" />
        <Dialog.Content
          className={cn(
            "fixed top-1/2 left-1/2 w-[min(28rem,calc(100vw-2rem))]",
            "-translate-x-1/2 -translate-y-1/2",
            "rounded-[var(--radius-dialog)] border border-[var(--color-border)]",
            "bg-[var(--color-surface)] p-[var(--space-l)]",
            "shadow-[var(--shadow-overlay)]",
          )}
        >
          <Dialog.Title className="text-[length:var(--text-h3)]">
            Remove {displayName}&rsquo;s profile?
          </Dialog.Title>
          <Dialog.Description className="mt-[var(--space-m)] text-[var(--color-text-muted)]">
            This also removes their missions, their mission progress, their saved
            responses, their Mission Trail and any files in it, anything they shared on
            the Mission Board, and their access code. Your account and other profiles
            aren&rsquo;t affected. This cannot be undone.
          </Dialog.Description>
          <p className="mt-[var(--space-s)] text-[length:var(--text-small)]">
            <a
              href={`/account/saved-work?child=${childId}`}
              className="inline-flex min-h-[var(--target-min)] items-center underline underline-offset-4"
            >
              Download {displayName}&rsquo;s saved work first
            </a>
          </p>

          <div className="mt-[var(--space-l)] flex flex-wrap gap-[var(--space-m)]">
            <Button
              onClick={() =>
                startTransition(() => {
                  void deleteChildAction(childId);
                })
              }
              isLoading={isPending}
              loadingLabel="Removing…"
              className="bg-[var(--color-error)] hover:bg-[var(--color-error)]"
            >
              Remove profile
            </Button>
            <Dialog.Close asChild>
              <Button variant="secondary">Keep it</Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
