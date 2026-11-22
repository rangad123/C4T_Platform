/**
 * Phase 5 F3: duplicate detection. Two different seeds with identical error text stay apart; three sightings of one seed in different
 * runs group under one stable id; the same source needs two more strong signals; a chain cannot pull two issues together; a person's
 * split holds on the next run. On the W0-1 corpus rows (several trials of bench-shop): no group mixes two seeds.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dedupe, mergeRefusal, signatureOf, splitPairs } from "../src/engine/findings/dedupe.js";
import { FindingViewSchema, type FindingView, type FindingViewInput } from "../src/engine/findings/view.js";

const ERROR = "Error: expect(locator).toHaveValue(expected) failed";
type AttemptIn = NonNullable<FindingViewInput["attempts"]>[number];

function finding(id: string, day: number, o: { source?: string | null; target?: string; endpoint?: string; steps?: string[]; stack?: string[]; issue?: string; requirements?: string[] }): FindingView {
    const steps = (o.steps ?? ["navigate:/account", "fill:Default delivery address", "click:Save", "assert:Default delivery address"]).map((s) => {
        const [action, target] = s.split(":") as [string, string];
        return action === "navigate" ? { action, url: target } : { action, target };
    });
    const attempt: AttemptIn = {
        outcome: "failed",
        failedStep: steps.length,
        check: "value",
        target: o.target ?? "Default delivery address",
        error: ERROR,
        page: `http://shop.test/account?run=${day}`,
        requests: o.endpoint ? [{ method: o.endpoint.split(" ")[0]!, path: o.endpoint.split(" ")[1]!, status: 500, own: true }] : [],
        stack: o.stack ?? [],
    };
    return FindingViewSchema.parse({
        id,
        projectId: "p1",
        source: { kind: "exploration", id: `t-${id}` },
        state: "candidate",
        title: id,
        testId: `t-${id}`,
        detectedAt: `2026-11-${String(day).padStart(2, "0")}T10:00:00.000Z`,
        expected: { text: "x", source: o.source === undefined ? "R-address" : o.source, stated: "explicit" },
        observed: "x",
        steps,
        attempts: [attempt, attempt],
        requirements: o.requirements ?? [],
        ...(o.issue ? { issueId: o.issue } : {}),
    });
}

describe("dedupe", () => {
    it("keeps two different seeds with identical error text apart", () => {
        // BS-06 (saved address not kept) and BS-04 (invalid email accepted): the same Playwright message, nothing else in common.
        const a = finding("bs06", 1, {});
        const b = finding("bs04", 1, { source: "R-email", target: "Email", steps: ["navigate:/register", "fill:Email", "click:Create account", "assert:Email"] });
        expect(signatureOf(a).error).toBe(signatureOf(b).error);
        expect(dedupe([a, b])).toHaveLength(2);
    });

    it("never merges on the source and the message alone, nor on one signal", () => {
        const a = finding("a", 1, {});
        const b = finding("b", 2, { target: "Name", steps: ["navigate:/account", "fill:Name", "click:Save", "assert:Name"] });
        expect(mergeRefusal(signatureOf(a), signatureOf(b))).toMatch(/Only the source agrees/);
        const c = finding("c", 3, { steps: ["navigate:/register", "click:Account", "fill:Default delivery address", "click:Save", "assert:Default delivery address"] });
        expect(mergeRefusal(signatureOf(a), signatureOf(c))).toMatch(/Only the source and the failing check agree/);
        expect(dedupe([a, b, c])).toHaveLength(3);
    });

    it("groups three sightings of one seed in different runs under the first sighting's id, keeping every member", () => {
        const runs = [finding("run3", 3, {}), finding("run1", 1, {}), finding("run2", 2, {})];
        const groups = dedupe(runs);
        expect(groups).toHaveLength(1);
        expect(groups[0]!.memberIds).toEqual(["run1", "run2", "run3"]);
        expect(groups[0]!.why.run2).toMatch(/failing check, action sequence/);
        // A later run joins the same id.
        expect(dedupe([...runs, finding("run4", 4, {})])[0]!.id).toBe(groups[0]!.id);
    });

    it("needs the same source: different expectations with the same check, steps and endpoint stay apart", () => {
        const a = finding("a", 1, { endpoint: "POST /api/account" });
        const b = finding("b", 2, { endpoint: "POST /api/account", source: "R-name" });
        expect(mergeRefusal(signatureOf(a), signatureOf(b))).toMatch(/different sources/);
        expect(dedupe([a, finding("n", 2, { source: null })])).toHaveLength(2);
    });

    it("counts the endpoint (ids as :id), the app stack frames (lines dropped) and a linked issue as strong signals", () => {
        const steps = (n: number) => ["navigate:/orders", `click:Order ${n}`, "assert:Total"];
        const a = finding("a", 1, { steps: steps(1), target: "Total", endpoint: "GET /api/orders/17", stack: ["server.mjs:orderTotal:120:9"] });
        const b = finding("b", 2, { steps: ["navigate:/orders", "click:Open", "assert:Sum"], target: "Sum", endpoint: "GET /api/orders/99", stack: ["server.mjs:orderTotal:121:3"] });
        expect(signatureOf(a).endpoint).toBe("GET /api/orders/:id");
        expect(dedupe([a, b])).toHaveLength(1);
        const c = finding("c", 1, { steps: ["navigate:/x"], target: "X", issue: "GH-42", endpoint: "GET /api/x" });
        const d = finding("d", 2, { steps: ["navigate:/y"], target: "Y", issue: "GH-42", endpoint: "GET /api/x" });
        expect(dedupe([c, d])).toHaveLength(1);
    });

    it("joins a group only when it matches every member, so a chain cannot mix issues", () => {
        // a~b on (check, actions); b~c on (stack, linked issue); a and c share only the source.
        const a = finding("a", 1, {});
        const b = finding("b", 2, { stack: ["s.mjs:b:1"], issue: "GH-1" });
        const c = finding("c", 3, { stack: ["s.mjs:b:1"], issue: "GH-1", target: "Other", steps: ["navigate:/other"] });
        const groups = dedupe([a, b, c]);
        expect(groups.map((g) => g.memberIds)).toEqual([["a", "b"], ["c"]]);
    });

    it("refuses a merge when both name a different endpoint or different stack frames, whatever else agrees", () => {
        const a = finding("a", 1, { endpoint: "POST /api/address", stack: ["server.mjs:saveAddress:10"] });
        const b = finding("b", 2, { endpoint: "POST /api/geocode", stack: ["geo.mjs:geocode:3"] });
        expect(mergeRefusal(signatureOf(a), signatureOf(b))).toMatch(/Different endpoints/);
        const c = finding("c", 2, { endpoint: "POST /api/address", stack: ["geo.mjs:geocode:3"] });
        expect(mergeRefusal(signatureOf(a), signatureOf(c))).toBe("Different stack frames.");
        // A server error on one side only: different symptoms.
        expect(mergeRefusal(signatureOf(a), signatureOf(finding("n", 2, {})))).toBe("Only one of them had a server error.");
        // Minified and library frames say nothing about the issue; a moved line in a named frame does not split it.
        const m1 = finding("m1", 1, { stack: ["at e (http://shop.test/assets/index-Ab12cd.js:1:1234)", "at x (node_modules/react/index.js:9:1)"] });
        expect(signatureOf(m1).stack).toBeNull();
        const b1 = finding("b1", 1, { stack: ["at saveAddress (/app/address-service.js:120:9)"] });
        const b2 = finding("b2", 2, { stack: ["at saveAddress (/app/address-service.js:124:3)"] });
        expect(dedupe([b1, b2])).toHaveLength(1);
        // A stray own 404 (a favicon) is not the failing endpoint.
        const fav = FindingViewSchema.parse({ ...finding("fav", 1, {}), attempts: [{ ...finding("fav", 1, {}).attempts[0]!, requests: [{ method: "GET", path: "/favicon.ico", status: 404, own: true }] }] });
        expect(signatureOf(fav).endpoint).toBeNull();
    });

    it("tells numbered fields apart but not counts in brackets", () => {
        const l1 = finding("l1", 1, { target: "Address line 1" });
        const l2 = finding("l2", 2, { target: "Address line 2" });
        expect(dedupe([l1, l2])).toHaveLength(2);
        expect(signatureOf(finding("c3", 1, { target: "Cart (3)" })).check).toBe(signatureOf(finding("c12", 1, { target: "Cart (12)" })).check);
    });

    it("takes the signature from the application failures, not from replays the environment or the test's own step broke", () => {
        const env = { outcome: "failed" as const, failedStep: 1, check: "visible", target: "Sign in", environment: "Sign-in refused", requests: [{ method: "POST", path: "/api/login", status: 401, own: true }] };
        const withEnv = (f: FindingView) => FindingViewSchema.parse({ ...f, attempts: [f.attempts[0], env, env] });
        const e1 = withEnv(finding("e1", 1, {}));
        const e2 = withEnv(finding("e2", 2, { target: "Coupon", steps: ["navigate:/cart", "fill:Coupon", "click:Apply", "assert:Coupon"] }));
        expect(signatureOf(e1).endpoint).toBeNull();
        expect(dedupe([e1, e2])).toHaveLength(2);
    });

    it("never merges across projects, and groups 800 sightings quickly", () => {
        expect(dedupe([finding("a", 1, {}), { ...finding("b", 2, {}), projectId: "p2" }])).toHaveLength(2);
        const many = Array.from({ length: 800 }, (_, i) => ({ ...finding(`s${i}`, 1, {}), detectedAt: new Date(Date.UTC(2026, 10, 1) + i * 1000).toISOString() }));
        const t0 = performance.now();
        const groups = dedupe(many, [["s0", "s1"]]);
        expect(performance.now() - t0).toBeLessThan(3000);
        expect(groups.map((g) => g.memberIds.length)).toEqual([1, 1, 798]);
    });

    it("orders by time, not by the timestamp's spelling", () => {
        const o1 = finding("o1", 1, {});
        const o2 = { ...finding("o2", 1, {}), detectedAt: "2026-11-01T10:00:00.400Z" };
        const o3 = { ...finding("o3", 1, {}), detectedAt: "2026-11-01T09:00:00-05:00" };
        expect(dedupe([o3, o2, o1]).map((g) => g.memberIds)).toEqual([["o1", "o2", "o3"]]);
    });

    it("keeps a person's split on the next run", () => {
        const fs3 = [finding("r1", 1, {}), finding("r2", 2, {}), finding("r3", 3, {})];
        const [group] = dedupe(fs3);
        const apart = splitPairs(group!, ["r3"]);
        expect(apart).toEqual([
            ["r1", "r3"],
            ["r2", "r3"],
        ]);
        const after = dedupe(fs3, apart);
        expect(after.map((g) => g.memberIds)).toEqual([["r1", "r2"], ["r3"]]);
        expect(after[0]!.id).toBe(group!.id);
        // A new sighting that looks like both sides of the split joins neither: it waits on its own for a person.
        const later = dedupe([...fs3, finding("r4", 4, {})], apart);
        expect(later.map((g) => g.memberIds)).toEqual([["r1", "r2"], ["r3"], ["r4"]]);
        expect(() => splitPairs(group!, ["zz"])).toThrow(/Not in this group: zz/);
        expect(() => splitPairs(group!, ["r1", "r2", "r3"])).toThrow(/leaves some members/);
    });
});

describe("dedupe on the W0-1 corpus rows", () => {
    const corpus = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "p5-corpus-findings.json"), "utf8")) as Array<{
        truth: { seed: string | null };
        view: FindingViewInput;
    }>;
    it("never puts two seeds in one group, per project or all together", () => {
        const views = corpus.map((r) => FindingViewSchema.parse(r.view));
        const seed = new Map(corpus.map((r, i) => [views[i]!.id, r.truth.seed]));
        const mixed = (groups: ReturnType<typeof dedupe>) => groups.filter((g) => new Set(g.memberIds.map((m) => seed.get(m)).filter(Boolean)).size > 1);
        expect(mixed(dedupe(views))).toEqual([]);
        for (const p of new Set(views.map((v) => v.projectId))) expect(mixed(dedupe(views.filter((v) => v.projectId === p)))).toEqual([]);
    });
});
