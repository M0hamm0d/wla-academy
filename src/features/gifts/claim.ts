/**
 * A confirmed claim on a gift, httpOnly and SameSite=Lax: a secret issued only
 * after a correct gift code was entered (D-142, D-149), never the code itself.
 *
 * Path "/", not "/redeem". Next renders a server action's redirect target inside
 * the action's own request, so after signing in (a request to /login) a cookie
 * scoped to /redeem isn't sent, and the page would ask for the code again.
 * Holding it redeems nothing by itself: it needs a signed-in parent and their
 * own child.
 */
export const GIFT_CLAIM_COOKIE = "wla_gift_claim";
export const GIFT_CLAIM_COOKIE_PATH = "/";
export const GIFT_REDEEM_PATH = "/redeem";
export const GIFT_REDEEM_URL = "https://wla-academy-kappa.vercel.app/redeem";
/** Long enough to create an account and follow its confirmation email. */
export const GIFT_CLAIM_SECONDS = 24 * 60 * 60;
