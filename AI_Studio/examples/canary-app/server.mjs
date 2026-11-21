// CanaryShop: a dependency-free fixture app that plants fake secrets everywhere an application can put them, for the evidence audit
// (tests/evidence-canary.test.ts, .scratch/ai-testing-engine/P5-EVIDENCE-AUDIT.md). Not part of the platform itself.
//   node examples/canary-app/server.mjs <port>
//
// Seven kinds (password, bearer token, session cookie, API key, personal data = e-mail + phone + address, card number, database
// connection string) in nine channels: form fields, headers (response and request), cookies, JSON bodies (request and response),
// URLs (links and fetches), console, page text, an iframe and a downloaded file. Every (channel, kind) pair has its own value
// (canaries.json), so a value found in stored data names both. The password field is empty: the test types the run's password into it,
// which is the field channel's password.
//
// The fields, page text and iframe sit at fixed places on a 1280x800 page (BOXES), so a test can check whether a screenshot covers them.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const C = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "canaries.json"), "utf8")).channels;
const KINDS = ["password", "bearer", "cookie", "apiKey", "email", "phone", "address", "card", "dbUrl"];
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 5760);

// Form fields: label, attributes, and the value it is filled with (password: typed by the test).
const FIELDS = {
    password: ['Password', 'type="password" name="password" autocomplete="current-password"'],
    bearer: ['Access token', 'name="token"'],
    cookie: ['Session', 'name="session"'],
    apiKey: ['API key', 'name="api_key"'],
    email: ['E-mail', 'type="email" name="email"'],
    phone: ['Phone', 'type="tel" name="phone"'],
    address: ['Address', 'name="address"'],
    card: ['Card number', 'name="cardnumber" autocomplete="cc-number"'],
    dbUrl: ['Connection string', 'name="dsn"'],
};
const top = (i) => 70 + i * 44;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

const home = () => {
    const fields = KINDS.map((k, i) => {
        const [label, attrs] = FIELDS[k];
        const value = k === "password" ? "" : ` value="${esc(C.field[k])}"`;
        return `<label style="position:absolute;left:20px;top:${top(i) - 18}px;font:12px sans-serif">${label}</label><input id="f-${k}" ${attrs}${value} aria-label="${label}" style="position:absolute;left:20px;top:${top(i)}px;width:400px;height:24px;font:14px monospace;border:1px solid #888;padding:2px">`;
    }).join("");
    const text = KINDS.map((k, i) => `<div id="t-${k}" style="position:absolute;left:470px;top:${top(i)}px;width:380px;height:28px;font:14px monospace;overflow:hidden">${esc(C.text[k])}</div>`).join("");
    const urlQs = new URLSearchParams(Object.fromEntries(KINDS.map((k) => [k, C.url[k]]))).toString();
    const script = `
const C = ${JSON.stringify({ console: C.console, json: C.json, url: C.url, header: C.header })};
for (const k of Object.keys(C.console)) console.log(k + ": " + C.console[k]);
console.error("profile check failed for " + C.console.email + " with token " + C.console.bearer);
fetch("/api/ping?${urlQs}");
fetch("/api/profile", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + C.header.bearer, "x-api-key": C.header.apiKey }, body: JSON.stringify(C.json) })
    .then((r) => r.json()).then(() => { document.getElementById("saved").textContent = "Profile saved"; });
`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Canary account</title></head>
<body style="margin:0;background:#fff"><main><h1 style="position:absolute;left:20px;top:0;margin:8px 0;font:20px sans-serif">Canary account</h1>
<form onsubmit="return false">${fields}</form>${text}
<iframe title="Billing" src="/frame" style="position:absolute;left:880px;top:60px;width:380px;height:420px;border:0"></iframe>
<p id="saved" role="status" style="position:absolute;left:20px;top:480px"></p>
<a href="/export.csv" download style="position:absolute;left:20px;top:520px">Export</a>
<a href="/?${urlQs}" style="position:absolute;left:120px;top:520px">Share</a>
</main><script>${script}</script></body></html>`;
};

const frame = () =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Billing</title></head><body style="margin:0;background:#fff">${KINDS.map((k, i) => `<div id="i-${k}" style="position:absolute;left:0;top:${i * 44 + 10}px;width:370px;height:28px;font:14px monospace;overflow:hidden">${esc(C.iframe[k])}</div>`).join("")}</body></html>`;

const send = (res, status, type, body, headers = {}) => {
    res.writeHead(status, { "content-type": type, ...headers });
    res.end(body);
};

const handler = (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
        switch (url.pathname) {
            case "/":
                return send(res, 200, "text/html; charset=utf-8", home(), {
                    "set-cookie": KINDS.map((k) => `c_${k}=${encodeURIComponent(C.cookie[k])}; Path=/`),
                    "x-password": C.header.password,
                    "x-session-token": `Bearer ${C.header.bearer}`,
                    "x-session-cookie": C.header.cookie,
                    "x-api-key": C.header.apiKey,
                    "x-customer-email": C.header.email,
                    "x-customer-phone": C.header.phone,
                    "x-customer-address": C.header.address,
                    "x-card": C.header.card,
                    "x-db-url": C.header.dbUrl,
                });
            case "/frame":
                return send(res, 200, "text/html; charset=utf-8", frame());
            case "/export.csv":
                return send(res, 200, "text/csv", `kind,value\n${KINDS.map((k) => `${k},"${C.download[k]}"`).join("\n")}\n`, { "content-disposition": 'attachment; filename="export.csv"' });
            case "/api/profile":
                return send(res, 200, "application/json", JSON.stringify({ saved: true, profile: C.json, received: raw.length }));
            case "/api/ping":
                return send(res, 200, "application/json", '{"ok":true}');
            default:
                return send(res, 404, "text/plain", "Not found");
        }
    });
};

http.createServer(handler).listen(PORT, "127.0.0.1", () => console.log(`canary-app on ${PORT}`));
