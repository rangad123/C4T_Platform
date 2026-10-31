/**
 * The external security scanners, against the platform's own vulnerable fixture, with the real binaries. Skipped unless
 * SECURITY_TEST_FIXTURE_URL is set AND the platform's own fixture is running at it, AND the tool is installed. To run:
 *
 *   node examples/security-fixture/server.mjs 5310
 *   SECURITY_TEST_FIXTURE_URL=http://127.0.0.1:5310 npx vitest run tests/security-scanner-integration.test.ts
 *   SECURITY_NUCLEI_TEMPLATES=examples/security-fixture/templates SECURITY_NUCLEI_PATH=... (already in your path)
 *
 * The defaults of nuclei/schemathesis/promptfoo path discovery are used. Each test that does not find its tool says so and skips
 * rather than failing. There is no port to bind from this test, no browser, no test data beyond the fixture.
 */
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZapAdapter } from "../src/security/scanners/zap/adapter.js";
import { NucleiAdapter } from "../src/security/scanners/nuclei/adapter.js";
import { SchemathesisAdapter } from "../src/security/scanners/schemathesis/adapter.js";
import { PromptfooAdapter } from "../src/security/scanners/promptfoo/adapter.js";
import { scannerSettings } from "../src/security/scanners/settings.js";

const base = process.env.SECURITY_TEST_FIXTURE_URL;
const describeIf = base ? describe : describe.skip;
const FIXTURE_TEMPLATES = path.resolve("examples/security-fixture/templates");
// The operator's own environment decides which tools are found and how ZAP is addressed; only the bounds are fixed here, so a test
// run finds the same binaries the platform would.
const settings = scannerSettings({
    ...process.env,
    SECURITY_SCANNERS: "zap,nuclei,schemathesis,promptfoo",
    ...(process.env.SECURITY_NUCLEI_TEMPLATES ? {} : { SECURITY_NUCLEI_TEMPLATES: FIXTURE_TEMPLATES }),
    SECURITY_SCANNER_MAX_RPS: "5",
    SECURITY_SCANNER_REQUEST_BUDGET: "200",
    // Generous enough for schemathesis to finish fuzzing the fixture's operation; the adapter still caps every run by it.
    SECURITY_SCANNER_MAX_MINUTES: "12",
});

const target = (urls: string[]) => {
    const origin = new URL(base!).origin;
    return {
        applicationId: "fixture",
        origin,
        urls,
        excludedPaths: ["/admin"],
        maxRequestsPerSecond: 3,
        requestBudget: 200,
        // The run's own time limit. Generous here because schemathesis is slow on Windows even against a tiny fixture.
        // The run's own time limit. Schemathesis is given 80% of it and uses the rest to write its report out.
        timeoutMs: 180_000,
        spec: null,
        aiInterface: null,
    };
};

let apiDoc: string | null = null;
beforeAll(async () => {
    if (!base) return;
    // /openapi.json is what the fixture serves. Schemathesis needs the text, not a URL, so the adapter can rewrite servers.
    try {
        const response = await fetch(new URL("/openapi.json", base));
        apiDoc = response.ok ? await response.text() : null;
    } catch {
        apiDoc = null;
    }
}, 30_000);

