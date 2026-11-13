/**
 * The screen map and exploring as each role, against a local school site on this file's own port: two accounts (a teacher who
 * can open Grades and sees "Delete course", a student who cannot), course pages that are one screen, an application form whose
 * later fields depend on earlier answers, and a "never" note that keeps the crawl off a menu and a link.
 */
import http from "node:http";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import { BrowserSession, launchChromium } from "../src/engine/discovery/browser.js";
import { crawl, type CrawlResult } from "../src/engine/discovery/crawler.js";
import { rolePageBudget, surveyAccess } from "../src/engine/identity/access.js";
import { roleDifferences } from "../src/engine/identity/role-differences.js";
import { refusedBy } from "../src/engine/memory/notes.js";
import { buildScreenMap } from "../src/engine/screenmap/map.js";

const PORT = 9240;
const BASE = `http://127.0.0.1:${PORT}`;
const hits: string[] = [];
let server: http.Server;
let browser: Browser;

const html = (title: string, body = "") => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><nav><a href="/">Home</a> <a href="/courses">Courses</a></nav>${body}</body></html>`;
const who = (req: http.IncomingMessage) => /(?:^|;\s*)who=(teacher|student)/.exec(req.headers.cookie ?? "")?.[1];

const APPLY = html(
    "Apply",
    `<form action="/apply" method="post">
  <label for="role">Role</label><select id="role" name="role"><option value="student">Student</option><option value="other">Other</option></select>
  <div id="other" style="display:none"><label for="spec">Please specify</label><input id="spec" name="spec"></div>
  <label><input type="checkbox" id="ref" name="ref"> I have a referral</label>
  <span id="refbox"></span>
  <button type="submit">Send application</button>
</form>
<script>
document.getElementById("role").onchange = (e) => { document.getElementById("other").style.display = e.target.value === "other" ? "block" : "none"; };
document.getElementById("ref").onchange = (e) => { document.getElementById("refbox").innerHTML = e.target.checked ? '<label for="code">Referral code</label><input id="code" name="code">' : ""; };
</script>`,
);

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", BASE);
        const p = url.pathname;
        hits.push(p);
        const send = (body: string, status = 200) => {
            res.writeHead(status, { "content-type": "text/html" });
            res.end(body);
        };
        const role = who(req);
        if (p === "/login" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                const u = new URLSearchParams(body).get("username");
                const ok = (u === "teacher" || u === "student") && new URLSearchParams(body).get("password") === "pw";
                res.writeHead(302, { location: ok ? "/" : "/login", ...(ok ? { "set-cookie": `who=${u}; Path=/` } : {}) });
                res.end();
            });
            return;
        }
        if (p === "/login") return send(html("Sign in", `<form method="post" action="/login"><input name="username"><input type="password" name="password"><button type="submit">Sign in</button></form>`));
        if (p === "/") {
            const extra = role === "teacher" ? `<a href="/grades">Grades</a>` : "";
            return send(
                html(
                    "Home",
                    `${extra} <a href="/apply">Apply</a> <a href="/danger-zone">Wipe everything</a> <a href="/login">Sign in</a>
