/**
 * A small site for "reuse earlier runs" (memory/probe-reuse.ts): six pages whose probes are observable from the server.
 *   /  /a  /b  /c  /d  /e     every page: a heading, a form with an e-mail field (its own validation message, shown when the field is
 *                            left with an invalid value) and a "More" toggle (aria-expanded) that calls GET /api/more/<page> when opened
 *                            and then shows a link to /a. /a's form also has a drop-down whose "Business" choice shows a Company field.
 *   /members/enter           the sign-in form (linked from nowhere, at no usual sign-in address); /members after signing in.
 * `more` counts the toggle calls per page: a page whose probes ran opened its toggle; a page whose probe results were reused did not.
 * `message[page]` and `heading[page]` change a page between runs: a new validation message keeps the page's fingerprints (only a spot
 * check can see it); a new heading changes them.
 * Account: reuser@example.test / Reuse-Pass-4471
 */
import http from "node:http";

export const REUSE_SITE_USER = { email: "reuser@example.test", password: "Reuse-Pass-4471" };
export const REUSE_PAGES = ["/", "/a", "/b", "/c", "/d", "/e"] as const;

export interface ReuseSite {
    server: http.Server;
    more: Map<string, number>;
    message: Record<string, string>;
    heading: Record<string, string>;
    /** Sign-ins sent to the form. */
    signIns: number;
    reset(): void;
}

const name = (p: string) => (p === "/" ? "home" : p.slice(1));

function page(p: string, site: ReuseSite): string {
    const n = name(p);
    const links = REUSE_PAGES.filter((x) => x !== p && x !== "/")
        .map((x) => `<a href="${x}">Page ${name(x)}</a>`)
        .join(" ");
    const select =
        p === "/a"
            ? `<label for="kind">Kind</label><select id="kind" name="kind"><option value="">Choose</option><option value="private">Private</option><option value="business">Business</option></select><span id="company-wrap" hidden><label for="company">Company</label><input id="company" name="company"></span>`
            : "";
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Reuse ${n}</title></head><body>
<main>
<h1>${site.heading[p] ?? `Page ${n}`}</h1>
<nav aria-label="Main"><a href="/">Home</a> ${links}</nav>
<button id="more" aria-expanded="false" aria-controls="more-panel">More</button><div id="more-panel"></div>
<form id="f" onsubmit="return false"><label for="email">Contact e-mail</label><input id="email" name="email" type="email" aria-describedby="email-msg"><span id="email-msg"></span>${select}</form>
</main>
<script>
document.getElementById("more").addEventListener("click", async (e) => {
  const b = e.currentTarget; b.setAttribute("aria-expanded", "true");
  await fetch("/api/more/${n}");
  document.getElementById("more-panel").innerHTML = '<ul><li><a href="/a">More about a</a></li></ul>';
});
document.getElementById("email").addEventListener("blur", (e) => {
  document.getElementById("email-msg").textContent = e.target.validity.valid ? "" : ${JSON.stringify(site.message[p] ?? `Enter a valid e-mail for ${n}`)};
});
const kind = document.getElementById("kind");
if (kind) kind.addEventListener("change", () => { document.getElementById("company-wrap").hidden = kind.value !== "business"; });
</script></body></html>`;
}

export function startReuseSite(port: number): Promise<ReuseSite> {
    const site: ReuseSite = {
        server: undefined as never,
        more: new Map(),
        message: {},
        heading: {},
        signIns: 0,
        reset() {
            site.more.clear();
            site.message = {};
            site.heading = {};
            site.signIns = 0;
        },
    };
    site.server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        const p = url.pathname;
        const authed = (req.headers.cookie ?? "").includes("member=ok");
        if (p.startsWith("/api/more/")) {
            const n = p.slice("/api/more/".length);
            site.more.set(n, (site.more.get(n) ?? 0) + 1);
            res.writeHead(200, { "content-type": "application/json" });
            return void res.end(JSON.stringify({ ok: true }));
        }
        if (p === "/members/enter" && req.method === "POST") {
            let body = "";
            req.on("data", (d) => (body += d));
            req.on("end", () => {
                site.signIns++;
                const f = new URLSearchParams(body);
                if (f.get("email") === REUSE_SITE_USER.email && f.get("password") === REUSE_SITE_USER.password) {
                    res.writeHead(302, { location: "/members", "set-cookie": "member=ok; Path=/; HttpOnly" });
                    return void res.end();
                }
                res.writeHead(401, { "content-type": "text/html" });
                res.end(`<!doctype html><html><body><h1>Members</h1><p role="alert">Wrong e-mail or password</p><form method="post"><input name="email" type="email"><input name="password" type="password"><button type="submit">Enter</button></form></body></html>`);
            });
            return;
        }
        if (p === "/members/enter") {
            res.writeHead(200, { "content-type": "text/html" });
            return void res.end(
                `<!doctype html><html><head><title>Members</title></head><body><h1>Members</h1><form method="post"><label for="m-email">E-mail</label><input id="m-email" name="email" type="email"><label for="m-pass">Password</label><input id="m-pass" name="password" type="password"><button type="submit">Enter</button></form></body></html>`,
            );
        }
        if (p === "/members") {
            res.writeHead(authed ? 200 : 302, authed ? { "content-type": "text/html" } : { location: "/members/enter" });
            return void res.end(authed ? `<!doctype html><html><head><title>Members</title></head><body><h1>Welcome back</h1><a href="/">Home</a></body></html>` : "");
        }
        if ((REUSE_PAGES as readonly string[]).includes(p)) {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            return void res.end(page(p, site));
        }
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
    });
    return new Promise((resolve) => site.server.listen(port, "127.0.0.1", () => resolve(site)));
}
