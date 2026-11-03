// Journal publishing (D-147), for real. node scripts/browser/local/journeys-journal.mjs
// Creates its own editor, category and articles, and removes them at the end. Screenshots
// go to /tmp/wla-local-journeys.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { ACADEMY, RUN, browser, chk, closeAll, cleanup, ensureAccount, section, sleep, sql, summary } from "./driver.mjs";

const DIR = "/tmp/wla-local-journeys/journal";
mkdirSync(DIR, { recursive: true });
const SOURCE = new URL("../../../public/missions/six-names.jpg", import.meta.url).pathname;
const a = `${DIR}/a.png`, c = `${DIR}/c.jpg`;
execFileSync("sips", ["-s", "format", "png", "-Z", "900", SOURCE, "--out", a], { stdio: "ignore" });
execFileSync("sips", ["-s", "format", "jpeg", "-Z", "700", SOURCE, "--out", c], { stdio: "ignore" });

const slug = `e2e-${RUN}-first-light`, moved = `e2e-${RUN}-moved`, taken = `e2e-${RUN}-taken`;
const b = await browser("journal");
const articleWhere = (id) => sql(`select live_revision_id is not null, coalesce(working_revision_id=live_revision_id,false) from journal_articles where id='${id}'`);
const rev = (id, col) => sql(`select r.${col} from journal_revisions r join journal_articles a on a.working_revision_id=r.id where a.id='${id}'`);
const dialog = () => b.eval("!!document.querySelector('dialog[open]')");
const byLabel = (text, scope) => b.eval(`(() => {
  const root = ${scope === "dialog" ? "document.querySelector('dialog[open]')" : "document.querySelector('aside[aria-labelledby]:not([hidden])')"};
  const l = [...root.querySelectorAll('label')].find(x => x.textContent.trim() === ${JSON.stringify(text)});
  return l ? '#' + CSS.escape(l.htmlFor) : null; })()`);
const fillBy = async (text, value, scope = "side") => b.fill(await byLabel(text, scope), value);
const setSelect = async (text, value, scope = "side") => { const s = await byLabel(text, scope);
  await b.eval(`(() => { const el = document.querySelector(${JSON.stringify(s)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('change',{bubbles:true})); })()`); };
