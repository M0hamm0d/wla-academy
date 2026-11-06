import { z } from "zod";

/**
 * Fail fast on misconfiguration — but fail SEPARATELY.
 *
 * The schemas are split by the service they configure, and that split is
 * load-bearing rather than tidiness. A single schema validating all five
 * variables together meant `createAdminClient()` threw when Stripe was
 * unconfigured, so **granting a FREE mission required Stripe credentials** —
 * a deployment offering only free missions could not grant access at all.
 *
 * `lib/email/send.ts` already reasoned its way to the same conclusion in the
 * other direction: "email must not become a hard requirement for payments to
 * work". Payments must equally not be a hard requirement for free access.
 *
 * Tech Spec §47: the service-role key must never reach the client, so it is
 * absent from `publicEnv` and these schemas are only read from server code.
 */

const supabaseSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
});

const stripeSchema = z.object({
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
});

const siteUrlSchema = z.string().url().transform((value) => {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) return "";
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") return "";
  return url.origin;
});

export type SupabaseServerEnv = z.infer<typeof supabaseSchema>;
export type StripeEnv = z.infer<typeof stripeSchema>;

function parse<T>(schema: z.ZodType<T>, what: string): T {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(
      `Missing or invalid ${what} environment variables: ${missing}. See .env.example.`,
    );
  }
  return result.data;
}

let supabaseCache: SupabaseServerEnv | null = null;
let stripeCache: StripeEnv | null = null;

/** Needed by anything that talks to Supabase with the service role. */
export function supabaseServerEnv(): SupabaseServerEnv {
  supabaseCache ??= parse(supabaseSchema, "Supabase");
  return supabaseCache;
}

/** Needed only where Stripe is genuinely involved. */
export function stripeEnv(): StripeEnv {
  stripeCache ??= parse(stripeSchema, "Stripe");
  return stripeCache;
}

/** Trusted server origin for payment redirects and absolute transactional links. */
export function siteUrl(): string {
  const result = siteUrlSchema.safeParse(process.env.SITE_URL);
  if (!result.success || !result.data) throw new Error("Missing or invalid SITE_URL environment variable. See .env.example.");
  return result.data;
}

export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
};
