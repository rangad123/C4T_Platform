// SecFixture: a tiny, deliberately flawed application that the platform owns, used as the target of scanner integration tests.
// It is NOT part of the platform and must never be exposed on a network other than 127.0.0.1.
//
//   node examples/security-fixture/server.mjs [port]
//
// The default port is 5310. Keep it: 5470 and 5471 belong to tests/vision.test.ts (its fixture app and its scripted model endpoint), and
// squatting on either makes that whole file fail with EADDRINUSE.
//
// Everything it does is deterministic, so a test can assert on an exact finding:
//   /                       home page: no security headers, a version banner, a link to /search
//   /search?q=              reflects ?q into the HTML without encoding  -> reflected XSS for a reviewed template
//   /debug/config.json      readable settings with a key that looks like a secret -> exposed-secret template
//   /files/                 a directory listing
//   /admin/                 an authenticated-looking area: tests put it in excludedPaths and assert it is never requested
//   /openapi.json           an OpenAPI 3.0 document for the API-security tests
//   /api/items              200 items in one answer -> the "more data than needed" check
//   /api/books, /api/books/{id}   the operations Schemathesis is pointed at
//   /api/secret             needs the key "Bearer test-token"; answering without it returns 401
//   /ai/chat                an OpenAI-shaped chat endpoint that echoes the prompt -> the promptfoo target
//   /slow?ms=               an answer that takes that many milliseconds, so a test can cancel an assessment that is really running
//   /__log                  every request this server received (method, path), newest last: tests assert scope and rate
//   /__reset                clears that log
import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 5310);
const log = [];

const OPENAPI = {
    openapi: "3.0.3",
    info: { title: "SecFixture API", version: "1.0.0" },
    servers: [{ url: `http://127.0.0.1:${PORT}` }],
    paths: {
        "/api/books": {
            get: {
                operationId: "listBooks",
                summary: "List books",
                responses: { 200: { description: "A list of books", content: { "application/json": { schema: { type: "array", items: { type: "object", required: ["title"], properties: { title: { type: "string" }, isbn: { type: "string" } } } } } } } },
            },
            post: {
                operationId: "createBook",
                summary: "Create a book",
                requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["title"], properties: { title: { type: "string" } } } } } },
                responses: { 201: { description: "Created" } },
            },
        },
        "/api/books/{id}": {
            get: {
                operationId: "getBook",
                summary: "One book",
                parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
                responses: { 200: { description: "One book", content: { "application/json": { schema: { type: "object", required: ["title"], properties: { title: { type: "string" } } } } } }, 404: { description: "No such book" } },
            },
        },
        "/api/secret": {
            get: {
                operationId: "getSecret",
                summary: "A value that needs a token",
                security: [{ bearerAuth: [] }],
                responses: { 200: { description: "The value" }, 401: { description: "No token" } },
            },
        },
    },
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
};

const BOOKS = [
    { title: "The Left Hand of Darkness", isbn: "9780441478125" },
    { title: "Piranesi", isbn: "9781635575637" },
    { title: "A Memory Called Empire", isbn: "9781250186430" },
];

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
/** The one flaw this fixture exists for: the query is copied into the page without encoding it. */
const reflect = (q) => q.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    log.push(`${req.method} ${url.pathname}`);
    // Deliberately no security headers, and a banner that gives the version away.
    const send = (status, type, body, extra = {}) => {
        res.writeHead(status, { "content-type": type, "server": "fixture/1.4.2", ...extra });
        res.end(body);
    };

    switch (url.pathname) {
        case "/":
            return send(200, "text/html; charset=utf-8", page("SecFixture", '<h1>SecFixture</h1><p>Scan me.</p><a href="/search">Search</a> <a href="/admin/">Admin</a>'));
        case "/search": {
            const q = url.searchParams.get("q") ?? "";
            // The reflected value is written unescaped into a <p>: a reviewed template can prove it by sending <script>alert(1)</script>.
            return send(200, "text/html; charset=utf-8", `<!doctype html><html><head><meta charset="utf-8"><title>Search</title></head><body><h1>Search</h1><p id="q">${q}</p></body></html>`);
        }
        case "/debug/config.json":
            return send(200, "application/json", JSON.stringify({ environment: "production", db: { host: "db.internal" }, apiKey: "sk_live_fixture_0123456789", debug: true }, null, 2));
        case "/files/":
            return send(200, "text/html", page("Index of /files/", '<h1>Index of /files/</h1><a href="notes.txt">notes.txt</a><a href="report.csv">report.csv</a>'));
        case "/files/notes.txt":
            return send(200, "text/plain", "internal notes\n");
        case "/admin/":
            // Only reached when a scan ignored the excluded paths, which the tests assert it never does.
            return send(200, "text/html", page("Admin", "<h1>Admin</h1><p>Should never be requested by an authorized scan.</p>"));
        case "/openapi.json":
            return send(200, "application/json", JSON.stringify(OPENAPI));
        case "/api/items":
            return send(200, "application/json", JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: i, name: `item-${i}`, internal_note: `note ${i}` }))));
        case "/api/books":
            if (req.method === "GET") return send(200, "application/json", JSON.stringify(BOOKS));
            if (req.method === "POST") return send(201, "application/json", JSON.stringify({ title: "Added", isbn: "000" }));
            return send(405, "text/plain", "Method not allowed");
        case "/api/secret":
            return req.headers.authorization === "Bearer test-token" ? send(200, "application/json", '{"value":"top secret"}') : send(401, "application/json", '{"error":"no token"}');
        case "/ai/chat":
        case "/ai/chat/completions": {
            // An OpenAI-shaped endpoint: enough for a prompt-evaluation harness to drive, deterministic, no model involved.
            let body = "";
            req.on("data", (c) => (body += c));
            return req.on("end", () => {
                let prompt = "";
                try {
                    const parsed = JSON.parse(body || "{}");
                    prompt = parsed.messages?.map((m) => m.content).join(" ") ?? "";
                } catch {
                    prompt = "";
                }
                return send(200, "application/json", JSON.stringify({ id: `chatcmpl-${randomUUID()}`, choices: [{ message: { role: "assistant", content: `You said: ${prompt}` } }] }));
            });
        }
        case "/slow": {
            // A deliberately slow answer, so a test can start an assessment and cancel it while it is genuinely mid-crawl rather than
            // racing a fast target that finishes first. Nothing about it is a vulnerability: the point is only to take time.
            const ms = Math.min(60_000, Math.max(0, Number(url.searchParams.get("ms") ?? 5_000) || 0));
            return setTimeout(() => send(200, "text/plain", "slow"), ms);
        }
        case "/__log":
            return send(200, "application/json", JSON.stringify(log));
        case "/__reset":
            log.length = 0;
            return send(200, "application/json", '{"ok":true}');
        default:
            return send(404, "text/plain", "Not found");
    }
});

server.listen(PORT, "127.0.0.1", () => console.log(`security-fixture on http://127.0.0.1:${PORT}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
