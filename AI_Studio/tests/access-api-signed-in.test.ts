/**
 * Signed-in API access checks on the bench apps, in a real browser: the accounts have no API tokens, so the survey signs each in through
 * the sign-in form and calls the API with its session; the checks then run through the access helper the generated scripts carry.
 * Each check set must be red on its seed (BS-08 another person's order, BR-01 another user's note, BR-03 any user lists people) and
 * green on the clean app. The bench servers run on loopback ports and are stopped by this test.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import type { DraftSpec } from "../src/engine/api/test-specs.js";
import { ACCESS_HELPER_SOURCE, generateApiAccessSpecs, generateApiListSpecs, signedInRequests, surveyAccess, surveyApiAccess, surveyApiLists, type SurveyEndpoint } from "../src/engine/identity/access.js";

const helper = new Function("totpCode", "createHmac", `${ACCESS_HELPER_SOURCE}\nreturn { accessAssert };`)(() => "000000", createHmac) as { accessAssert: (page: unknown, base: string, spec: string) => Promise<void> };
const ROOT = path.resolve(__dirname, "..");
const ACCOUNTS: Record<string, string[]> = { "bench-shop": ["alice", "bob"], "bench-rbac": ["ana", "ben", "mia", "ada"] };
for (const names of Object.values(ACCOUNTS))
    for (const n of names) {
        process.env[`TEST_${n.toUpperCase()}_USERNAME`] = `${n}@example.test`;
        process.env[`TEST_${n.toUpperCase()}_PASSWORD`] = "Password1!";
    }

let port = 9640;
const children: ChildProcess[] = [];
async function start(app: string, defects: string): Promise<string> {
    const p = port++;
    const child = spawn(process.execPath, [path.join(ROOT, "examples", app, "server.mjs"), String(p)], { env: { ...process.env, BENCH_DEFECTS: defects, BENCH_LOGIN: "html" }, stdio: "ignore" });
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
    throw new Error(`${app} did not start`);
}

let browser: Browser;
beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
}, 60_000);
afterAll(async () => {
    await browser?.close();
    for (const c of children) c.kill();
});

/** The engine's survey and generation as the exploration runs them, then every check run through the script-side helper. */
async function checksOn(app: string, defects: string): Promise<Array<{ title: string; open: boolean; message: string }>> {
    const base = await start(app, defects);
    const ctx = { config: loadConfig(), llm: undefined as never, emit: () => undefined };
    const roles = ACCOUNTS[app]!.map((name) => ({ name, username: `${name}@example.test`, password: "Password1!" }));
    const endpoints: SurveyEndpoint[] = parseOpenApi(await (await fetch(`${base}/openapi.json`)).json(), `${base}/openapi.json`).operations.map((a) => ({ method: a.method, path: a.path, called: a.path, statuses: a.statuses }));
    const reach = await surveyAccess(ctx, browser, `${base}/`, roles, { maxPages: 20, maxDepth: 3, perPattern: 3 });
    const { sessions, close } = await signedInRequests(ctx, browser, `${base}/`, roles);
    let specs: DraftSpec[];
    try {
        const viewers = roles.filter((r) => sessions.has(r.name)).map((r) => ({ name: r.name, request: sessions.get(r.name)! }));
        expect(viewers.length).toBe(roles.length);
        const lists = await surveyApiLists(viewers, base, endpoints);
        const vertical = await surveyApiAccess(sessions.get("anonymous")!, base, endpoints, roles, 12, sessions);
        specs = [...generateApiListSpecs(lists), ...generateApiAccessSpecs(vertical, { maxSpecs: 8, reach }).filter((s) => s.kind === "web")];
    } finally {
        await close();
    }
    const page = await (await browser.newContext()).newPage();
    const out = [];
    for (const s of specs) {
        const expected = String((s.steps[1] as { expected: string }).expected);
        const err = await helper.accessAssert(page, `${base}/`, expected).then(() => undefined, (e: Error) => e);
        out.push({ title: s.title, open: Boolean(err?.message.startsWith("Access control check failed:")), message: err?.message ?? "" });
    }
    await page.context().close();
    return out;
}

describe("signed-in API access checks on the bench apps", () => {
    it("bench-shop: alice and bob each refused the other's order; open on BS-08", async () => {
        const seeded = await checksOn("bench-shop", "BS-08");
        const clean = await checksOn("bench-shop", "none");
        const cross = ["“alice” account: cannot read a record of “bob” through the API (GET /api/orders/ord-1001)", "“bob” account: cannot read a record of “alice” through the API (GET /api/orders/ord-1000)"];
        expect(seeded.filter((c) => c.title.includes("record of")).map((c) => c.title)).toEqual(cross);
        expect(seeded.filter((c) => cross.includes(c.title)).every((c) => c.open)).toBe(true);
        expect(clean.map((c) => c.title)).toEqual(seeded.map((c) => c.title));
        expect(clean.filter((c) => c.open || c.message)).toEqual([]);
    }, 240_000);

    it("bench-rbac: notes of another user (BR-01) and the people list (BR-03) are refused when clean and open when seeded", async () => {
        const seeded = await checksOn("bench-rbac", "BR-01,BR-03");
        const clean = await checksOn("bench-rbac", "none");
        const titles = seeded.map((c) => c.title);
        expect(titles).toEqual(
            expect.arrayContaining([
                "“ana” account: cannot read a record of “ben” through the API (GET /api/notes/n2)",
                "“ben” account: cannot read a record of “ana” through the API (GET /api/notes/n1)",
                "“ana” account: cannot call GET /api/admin/users",
                "“ben” account: cannot call GET /api/admin/users",
                "“mia” account: cannot call GET /api/admin/users",
            ]),
        );
        expect(titles.some((t) => t.startsWith("“ada” account"))).toBe(false);
        expect(seeded.filter((c) => !c.open)).toEqual([]);
        expect(clean.map((c) => c.title)).toEqual(titles);
        expect(clean.filter((c) => c.open || c.message)).toEqual([]);
        // one seed at a time: BR-03 alone opens only the people list
        const br03 = await checksOn("bench-rbac", "BR-03");
        expect(br03.filter((c) => c.open).map((c) => c.title).sort()).toEqual(titles.filter((t) => t.includes("/api/admin/users")).sort());
    }, 360_000);
});
