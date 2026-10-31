/**
 * Fixture app for the environments and test-data tests: the same small shop run twice, as a "staging" server with one
 * harmless bug and as a "production" server that is correct. Each instance records what it was asked, so tests can prove
 * which address, token and variables a run really used, and that a read-only production never saw a data-changing request.
 *
 *   /offer          the free-shipping banner: "over $50" (production) or "over $5O" (staging bug: a letter O)
 *   /greet?name=X   "Hello, X!"; the last name asked for is remembered (proves {{env.NAME}} reached the script)
 *   /search?q=X     "Results for X" (a data-driven test visits it once per row)
 *   /api/items      GET lists items; POST creates one (counted: `mutations`)
 *   /api/me         needs this server's own bearer token (proves which credential a run used)
 */
import http from "node:http";

export interface EnvironmentsApp {
    server: http.Server;
    /** Data-changing requests received (POST / PUT / PATCH / DELETE). */
    readonly mutations: number;
    /** Every request: path and the Authorization header it carried. */
    readonly hits: Array<{ method: string; path: string; auth: string }>;
    readonly lastGreeting: string | undefined;
    reset(): void;
    close(): Promise<void>;
}

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function startEnvironmentsApp(port: number, opts: { label: string; bug: boolean; token: string }): Promise<EnvironmentsApp> {
    const hits: EnvironmentsApp["hits"] = [];
    let mutations = 0;
    let lastGreeting: string | undefined;
    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        const auth = String(req.headers.authorization ?? "");
        hits.push({ method: req.method ?? "GET", path: url.pathname, auth });
        if (req.method && !["GET", "HEAD", "OPTIONS"].includes(req.method)) mutations++;
        const json = (status: number, body: unknown) => {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify(body));
        };
        const html = (body: string) => {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(body);
        };
        switch (url.pathname) {
            case "/":
                return html(page(`Acme Shop (${opts.label})`, `<p>Welcome.</p><a href="/offer">Offer</a>`));
            case "/offer":
                return html(page("Offer", `<p id="offer">Free shipping on orders over ${opts.bug ? "$5O" : "$50"}</p>`));
            case "/greet": {
                lastGreeting = url.searchParams.get("name") ?? "";
                return html(page("Greeting", `<p id="greeting">Hello, ${esc(lastGreeting)}!</p>`));
            }
            case "/search": {
                const q = url.searchParams.get("q") ?? "";
                return html(page("Search", `<p id="results">Results for ${esc(q)}</p>`));
            }
            case "/api/items":
                if (req.method === "POST") return json(201, { id: 2, name: "created" });
                return json(200, [{ id: 1, name: "apple" }]);
            case "/api/me":
                return auth === `Bearer ${opts.token}` ? json(200, { user: "tester", environment: opts.label }) : json(401, { error: "unauthorized" });
            default:
                res.writeHead(404, { "content-type": "text/html" });
                return void res.end(page("Not found", ""));
        }
    });
    return new Promise((resolve) =>
        server.listen(port, "127.0.0.1", () =>
            resolve({
                server,
                get mutations() {
                    return mutations;
                },
                hits,
                get lastGreeting() {
                    return lastGreeting;
                },
                reset() {
                    mutations = 0;
                    hits.length = 0;
                    lastGreeting = undefined;
                },
                close: () => new Promise<void>((r) => server.close(() => r())),
            }),
        ),
    );
}

const nav = (url: string) => ({ action: "navigate", url }) as const;
const css = (value: string) => ({ by: "css", value }) as const;

/** Specs used against both servers. */
export const ENV_SPECS = [
    { testId: "WEB-001", title: "The offer banner shows the free-shipping threshold", kind: "web", steps: [nav("/offer"), { action: "assert", check: "text", locator: css("#offer"), expected: "over $50" }] },
    { testId: "WEB-002", title: "The greeting uses this environment's name", kind: "web", steps: [nav("/greet?name={{env.GREETING_NAME}}"), { action: "assert", check: "text", locator: css("#greeting"), expected: "Hello, {{env.GREETING_NAME}}!" }] },
    { testId: "API-001", title: "The item list is available", kind: "api", steps: [{ action: "request", method: "GET", path: "/api/items" }, { action: "assertResponse", check: "status", expected: 200 }] },
    { testId: "API-002", title: "An item can be created", kind: "api", steps: [{ action: "request", method: "POST", path: "/api/items", body: { name: "new" } }, { action: "assertResponse", check: "status", expected: 201 }] },
    { testId: "API-003", title: "The signed-in user can be read", kind: "api", steps: [{ action: "request", method: "GET", path: "/api/me" }, { action: "assertResponse", check: "status", expected: 200 }] },
] as const;
