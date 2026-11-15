// A tiny stand-in benchmark app for tests/bench-controller.test.ts (the benchmark apps' interface: BENCH_DEFECTS, BENCH_RESET_TOKEN,
// POST /__bench/reset). Three behaviours, chosen so the result is known in advance with a scripted model:
//   SI-1  the shop page's item list request fails (HTTP 500)        → page health finds it, only with SI-1 on: confirmed
//   SI-2  the home page shows a wrong total                         → nothing checks it: missed
//   always: the about page links to a page that does not exist      → page health finds it with every behaviour off too: false positive
//   node tests/fixtures/bench-standin.mjs <port>
import http from "node:http";

const PORT = Number(process.argv[2] ?? 9471);
const SWITCHES = new Set(String(process.env.BENCH_DEFECTS ?? "none").split(",").map((s) => s.trim()).filter((s) => s && s !== "none"));
const on = (id) => SWITCHES.has("all") || SWITCHES.has(id);
const TOKEN = process.env.BENCH_RESET_TOKEN ?? "";
let visits = 0;

const page = (title, body) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><nav><a href="/">Home</a> <a href="/shop">Shop</a> <a href="/about">About</a></nav><main>${body}</main></body></html>`;

http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    const html = (b) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(b);
    };
    if (url.pathname === "/__bench/reset") {
        if (!TOKEN) return res.writeHead(404).end();
        if (req.method !== "POST" || req.headers["x-bench-reset"] !== TOKEN) return res.writeHead(403).end();
        visits = 0;
        return res.writeHead(204).end();
    }
    visits++;
    if (url.pathname === "/") return html(page("Stand-in shop", `<h1>Stand-in shop</h1><p>Two items, total <span id="total">${on("SI-2") ? "$31.00" : "$30.00"}</span>.</p>`));
    if (url.pathname === "/shop")
        return html(page("Shop", `<h1>Shop</h1><ul id="items"></ul><script>fetch("/api/items").then((r) => r.json()).then((items) => { for (const i of items) { const li = document.createElement("li"); li.textContent = i; document.getElementById("items").append(li); } }).catch(() => {});</script>`));
    if (url.pathname === "/about") return html(page("About", `<h1>About</h1><p>Read <a href="/history">our history</a>.</p>`));
    if (url.pathname === "/api/items") {
        if (on("SI-1")) return res.writeHead(500, { "content-type": "application/json" }).end('{"error":"server"}');
        return res.writeHead(200, { "content-type": "application/json" }).end('["Mug","Lamp"]');
    }
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end(page("Not found", "<h1>Not found</h1>"));
}).listen(PORT, "127.0.0.1");
