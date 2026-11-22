/**
 * The run's database check service (Phase 4 C10): how a script's `dbCheck` step reaches the run's `DatabaseProbe` without holding any
 * database access. It listens on loopback only, for one validation run, behind a random bearer token that goes to the scripts in their
 * environment (DB_CHECK_URL, DB_CHECK_TOKEN) and dies with the run. A request names a check (./checks.ts) and the test values it uses;
 * the answer is the probe's result: counts, keyed fingerprints and masked keys, never row contents.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { DB_CHECK_NAME_MAX, parseDbCheck, resolveParams } from "./checks.js";
import type { Step } from "../spec/schema.js";
import { DatabaseCheckRefused, type DatabaseProbe } from "./probe.js";

/** Bounds: a request body, and the checks one run may make (40 steps, each read before and at the step, over a few repeats). */
const BODY_MAX = 16 * 1024;
export const DB_SERVICE_CALLS_MAX = 2000;

const RequestSchema = z.object({ name: z.string().min(1).max(DB_CHECK_NAME_MAX), vars: z.record(z.string().max(63), z.string().max(2000)).default({}) }).strict();

export interface DbCheckService {
    url: string;
    token: string;
    close(): Promise<void>;
}

class CapReached extends Error {}

export async function startDbCheckService(probe: DatabaseProbe, maxCalls = DB_SERVICE_CALLS_MAX): Promise<DbCheckService> {
    const token = randomBytes(24).toString("base64url");
    const want = Buffer.from(`Bearer ${token}`);
    let calls = 0;
    const server = http.createServer((req, res) => {
        const send = (status: number, body: unknown) => {
            res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
            res.end(JSON.stringify(body));
        };
        const got = Buffer.from(req.headers.authorization ?? "");
        if (got.length !== want.length || !timingSafeEqual(got, want)) return send(401, { error: "not authorised" });
        if (req.method !== "POST" || req.url !== "/check") return send(404, { error: "POST /check only" });
        const full = () => send(429, { error: `more than ${maxCalls} database checks in one run` });
        // Every call to the probe counts, the second try with numbers too: the cap is on what reaches the database.
        const ask = (t: Parameters<DatabaseProbe["check"]>[0], p: Parameters<DatabaseProbe["check"]>[1]) => {
            if (++calls > maxCalls) throw new CapReached();
            return probe.check(t, p);
        };
        if (calls >= maxCalls) return full();
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (c: Buffer) => {
            size += c.length;
            if (size > BODY_MAX) req.destroy();
            else chunks.push(c);
        });
        req.on("end", () => {
            void (async () => {
                try {
                    const body = RequestSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
                    if (!body.success) return send(400, { error: "a check is { name, vars } with text values" });
                    const { template, params } = parseDbCheck(body.data.name);
                    const values = resolveParams(params, body.data.vars);
                    let r = await ask(template, values);
                    // A test value is text (a captured id); a numeric key column stores a number: try the numbers once.
                    const nums = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, typeof v === "string" && /^-?\d{1,15}$/.test(v) ? Number(v) : v]));
                    if (template.kind === "exists" && r.count === 0 && JSON.stringify(nums) !== JSON.stringify(values) && calls < maxCalls) r = await ask(template, nums);
                    send(200, { kind: r.kind, table: r.table, count: r.count, ids: r.ids, examples: r.examples });
                } catch (e) {
                    if (e instanceof CapReached) return full();
                    // A refusal names the rule; any other failure (the back end) says so in one line, never with the request's values.
                    send(e instanceof DatabaseCheckRefused ? 400 : 502, { error: e instanceof DatabaseCheckRefused ? e.message : `the database could not be read (${(e instanceof Error ? e.message : String(e)).slice(0, 200)})` });
                }
            })();
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}/check`,
        token,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

/**
 * The service for one validation run, when it is needed and can be reached: a probe is set up, a test has a database check, and the
 * scripts run on this machine (a runner agent elsewhere cannot reach loopback here; its database steps are skipped with a note).
 */
export async function dbServiceFor(probe: DatabaseProbe | undefined, specs: ReadonlyArray<{ steps: readonly Step[] }>, remote: boolean): Promise<DbCheckService | undefined> {
    if (!probe || remote || !specs.some((s) => s.steps.some((x) => x.action === "assertResponse" && x.check === "dbCheck"))) return undefined;
    return await startDbCheckService(probe);
}
