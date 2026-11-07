// Access codes (D-143), for real. node scripts/browser/local/journeys-access.mjs
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { ACADEMY, ENV, SUPABASE, addChildPage, browser, childId, chk, cleanup, closeAll, purgeMail, section, signUp, sleep, sql, summary, tokenFor } from "./driver.mjs";

const parent = await browser("parent");
const kid = await browser("kid");
const other = await browser("other");
try {
  section("A parent's code");
  const email = await signUp(parent, "access-parent");
  const code = await addChildPage(parent, "Amina");
  chk("a new child gets a code, shown in the confirmation", /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code ?? ""));
  chk("the confirmation says it can be viewed again", /see it again from their profile/i.test(await parent.text()));
  const id = childId(email, "Amina");

  await parent.goto(`/account/children/${id}`);
  chk("the profile's page HTML doesn't hold the code", !(await parent.html()).includes(code));
  chk("nor does its address", !(await parent.url()).includes(code));
  chk("the database holds only ciphertext", sql(`select code_ciphertext like 'v1.%' and position('${code.replace("-", "")}' in code_ciphertext||code_hash||code_lookup)=0 from child_access_credentials where child_id='${id}' and revoked_at is null`) === "t");
  await parent.click(/^show access code$/i);
  await parent.waitText(/access code\./);
  chk("Show access code displays the active code", (await parent.code()) === code);
  await parent.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], origin: ACADEMY }).catch(() => {});
  await parent.click(/^copy code$/i);
  await sleep(400);
  const said = await parent.eval("document.querySelector('[data-testid=child-code]').parentElement.innerText");
  chk("Copy says it copied", said.includes("Copied."), said.replace(code, "[code]"));
  chk("and the clipboard holds the code", (await parent.eval("navigator.clipboard.readText()").catch(() => null)) === code);
  chk("the code isn't kept in browser storage", !(await parent.eval("JSON.stringify(Object.values(localStorage)) + JSON.stringify(Object.values(sessionStorage))")).includes(code));
  chk("a view is recorded", sql(`select code_last_viewed_at is not null from child_access_credentials where child_id='${id}' and revoked_at is null`) === "t");

  section("The child, with that code");
  const childLogin = async (c) => {
    await kid.send("Network.clearBrowserCookies");
    await kid.goto("/child/login");
    await kid.fill("input[name=code]", c);
    await kid.click(/./, { selector: "form button[type=submit]" });
    await sleep(1500);
    return kid.path();
  };
  const landed = await childLogin(code);
  chk("the code signs the child in", /\/academy/.test(landed), landed);

  section("Replacing it");
  await parent.goto(`/account/children/${id}`);
  await parent.click(/^generate new access code$/i);
  const dialog = await parent.text();
  chk("the confirmation says the code stops working at once", /stop working immediately/.test(dialog));
  chk("that the child is signed out", /signed out/.test(dialog));
  chk("and that the new code must be shared", /give Amina the new code/.test(dialog));
  await parent.click(/^keep the current code$/i);
  chk("cancelling closes it", !/stop working immediately/.test(await parent.text()));
  chk("cancelling replaced nothing", sql(`select count(*) from child_access_credentials where child_id='${id}'`) === "1");
  await kid.goto("/academy/my-missions");
  chk("and the child stays signed in", /\/academy\/my-missions/.test(await kid.path()));

  await parent.click(/^generate new access code$/i);
  await parent.click(/^replace the code$/i, { selector: "dialog button" });
  await parent.waitText(/old code has stopped working/);
  const fresh = await parent.code();
  chk("confirming shows a different code", fresh && fresh !== code);
  await kid.goto("/academy/my-missions");
  chk("the child's session has ended", !/\/academy\/my-missions/.test(await kid.path()), await kid.path());
  const oldTry = await childLogin(code);
  chk("the old code no longer works", /\/child\/login/.test(oldTry) && /(didn.t|isn.t|not).*(work|right|recogn|valid)|check/i.test(await kid.text()), await kid.text());
  chk("the new code works", /\/academy/.test(await childLogin(fresh)));
  await parent.goto(`/account/children/${id}`);
  await parent.click(/^show access code$/i);
  await parent.waitText(/access code\./);
  chk("the new code can be shown again after leaving the page", (await parent.code()) === fresh);

  section("A code from before this feature");
  sql(`update child_access_credentials set code_ciphertext=null where child_id='${id}' and revoked_at is null`);
  await parent.goto(`/account/children/${id}`);
  chk("it says how to make it viewable", /Replace this code to be able to view it\./.test(await parent.text()));
  chk("with no Show button", !(await parent.has(/^show access code$/i)));
  chk("and it still signs in", /\/academy/.test(await childLogin(fresh)));

  section("Everyone else");
  const otherEmail = await signUp(other, "access-other");
  await other.goto(`/account/children/${id}`);
  chk("another parent can't open the profile", /not found|404/i.test(await other.text()) && !(await other.has(/access code/i)), (await other.text()).slice(0, 200));
  const token = await tokenFor(otherEmail);
  const rest = (path, init = {}) => fetch(`${SUPABASE}/rest/v1/${path}`, { ...init, headers: { apikey: ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers } });
  chk("a parent's API token can't select the ciphertext", (await rest("child_access_credentials?select=code_ciphertext")).status >= 400);
  chk("nor call the read function", (await rest("rpc/read_child_code_copy", { method: "POST", body: JSON.stringify({ p_child_id: id, p_parent_id: id }) })).status >= 400);
  const anon = await fetch(`${SUPABASE}/rest/v1/child_access_credentials?select=code_ciphertext`, { headers: { apikey: ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY } });
  chk("nor can an anonymous one", anon.status >= 400);

  section("Rotating the key, for real");
  sql(`update child_access_credentials set revoked_at=now() where child_id='${id}' and revoked_at is null`);
  await parent.goto(`/account/children/${id}`);
  await parent.click(/^create an access code$/i);
  await parent.waitText(/can see it again/);
  const rotated = await parent.code();
  const before = sql(`select code_ciphertext from child_access_credentials where child_id='${id}' and revoked_at is null`);
  chk("a viewable code exists to rotate", Boolean(rotated && before));
  const OLD = ENV.CHILD_CODE_ENCRYPTION_KEY;
  const NEW = randomBytes(32).toString("base64");
  const rotate = (current, previous) => JSON.parse(execFileSync("node", ["scripts/rotate-child-code-key.ts"], {
    cwd: new URL("../../../", import.meta.url).pathname, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: SUPABASE, SUPABASE_SERVICE_ROLE_KEY: ENV.SUPABASE_SERVICE_ROLE_KEY, CHILD_CODE_ENCRYPTION_KEY: current, CHILD_CODE_ENCRYPTION_KEY_PREVIOUS: previous },
  })).children; // the script also re-seals purchasers' gift-code copies (D-149), reported separately
  const first = rotate(NEW, OLD);
  chk("rotating re-encrypts under the new key, with nothing unreadable or failed", first.moved >= 1 && first.unreadable === 0 && first.failed === 0, JSON.stringify(first));
  const during = sql(`select code_ciphertext from child_access_credentials where child_id='${id}' and revoked_at is null`);
  chk("the copy changed and its key id changed", during !== before && during.split(".")[1] !== before.split(".")[1]);
  await parent.goto(`/account/children/${id}`);
  await parent.click(/^show access code$/i);
  await parent.waitText(/can't show this code|access code\./);
  chk("a server without the new key says the code still works, and shows nothing", /still works/.test(await parent.text()) && !(await parent.code()));
  const rerun = rotate(NEW, OLD);
  chk("running it again changes nothing", rerun.moved === 0 && rerun.already === first.moved + first.already, JSON.stringify(rerun));
  const back = rotate(OLD, NEW);
  chk("rotating back works the same way", back.moved >= 1 && back.failed === 0 && back.unreadable === 0, JSON.stringify(back));
  await parent.goto(`/account/children/${id}`);
  await parent.click(/^show access code$/i);
  await parent.waitText(/access code\./);
  chk("and the same code shows again", (await parent.code()) === rotated);
} finally {
  closeAll();
  await purgeMail().catch(() => {});
  if (!process.env.KEEP) cleanup();
}
process.exit(summary() ? 1 : 0);
