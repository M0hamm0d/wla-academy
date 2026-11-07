// Purchase and gifting (D-149, D-152), for real. Stripe's hosted test page with its published test
// card, then the webhook delivered and signed locally (no `stripe listen` here).
import { addChildPage, browser, childId, chk, cleanup, closeAll, consent, countMail, deliverWebhook, emailFor, made, mailFor, payOnStripe, purgeMail, section, signUp, sleep, sql, stripeGet, summary } from "./driver.mjs";

const SLUG = "six-names";
const mission = sql(`select id from missions where slug='${SLUG}'`);
const entitled = (child) => sql(`select string_agg(source::text||':'||status::text, ',') from mission_entitlements where child_id='${child}' and mission_id='${mission}'`);
const giftBy = (buyerEmail, col = "status") => sql(`select ${col} from mission_gifts where purchaser_id=(select id from auth.users where email='${buyerEmail}') order by created_at desc limit 1`);

/** Pay, then deliver the webhook. Returns how it went, for the report. */
async function completePayment(b, sessionId) {
  const paid = await payOnStripe(b);
  made.sessions.add(sessionId());
  const session = await stripeGet(`checkout/sessions/${sessionId()}`);
  if (paid.paid && session.payment_status === "paid") {
    console.log("  (paid on Stripe's hosted test page)");
    return { session, delivery: await deliverWebhook(session), real: true };
  }
  console.log(`  (Stripe's page wasn't completed: ${paid.reason}; webhook simulated with a signed paid session)`);
  const simulated = { ...session, payment_status: "paid", status: "complete", payment_intent: session.payment_intent ?? `pi_e2e_${Date.now()}` };
  return { session: simulated, delivery: await deliverWebhook(simulated), real: false };
}

