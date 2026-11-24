/**
 * Phase 5 C2: likely cause in the code (src/engine/findings/root-cause.ts) over a code source (src/engine/findings/code-source.ts).
 * No browser, no real model: scripted doubles only.
 *
 * The bench case uses the 8 seed-pinned findings of the offline corpus (W0-1, tests/fixtures/p5-seed-findings.json: what the failed
 * attempt recorded) against examples/bench-shop as a local code source. The truth (W0-3) was written by reading server.mjs: BS-04 sits in
 * register(), reached by the form route POST /register (through formPosts) and POST /api/register; BS-06 sits in the handler of
 * PUT /api/profile. The double cites the seed's real line; one double cites a line that does not exist, and is dropped. Small sample.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkoutCodeSource, localCodeSource, repositoryCodeSource, type CodeSource } from "../src/engine/findings/code-source.js";
import { rootCause, ROOT_CAUSE_LIMITS } from "../src/engine/findings/root-cause.js";
import { FindingViewSchema, type FindingView, type FindingViewInput } from "../src/engine/findings/view.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import seeds from "./fixtures/p5-seed-findings.json" with { type: "json" };

const SHOP_DIR = path.join(import.meta.dirname, "..", "examples", "bench-shop");
const SHOP = fs.readFileSync(path.join(SHOP_DIR, "server.mjs"), "utf8");
const seedLine = (id: string) => SHOP.split("\n").findIndex((l) => l.includes(`on("${id}")`)) + 1;
/** W0-3: the function holding the seed, or the routes whose handlers reach it. */
const TRUTH: Record<string, { functions: string[]; routes: string[] }> = {
    "BS-04": { functions: ["register"], routes: ["POST /register", "POST /api/register"] },
    "BS-06": { functions: [], routes: ["PUT /api/profile"] },
};

const view = (over: Partial<FindingViewInput>): FindingView =>
    FindingViewSchema.parse({
        id: "f-1",
        projectId: "p-1",
        source: { kind: "execution", id: "t-1" },
        state: "reproduced",
        title: "A finding",
        testId: "t-1",
        detectedAt: "2026-11-21T10:00:00.000Z",
        expected: { text: "It works.", source: "R-1", stated: "explicit" },
        observed: "It did not.",
        steps: [],
        attempts: [],
        ...over,
    });
type Seed = (typeof seeds.findings)[number];
const seedView = (s: Seed): FindingView =>
    view({
        id: `${s.trial}/${s.testKey}`,
        title: s.title,
        expected: { text: s.expected, source: "R-1", stated: "explicit" },
        attempts: [1, 2].map(() => ({
            outcome: "failed" as const,
            failedStep: s.failedStep,
            error: s.error,
            requests: s.endpoints.map((e) => ({ method: e.method, path: e.path, status: e.status, own: true })),
        })),
    });

interface Seen {
    prompts: string[];
}
function scripted(answer: (prompt: string) => unknown, seen: Seen = { prompts: [] }): LlmClient & { seen: Seen } {
    return {
        modelName: "scripted",
        model: {} as LlmClient["model"],
        usage: { inputTokens: 0, outputTokens: 0 },
        seen,
        async object({ prompt, schema }) {
            seen.prompts.push(prompt);
            return schema.parse(answer(prompt));
        },
        async text() {
            throw new Error("not used");
        },
    } as LlmClient & { seen: Seen };
}
const cites = (...h: Array<[string, number]>) => () => ({ hypotheses: h.map(([file, line]) => ({ file, line, explanation: `Line ${line} decides it.` })) });

