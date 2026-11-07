// Headless Chrome over CDP for LOCAL journeys. No npm dependencies, and it reads
// no QA credentials: everything it signs in with, it created. Prints no secrets.
import { spawn, execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
export { sleep };

export const ACADEMY = process.env.BASE ?? "http://localhost:3000";
export const WEBSITE = process.env.WEBSITE ?? "http://localhost:8080";
export const SUPABASE = "http://127.0.0.1:55321";
export const MAILPIT = "http://127.0.0.1:55324";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = process.env.QA_OUT ?? "/tmp/wla-local-journeys";
mkdirSync(OUT, { recursive: true });

export const ENV = Object.fromEntries(
  readFileSync(new URL("../../../.env.development.local", import.meta.url), "utf8")
    .split("\n").filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")]; }),
);

export const RUN = process.env.RUN_ID ?? randomBytes(3).toString("hex");
export const emailFor = (who) => `e2e-${RUN}-${who}@wla-e2e.test`;
export const PASSWORD = `E2e-${randomBytes(12).toString("hex")}-a1`;

let passed = 0, failed = 0;
export function chk(label, ok, detail = "") {
  if (ok) { passed++; console.log(`PASS  ${label}`); }
  else { failed++; console.log(`FAIL  ${label}${detail ? ` :: ${String(detail).slice(0, 300)}` : ""}`); }
  return ok;
}
export function section(name) { console.log(`\n=== ${name}`); }
export function summary() { console.log(`\nPASS: ${passed}   FAIL: ${failed}`); return failed; }

// ------------------------------------------------------------------ database
export function sql(statement) {
  return execFileSync("docker", ["exec", "-i", "supabase_db_WLA", "psql", "-U", "postgres", "-d", "postgres", "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1"],
    { input: statement, encoding: "utf8", maxBuffer: 1 << 24 }).trim();
}

// ------------------------------------------------------------------- mailpit
export async function mailFor(address, subject, { after = 0, timeout = 25000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const res = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}&limit=50`)).json();
    const hit = (res.messages ?? []).find((m) => subject.test(m.Subject) && new Date(m.Created).getTime() >= after);
    if (hit) return (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json();
    await sleep(400);
  }
  return null;
}
export async function countMail(address, subject) {
  const res = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}&limit=100`)).json();
  return (res.messages ?? []).filter((m) => subject.test(m.Subject)).length;
}
export async function purgeMail() {
  const res = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${`e2e-${RUN}-`}"`)}&limit=500`)).json();
  const ids = (res.messages ?? []).filter((m) => m.To?.some((t) => t.Address.startsWith(`e2e-${RUN}-`))).map((m) => m.ID);
  if (ids.length) await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ IDs: ids }) });
}

// -------------------------------------------------------------------- stripe
export async function stripeGet(path) {
  for (let i = 0; ; i++) {
    try {
      return await (await fetch(`https://api.stripe.com/v1/${path}`, { headers: { Authorization: `Bearer ${ENV.STRIPE_SECRET_KEY}` } })).json();
    } catch (error) {
      if (i >= 5) throw error;
      await sleep(2000 * (i + 1));
    }
  }
}

/** Deliver a signed webhook to the local Academy, as Stripe would. */
export async function deliverWebhook(session, eventId = `evt_e2e_${RUN}_${randomBytes(4).toString("hex")}`) {
  const body = JSON.stringify({ id: eventId, object: "event", type: "checkout.session.completed", api_version: "2025-01-27", created: Math.floor(Date.now() / 1000), data: { object: session } });
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", ENV.STRIPE_WEBHOOK_SECRET).update(`${t}.${body}`).digest("hex");
  const res = await fetch(`${ACADEMY}/api/webhooks/stripe`, { method: "POST", headers: { "stripe-signature": `t=${t},v1=${v1}`, "Content-Type": "application/json" }, body });
  return { status: res.status, json: await res.json().catch(() => null), eventId };
}

