/**
 * C3e writes as a second or lesser identity, on bench-rbac in a real browser: the checks are generated from the signed-in API survey (lists
 * and the vertical survey) and the API description, then run through the access helper the generated scripts carry, one at a time.
 * Each must be red on its own seed (BR-02 a shared reader edits, BR-04 a manager makes itself admin, BR-06 a revoked share is still
 * readable) and green on the clean app, within 8 writes. The bench reset between tests is verified: what the checks wrote is gone after
 * it. The bench servers run on loopback ports and are stopped by this test.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import { ACCESS_HELPER_SOURCE, signedInRequests, surveyApiAccess, surveyApiLists, type SurveyEndpoint } from "../src/engine/identity/access.js";
import { generateIdentityWriteSpecs, MAX_IDENTITY_WRITES } from "../src/engine/identity/identity-writes.js";

const helper = new Function("totpCode", "createHmac", "IGNORE_HTTPS_ERRORS", `${ACCESS_HELPER_SOURCE}\nreturn { accessAssert };`)(() => "000000", createHmac, false) as { accessAssert: (page: unknown, base: string, spec: string) => Promise<void> };
const ROOT = path.resolve(__dirname, "..");
const NAMES = ["ana", "ben", "mia", "ada"];
for (const n of NAMES) {
    process.env[`TEST_${n.toUpperCase()}_USERNAME`] = `${n}@example.test`;
    process.env[`TEST_${n.toUpperCase()}_PASSWORD`] = "Password1!";
}
const RESET = "reset-token-for-identity-writes";

let port = 9680;
const children: ChildProcess[] = [];
async function start(defects: string): Promise<string> {
    const p = port++;
    const child = spawn(process.execPath, [path.join(ROOT, "examples", "bench-rbac", "server.mjs"), String(p)], { env: { ...process.env, BENCH_DEFECTS: defects, BENCH_LOGIN: "html", BENCH_RESET_TOKEN: RESET }, stdio: "ignore" });
    children.push(child);
    const base = `http://127.0.0.1:${p}`;
    for (let i = 0; i < 100; i++) {
        try {
            if ((await fetch(`${base}/openapi.json`)).ok) return base;
        } catch {
            /* not up yet */
        }
        await sleep(100);
    }
    throw new Error("bench-rbac did not start");
}

let browser: Browser;
beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
}, 60_000);
afterAll(async () => {
    await browser?.close();
    for (const c of children) c.kill();
});

/** What the checks can change: who reads Ben's shared note and every account's role, read by the owner and the admin. */
async function snapshot(base: string): Promise<string> {
    const as = async (who: string) => {
        const r = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `${who}@example.test`, password: "Password1!" }) });
        const sid = /sid=[^;]+/.exec(r.headers.get("set-cookie") ?? "")?.[0];
        if (!sid) throw new Error(`no session for ${who}`);
        return (p: string) => fetch(`${base}${p}`, { headers: { cookie: sid } }).then((x) => x.text());
    };
    return JSON.stringify([await (await as("ben"))("/api/notes/n3"), await (await as("ada"))("/api/admin/users")]);
}

const writesOf = (kind: string) => ({ owner: 1, role: 2, revoke: 1 })[kind] ?? 99;

