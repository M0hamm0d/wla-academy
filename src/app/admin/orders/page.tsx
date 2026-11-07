import { AdminPage, DataTable, Td, StatusTag } from "@/components/admin/admin-page";
import { adminGifts, adminOrders } from "@/features/admin/lms-queries";
import { formatPrice } from "@/lib/utils";

export const metadata = { title: "Orders" };

const GIFT_STATUS = {
  pending: "Payment not completed",
  paid: "Paid, not redeemed",
  redeemed: "Redeemed",
} as const;

/**
 * ADMIN ORDERS — brief §21, and its constraint: an admin must not be able to
 * fabricate a payment record.
 *
 * This surface is READ ONLY and has no companion write action anywhere in the
 * codebase. Entitlement remains server-controlled: it is written by the Stripe
 * webhook against a verified signature, which also stamps the payment on the
 * order (D-148), so `state` is a recorded fact no administrator can edit. An
 * order from a closed account stays as a financial record, without anyone's
 * name or address. "Consent" and "Confirmation" show that both checkout
 * statements were recorded and the confirmation email left (D-152).
 */
export default async function AdminOrdersPage() {
  const [orders, gifts] = await Promise.all([adminOrders(), adminGifts()]);
  const date = (value: string | null) =>
    value ? new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";

  return (
    <AdminPage title="Orders" intro="View purchases, gifts and entitlements.">
      {orders.length === 0 ? (
        <p className="text-[var(--color-text-muted)]">No orders yet.</p>
      ) : (
        <DataTable caption="Orders" columns={["Date", "Parent", "Child", "Mission", "Amount", "State", "Consent", "Confirmation"]}>
          {orders.map((o) => (
            <tr key={o.id}>
              <Td>{new Date(o.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</Td>
              <Td>{o.parent_email ?? "Account closed"}</Td>
              <Td>{o.child_name ?? "—"}</Td>
              <Td>{o.mission_title}</Td>
              <Td>{formatPrice(o.amount_minor, o.currency)}</Td>
              <Td><StatusTag status={o.state === "paid" ? "published" : "draft"} /></Td>
              <Td>{o.consent_recorded ? "Recorded" : "Not recorded"}</Td>
              <Td>{o.state !== "paid" ? "—" : o.confirmation_sent ? "Sent" : "Not sent"}</Td>
            </tr>
          ))}
        </DataTable>
      )}
      <p className="mt-[var(--space-l)] wla-measure text-[length:var(--text-small)] text-[var(--color-text-muted)]">
        Payment state is recorded by the payment provider&rsquo;s verified webhook.
        It cannot be set from here.
      </p>

      <h2 className="mt-[var(--space-2xl)] text-[length:var(--text-h3)]">Gifts</h2>
      <div className="mt-[var(--space-m)]">
        {gifts.length === 0 ? (
          <p className="text-[var(--color-text-muted)]">No gifts yet.</p>
        ) : (
          <DataTable caption="Gifts" columns={["Date", "Mission", "Purchaser", "Amount", "Status", "Paid", "Redeemed", "Redeemed by", "Child", "Consent", "Confirmation"]}>
            {gifts.map((g) => (
              <tr key={g.id}>
                <Td>{date(g.created_at)}</Td>
                <Td>{g.mission_title}</Td>
                <Td>{g.purchaser_email ?? "—"}</Td>
                <Td>{formatPrice(g.amount_minor, g.currency)}</Td>
                {/* In words: a pending gift is unpaid, and redeems nothing. */}
                <Td>{GIFT_STATUS[g.status]}</Td>
                <Td>{date(g.paid_at)}</Td>
                <Td>{date(g.redeemed_at)}</Td>
                <Td>{g.redeemed_by_email ?? "—"}</Td>
                <Td>{g.redeemed_child_name ?? "—"}</Td>
                <Td>{g.consent_recorded ? "Recorded" : "Not recorded"}</Td>
                <Td>{g.status === "pending" ? "—" : g.confirmation_sent ? "Sent" : "Not sent"}</Td>
              </tr>
            ))}
          </DataTable>
        )}
      </div>
      <p className="mt-[var(--space-l)] wla-measure text-[length:var(--text-small)] text-[var(--color-text-muted)]">
        Set by the payment provider and by redemption. It cannot be changed from here.
        Gift codes are never shown to administrators, and no recipient address is collected.
      </p>
    </AdminPage>
  );
}