// ------------------------------------------------------------------- browser
let nextPort = 9520;
const procs = [];
export function closeAll() {
  for (const p of procs) { try { p.proc.kill("SIGKILL"); } catch {} try { rmSync(p.dir, { recursive: true, force: true }); } catch {} }
}
export async function browser(name) {
  const port = nextPort++;
  const dir = `${OUT}/profile-${name}-${port}`;
  const proc = spawn(CHROME, [`--remote-debugging-port=${port}`, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${dir}`, "about:blank"], { stdio: "ignore" });
  procs.push({ proc, dir });
  let target;
  for (let i = 0; i < 80 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch {}
    if (!target) await sleep(250);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map();
  const send = (method, params = {}) => new Promise((res, rej) => {
    const n = ++id;
    const timer = setTimeout(() => { pending.delete(n); rej(new Error(`${method} timed out`)); }, 60000);
    pending.set(n, (m) => {
      clearTimeout(timer);
      if (m.error) rej(new Error(`${method}: ${m.error.message}`));
      else res(m.result);
    });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const requests = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
    else if (m.method === "Network.requestWillBeSent") requests.push(m.params.request.url);
  };
  await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable"); await send("DOM.enable");
  // Headless pages have no focus, and the clipboard API refuses without it.
  await send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });

  const b = {
    name, send, requests,
    async eval(expr) {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error("eval: " + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
      return r.result.value;
    },
    async goto(url, { wait = 500 } = {}) {
      await send("Page.navigate", { url: url.startsWith("http") ? url : ACADEMY + url });
      await sleep(250);
      const t0 = Date.now();
      while (Date.now() - t0 < 40000) {
        try { if ((await b.eval("document.readyState")) === "complete" && !/^\s*Loading/.test(await b.eval("document.body.innerText"))) break; } catch {}
        await sleep(200);
      }
      await b.hydrated();
      await sleep(wait);
    },
    async hydrated() {
      for (let i = 0; i < 100; i++) {
        try { if (await b.eval("(() => { const el = document.querySelector('form button, main button, main a, header a'); return !el || Object.keys(el).some(k => k.startsWith('__reactProps')); })()")) return; } catch {}
        await sleep(150);
      }
    },
    url: () => b.eval("location.href"),
    path: () => b.eval("location.pathname + location.search"),
    text: () => b.eval("document.body.innerText"),
    html: () => b.eval("document.documentElement.outerHTML"),
    async waitText(re, timeout = 25000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) { try { if (re.test(await b.text())) return true; } catch {} await sleep(200); }
      return false;
    },
    async waitUrl(re, timeout = 25000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) { try { if (re.test(await b.url())) return true; } catch {} await sleep(200); }
      return false;
    },
    async click(match, { selector = "button, a, label, [role=button]", nth = 0 } = {}) {
      const ok = await b.eval(`(() => {
        const rx = new RegExp(${JSON.stringify(match.source)}, ${JSON.stringify(match.flags)});
        const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(e => {
          const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && !e.disabled && rx.test((e.innerText || e.getAttribute('aria-label') || '').trim());
        });
        const el = els[${nth}]; if (!el) return false;
        el.scrollIntoView({block:'center'}); el.click(); return true;
      })()`);
      if (!ok) throw new Error(`click: nothing matches ${match} on ${await b.path()}: ${(await b.text()).slice(0, 300)}`);
      await sleep(200);
    },
    has: (match, selector = "button, a") => b.eval(`[...document.querySelectorAll(${JSON.stringify(selector)})].some(e => { const r = e.getBoundingClientRect(); return r.width > 0 && new RegExp(${JSON.stringify(match.source)}, ${JSON.stringify(match.flags)}).test((e.innerText||'').trim()); })`),
    async fill(selector, value) {
      const ok = await b.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false;
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true}));
        return true; })()`);
      if (!ok) throw new Error(`fill: no ${selector} on ${await b.path()}`);
    },
    /** Real keystrokes, for pages (Stripe) whose fields ignore synthetic events. */
    async type(selector, text) {
      if (!(await b.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView({block:'center'}); el.focus(); return true; })()`))) throw new Error(`type: no ${selector}`);
      await send("Input.insertText", { text });
      await sleep(150);
    },
    code: () => b.eval("document.querySelector('[data-testid=child-code]')?.innerText ?? null"),
    async setFile(selector, path) {
      const { root } = await send("DOM.getDocument", { depth: -1 });
      const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector });
      if (!nodeId) throw new Error("setFile: no " + selector);
      await send("DOM.setFileInputFiles", { nodeId, files: [path] });
    },
    async shot(name) {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, "base64"));
    },
    /** Does an image with this src fragment actually display? */
    imageLoaded: (fragment) => b.eval(`(async () => {
      for (let i = 0; i < 60; i++) {
        const img = [...document.images].find(x => decodeURIComponent(x.currentSrc || x.src).includes(${JSON.stringify(fragment)}));
        if (img) { img.scrollIntoView(); if (img.complete && img.naturalWidth > 0) return true; }
        await new Promise(r => setTimeout(r, 250));
      }
      return false; })()`),
  };
  return b;
}

// ------------------------------------------------------------------ accounts
/** A real signup through the page, confirmed from the email it sends. */
export async function signUp(b, who, next = "/account") {
  const email = emailFor(who);
  await b.goto(`/signup?next=${encodeURIComponent(next)}`);
  await b.fill("input[name=name]", `E2E ${who}`);
  await b.fill("input[name=email]", email);
  await b.fill("input[name=password]", PASSWORD);
  const started = Date.now() - 2000;
  await b.click(/create|sign up/i, { selector: "button[type=submit]" });
  const mail = await mailFor(email, /confirm/i, { after: started });
  if (!mail) throw new Error(`no confirmation mail for ${who}`);
  const link = (mail.Text.match(/https?:\/\/\S+/) ?? [])[0]?.replace(/&amp;/g, "&");
  if (!link) throw new Error(`no link in confirmation mail for ${who}`);
  await b.goto(link);
  return email;
}

/**
 * A ready account, for journeys not testing signup. The local auth service limits
 * signup emails per hour, which several journeys in a row can reach.
 */
export async function ensureAccount(b, who, next = "/account") {
  const email = emailFor(who);
  const res = await fetch(`${SUPABASE}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: ENV.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${ENV.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  if (!res.ok) throw new Error(`couldn't create ${who}: HTTP ${res.status}`);
  await signIn(b, email, next);
  // A dev server compiling after a code change can be slow to leave /login, or
  // miss the first try: wait for the redirect, and only then sign in again.
  for (let i = 0; i < 3; i++) {
    for (let t = 0; t < 20 && /\/login/.test(await b.path()); t++) await sleep(500);
    if (!/\/login/.test(await b.path())) break;
    await b.goto(`/login?next=${encodeURIComponent(next)}`);
    if (!/\/login/.test(await b.path())) break;
    await b.fill("input[name=email]", email);
    await b.fill("input[name=password]", PASSWORD);
    await b.click(/sign in|log in/i, { selector: "button[type=submit]" });
  }
  return email;
}

export async function signIn(b, email, next = "/account") {
  await b.goto(`/login?next=${encodeURIComponent(next)}`);
  await b.fill("input[name=email]", email);
  await b.fill("input[name=password]", PASSWORD);
  await b.click(/sign in|log in/i, { selector: "button[type=submit]" });
  await sleep(600);
}

export async function tokenFor(email) {
  const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  return (await res.json()).access_token;
}

export async function addChildPage(b, name) {
  await b.goto("/account/children/new");
  await b.fill("input[name=displayName]", name);
  await b.click(/add profile/i, { selector: "button[type=submit]" });
  await b.waitText(new RegExp(`${name} has been added`));
  return b.code();
}

export function childId(email, name) {
  return sql(`select c.id from child_profiles c join auth.users u on u.id=c.parent_id where u.email='${email}' and c.display_name='${name}'`);
}

/** Pay on Stripe's hosted test page with its published test card. */
export async function payOnStripe(b) {
  if (!(await b.waitUrl(/checkout\.stripe\.com/, 90000))) return { paid: false, reason: `never reached Stripe: ${await b.path()}` };
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) { if (await b.eval("!!document.querySelector('#cardNumber')")) break; await sleep(300); }
  if (!(await b.eval("!!document.querySelector('#cardNumber')"))) return { paid: false, reason: "no card field" };
  await b.type("#cardNumber", "4242424242424242");
  await b.type("#cardExpiry", "1234");
  await b.type("#cardCvc", "123");
  await b.type("#billingName", "E2E Test");
  if (await b.eval("!!document.querySelector('#billingPostalCode')")) await b.type("#billingPostalCode", "SW1A 1AA");
  // Stripe's optional "save my details" offer stays off.
  await b.eval("(() => { const c = document.querySelector('#enableStripePass'); if (c && c.checked) c.click(); })()");
  await b.eval("document.querySelector('button[type=submit], .SubmitButton').click()");
  const ok = await b.waitUrl(/localhost:3000/, 60000);
  return ok ? { paid: true } : { paid: false, reason: "no redirect back", text: (await b.text()).slice(0, 200) };
}

/** Stripe sessions and closure requests this run made, so cleanup can find them after their accounts are gone. */
export const made = { sessions: new Set(), deletions: new Set(), since: new Date().toISOString() };
// The deletion-ledger outbox (D-157) records every closure, hold and removal a
// run makes; cleanup removes what was recorded after this point. Like the
// Storage sweep, it assumes nothing else uses the local stack during a run.
const outbox = sql(`select to_regclass('public.privacy_ledger_outbox') is not null`) === "t";
made.outboxFrom = outbox ? Number(sql(`select coalesce(max(seq), 0) from privacy_ledger_outbox`)) : null;

/** Tick both checkout statements (D-152): payment can't start without them. */
export async function consent(b) {
  await b.click(/access to start as soon as my payment is confirmed/i, { selector: "label" });
  await b.click(/lose my right to cancel/i, { selector: "label" });
}

export function cleanup() {
  const like = `e2e-${RUN}-%@wla-e2e.test`;
  const sessions = [...made.sessions].map((s) => `'${s}'`).join(",") || "''";
  const deletions = [...made.deletions].map((d) => `'${d}'`).join(",") || "'00000000-0000-0000-0000-000000000000'";
  sql(`
    delete from mission_gifts where purchaser_id in (select id from auth.users where email like '${like}') or stripe_session_id in (${sessions}) or stripe_session_id like 'cs_e2e_${RUN}%';
    delete from checkout_intents where stripe_session_id in (${sessions}) or parent_id in (select id from auth.users where email like '${like}');
    delete from privacy_deletions where id in (${deletions});
    delete from gift_code_attempts where occurred_at >= '${made.since}';
    delete from stripe_events where id like 'evt_e2e_${RUN}%';
    delete from missions where slug like 'e2e-${RUN}-%';
    delete from auth.users where email like '${like}';
  `);
  if (made.outboxFrom !== null) sql(`delete from privacy_ledger_outbox where seq > ${made.outboxFrom}`);
}
