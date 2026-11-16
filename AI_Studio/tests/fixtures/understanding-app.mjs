// A small app for the crawl's understanding of pages: field constraints, client-side validation messages, dialogs, menus,
// tables, and the requests a safe interaction causes. Loopback only.
//   node tests/fixtures/understanding-app.mjs <port>
//   /                home: page load calls GET /api/summary; "Open details" calls GET /api/orders/42; a Help dialog, an account
//                    menu, and an orders table whose cells must never be stored
//   /register        a form with constraints (email, number range, length, pattern, choices) and an app-side phone message;
//                    four fields try to send data when they are left: requestSubmit(), submit(), a navigation, a background POST
//   /profile         eight email fields whose handlers try to send what was typed: a delayed POST, a form posted into a new window,
//                    window.open, a GET on every keystroke, an image beacon, a GET form in an iframe and a WebSocket message. From the
//                    second visit on, a form asking to type DELETE is put in front of it (the page's fields move)
//   /__stats         what the server saw: form posts and form submissions by GET, the API calls, every /save/ request and every
//                    WebSocket message
import { createHash } from "node:crypto";
import http from "node:http";

const port = Number(process.argv[2]);
const stats = { posts: 0, formGets: 0, api: [], saves: [], ws: [] };
const visits = new Map();