describe("the bench: seed findings of the offline corpus", () => {
    const shop = localCodeSource(SHOP_DIR, "the bench-shop source");

    it(`points at the seed's function or a handler that calls it, Strongly supported in at least 60% (${seeds.findings.length} pinned; small sample)`, async () => {
        expect(seeds.findings).toHaveLength(8);
        const results: string[] = [];
        let strong = 0;
        for (const [i, s] of seeds.findings.entries()) {
            // The last finding's double cites a line past the end of the file: dropped, never a location.
            const missing = i === seeds.findings.length - 1;
            const llm = scripted(missing ? cites(["server.mjs", SHOP.split("\n").length + 50]) : cites(["server.mjs", seedLine(s.seed)]));
            const r = await rootCause({ members: [seedView(s)], code: shop, llm });
            results.push(`${s.testKey} ${s.seed} ${r.label} ${r.location?.function ?? "-"} ${r.location?.route ?? "-"}`);
            if (missing) {
                expect(r.label).toBe("unknown");
                expect(r.location).toBeUndefined();
                expect(r.dropped.join(" ")).toMatch(/dropped/);
                continue;
            }
            expect(r.label, results.at(-1)).toBe("strongly_supported");
            const t = TRUTH[s.seed]!;
            expect(t.functions.includes(r.location!.function ?? "") || t.routes.includes(r.location!.route ?? ""), results.at(-1)).toBe(true);
            expect(r.location!.line).toBe(seedLine(s.seed));
            strong++;
        }
        expect(strong / seeds.findings.length).toBeGreaterThanOrEqual(0.6);
    });

    it("finds the handlers of the requests and the helpers they call, data operations too, without an AI", async () => {
        const bs04 = seeds.findings.find((s) => s.seed === "BS-04")!;
        const r = await rootCause({ members: [seedView(bs04)], code: shop });
        expect(r.label).toBe("unknown");
        expect(r.handlers.map((h) => h.route)).toEqual(["POST /register"]);
        expect(r.helpers.map((h) => h.function)).toEqual(expect.arrayContaining(["formPosts", "register"]));
        const reg = r.helpers.find((h) => h.function === "register")!;
        expect(seedLine("BS-04")).toBeGreaterThanOrEqual(reg.line);
        expect(seedLine("BS-04")).toBeLessThanOrEqual(reg.end!);
        expect(r.dataOps.some((d) => d.function === "register" && /db\.users/.test(d.why))).toBe(true);
        expect(r.reason).toMatch(/no AI model/);
    });

    it("a real line that no handler of the run reaches is only a Hypothesis", async () => {
        const bs04 = seeds.findings.find((s) => s.seed === "BS-04")!;
        const reg = (await rootCause({ members: [seedView(bs04)], code: shop })).helpers.find((h) => h.function === "register")!;
        // A shown context line just before register(): it exists, but lies in no reached handler or helper.
        const before = reg.line - 2;
        const r = await rootCause({ members: [seedView(bs04)], code: shop, llm: scripted(cites(["server.mjs", before])) });
        expect(r.label).toBe("hypothesis");
        expect(r.location).toMatchObject({ file: "server.mjs", line: before });
    });

    it("drops a citation of a line that was not shown, of a file that does not exist, and of a path outside the source", async () => {
        const bs06 = seeds.findings.find((s) => s.seed === "BS-06")!;
        // What is shown: ±20 numbered lines around the reached locations, within the cap.
        const first: Seen = { prompts: [] };
        await rootCause({ members: [seedView(bs06)], code: shop, llm: scripted(cites(), first) });
        const shownLines = new Set([...first.prompts[0]!.matchAll(/^(\d+)\| /gm)].map((m) => Number(m[1])));
        expect(shownLines.has(seedLine("BS-06"))).toBe(true);
        expect(shownLines.size).toBeLessThanOrEqual(ROOT_CAUSE_LIMITS.promptLines);
        const notShown = SHOP.split("\n").findIndex((_, i) => i > 0 && !shownLines.has(i + 1)) + 1;
        expect(notShown).toBeGreaterThan(0);
        const llm = scripted(cites(["server.mjs", notShown], ["missing.mjs", 3], ["../../package.json", 1], ["server.mjs", seedLine("BS-06")]));
        const r = await rootCause({ members: [seedView(bs06)], code: shop, llm });
        expect(r.dropped).toHaveLength(3);
        expect(r.dropped[0]).toContain(`server.mjs:${notShown}`);
        expect(r.label).toBe("strongly_supported");
        expect(r.location).toMatchObject({ line: seedLine("BS-06"), route: "PUT /api/profile" });
    });
});

describe("without a code source", () => {
    it("is Unknown, and asks no AI, whatever the evidence", async () => {
        const s = seeds.findings[0]!;
        const seen: Seen = { prompts: [] };
        const llm = scripted(cites(["server.mjs", seedLine(s.seed)]), seen);
        const withStack = view({ ...seedView(s), attempts: [{ outcome: "failed", stack: ["server.mjs:register"], requests: [{ method: "POST", path: "/register", status: 500, own: true }] }] });
        for (const code of [undefined, repositoryCodeSource({ owner: "acme", repo: "shop" }, "0".repeat(40), {})]) {
            const r = await rootCause({ members: [withStack], code, llm });
            expect(r.label).toBe("unknown");
            expect(r.location).toBeUndefined();
        }
        expect(seen.prompts).toHaveLength(0);
    });
});