/** The engine's survey and generation as the exploration runs them, then each check through the script-side helper, in order. */
async function checksOn(defects: string): Promise<{ base: string; before: string; checks: Array<{ title: string; open: boolean; message: string }>; writes: number }> {
    const base = await start(defects);
    const before = await snapshot(base);
    const ctx = { config: loadConfig(), llm: undefined as never, emit: () => undefined };
    const roles = NAMES.map((name) => ({ name, username: `${name}@example.test`, password: "Password1!" }));
    const apis = parseOpenApi(await (await fetch(`${base}/openapi.json`)).json(), `${base}/openapi.json`).operations;
    const endpoints: SurveyEndpoint[] = apis.map((a) => ({ method: a.method, path: a.path, called: a.path, statuses: a.statuses }));
    const { sessions, close } = await signedInRequests(ctx, browser, `${base}/`, roles);
    let specs;
    try {
        expect([...sessions.keys()].sort()).toEqual(["anonymous", ...NAMES].sort());
        const lists = await surveyApiLists(roles.map((r) => ({ name: r.name, request: sessions.get(r.name)! })), base, endpoints);
        const access = await surveyApiAccess(sessions.get("anonymous")!, base, endpoints, roles, 12, sessions);
        specs = generateIdentityWriteSpecs({ apis, lists, access });
    } finally {
        await close();
    }
    const page = await (await browser.newContext()).newPage();
    const checks = [];
    let writes = 0;
    for (const s of specs) {
        const cfg = String((s.steps[1] as { expected: string }).expected);
        writes += writesOf(JSON.parse(cfg).identityWrite);
        const err = await helper.accessAssert(page, `${base}/`, cfg).then(() => undefined, (e: Error) => e);
        checks.push({ title: s.title, open: Boolean(err?.message.startsWith("Access control check failed:")), message: err?.message ?? "" });
    }
    await page.context().close();
    return { base, before, checks, writes };
}

async function reset(base: string): Promise<void> {
    expect((await fetch(`${base}/__bench/reset`, { method: "POST", headers: { "x-bench-reset": RESET } })).status).toBe(200);
}

const OWNER = "“ana” account: cannot change a record it does not own (PUT /api/notes/n3)";
const REVOKE = "“ben” account stops sharing /api/notes/n3 with “ana”: “ana” can no longer read it";
const ROLE = (who: string) => `“${who}” account: cannot change its own role (PATCH /api/admin/users/{id})`;
const TITLES = [OWNER, REVOKE, ROLE("ana"), ROLE("ben"), ROLE("mia")];

describe("writes as a second or lesser identity (bench-rbac)", () => {
    it("is green on the clean app within 8 writes, and the bench reset puts back what the checks wrote", async () => {
        const clean = await checksOn("none");
        expect(clean.checks.map((c) => c.title)).toEqual(TITLES);
        expect(clean.checks.filter((c) => c.open || c.message)).toEqual([]);
        expect(clean.writes).toBeLessThanOrEqual(MAX_IDENTITY_WRITES);
        // The revoke is a real write: the share is gone until the bench is reset between tests.
        expect(await snapshot(clean.base)).not.toBe(clean.before);
        await reset(clean.base);
        expect(await snapshot(clean.base)).toBe(clean.before);
    }, 240_000);

    it("is red on BR-02, BR-04 and BR-06, each on its own seed only", async () => {
        const opened = async (seed: string) => {
            const r = await checksOn(seed);
            expect(r.checks.map((c) => c.title)).toEqual(TITLES);
            expect(r.checks.filter((c) => !c.open && c.message)).toEqual([]);
            if (seed === "BR-04") {
                // The accepted role change was changed back by the check itself; only the revoke's own write is left for the reset.
                expect(r.checks.find((c) => c.open)?.message).toMatch(/it was changed back\./);
                expect(JSON.parse(await snapshot(r.base))[1]).toBe(JSON.parse(r.before)[1]);
            }
            await reset(r.base);
            expect(await snapshot(r.base)).toBe(r.before);
            return r.checks.filter((c) => c.open);
        };
        const br02 = await opened("BR-02");
        expect(br02.map((c) => c.title)).toEqual([OWNER]);
        expect(br02[0]!.message).toMatch(/^Access control check failed: 1 write may be open to an account that is not the owner\n- \[high\] A signed-in “ana” user, who reads this record but does not own it, sent PUT \/api\/notes\/n3 and it was accepted \(HTTP 200\) \(documented: HTTP 403 or 404\)/);
        expect((await opened("BR-04")).map((c) => c.title)).toEqual([ROLE("mia")]);
        const br06 = await opened("BR-06");
        expect(br06.map((c) => c.title)).toEqual([REVOKE]);
        expect(br06[0]!.message).toMatch(/“ana” could still call GET \/api\/notes\/n3 \(HTTP 200\)/);
        expect(br06.map((c) => c.message).join("")).not.toMatch(/sid=|Password1|example\.test/);
    }, 480_000);
});