describeIf("external scanners against the platform's fixture", () => {
    it("Nuclei: every fixture template fires against the matching page, and /admin is never asked", async () => {
        const adapter = new NucleiAdapter({ settings });
        const available = await adapter.available();
        if (available.state !== "available") {
            console.warn("skip: nuclei is not available - " + (available.reason ?? available.state));
            return;
        }
        // conservative-active, not passive: at the passive profile the adapter passes nuclei's own -passive, which leaves out any template
        // nuclei does not judge passive (verified on nuclei 3.11.1: 1 of these 3 survives it). Which templates are passive is nuclei's call,
        // not the platform's, so this test runs the profile where the reviewed templates actually run.
        const out = await adapter.start(target([`${base}/`, `${base}/search?q=hello`, `${base}/debug/config.json`]), "conservative-active", { signal: AbortSignal.timeout(240_000) });
        const results = await out.results();
        await out.cleanup();
        const ids = results.findings.map((f) => f.scannerRuleId);
        expect(ids.some((i) => i.includes("missing-security-headers"))).toBe(true);
        expect(ids.some((i) => i.includes("exposed-debug-config"))).toBe(true);
        expect(ids.some((i) => i.includes("reflected-xss-search"))).toBe(true);
        for (const f of results.findings) {
            expect(String(f.url)).not.toMatch(/\/admin/);
        }
        // Every finding says which template produced it and quotes its own evidence, so a person can judge it.
        for (const f of results.findings) {
            expect(f.evidence.length).toBeGreaterThan(0);
        }
    }, 300_000);

    it("Schemathesis: the uploaded API document drives the requests, and /admin is never asked", async () => {
        const adapter = new SchemathesisAdapter({ settings });
        const available = await adapter.available();
        if (available.state !== "available") {
            console.warn("skip: schemathesis is not available - " + (available.reason ?? available.state));
            return;
        }
        expect(apiDoc).toBeTruthy();
        const t = target([`${base}/`, `${base}/api/books`]);
        const withSpec = { ...t, spec: { fileName: "openapi.json", text: apiDoc! } };
        // Schemathesis is slow: most of the wall clock is its own start-up and strategy generation, not the handful of requests it sends.
        const out = await adapter.start(withSpec, "passive", { signal: AbortSignal.timeout(300_000) });
        const results = await out.results();
        await out.cleanup();
        // Schemathesis is allowed to report zero findings (the document is well-formed) or to report a real contradiction. Either is
        // honest. What it must NOT do is request anything under /admin.
        for (const f of results.findings) {
            expect(String(f.url)).not.toMatch(/\/admin/);
        }
        // The coverage list always says which operations were exercised, so a report is readable.
        expect(results.coverage.inspected.length + results.coverage.notInspected.length).toBeGreaterThan(0);
        // And it must not claim it exercised nothing. The fixture's API matches its document, so a correct run finds nothing at all, and the
        // operation count used to be read only from failing records - which made a perfect run report "0 operations".
        expect(results.coverage.inspected.join(" ")).not.toMatch(/for 0 operations/);
    }, 300_000);

    it("Promptfoo: runs only the reviewed cases, says the AI case ids in evidence, and never reaches an excluded path", async () => {
        // The fixture exposes /ai/chat (and /ai/chat/completions for promptfoo). Both answer in the same way.
        const aiBase = base!.replace(/\/$/, "") + "/ai";
        const adapter = new PromptfooAdapter({ settings });
        const available = await adapter.available();
        if (available.state !== "available") {
            console.warn("skip: promptfoo is not available - " + (available.reason ?? available.state));
            return;
        }
        const t = target([aiBase + "/chat"]);
        const withAi = { ...t, aiInterface: { kind: "http-chat" as const, url: aiBase + "/chat" } };
        const out = await adapter.start(withAi, "passive", { signal: AbortSignal.timeout(240_000) });
        const results = await out.results();
        await out.cleanup();
        const known = ["control-benign-question", "instruction-disclosure", "prompt-injection-override", "prompt-injection-indirect", "sensitive-credential-disclosure", "sensitive-configuration-disclosure", "excessive-agency-claimed-action", "unsafe-tool-use-claimed-action"];
        // Every finding must name one of the reviewed cases (prefixed with the tool that raised it) - never a case nobody reviewed.
        for (const f of results.findings) {
            const id = String(f.scannerRuleId).replace(/^promptfoo:/, "");
            expect(known).toContain(id);
        }
    }, 300_000);

    it("ZAP: reports in plain words whether its daemon is up, and which of the two failure modes is in play", async () => {
        // The fixture for ZAP needs a running daemon, which is not provided here. This test is honest about that: it never tries to
        // start a daemon, and the adapter's health view distinguishes the two real failure modes by what it says.
        const adapter = new ZapAdapter({ settings });
        const available = await adapter.available();
        if (available.state === "available") {
            // A real daemon is up (the operator set SECURITY_ZAP_URL and SECURITY_ZAP_API_KEY). A passive run asks for the pages, and the
            // fixture deliberately has no security headers, so real ZAP rules must fire on it.
            const out = await adapter.start(target([`${base}/`, `${base}/search?q=hello`]), "passive", { signal: AbortSignal.timeout(240_000) });
            const results = await out.results();
            await out.cleanup();
            for (const f of results.findings) {
                expect(String(f.url)).not.toMatch(/\/admin/);
            }
            // A daemon that answers but reports nothing would look exactly like a working scan that found nothing, so the scan has to
            // prove itself. ZAP's own alert ids are the proof: 10021 (X-Content-Type-Options) and 10038 (CSP) are two of its passive
            // header rules, and the fixture answers without either header.
            const ids = results.findings.map((f) => f.scannerRuleId);
            expect(ids.some((i) => i === "zap:10021")).toBe(true);
            expect(ids.some((i) => i === "zap:10038")).toBe(true);
            // Every finding carries ZAP's own severity and something a person can read, not just an id.
            for (const f of results.findings) {
                expect(f.severity).toMatch(/^(low|medium|high|critical)$/);
                expect(f.title.length).toBeGreaterThan(0);
                expect(f.url).toContain(new URL(base!).host);
            }
            // And the coverage says what was and was not done, rather than implying a full test.
            expect(results.coverage.inspected.join(" ")).toMatch(/passive rules ran/);
            expect(results.coverage.notInspected.join(" ")).toMatch(/Only passive rules ran/);
        } else {
            // Every way ZAP can be unusable has to come with a reason and a fix that applies to it. Asserting one fixed sentence here
            // only ever tested whichever failure the machine happened to be in.
            expect(["unavailable", "not_configured", "misconfigured"]).toContain(available.state);
            expect(available.reason).toBeTruthy();
            expect(available.remedy).toBeTruthy();
            // The fix must name something concrete to change, never "try again".
            expect(available.remedy).toMatch(/SECURITY_ZAP_URL|SECURITY_ZAP_API_KEY|SECURITY_SCANNERS|zap\.sh|Check that ZAP is running/);
            // The two reachability failures need opposite fixes, so they must be told apart in the words themselves: telling an operator
            // to "check that ZAP is running" while ZAP is running with its API closed costs them an afternoon.
            if (/closed the connection/.test(available.reason ?? "")) expect(available.remedy).toMatch(/api\.enabled=true/);
            if (/could not be reached|refused the API key/.test(available.reason ?? "")) expect(available.remedy).not.toMatch(/api\.enabled=true/);
        }
    }, 300_000);
});

afterAll(() => { /* nothing to close; the fixture is the operator's */ });