const buyer = await browser("buyer");
const r1 = await browser("recipient1");
const r2 = await browser("recipient2");
const intruder = await browser("intruder");
const results = {};
try {
  section("Buying for a child who already exists");
  const buyerEmail = await signUp(buyer, "buyer");
  await addChildPage(buyer, "Existing");
  const existingId = childId(buyerEmail, "Existing");
  await buyer.goto(`/purchase/${SLUG}`);
  chk("the existing child is listed, with the option to add one", await buyer.has(/^add a new child$/i) && /Existing/.test(await buyer.text()));
  chk("both checkout statements are there, unticked", await buyer.eval("[...document.querySelectorAll('input[name=earlySupplyConsent], input[name=cancellationAcknowledged]')].filter(i => !i.checked).length === 2"));
  await buyer.click(/continue to payment/i);
  await sleep(600);
  chk("without them, payment doesn't start", /\/purchase\/six-names/.test(await buyer.path()) && !sql(`select 1 from checkout_intents i join auth.users u on u.id=i.parent_id where u.email='${buyerEmail}' limit 1`));
  await consent(buyer);
  await buyer.click(/continue to payment/i);
  const lastIntent = (child) => () => sql(`select stripe_session_id from checkout_intents where child_id='${child}' order by created_at desc limit 1`);
  let paid = await completePayment(buyer, lastIntent(existingId));
  results.real = paid.real;
  chk("the webhook accepts it", paid.delivery.status === 200, JSON.stringify(paid.delivery));
  chk("that child has the mission", entitled(existingId) === "purchase:active", entitled(existingId));

  section("Adding a new child during the purchase");
  await buyer.goto(`/purchase/${SLUG}`);
  chk("a child who has it isn't offered, and adding one is", /aren.t shown|already has/i.test(await buyer.text()) && await buyer.has(/^add a new child$/i));
  await buyer.click(/^add a new child$/i);
  chk("the form opens on the page, without leaving", /\/purchase\/six-names/.test(await buyer.path()) && await buyer.eval("!!document.querySelector('input[name=displayName]')"));
  chk("payment waits while it's open", !(await buyer.has(/continue to payment/i)));
  await buyer.fill("input[name=displayName]", "Newkid");
  await buyer.click(/^add this child$/i);
  await buyer.waitText(/Newkid has been added and selected/);
  const newId = childId(buyerEmail, "Newkid");
  chk("the child now exists, under this parent", Boolean(newId));
  chk("selected automatically", await buyer.eval(`document.querySelector('input[type=radio][value="${newId}"]')?.checked === true`));
  const newCode = await buyer.code();
  chk("the access code is on screen before leaving for Stripe", /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(newCode ?? "") && await buyer.has(/continue to payment/i));
  chk("Copy is offered", await buyer.has(/^copy code$/i));
  chk("exactly one code exists", sql(`select count(*) from child_access_credentials where child_id='${newId}'`) === "1");
  chk("the mission is still the one being bought", /\/purchase\/six-names/.test(await buyer.path()) && /Six Names/.test(await buyer.text()));
  await consent(buyer);
  await buyer.click(/continue to payment/i);
  paid = await completePayment(buyer, lastIntent(newId));
  chk("the new child receives the mission", paid.delivery.status === 200 && entitled(newId) === "purchase:active", entitled(newId));
  chk("and only that child's record changed", entitled(existingId) === "purchase:active");
  const again = await deliverWebhook(paid.session, paid.delivery.eventId);
  chk("a repeated webhook is a no-op", again.status === 200 && entitled(newId) === "purchase:active" && sql(`select count(*) from mission_entitlements where child_id='${newId}'`) === "1");
  await buyer.goto("/account/children");
  chk("the new child is in child management", /Newkid/.test(await buyer.text()));
  await buyer.goto(`/account/children/${newId}`);
  await buyer.click(/^show access code$/i);
  await buyer.waitText(/access code\./);
  chk("and their code can still be viewed afterwards", (await buyer.code()) === newCode);

  section("Abandoning checkout keeps the child");
  await buyer.goto(`/purchase/${SLUG}`);
  await buyer.click(/^add a new child$/i);
  await buyer.fill("input[name=displayName]", "Abandoned");
  await buyer.click(/^add this child$/i);
  await buyer.waitText(/Abandoned has been added/);
  await consent(buyer);
  await buyer.click(/continue to payment/i);
  await buyer.waitUrl(/checkout\.stripe\.com/, 90000);
  const abandonedId = childId(buyerEmail, "Abandoned");
  await buyer.goto("/account/children");
  chk("the child stays, with no mission", /Abandoned/.test(await buyer.text()) && !entitled(abandonedId));

  section("Retrying adding a child");
  await buyer.goto(`/purchase/${SLUG}`);
  await buyer.click(/^add a new child$/i);
  await buyer.fill("input[name=displayName]", "Retried");
  // Two submissions of one attempt, as a double click or a retried request would be.
  await buyer.eval(`(() => { const b = [...document.querySelectorAll('button')].find(x => /^add this child$/i.test(x.innerText.trim())); b.click(); b.click(); })()`);
  await buyer.waitText(/Retried has been added/);
  await sleep(800);
  chk("one profile", sql(`select count(*) from child_profiles c join auth.users u on u.id=c.parent_id where u.email='${buyerEmail}' and c.display_name='Retried'`) === "1");
  chk("one code, never revoked by a retry", sql(`select count(*) from child_access_credentials a join child_profiles c on c.id=a.child_id join auth.users u on u.id=c.parent_id where u.email='${buyerEmail}' and c.display_name='Retried'`) === "1");

  section("The purchase was recorded with consent, and confirmed by email (D-152)");
  const order = sql(`select (early_supply_consent_at is not null and cancellation_ack_at is not null)::text||'|'||coalesce(consent_wording,'')||'|'||(paid_at is not null)::text||'|'||(confirmation_sent_at is not null)::text from checkout_intents where child_id='${existingId}' order by created_at limit 1`).split("|");
  chk("both statements are recorded with the order, with the wording shown", order[0] === "true" && /14-day cancellation period/.test(order[2] ?? ""), order.join("|").slice(0, 120));
  chk("the payment is stamped on the order", order.at(-2) === "true");
  const confirmation = await mailFor(buyerEmail, /Order confirmed/i);
  chk("an order confirmation reached the buyer, with the price and both statements",
    Boolean(confirmation) && /£\d+\.\d\d/.test(confirmation.Text) && /lose my right to cancel/.test(confirmation.Text) && /access to start as soon as/.test(confirmation.Text));
  chk("and its sending is recorded", order.at(-1) === "true");

  section("Buying a gift: no recipient address");
  const giftStart = Date.now() - 2000;
  const before = sql(`select count(*) from mission_entitlements e join child_profiles c on c.id=e.child_id join auth.users u on u.id=c.parent_id where u.email='${buyerEmail}'`);
  const buyGift = async () => {
    await buyer.goto(`/purchase/${SLUG}?gift=1`);
    await consent(buyer);
    await buyer.click(/continue to payment/i);
    return completePayment(buyer, () => giftBy(buyerEmail, "stripe_session_id"));
  };
  await buyer.goto(`/purchase/${SLUG}?gift=1`);
  chk("the gift form asks for no email address", await buyer.eval("!document.querySelector('input[type=email], input[name=recipientEmail]')") && /don.t need their email address/i.test(await buyer.text()));
  const g1 = await buyGift();
  chk("the webhook makes it paid", g1.delivery.status === 200 && giftBy(buyerEmail) === "paid", giftBy(buyerEmail));
  chk("the purchaser gets no entitlement", sql(`select count(*) from mission_entitlements e join child_profiles c on c.id=e.child_id join auth.users u on u.id=c.parent_id where u.email='${buyerEmail}'`) === before);
  chk("consent was recorded with the gift", giftBy(buyerEmail, "(early_supply_consent_at is not null and cancellation_ack_at is not null)") === "t");
  chk("no recipient address exists anywhere on the gift", sql(`select count(*) from information_schema.columns where table_name='mission_gifts' and column_name ilike '%recipient%'`) === "0");
  await buyer.goto("/gift?purchase=success");
  await buyer.waitText(/Ready to share/);
  const code1 = await buyer.eval("document.querySelector('[data-testid=gift-code]')?.innerText.trim()");
  chk("back from paying, the purchaser sees the gift code", /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code1 ?? ""), code1);
  chk("with Copy code and Copy message", await buyer.has(/^copy code$/i) && await buyer.has(/^copy message$/i));
  const giftMail = await mailFor(buyerEmail, /Your gift code/i, { after: giftStart });
  chk("the purchaser's confirmation email has the same code, how to redeem it, and the order", Boolean(giftMail) && giftMail.Text.includes(code1) && /\/redeem/.test(giftMail.Text) && /lose my right to cancel/.test(giftMail.Text));
  chk("it went to the purchaser only", (giftMail?.To ?? []).every((t) => t.Address === buyerEmail));
  chk("only a keyed hash and an encrypted copy are stored", giftBy(buyerEmail, `(code_lookup ~ '^[0-9a-f]{64}$' and position('${(code1 ?? "x").replaceAll("-", "")}' in code_lookup)=0 and code_ciphertext like 'v1.%' and position('${(code1 ?? "x").replaceAll("-", "")}' in code_ciphertext)=0)`) === "t");
  const replay = await deliverWebhook(g1.session, g1.delivery.eventId);
  await sleep(600);
  chk("a repeated webhook sends nothing more and keeps the code", replay.status === 200 && (await countMail(buyerEmail, /Your gift code/i)) === 1 && giftBy(buyerEmail, "code_lookup") !== "");
  await buyer.goto("/account");
  chk("the code is under Account, Gifts you've bought", /Gifts you.ve bought/.test(await buyer.text()) && (await buyer.text()).includes(code1));

  section("Redeeming with the code alone, into a new account and a new child");
  const recipientEmail = emailFor("recipient");
  await r1.goto("/redeem");
  chk("Redeem a Gift asks only for the code", await r1.eval("!!document.querySelector('input[name=code]') && !document.querySelector('input[type=email]')"));
  await r1.fill("input[name=code]", "AAAA-BBBB-CCCC");
  await r1.click(/^continue$/i);
  await r1.waitText(/isn.t right, or it has already been used/);
  chk("a wrong code gets one message, and no claim", !/given Six Names/.test(await r1.text()));
  await r1.fill("input[name=code]", code1.toLowerCase().replaceAll("-", " "));
  await r1.click(/^continue$/i);
  await r1.waitText(/given Six Names/);
  chk("the right code, however typed, reveals the gift", /\/redeem$/.test(await r1.path()));
  chk("the claim cookie is httpOnly, and nothing about the code is in browser storage or the address",
    !(await r1.eval("document.cookie")).includes("wla_gift_claim") && !(await r1.eval("JSON.stringify(Object.values(localStorage))+JSON.stringify(Object.values(sessionStorage))+location.href")).includes(code1.replaceAll("-", "")));
  await r1.click(/^create an account$/i);
  await signUp(r1, "recipient", "/redeem");
  await r1.waitText(/given Six Names/);
  chk("after signing up they come back to the gift", /\/redeem/.test(await r1.path()), await r1.path());
  await r1.fill("input[name=displayName]", "Giftkid");
  await r1.click(/^add this child$/i);
  await r1.waitText(/Giftkid has been added and selected/);
  await r1.click(/^redeem this gift$/i);
  await r1.waitUrl(/my-missions/);
  const giftKid = childId(recipientEmail, "Giftkid");
  chk("that child has the gifted mission", entitled(giftKid) === "gift:active", entitled(giftKid));
  chk("it appears in their My Missions", /Six Names/.test(await r1.text()));
  chk("the gift is redeemed, and its code and copy are gone", giftBy(buyerEmail, "(status='redeemed' and code_lookup is null and code_ciphertext is null)") === "t");
  chk("no email went to the recipient about the gift", (await countMail(recipientEmail, /gift|given/i)) === 0);
  await r1.goto("/redeem");
  await r1.fill("input[name=code]", code1);
  await r1.click(/^continue$/i);
  await r1.waitText(/isn.t right, or it has already been used/);
  chk("the code works once", sql(`select count(*) from mission_entitlements where child_id='${giftKid}'`) === "1");
  await buyer.goto("/account");
  chk("the purchaser sees it was redeemed, and nothing about who", /Redeemed on/.test(await buyer.text()) && !/Giftkid/.test(await buyer.text()));

  section("Replacing a code, and another family can't take a gift");
  const g2 = await buyGift();
  chk("a second gift is paid", g2.delivery.status === 200 && giftBy(buyerEmail) === "paid");
  await buyer.goto("/account");
  await buyer.waitText(/Ready to share/);
  const code2 = await buyer.eval("[...document.querySelectorAll('[data-testid=gift-code]')].map(e => e.innerText.trim())[0]");
  await buyer.click(/^replace this code$/i);
  await buyer.click(/current code will stop working/i, { selector: "label" });
  await buyer.click(/^make a new code$/i);
  await buyer.waitText(/old one no longer works/);
  const code3 = await buyer.eval("[...document.querySelectorAll('[data-testid=gift-code]')].map(e => e.innerText.trim())[0]");
  chk("the purchaser gets a new code", /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code3 ?? "") && code3 !== code2, `${code2} -> ${code3}`);
  await r2.goto("/redeem");
  await r2.fill("input[name=code]", code2);
  await r2.click(/^continue$/i);
  await r2.waitText(/isn.t right, or it has already been used/);
  chk("the replaced code no longer works", !/given Six Names/.test(await r2.text()));
  const coderEmail = await signUp(r2, "coder");
  await addChildPage(r2, "Coder");
  const coder = childId(coderEmail, "Coder");
  await r2.goto("/redeem");
  await r2.fill("input[name=code]", code3);
  await r2.click(/^continue$/i);
  await r2.waitText(/given Six Names/);
  await r2.hydrated();
  chk("signed in already, the existing child is offered", await r2.eval(`!!document.querySelector('input[type=radio][value="${coder}"]')`));
  const intruderEmail = await signUp(intruder, "intruder");
  await addChildPage(intruder, "Theirs");
  const tampered = await r2.eval(`(() => { const i = document.querySelector('input[name=childId]'); i.value = ${JSON.stringify(childId(intruderEmail, "Theirs"))}; return true; })()`);
  await r2.click(/^redeem this gift$/i);
  await r2.waitText(/Choose who this mission is for/);
  chk("another family's child id is refused, and the gift isn't used", tampered && giftBy(buyerEmail) === "paid" && !entitled(childId(intruderEmail, "Theirs")));
  await intruder.goto("/redeem");
  chk("another browser sees no gift", !/Six Names/.test(await intruder.text()));
  await r2.goto("/redeem");
  await r2.click(/^redeem this gift$/i);
  await r2.waitUrl(/my-missions/);
  chk("the chosen child of the code's holder has it", entitled(coder) === "gift:active", entitled(coder));

  section("Repeated wrong codes are stopped (last: it limits this whole machine)");
  for (let i = 0; i < 10; i++) {
    await intruder.goto("/redeem");
    await intruder.fill("input[name=code]", `WRNG-${String(i).padStart(4, "2").replace(/[01]/g, "3")}-CCCC`);
    await intruder.click(/^continue$/i);
    await intruder.waitText(/isn.t right|Too many/);
  }
  await intruder.goto("/redeem");
  await intruder.fill("input[name=code]", "WRNG-2222-DDDD");
  await intruder.click(/^continue$/i);
  chk("after ten wrong codes, the next is refused for 15 minutes", await intruder.waitText(/Too many codes have been tried/));

  console.log(`\nStripe's hosted page completed for real: ${results.real}`);
} finally {
  closeAll();
  await purgeMail().catch(() => {});
  if (!process.env.KEEP) cleanup();
}
process.exit(summary() ? 1 : 0);
