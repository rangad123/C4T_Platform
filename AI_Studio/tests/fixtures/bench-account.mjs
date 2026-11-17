// A stand-in benchmark app with one account, for tests/bench-harness-limits-unit.test.ts: a test can spend from it (POST /spend), which
// leaves the account changed until the app starts again. GET /account says whether it was changed and which behaviours are on.
//   node tests/fixtures/bench-account.mjs <port>
import http from "node:http";

const PORT = Number(process.argv[2] ?? 9473);
const SWITCHES = String(process.env.BENCH_DEFECTS ?? "none").split(",").map((s) => s.trim()).filter((s) => s && s !== "none");
let spent = false;

http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    const json = (v) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v));
    if (url.pathname === "/spend" && req.method === "POST") {
        spent = true;
        return json({ spent });
    }
    if (url.pathname === "/account") return json({ spent, defects: SWITCHES });
    if (url.pathname === "/") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>Account</title><h1>Account</h1>");
    res.writeHead(404).end();
}).listen(PORT, "127.0.0.1");