<button aria-expanded="false" id="tools">Admin tools</button><div id="toolbox"></div>
<script>document.getElementById("tools").onclick = () => { fetch("/hit/tools"); document.getElementById("toolbox").innerHTML = '<a href="/behind-tools">Tool page</a>'; };</script>`,
                ),
            );
        }
        if (p === "/courses") return send(html("Courses", `<a href="/course/algebra">Algebra</a> <a href="/course/biology">Biology</a> <a href="/course/chemistry">Chemistry</a>`));
        if (p.startsWith("/course/")) {
            const name = p.slice(8);
            return send(html(name[0]!.toUpperCase() + name.slice(1), `<p>Lessons</p><button>Enrol</button>${role === "teacher" ? "<button>Delete course</button>" : ""}<a href="/courses">All courses</a>`));
        }
        if (p === "/grades") return role === "teacher" ? send(html("Grades", "<table><tr><td>A</td></tr></table>")) : send(html("Forbidden"), 403);
        if (p === "/apply") return send(APPLY);
        if (p.startsWith("/hit/")) return send("ok");
        return send(html(p.slice(1) || "page"));
    });
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
    browser = await launchChromium(true);
}, 30_000);
afterAll(async () => {
    await browser?.close();
    await new Promise((r) => server?.close(r));
});

const context = (): EngineContext => ({ config: loadConfig({}), emit: () => undefined, llm: null }) as unknown as EngineContext;

describe("the screen map of a real crawl", () => {
    it("has the expected screens and transitions, and the form's conditional fields", async () => {
        const session = await BrowserSession.launch(browser, { startUrl: BASE });
        let r: CrawlResult;
        try {
            r = await crawl(session, context(), { startUrl: BASE, maxPages: 60, maxDepth: 4, maxPerPattern: 3 });
        } finally {
            await session.close();
        }
        const map = buildScreenMap(r);
        const keys = map.screens.map((s) => s.key);
        expect(keys).toEqual(expect.arrayContaining(["/", "/courses", "/course/{slug}", "/apply", "/login"]));
        expect(keys.filter((k) => k.startsWith("/course/"))).toEqual(["/course/{slug}"]);
        const edges = map.transitions.map((t) => `${t.from} -> ${t.to}: ${t.action}`);
        expect(edges).toEqual(expect.arrayContaining(["/ -> /courses: Courses", "/ -> /apply: Apply", "/courses -> /course/{slug}: Algebra", "/course/{slug} -> /courses: All courses"]));
        expect(map.conditional).toEqual(
            expect.arrayContaining([
                { screen: "/apply", when: "Role = Other", shows: ["Please specify"] },
                { screen: "/apply", when: "I have a referral ticked", shows: ["Referral code"] },
            ]),
        );
        // Choosing was all: the form was never sent.
        expect(hits.filter((h) => h === "/apply").length).toBeGreaterThan(0);
    }, 120_000);

    it("keeps away from a menu and a link a never-note names", async () => {
        hits.length = 0;
        const session = await BrowserSession.launch(browser, { startUrl: BASE });
        try {
            const refuse = refusedBy([{ text: "Never press Admin tools" }, { text: 'Never open "Wipe everything"' }]);
            const r = await crawl(session, context(), { startUrl: BASE, maxPages: 20, maxDepth: 2, maxPerPattern: 3, refuse });
            expect(r.pages.map((p) => p.path)).not.toContain("/danger-zone");
            expect(r.pages.map((p) => p.path)).not.toContain("/behind-tools");
        } finally {
            await session.close();
        }
        expect(hits).not.toContain("/hit/tools");
        expect(hits).not.toContain("/danger-zone");
    }, 120_000);
});

describe("exploring as each role", () => {
    it("crawls as each account within its share of the budget; reach differs as expected", async () => {
        const roles = [
            { name: "teacher", username: "teacher", password: "pw" },
            { name: "student", username: "student", password: "pw" },
        ];
        const share = rolePageBudget(40, roles.length);
        const crawled: Array<{ who: string; pages: number }> = [];
        const reach = await surveyAccess(context(), browser, BASE, roles, { maxPages: share, maxDepth: 4, perPattern: 3, onCrawl: (who, r) => crawled.push({ who, pages: r.pages.length }) });
        expect(share).toBe(20);
        expect(crawled.map((c) => c.who)).toEqual(["anonymous", "teacher", "student"]);
        for (const c of crawled) expect(c.pages).toBeLessThanOrEqual(share);
        const paths = (w: string) => reach.find((r) => r.who === w)!.pages.map((p) => p.path);
        expect(paths("teacher")).toContain("/grades");
        expect(paths("student")).not.toContain("/grades");
        const diff = roleDifferences(reach);
        expect(diff).toContain("“teacher” can open /grades (“Grades”); “student” did not reach it.");
        expect(diff.some((d) => /“teacher” sees “Delete course”; “student” does not/.test(d))).toBe(true);
    }, 180_000);
});