const page = (title, body, script = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1><nav><a href="/">Home</a> <a href="/register">Register</a> <a href="/profile">Profile</a></nav>${body}<script>${script}</script></body></html>`;

const HOME = page(
    "Orders home",
    `<button aria-haspopup="dialog" id="help">Help</button><div id="dialog-host"></div>
<button aria-haspopup="menu" aria-expanded="false" id="account">Account menu</button><div id="menu-host"></div>
<button aria-expanded="false" id="details">Open details</button><div id="details-box"></div>
<dialog aria-label="Session expiring"><p>Your session ends soon.</p></dialog>
<table><caption>Recent orders</caption>
<thead><tr><th>Order</th><th>Status</th><th>Total</th></tr></thead>
<tbody><tr><td>CELL-ORDER-7731</td><td>CELL-STATUS-SHIPPED</td><td>CELL-TOTAL-99</td></tr></tbody></table>
<div role="grid" aria-label="Stock levels"><div role="row"><span role="columnheader">Item</span><span role="columnheader">On hand</span></div><div role="row"><span role="gridcell">CELL-ITEM-MUG</span><span role="gridcell">CELL-QTY-4</span></div></div>`,
    `fetch("/api/summary");
document.getElementById("help").onclick = () => {
  document.getElementById("dialog-host").innerHTML = '<div role="dialog" aria-labelledby="help-title"><h2 id="help-title">Getting help</h2><p>Write to support.</p></div>';
};
document.getElementById("account").onclick = (e) => {
  e.target.setAttribute("aria-expanded", "true");
  document.getElementById("menu-host").innerHTML = '<ul role="menu" aria-label="Account"><li role="menuitem">Profile</li><li role="menuitem">Preferences</li></ul>';
};
document.getElementById("details").onclick = (e) => {
  e.target.setAttribute("aria-expanded", "true");
  fetch("/api/orders/42").then((r) => r.json()).then((o) => { document.getElementById("details-box").textContent = "Order " + o.id; });
};`,
);

const REGISTER = page(
    "Create an account",
    `<form method="post" action="/register" id="signup" novalidate>
<label>Email <input type="email" name="email" required></label>
<label>Age <input type="number" name="age" min="18" max="120" required></label>
<label>Username <input type="text" name="username" minlength="3" maxlength="20" pattern="[a-z0-9]+" required></label>
<label>Country <select name="country" required><option value="">Choose</option><option value="in">India</option><option value="no">Norway</option><option value="pe">Peru</option></select></label>
<label>Phone <input type="tel" name="phone" aria-describedby="phone-error" value="5550100"></label><span id="phone-error"></span>
<label>Nickname <input type="text" name="nickname" required></label>
<label>City <input type="text" name="city" required></label>
<label>Referral <input type="text" name="referral" required></label>
<label>Draft <input type="text" name="draft" required></label>
<label>Reset code <input type="text" name="resetcode" required></label>
<label>Password <input type="password" name="password" required minlength="8"></label>
<label>About you <textarea name="bio" maxlength="200"></textarea></label>
<input type="hidden" name="token" value="hidden-value">
<button type="submit">Create account</button>
</form>`,
    `const phone = document.querySelector("[name=phone]");
phone.addEventListener("blur", () => {
  const bad = !/^[0-9]{7,}$/.test(phone.value);
  phone.setAttribute("aria-invalid", bad ? "true" : "false");
  document.getElementById("phone-error").textContent = bad ? "Enter digits only, at least 7" : "";
});
// Leaving this field tries to send the form (novalidate, so the browser would let it go), and the form's own handler sends the
// values by GET: the crawl must stop both.
document.getElementById("signup").addEventListener("submit", (e) => { e.preventDefault(); fetch("/register?via=script"); });
document.querySelector("[name=nickname]").addEventListener("blur", () => document.getElementById("signup").requestSubmit());
// The same through the other doors: submit() (no submit event), a navigation carrying the values, a background POST.
document.querySelector("[name=city]").addEventListener("blur", () => document.getElementById("signup").submit());
document.querySelector("[name=referral]").addEventListener("blur", () => location.assign("/register?referral=1"));
document.querySelector("[name=draft]").addEventListener("blur", () => fetch("/api/draft", { method: "POST", body: "{}" }));`,
);

const PROFILE_FIELDS = ["contact", "debounced", "blank", "opener", "lookup", "beacon", "framed", "socket"];
const profile = (moved) =>
    page(
        "Profile",
        `${moved ? '<form><label>Type DELETE to remove your account <input type="email" name="delete_account_confirm" required></label></form>' : ""}
<form id="profile" novalidate>${PROFILE_FIELDS.map((n) => `<label>${n} <input type="email" name="${n}"${n === "contact" ? " required" : ""}></label>`).join("\n")}</form>
<form id="popup" method="post" action="/save/blank" target="_blank"><input type="hidden" name="v"></form>
<iframe src="/frame"></iframe>`,
        `const f = (n) => document.querySelector("[name=" + n + "]");
const wrong = f("delete_account_confirm");
if (wrong) wrong.addEventListener("input", () => { document.cookie = "wrong_field=1; path=/"; });
f("debounced").addEventListener("change", () => { const v = f("debounced").value; setTimeout(() => fetch("/save/debounced", { method: "POST", body: v }), 400); });
f("blank").addEventListener("blur", () => { const p = document.getElementById("popup"); p.v.value = f("blank").value; p.submit(); });
f("opener").addEventListener("blur", () => {
  window.open("/save/open?v=" + encodeURIComponent(f("opener").value));
  // A window with no address of its own: no request to refuse, so only closing it gets rid of it.
  const w = window.open("", "_blank");
  if (w) w.document.write("<p>" + f("opener").value + "</p>");
});
f("lookup").addEventListener("input", () => fetch("/save/get?v=" + encodeURIComponent(f("lookup").value)));
f("beacon").addEventListener("blur", () => { new Image().src = "/save/img?v=" + encodeURIComponent(f("beacon").value); });
f("framed").addEventListener("blur", () => { const d = frames[0].document; d.forms[0].v.value = f("framed").value; d.forms[0].requestSubmit(); });
const ws = new WebSocket("ws://" + location.host + "/live");
f("socket").addEventListener("blur", () => ws.send("change:" + f("socket").value));`,
    );

const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (body, type = "text/html", status = 200) => {
        res.writeHead(status, { "content-type": type });
        res.end(body);
    };
    if (url.pathname.startsWith("/save/")) stats.saves.push(`${req.method} ${url.pathname}${url.search}`);
    if (req.method === "POST") {
        stats.posts++;
        return send("posted", "text/plain");
    }
    if (url.pathname === "/__stats") return send(JSON.stringify(stats), "application/json");
    if (url.pathname.startsWith("/api/")) {
        stats.api.push(`${req.method} ${url.pathname}`);
        if (url.pathname === "/api/summary") return send(JSON.stringify({ orders: 1 }), "application/json");
        if (url.pathname === "/api/orders/42") return send(JSON.stringify({ id: 42 }), "application/json");
        return send("{}", "application/json", 404);
    }
    if (url.pathname === "/") return send(HOME);
    if (url.pathname === "/profile") {
        visits.set("/profile", (visits.get("/profile") ?? 0) + 1);
        return send(profile(visits.get("/profile") > 1));
    }
    if (url.pathname === "/frame") return send(`<!doctype html><form method="get" action="/save/iframe"><input name="v"></form>`);
    if (url.pathname === "/register") {
        if (url.search) stats.formGets++;
        return send(REGISTER);
    }
    return send(page("Not found", ""), "text/html", 404);
});
// A bare WebSocket endpoint (/live): the handshake, then every text frame the page sends is recorded.
server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) return socket.destroy();
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 6) {
            const opcode = buf[0] & 0x0f;
            let len = buf[1] & 0x7f;
            let at = 2;
            if (len === 126) {
                len = buf.readUInt16BE(2);
                at = 4;
            }
            if (buf.length < at + 4 + len) return;
            const mask = buf.subarray(at, at + 4);
            const data = Buffer.from(buf.subarray(at + 4, at + 4 + len).map((b, i) => b ^ mask[i % 4]));
            buf = buf.subarray(at + 4 + len);
            if (opcode === 1) stats.ws.push(data.toString("utf8"));
            if (opcode === 8) return socket.end();
        }
    });
    socket.on("error", () => undefined);
});
server.listen(port, "127.0.0.1");
