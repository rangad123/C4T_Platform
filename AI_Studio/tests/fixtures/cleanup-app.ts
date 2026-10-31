/**
 * Fixture API for the test-data cleanup tests: an in-memory store that records exactly what it was asked, so a test can prove
 * which records were removed, which were left alone, in what order, and with which credentials.
 *
 *   POST/GET/DELETE /api/items[/:id]     the normal case: created with a JSON id and a Location header; DELETE needs the bearer token
 *   POST /api/widgets                    created with a Location header only (no id in the body); DELETE /api/widgets/:id works
 *   POST /api/notes                      creates a record, but the API has no DELETE for it (no way to remove it)
 *   POST /api/flaky, DELETE .../:id      DELETE answers 500 until `flakyHealthy` is switched on
 *   POST /api/ghosts, DELETE .../:id     someone else already removed it: DELETE answers 404
 *   POST /api/login                      answers with an id and a token; it creates no record and must never be "cleaned"
 *   GET  /openapi.json                   the API description (no DELETE for notes)
 *
 * Every record carries `BODY_MARKER` in its body, so tests can prove that only ids and paths are ever stored.
 */
import http from "node:http";

export const BODY_MARKER = "body-marker-91c2e7";

export interface CleanupApp {
    server: http.Server;
    /** Records currently held, by resource then id. */
    readonly store: Record<string, Map<string, { id: string; name: string; seededBy: "test" | "seed" }>>;
    /** Every mutating request in order: what happened and with which Authorization header. */
    readonly log: Array<{ op: "create" | "delete" | "delete-refused"; resource: string; id: string; status: number; auth: string }>;
    readonly deletes: () => Array<{ resource: string; id: string; status: number; auth: string }>;
    flakyHealthy: boolean;
    /** When set, DELETE /api/items/:id waits this long before answering (timeout test). */
    deleteDelayMs: number;
    /** When set, Location headers point at this origin instead of the fixture itself (a hostile or confused server). */
    evilLocation: string | undefined;
    /** Pre-seeded records that no test created. */
    seed(resource: string, ids: string[]): void;
    reset(): void;
    close(): Promise<void>;
}

const RESOURCES = ["items", "widgets", "notes", "flaky", "ghosts"] as const;