describe("stack frames, data operations and commits", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-rc-"));
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(
        path.join(dir, "src", "app.js"),
        [
            'const express = require("express");',
            "const app = express();",
            "function total(lines) {",
            "    return lines.reduce((s, l) => s + l.price, 0) * 2;",
            "}",
            'app.get("/api/orders/:id", async (req, res) => {',
            "    const order = await db.orders.findOne({ id: req.params.id });",
            '    const key = "Bearer abcdefghijklmnop1234";',
            "    res.json({ ...order, total: total(order.lines) });",
            "});",
            "module.exports = app;",
        ].join("\n"),
    );
    const withLog: CodeSource = { ...localCodeSource(dir), log: async (f, n) => (f === "src/app.js" ? [{ sha: "abc1234", at: "2026-11-20T10:00:00Z", subject: "Double the total" }].slice(0, n) : []) };
    const order = view({
        attempts: [1, 2].map(() => ({
            outcome: "failed" as const,
            stack: ["at total (http://shop.example/src/app.js:4:12)", "at node_modules/express/lib/router.js:handle"],
            requests: [
                { method: "GET", path: "/api/orders/42?x=1", status: 200, own: true },
                { method: "GET", path: "/styles.css", status: 200, own: true },
                { method: "GET", path: "https://cdn.example/lib.js", status: 200, own: false },
            ],
        })),
    });

    it("a stack frame inside a reached helper is Strongly supported without an AI", async () => {
        const r = await rootCause({ members: [order], code: withLog });
        expect(r.label).toBe("strongly_supported");
        expect(r.location).toMatchObject({ file: "src/app.js", function: "total", line: 3, route: "GET /api/orders/{}" });
        expect(r.handlers).toEqual([expect.objectContaining({ route: "GET /api/orders/{}", line: 6 })]);
        expect(r.dataOps).toEqual([expect.objectContaining({ line: 7 })]);
        expect(r.commits).toEqual([expect.objectContaining({ sha: "abc1234", file: "src/app.js" })]);
    });

    it("masks secrets in the code it shows the AI", async () => {
        const seen: Seen = { prompts: [] };
        await rootCause({ members: [view({ ...order, attempts: order.attempts.map((a) => ({ ...a, stack: [] })) })], code: withLog, llm: scripted(cites(), seen) });
        expect(seen.prompts[0]).toContain("8| ");
        expect(seen.prompts[0]).not.toContain("abcdefghijklmnop1234");
    });

    it("a local source refuses paths that leave its folder, symlinks included", async () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-rc-out-"));
        fs.writeFileSync(path.join(outside, "secret.txt"), "top secret");
        fs.symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "link.txt"));
        const src = localCodeSource(dir);
        expect(await src.read("../" + path.basename(outside) + "/secret.txt")).toBeUndefined();
        expect(await src.read("link.txt")).toBeUndefined();
        expect(await src.has("/etc/hostname")).toBe(false);
        expect(await src.read("src/app.js", 3, 4)).toEqual(["function total(lines) {", "    return lines.reduce((s, l) => s + l.price, 0) * 2;"]);
    });

    it("the git-import checkout reads files by their object id", async () => {
        const blob = Buffer.from("line one\nline two\n");
        const c = checkoutCodeSource({ commit: "0123456789abcdef0123456789abcdef01234567", entries: [{ path: "a/b.js", type: "blob", sha: "s1", size: blob.length }, { path: "node_modules/x.js", type: "blob", sha: "s2", size: 1 }], read: async (shas) => new Map(shas.map((s) => [s, blob])) });
        expect(await c.files()).toEqual(["a/b.js"]);
        expect(await c.has("a/b.js")).toBe(true);
        expect(await c.read("a/b.js", 2, 2)).toEqual(["line two"]);
        expect(await c.read("nope.js")).toBeUndefined();
        expect(await c.log("a/b.js", 5)).toEqual([]);
        expect(c.label).toMatch(/0123456/);
    });
});
