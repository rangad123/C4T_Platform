/**
 * A small, deliberately slow site for the Explorer view tests (the port is the caller's):
 *   /  /pricing  /about  /docs  /team   pages with a heading and links; each answers after `delayMs`, so an exploration lasts long enough to be watched
 *   /login   Email + Password; the password field is PRE-FILLED with LOGIN_PREFILL (a known value to look for in pictures), at a fixed place;
 *            a script reports to /beacon.gif?n=<count> every time the number of fields carrying the covering marker changes, so a test can see
 *            that the cover was on while a picture was taken and gone afterwards
 *   /account  after signing in (demo@example.test / EXPLORER_PASSWORD)
 * `beacons` lists the counts the page reported; `hits` every path requested.
 */
import http from "node:http";

export const EXPLORER_USER = { email: "demo@example.test", password: "Explorer-Pass-4417" };
export const LOGIN_PREFILL = "prefilled-login-value-9051";
/** Where the password field sits in the login page (CSS pixels, 1280 px wide viewport). */
export const LOGIN_PASSWORD_BOX = { x: 20, y: 150, w: 360, h: 44 };

export interface ExplorerSite {
    server: http.Server;
    beacons: number[];
    hits: string[];
    close(): Promise<void>;
}

const layout = (title: string, body: string, script = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{margin:0;font:18px/1.4 sans-serif;background:#fff;color:#111} main{padding:20px} a{margin-right:14px} input{box-sizing:border-box}</style></head>
<body><main>${body}</main><script>${script}</script></body></html>`;

const NAV = `<nav aria-label="Main"><a href="/">Home</a><a href="/pricing">Pricing</a><a href="/about">About</a><a href="/docs">Docs</a><a href="/team">Team</a><a href="/login">Log in</a></nav>`;

const BEACON = `
var last = -1;
new MutationObserver(function () {
  var n = document.querySelectorAll("[data-aitp-xmask]").length;
  if (n !== last) { last = n; new Image().src = "/beacon.gif?n=" + n + "&t=" + Date.now(); }
}).observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ["data-aitp-xmask"] });`;

export function startExplorerSite(port: number, delayMs = 900): Promise<ExplorerSite> {
    const beacons: number[] = [];
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        const path = url.pathname;
        hits.push(path);
        if (path === "/beacon.gif") {
            beacons.push(Number(url.searchParams.get("n")));
            res.writeHead(200, { "content-type": "image/gif" });
            return void res.end(Buffer.from("R0lGODlhAQABAAAAACw=", "base64"));
        }
        const send = (title: string, body: string, script = "", code = 200) =>
            setTimeout(() => {
                res.writeHead(code, { "content-type": "text/html; charset=utf-8" });
                res.end(layout(title, body, script));
            }, delayMs);
        const authed = (req.headers.cookie ?? "").includes("session=ok");
        const pages: Record<string, [string, string]> = {
            "/": ["Explorer Shop", "Welcome to the Explorer Shop"],
            "/pricing": ["Pricing", "Pricing plans"],
            "/about": ["About", "About us"],
            "/docs": ["Docs", "Documentation"],
            "/team": ["Team", "Our team"],
        };
        const p = pages[path];
        if (p) return send(p[0], `${NAV}<h1>${p[1]}</h1><p>Some plain text on the ${p[0]} page.</p>`);
        if (path === "/login" && req.method === "POST") {
            let body = "";
            req.on("data", (d) => (body += d));
            req.on("end", () => {
                const f = new URLSearchParams(body);
                if (f.get("email") === EXPLORER_USER.email && f.get("password") === EXPLORER_USER.password) {
                    res.writeHead(302, { location: "/account", "set-cookie": "session=ok; Path=/; HttpOnly" });
                    return void res.end();
                }
                send("Sign in", `<h1>Sign in</h1><p role="alert">Invalid email or password</p>`, "", 401);
            });
            return;
        }
        if (path === "/login") {
            const b = LOGIN_PASSWORD_BOX;
            return send(
                "Sign in",
                `<h1 style="margin:0">Sign in</h1><form method="post" action="/login">` +
                    `<label for="email" style="position:absolute;left:20px;top:50px">Email</label><input id="email" name="email" type="email" style="position:absolute;left:20px;top:70px;width:360px;height:44px;font-size:20px">` +
                    `<label for="password" style="position:absolute;left:20px;top:${b.y - 24}px">Password</label><input id="password" name="password" type="password" value="${LOGIN_PREFILL}" style="position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;font-size:20px;border:2px solid #000;background:#fff">` +
                    `<button type="submit" style="position:absolute;left:20px;top:220px;height:44px">Log in</button></form>`,
                BEACON,
            );
        }
        if (path === "/account") {
            if (!authed) {
                res.writeHead(302, { location: "/login" });
                return void res.end();
            }
            return send("Your account", `${NAV}<h1>Your account</h1><p>Signed in as ${EXPLORER_USER.email}</p>`);
        }
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
    });
    return new Promise((resolve) =>
        server.listen(port, "127.0.0.1", () =>
            resolve({ server, beacons, hits, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) }),
        ),
    );
}
