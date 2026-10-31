// ChecksShop: a tiny dependency-free fixture for the page-health and passive-security check tests.
// Not part of the platform itself.
//   node examples/checks-app/server.mjs <port> <weak|hardened|spa> [tls-fixture-name]
//
//   weak      deliberately flawed: JavaScript errors, failing requests, broken links, no security headers,
//             an unprotected session cookie, CORS that echoes any Origin (with credentials), a readable
//             /.env and /.git/HEAD, a directory listing, version banners
//   hardened  clean page, all security headers, a protected session cookie, 404 for everything else
//   spa       a single-page-app catch-all: HTTP 200 + the same HTML shell for EVERY path (this is what makes
//             "200 means exposed" a false-positive factory)
//
// With a third argument (a name under tests/fixtures/tls, e.g. "localhost") the server speaks https with that
// self-signed certificate. /__log (weak only) lists the paths that were requested, newest last; /__auth counts credentialed requests.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 5210);
const MODE = process.argv[3] ?? "weak";
const TLS = process.argv[4];
const secure = Boolean(TLS);
const requested = [];
let credentialed = 0;

const PIXEL = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8'%3E%3Crect width='8' height='8' fill='%23336'/%3E%3C/svg%3E";

const page = (title, body, { head = "", lang = 'lang="en"', viewport = true } = {}) =>
    `<!doctype html><html ${lang}><head><meta charset="utf-8">${title ? `<title>${title}</title>` : ""}${viewport ? '<meta name="viewport" content="width=device-width, initial-scale=1">' : ""}${head}</head><body>${body}</body></html>`;

const HARDENED_HEADERS = {
    "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    ...(secure ? { "strict-transport-security": "max-age=31536000; includeSubDomains" } : {}),
};

function weak(req, res, url) {
    const origin = req.headers.origin;
    // CORS that trusts whatever Origin it is given, with credentials.
    const cors = origin ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true" } : {};
    const send = (status, type, body, extra = {}) => {
        res.writeHead(status, { "content-type": type, "x-powered-by": "Express/4.17.1", server: "Apache/2.4.41 (Ubuntu)", ...cors, ...extra });
        res.end(body);
    };
    switch (url.pathname) {
        case "/":
            return send(
                200,
                "text/html; charset=utf-8",
                page(
                    "ChecksShop",
                    `<h1>ChecksShop</h1><nav><a href="/about">About</a> <a href="/about">About again</a> <a href="/missing-page">Old offer</a> <a href="/broken-500">Reports</a>
<a href="mailto:hi@shop.example">Mail</a> <a href="tel:+100">Call</a> <a href="#top">Top</a> <a href="javascript:void(0)">Nothing</a> <a href="/logout">Sign out</a> <a href="/delete-account">Delete</a>
<a href="/basics">Basics</a> <a href="/mixed">Mixed</a></nav>
<script>
setTimeout(() => { throw new Error("Boom on the home page"); }, 0);
console.error("Home console error");
fetch("/api/boom").catch(() => {});
fetch("/api/missing").catch(() => {});
</script>`,
                ),
                {
                    "set-cookie": ["sessionid=abc123; Path=/", "theme=dark; Path=/", "XSRF-TOKEN=tok; Path=/"],
                },
            );
        case "/about":
            return send(200, "text/html; charset=utf-8", page("About", "<h1>About</h1><p>Plain page.</p>"));
        case "/basics":
            // no <title>, no lang, no viewport, two <h1>
            return send(200, "text/html; charset=utf-8", page("", "<h1>One</h1><h1>Two</h1>", { lang: "", viewport: false }));
        case "/mixed":
            return send(200, "text/html; charset=utf-8", page("Mixed", `<h1>Mixed</h1><img alt="" src="http://127.0.0.1:1/insecure.png"><script src="http://127.0.0.1:1/insecure.js"></script>`));
        case "/api/boom":
            return send(500, "application/json", '{"error":"boom"}');
        case "/broken-500":
            return send(500, "text/html", page("Broken", "<h1>Broken</h1>"));
        case "/.env":
            return send(200, "text/plain", "APP_ENV=production\nDB_PASSWORD=hunter2\nAPI_KEY=sk_live_abc123\n");
        case "/.git/HEAD":
            return send(200, "text/plain", "ref: refs/heads/main\n");
        case "/uploads/":
            return send(200, "text/html", "<html><head><title>Index of /uploads/</title></head><body><h1>Index of /uploads/</h1><a href=\"a.txt\">a.txt</a></body></html>");
        case "/__auth":
            return send(200, "application/json", String(credentialed));
        case "/__log":
            return send(200, "application/json", JSON.stringify(requested));
        default:
            return send(404, "text/plain", "Not found");
    }
}

function hardened(req, res, url) {
    const send = (status, type, body, extra = {}) => {
        res.writeHead(status, { "content-type": type, ...HARDENED_HEADERS, ...extra });
        res.end(body);
    };
    const cookie = `sessionid=s3cr3t; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
    switch (url.pathname) {
        case "/":
            return send(200, "text/html; charset=utf-8", page("Hardened shop", `<h1>Hardened shop</h1><a href="/about">About</a> <a href="/contact">Contact</a><a href="https://elsewhere.invalid/">Elsewhere</a>`), { "set-cookie": cookie });
        case "/about":
        case "/contact":
            return send(200, "text/html; charset=utf-8", page(url.pathname.slice(1), `<h1>${url.pathname.slice(1)}</h1><a href="/">Home</a>`));
        default:
            return send(404, "text/plain", "Not found");
    }
}

function spa(req, res, url) {
    const shell = page("Single page app", '<div id="app">Loading...</div><h1 hidden>App</h1><a href="/anything">Anything</a>');
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(shell);
}

const handler = (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (MODE === "weak") requested.push(url.pathname);
    // The passive checks must never send credentials: /__auth (weak) counts requests that carried any.
    if (req.headers.authorization || req.headers["x-key"] || req.headers["x-api-key"]) credentialed++;
    ({ weak, hardened, spa })[MODE](req, res, url);
};

if (TLS) {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../tests/fixtures/tls");
    https.createServer({ key: fs.readFileSync(path.join(dir, `${TLS}.key`)), cert: fs.readFileSync(path.join(dir, `${TLS}.crt`)) }, handler).listen(PORT, "127.0.0.1", () => console.log(`checks-app (${MODE}, https) on ${PORT}`));
} else {
    http.createServer(handler).listen(PORT, "127.0.0.1", () => console.log(`checks-app (${MODE}) on ${PORT}`));
}