export function startCleanupApp(port: number, opts: { token: string }): Promise<CleanupApp> {
    const store: CleanupApp["store"] = Object.fromEntries(RESOURCES.map((r) => [r, new Map()]));
    const log: CleanupApp["log"] = [];
    let next = 1;
    const state: { flakyHealthy: boolean; deleteDelayMs: number; evil: string | undefined } = { flakyHealthy: false, deleteDelayMs: 0, evil: undefined };
    const origin = `http://127.0.0.1:${port}`;

    const spec = {
        openapi: "3.0.3",
        info: { title: "Cleanup fixture", version: "1.0.0" },
        servers: [{ url: origin }],
        components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
        security: [{ bearer: [] }],
        paths: {
            ...Object.fromEntries(
                ["items", "flaky", "ghosts", "widgets", "notes"].map((r) => [
                    `/api/${r}`,
                    {
                        post: {
                            summary: `Create a ${r.slice(0, -1)}`,
                            requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } } } } },
                            responses: { "201": { description: "created", content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } } } } }, "400": { description: "bad request" } },
                        },
                    },
                ]),
            ),
            ...Object.fromEntries(
                ["items", "flaky", "ghosts", "widgets"].map((r) => [
                    `/api/${r}/{id}`,
                    {
                        delete: {
                            summary: `Remove a ${r.slice(0, -1)}`,
                            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
                            responses: { "204": { description: "removed" }, "404": { description: "not found" } },
                        },
                    },
                ]),
            ),
        },
    };

    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", origin);
        const auth = String(req.headers.authorization ?? "");
        const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
            res.writeHead(status, { "content-type": "application/json", ...headers });
            res.end(JSON.stringify(body));
        };
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", async () => {
            if (url.pathname === "/openapi.json") return json(200, spec);
            const m = /^\/api\/(items|widgets|notes|flaky|ghosts)(?:\/([^/]+))?$/.exec(url.pathname);
            if (url.pathname === "/api/login" && req.method === "POST") return json(200, { id: 1, token: "session-token-not-a-record" });
            if (!m) return json(404, { error: "not found" });
            const resource = m[1]!;
            const id = m[2] ? decodeURIComponent(m[2]) : undefined;
            const bucket = store[resource]!;
            if (auth !== `Bearer ${opts.token}`) return json(401, { error: "unauthorized" });
            if (req.method === "GET") {
                if (!id) return json(200, [...bucket.values()]);
                const r = bucket.get(id);
                return r ? json(200, r) : json(404, { error: "no such record" });
            }
            if (req.method === "POST" && !id) {
                let body: { name?: unknown } = {};
                try {
                    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
                } catch {
                    return json(400, { error: "bad json" });
                }
                if (typeof body.name !== "string" || !body.name) return json(400, { error: "name is required" });
                const newId = String(next++);
                bucket.set(newId, { id: newId, name: `${BODY_MARKER} ${body.name}`.slice(0, 80), seededBy: "test" });
                log.push({ op: "create", resource, id: newId, status: 201, auth });
                const loc = { location: `${state.evil ?? ""}/api/${resource}/${newId}` };
                if (resource === "widgets") return json(201, { created: true, marker: BODY_MARKER }, loc); // no id in the body: Location only
                return json(201, { id: newId, name: `${BODY_MARKER} ${body.name}` }, resource === "notes" ? {} : loc);
            }
            if (req.method === "DELETE" && id) {
                if (state.deleteDelayMs) await new Promise((r) => setTimeout(r, state.deleteDelayMs));
                if (resource === "notes") {
                    log.push({ op: "delete-refused", resource, id, status: 405, auth });
                    return json(405, { error: "no delete" });
                }
                if (resource === "flaky" && !state.flakyHealthy) {
                    log.push({ op: "delete-refused", resource, id, status: 500, auth });
                    return json(500, { error: `internal error ${BODY_MARKER}` });
                }
                if (resource === "ghosts") {
                    log.push({ op: "delete-refused", resource, id, status: 404, auth });
                    return json(404, { error: "gone already" });
                }
                const existed = bucket.delete(id);
                log.push({ op: "delete", resource, id, status: existed ? 204 : 404, auth });
                if (!existed) return json(404, { error: "no such record" });
                res.writeHead(204);
                return void res.end();
            }
            return json(405, { error: "method not allowed" });
        });
    });

    return new Promise((resolve) =>
        server.listen(port, "127.0.0.1", () => {
            const app: CleanupApp = {
                server,
                store,
                log,
                deletes: () => log.filter((l) => l.op !== "create").map((l) => ({ resource: l.resource, id: l.id, status: l.status, auth: l.auth })),
                get flakyHealthy() {
                    return state.flakyHealthy;
                },
                set flakyHealthy(v: boolean) {
                    state.flakyHealthy = v;
                },
                get deleteDelayMs() {
                    return state.deleteDelayMs;
                },
                set deleteDelayMs(v: number) {
                    state.deleteDelayMs = v;
                },
                get evilLocation() {
                    return state.evil;
                },
                set evilLocation(v: string | undefined) {
                    state.evil = v;
                },
                seed(resource, ids) {
                    for (const id of ids) store[resource]!.set(id, { id, name: `seeded ${id}`, seededBy: "seed" });
                },
                reset() {
                    for (const b of Object.values(store)) b.clear();
                    log.length = 0;
                    state.flakyHealthy = false;
                    state.deleteDelayMs = 0;
                    state.evil = undefined;
                    next = 1;
                },
                close: () => new Promise<void>((r) => (server.closeAllConnections?.(), server.close(() => r()))),
            };
            resolve(app);
        }),
    );
}
