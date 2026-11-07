"use client";

import { useActionState, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { FormError, FormNotice } from "@/components/ui/field";
import { reissueGiftCodeAction, type ReissueState } from "@/features/gifts/actions";
import type { PurchasedGift } from "@/features/gifts/purchaser";

/**
 * GIFTS YOU'VE BOUGHT (D-149). The purchaser receives each code here and shares
 * it however they choose: copied into a message, or the device's own share
 * sheet. WLA asks for no recipient address and sends the recipient nothing.
 *
 * Copy and Share say so in words when they fail, and the code stays on screen
 * to write down.
 */
export function PurchasedGifts({ gifts, siteUrl }: { gifts: PurchasedGift[]; siteUrl: string }) {
  if (gifts.length === 0) return null;
  return (
    <ul className="mt-[var(--space-s)] flex flex-col gap-[var(--space-l)]">
      {gifts.map((g) => (
        <li key={g.id} className="border-t border-[var(--color-border)] pt-[var(--space-m)]">
          {/* Not a heading: this list sits under different headings on Account and Buy a Gift. */}
          <p className="font-medium">{g.missionTitle}</p>
          <p className="text-[length:var(--text-small)] text-[var(--color-text-muted)]">
            Bought {new Date(g.createdAt).toLocaleDateString("en-GB")} · {statusWords(g)}
          </p>
          {g.status === "paid" && <GiftCode gift={g} siteUrl={siteUrl} />}
        </li>
      ))}
    </ul>
  );
}

function statusWords(g: PurchasedGift): string {
  if (g.status === "pending") return "Waiting for payment to be confirmed. Refresh in a moment.";
  if (g.status === "redeemed") {
    return `Redeemed${g.redeemedAt ? ` on ${new Date(g.redeemedAt).toLocaleDateString("en-GB")}` : ""}`;
  }
  return "Ready to share. Not redeemed yet.";
}

function GiftCode({ gift, siteUrl }: { gift: PurchasedGift; siteUrl: string }) {
  const [state, action, isPending] = useActionState(reissueGiftCodeAction, {} as ReissueState);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  // Known only in the browser; checked after hydration so both renders agree.
  const [canShare, setCanShare] = useState(false);
  useEffect(() => {
    queueMicrotask(() => setCanShare(typeof navigator.share === "function"));
  }, []);
  const code = state.code ?? gift.code;
  const redeemAt = `${siteUrl.replace(/\/$/, "")}/redeem`;
  const message = code
    ? `I've given you a Within Lab Academy mission: ${gift.missionTitle}. To redeem it, go to ${redeemAt} and enter this code: ${code}`
    : "";

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setFeedback(`${what} copied.`);
    } catch {
      setFeedback("Couldn’t copy — please write the code down.");
    }
  }

  async function share() {
    try {
      await navigator.share({ title: `A gift: ${gift.missionTitle}`, text: message });
      setFeedback(null);
    } catch (error) {
      // Cancelling the share sheet is not a failure worth a message.
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setFeedback("Couldn’t open sharing — use Copy message instead.");
      }
    }
  }

  return (
    <div className="mt-[var(--space-s)] flex flex-col gap-[var(--space-s)]">
      <FormNotice message={state.notice} />
      <FormError message={state.error} />
      {code ? (
        <>
          <div className="flex flex-wrap items-center gap-x-[var(--space-m)] gap-y-[var(--space-xs)]">
            <p
              className="font-[family-name:var(--font-serif)] text-[length:var(--text-h2)] tracking-[0.12em]"
              data-testid="gift-code"
            >
              {code}
            </p>
            <Button type="button" variant="secondary" onClick={() => copy(code, "Code")}>
              Copy code
            </Button>
            <Button type="button" variant="secondary" onClick={() => copy(message, "Message")}>
              Copy message
            </Button>
            {canShare && (
              <Button type="button" variant="secondary" onClick={share}>
                Share
              </Button>
            )}
          </div>
          <span role="status" className="text-[length:var(--text-small)]">
            {feedback}
          </span>
          <p className="text-[length:var(--text-small)] text-[var(--color-text-muted)]">
            Share it with the person you&rsquo;re giving it to. They enter it at Redeem a Gift. It
            works once and doesn&rsquo;t expire. Whoever has it can redeem it, so keep it private
            until you give it.
          </p>
        </>
      ) : (
        <p className="text-[length:var(--text-small)]">
          {gift.codeUnavailable === "unreadable"
            ? "This code can’t be shown. Get a new code to share instead."
            : "This code can’t be shown here. If you don’t have it from your confirmation email, get a new code."}
        </p>
      )}

      {!replacing ? (
        <Button type="button" variant="text" onClick={() => setReplacing(true)}>
          {code ? "Replace this code" : "Get a new code"}
        </Button>
      ) : (
        <form action={action} className="flex flex-col gap-[var(--space-s)]">
          <input type="hidden" name="giftId" value={gift.id} />
          <label className="flex min-h-[var(--target-min)] items-start gap-[var(--space-s)]">
            <input type="checkbox" name="confirm" value="yes" required className="mt-[3px] h-5 w-5 accent-[var(--color-primary)]" />
            <span>The current code will stop working. Anyone you&rsquo;ve already given it to will need the new one.</span>
          </label>
          <div className="flex flex-wrap gap-[var(--space-s)]">
            <Button type="submit" isLoading={isPending} loadingLabel="Making a new code…">
              Make a new code
            </Button>
            <Button type="button" variant="secondary" onClick={() => setReplacing(false)}>
              Keep this code
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
