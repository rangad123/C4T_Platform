// A11yShop: a tiny dependency-free fixture for the accessibility (axe-core) audit tests.
// Not part of the platform itself.
//   node examples/a11y-app/server.mjs [port]      (default 5111)
//
//   /             clean home page
//   /clean        clean form page (labelled inputs, alt text, good contrast)
//   /bad          deliberate violations: image without alt, unlabelled input, low-contrast text
//   /contrast     only low-contrast text (lets tests check the impact threshold)
import http from "node:http";

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 5111);

// Inline SVG so <img> elements never trigger a network 404.
const PIXEL = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect width='40' height='40' fill='%23336'/%3E%3C/svg%3E";

const layout = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui,sans-serif;margin:0;color:#111;background:#fff}
header,main{padding:16px 24px}a{color:#0b3d91}.faint{color:#d4d4d4}</style></head>
<body><header><nav aria-label="Main"><a href="/">Home</a> <a href="/clean">Contact</a></nav></header>
<main>${body}</main></body></html>`;

const PAGES = {
    "/": layout(
        "A11yShop",
        `<h1>A11yShop</h1><p>Welcome to the accessible demo shop.</p>
<img src="${PIXEL}" alt="Shop logo">`,
    ),
    "/clean": layout(
        "Contact us",
        `<h1>Contact us</h1>
<form id="contact" action="/clean" method="get">
<p><label for="email">Email</label> <input id="email" name="email" type="email"></p>
<p><label for="msg">Message</label> <textarea id="msg" name="msg"></textarea></p>
<p><img src="${PIXEL}" alt="Support team"></p>
<button type="submit">Send</button>
</form>`,
    ),
    "/bad": layout(
        "Broken page",
        `<h1>Newsletter</h1>
<section id="promo"><img src="${PIXEL}"><p class="faint">Low contrast promotional text that is hard to read.</p></section>
<form id="signup" action="/bad" method="get"><input type="text" name="email"> <button type="submit">Subscribe</button></form>`,
    ),
    "/contrast": layout(
        "Faint page",
        `<h1>Notes</h1><p class="faint">Only this paragraph has a contrast problem.</p>`,
    ),
};

http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const html = PAGES[path];
    res.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(html ?? layout("Not found", "<h1>Not found</h1>"));
}).listen(PORT, "127.0.0.1", () => console.log(`A11yShop on http://127.0.0.1:${PORT}`));