const valueOf = async (text, scope = "side") => b.eval(`document.querySelector(${JSON.stringify(await byLabel(text, scope))}).value`);
const pressEnter = async (sel) => b.eval(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
const typeBody = async (text) => { await b.eval(`document.querySelector('.ProseMirror').focus()`); await b.send("Input.insertText", { text }); await sleep(200); };
const quiet = async () => { for (let i = 0; i < 80; i++) { if (!/Uploading —/.test(await b.text())) return; await sleep(250); } };
const newArticle = async () => { await b.goto("/editorial"); await b.click(/new article/i); await b.waitUrl(/editorial\/articles\/[0-9a-f-]{36}/); await b.hydrated(); await sleep(700); return (await b.path()).split("/").pop(); };
const width = () => b.eval("document.documentElement.scrollWidth <= window.innerWidth");
const before = sql("select (select count(*) from journal_articles)||'/'||(select count(*) from journal_articles where live_revision_id is not null)||'/'||(select count(*) from journal_revisions)");
const created = [];

try {
  section("Setting up");
  const email = await ensureAccount(b, "journal-editor");
  sql(`update profiles set is_admin=true where id=(select id from auth.users where email='${email}')`);
  sql(`insert into journal_categories (name,slug,sort_order) values ('E2E Essays','e2e-${RUN}-essays',900)`);
  const catId = sql(`select id from journal_categories where slug='e2e-${RUN}-essays'`);

  section("The editor and Article Settings");
  const id = await newArticle(); created.push(id);
  chk("Article Settings is in view without opening anything", await b.eval("(() => { const h=[...document.querySelectorAll('h2')].find(x=>x.textContent==='Article Settings'); const r=h.getBoundingClientRect(); return r.width>0 && r.top<window.innerHeight; })()"));
  chk("the buttons say Save draft and Publish", (await b.has(/^save draft$/i)) && (await b.has(/^publish$/i)));
  await b.fill("textarea[name=title]", `E2E First Light ${RUN}`);
  await typeBody("A first paragraph, written for this journey.");
  chk("the web address follows the title", (await valueOf("Web address")) === `e2e-first-light-${RUN}`);
  await fillBy("Web address", slug);
  await setSelect("Category", catId);
  await fillBy("Tags", "Quiet Rooms"); await pressEnter(await byLabel("Tags"));
  await fillBy("Tags", "morning"); await pressEnter(await byLabel("Tags"));
  await sleep(200);
  chk("tags appear as they are added", /quiet rooms/.test(await b.text()) && /morning/.test(await b.text()));
  const sticky = await b.eval("(async () => { const a=document.querySelector('aside[aria-labelledby]'); window.scrollTo(0, 0); const before=a.getBoundingClientRect().top; return getComputedStyle(a).position + ':' + (before>=0); })()");
  chk("the sidebar is sticky on a wide screen", sticky.startsWith("sticky"));

  section("Save draft stays separate");
  await b.click(/^save draft$/i, { selector: "button" });
  chk("it says the draft saved", await b.waitText(/Draft saved at/));
  chk("no review opened", !(await dialog()));
  chk("the article isn't published", articleWhere(id).startsWith("f"));
  chk("the settings were saved", rev(id, "slug") === slug && rev(id, "category_id") === catId && rev(id, "tags") === "{morning,quiet-rooms}");

  section("The featured image");
  await b.setFile("aside input[type=file]", a); await sleep(400); await quiet();
  await b.waitText(/Image description/, 15000);
  chk("an uploaded featured image shows", await b.imageLoaded("/api/journal/media/"));
  await sleep(300);
  await b.click(/^save draft$/i, { selector: "button" });
  await sleep(1500);
  await b.waitText(/Saved|Draft saved at/);
  chk("a draft saves with the image and no description yet", rev(id, "featured_media_id") !== "" && rev(id, "featured_alt") === "" && !/Describe the featured image/.test(await b.text()));
  chk("still not published", articleWhere(id).startsWith("f"));
  await b.shot("journal-editor-desktop");

  section("The review");
  await b.click(/^publish$/i, { selector: "button" }); await sleep(300);
  chk("Publish opens the review", /Review Before Publishing/.test(await b.text()));
  chk("opening it publishes nothing", articleWhere(id).startsWith("f"));
  await b.shot("journal-review-desktop");
  const altSel = await byLabel("Image description", "dialog");
  chk("a featured image without a description holds it back", await b.eval("[...document.querySelectorAll('dialog[open] button')].find(x=>x.innerText==='Publish Article').disabled"));
  chk("and the field is marked", await b.eval(`document.querySelector(${JSON.stringify(altSel)}).getAttribute('aria-invalid')==='true'`));
  // Past the browser's check: the real server action, with the saved version that has no description.
  const server = await b.eval(`(async () => {
    const d=document.querySelector('dialog[open]'); const g=[...d.querySelectorAll('button')].find(x=>x.innerText==='Publish Article');
    const key=Object.keys(g).find(k=>k.startsWith('__reactProps')); g[key].disabled=false; g.disabled=false; g.removeAttribute('disabled');
    g[key].onClick(); await new Promise(r=>setTimeout(r,3000)); return document.querySelector('dialog[open]')?.innerText ?? ''; })()`);
  chk("forcing the button past the browser's check is refused by the server, publishing nothing", /Describe the featured image/.test(server) && articleWhere(id).startsWith("f") && /editorial\/articles/.test(await b.path()));
  await b.shot("journal-review-problem");
  await b.fill(altSel, "A stack of kraft cards");
  await fillBy("Excerpt", "Written in the review.", "dialog");
  await fillBy("Tags", "from review", "dialog"); await pressEnter(await byLabel("Tags", "dialog")); await sleep(200);
  await b.click(/^back to editing$/i, { selector: "dialog[open] button" }); await sleep(300);
  chk("Back to Editing closes it, publishing nothing", !(await dialog()) && articleWhere(id).startsWith("f"));
  chk("what was changed in the review is in the editor", (await b.eval("document.querySelector('input[name=excerpt]').value")) === "Written in the review." && /from review/.test(await b.text()) && (await valueOf("Image description")) === "A stack of kraft cards");
  chk("and is marked unsaved", /Unsaved changes/.test(await b.text()));
  chk("the article text is untouched", (await b.eval("document.querySelector('.ProseMirror').innerText")).includes("A first paragraph"));

  section("A refusal keeps everything");
  // A real refusal from the database: another article holds this web address.
  await b.click(/^save draft$/i, { selector: "button" }); await b.waitText(/Draft saved at/);
  created.push(sql(`insert into journal_articles (slug) values ('${taken}') returning id`));
  await fillBy("Web address", taken);
  await b.click(/^publish$/i, { selector: "button" }); await sleep(300);
  await b.click(/^publish article$/i, { selector: "dialog[open] button" });
  await b.waitText(/already uses that URL slug|Please correct/, 15000);
  chk("a taken web address is refused, without success or leaving", /editorial\/articles/.test(await b.path()) && !/published successfully/.test(await b.text()) && articleWhere(id).startsWith("f"));
  chk("the field is marked", await b.eval(`document.querySelector(${JSON.stringify(await byLabel("Web address", "dialog"))}).getAttribute('aria-invalid')==='true'`));
  await fillBy("Web address", slug, "dialog"); await sleep(200);
  chk("everything else is still there", (await valueOf("Title", "dialog")).startsWith("E2E First Light") && (await valueOf("Excerpt", "dialog")) === "Written in the review.");

  section("Publishing");
  await b.eval("(() => { const g=[...document.querySelectorAll('dialog[open] button')].find(x=>x.innerText==='Publish Article'); g.click(); g.click(); g.click(); })()");
  await sleep(60);
  chk("it goes to the Journal articles list", await b.waitUrl(/\/editorial(\?|$)/, 30000));
  chk("with the success message", await b.waitText(/Article published successfully\. Your article is now live on the Journal\./));
  await b.shot("journal-published-toast");
  chk("the address is tidied, so a reload won't repeat it", (await b.path()) === "/editorial");
  const row = await b.eval(`[...document.querySelectorAll('tr')].find(t => t.innerText.includes(${JSON.stringify(`E2E First Light ${RUN}`)}))?.innerText ?? ''`);
  chk("the list shows it as Published", /Published/.test(row), row);
  chk("the database agrees, published once", articleWhere(id).startsWith("t") && sql(`select count(*) from journal_audit where article_id='${id}' and action='published'`) === "1");
  const first = sql(`select first_published_at from journal_articles where id='${id}'`);
  const pub = await (await fetch(`${ACADEMY}/api/journal/articles/${slug}`)).json();
  chk("the public API serves it", JSON.stringify(pub).includes(`E2E First Light ${RUN}`));
  chk("with its image description and tags", JSON.stringify(pub).includes("A stack of kraft cards") && JSON.stringify(pub).includes("quiet-rooms"));
  await b.goto("/editorial");
  chk("a reload doesn't repeat the message", !/published successfully/.test(await b.text()));
  await b.goto(`/editorial?notice=published&article=${created[1]}`);
  chk("an address typed by hand can't announce it for an unpublished article", !/published successfully/.test(await b.text()));

  section("Updating what's published");
  await b.goto(`/editorial/articles/${id}`); await sleep(500);
  chk("the button says Update Article", await b.has(/^update article$/i));
  await b.fill("textarea[name=title]", `E2E First Light ${RUN} revised`);
  await b.click(/^save draft$/i, { selector: "button" });
  chk("Save draft on a published article saves", await b.waitText(/Saved as a new draft|Draft saved at/));
  chk("it stays published, readers keeping the live version", articleWhere(id) === "t|f" && !JSON.stringify(await (await fetch(`${ACADEMY}/api/journal/articles/${slug}`)).json()).includes("revised"));
  await b.click(/^update article$/i, { selector: "button" }); await sleep(300);
  chk("the review says it's an update", /Review Before Updating/.test(await b.text()) && /already published/.test(await b.text()));
  await b.shot("journal-review-update");
  chk("and offers Update Article, not Publish Article", (await b.has(/^update article$/i, "dialog[open] button")) && !(await b.has(/^publish article$/i, "dialog[open] button")));
  await fillBy("Web address", moved, "dialog"); await sleep(100);
  await b.click(/^update article$/i, { selector: "dialog[open] button" });
  chk("updating goes to the list, saying so", (await b.waitUrl(/\/editorial(\?|$)/, 30000)) && (await b.waitText(/Article updated successfully/)));
  chk("still published, with the same first-published date", articleWhere(id) === "t|t" && sql(`select first_published_at from journal_articles where id='${id}'`) === first);
  chk("the new web address is live", JSON.stringify(await (await fetch(`${ACADEMY}/api/journal/articles/${moved}`)).json()).includes("revised"));

  section("A new article with nothing in it");
  const blank = await newArticle(); created.push(blank);
  await b.click(/^publish$/i, { selector: "button" }); await sleep(300);
  chk("the missing details are listed", /Give it a title/.test(await b.text()) && /has no text/.test(await b.text()) && /needs a web address/.test(await b.text()));
  chk("and it can't be published", await b.eval("[...document.querySelectorAll('dialog[open] button')].find(x=>x.innerText==='Publish Article').disabled"));
  await b.click(/^go to this field$/i, { selector: "dialog[open] button" });
  chk("Go to this field goes there", await b.eval(`document.activeElement === document.querySelector(${JSON.stringify(await byLabel("Title", "dialog"))})`));
  await b.click(/^go to the article$/i, { selector: "dialog[open] button" }); await sleep(300);
  chk("Go to the article goes to the editor", !(await dialog()) && await b.eval("document.activeElement.classList.contains('ProseMirror')"));

  section("Leaving with unsaved changes");
  await b.fill("textarea[name=title]", "Unsaved words");
  await sleep(200);
  await b.click(/articles/i, { selector: "a[href='/editorial']", nth: 0 });
  chk("it asks first", await b.waitText(/Discard unsaved changes/, 5000));
  await b.click(/^keep editing$/i, { selector: "dialog[open] button" });
  chk("and keeps the words", (await b.eval("document.querySelector('textarea[name=title]').value")) === "Unsaved words");

  section("A smaller screen");
  await b.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(400);
  chk("no sideways scroll", await width());
  chk("settings are closed but one button away", (await b.has(/^article settings$/i)) && await b.eval("getComputedStyle(document.querySelector('aside[aria-labelledby]')).display==='none'"));
  await b.shot("journal-editor-mobile");
  await b.click(/^article settings$/i, { selector: "button" }); await sleep(300);
  chk("they open, with focus on the heading", await b.eval("document.activeElement.textContent==='Article Settings'"));
  await b.shot("journal-settings-mobile");
  await b.click(/close/i, { selector: "aside button[aria-label='Close article settings']" }); await sleep(200);
  await b.click(/^publish$/i, { selector: "button" }); await sleep(300);
  chk("the review fits a phone", await width());
  await b.shot("journal-review-mobile");
  const buttons = await b.eval("(() => { const d=document.querySelector('dialog[open]'); const r=[...d.querySelectorAll('button')].filter(x=>/Back to Editing|Publish Article/.test(x.innerText)).map(x=>x.getBoundingClientRect()); return r.every(x=>x.bottom<=window.innerHeight && x.height>=44); })()");
  chk("its two actions stay on screen, at a proper size", buttons);
} catch (e) {
  chk(`journey stopped: ${e.message}`, false);
  await b.shot("journal-failure").catch(() => {});
} finally {
  // Only what this run made. A published article's history is removed with it.
  const ids = created.map((x) => `'${x}'`).join(",");
  if (ids && !process.env.KEEP) {
    try {
      const paths = sql(`select storage_path from journal_media where article_id in (${ids})`);
      sql(`set session_replication_role = replica;
           delete from journal_media where article_id in (${ids});
           delete from journal_audit where article_id in (${ids});
           delete from journal_revisions where article_id in (${ids});
           delete from journal_article_members where article_id in (${ids});
           delete from journal_articles where id in (${ids});
           set session_replication_role = origin;
           delete from journal_categories where slug='e2e-${RUN}-essays';`);
      void paths;
      sql(`set storage.allow_delete_query = 'true'; delete from storage.objects where bucket_id='journal-media' and split_part(name,'/',1) in (${ids});`);
    } catch (e) { console.log("cleanup:", e.message.slice(0, 300)); }
  }
  if (!process.env.KEEP) cleanup();
  closeAll();
  const after = sql("select (select count(*) from journal_articles)||'/'||(select count(*) from journal_articles where live_revision_id is not null)||'/'||(select count(*) from journal_revisions)");
  chk(`the Journal is back as it was (${before})`, after === before, after);
}
process.exit(summary() ? 1 : 0);
