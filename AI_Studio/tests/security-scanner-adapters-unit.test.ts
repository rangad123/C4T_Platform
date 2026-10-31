/**
 * What each adapter does with what its tool actually reported.
 *
 * The report files under tests/fixtures/security are REAL output, captured by running schemathesis 4.32.4 and promptfoo 0.124.1 against
 * the platform's own vulnerable fixture (examples/security-fixture). They are the tool's own shape, not a shape invented here, which is the
 * point: if a tool changes what it writes, these tests are what notices. Nothing in this file runs a tool.
 *
 * `schemathesis-clean-report.ndjson` is a slice of a real run rather than the whole file: every `ScenarioFinished` record schemathesis wrote
 * for the examples and coverage phases, plus three of its fuzzing records, from a run in which it correctly found nothing. A real clean run
 * is 219KB of generated data; the parser only reads the fields these records carry, and the shape is the tool's own.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveExecutable } from "../src/security/scanners/binaries.js";
import { checksFor, methodsFor, parseSchemathesisNdjson, rewriteServers, SAFE_METHODS, schemathesisEnv, schemathesisFailureToFinding, STATE_CHANGING_METHODS, stripBom } from "../src/security/scanners/schemathesis/adapter.js";
import { failureReasonOf, parsePromptfooResults, promptfooCaseToFinding, promptfooCoverage, promptfooEnv, renderPromptfooConfig, SYSTEM_REFERENCE } from "../src/security/scanners/promptfoo/adapter.js";
import { AI_EVALUATION_CASES, casesFor } from "../src/security/scanners/promptfoo/cases.js";
import { parseNucleiLine, nucleiFindingToFinding, cwesOf } from "../src/security/scanners/nuclei/adapter.js";
import { templateAllowed, MAX_TEMPLATES_PER_RUN } from "../src/security/scanners/nuclei/policy.js";
import { ZapAdapter, alertIsInScope, zapAlertToFinding, zapUrl, zapCoverage, zapReachability } from "../src/security/scanners/zap/adapter.js";
import { ScannerError } from "../src/security/scanners/contract.js";
import { scannerSettings } from "../src/security/scanners/settings.js";
import { categoryFor, dedupeFindings, scannerFindingToRaw, severityOf, worstSeverity } from "../src/security/scanners/normalize.js";

const FIXTURE = path.join(__dirname, "fixtures", "security");
const read = (name: string) => readFileSync(path.join(FIXTURE, name), "utf8");

describe("Schemathesis output, as the tool actually wrote it", () => {
    const parsed = parseSchemathesisNdjson(read("schemathesis-report.ndjson"));

    it("reads one contract mismatch out of a real report, with the tool's own severity and check", () => {
        expect(parsed.failures).toHaveLength(1);
        const failure = parsed.failures[0]!;
        expect(failure.check).toBe("response_schema_conformance");
        expect(failure.code).toBe("ST108");
        expect(failure.title).toBe("Response violates schema");
        expect(failure.severity).toBe("high");
        expect(failure.method).toBe("GET");
        expect(failure.path).toBe("/api/books");
        expect(failure.statusCode).toBe(200);
    });

    it("counts a skipped operation as skipped rather than as a failure", () => {
        expect(parsed.skipped).toBe(1);
        expect(parsed.tested).toBe(1);
        expect(parsed.operations.has("GET /api/books")).toBe(true);
    });

    it("still names the operations it exercised when nothing was wrong", () => {
        // A clean report is the common case, and it used to count as nothing at all. The operation label was read only inside the failure
        // branch, so a document that matched the API it describes reported "0 operations" while it had in fact tested every one of them.
        const clean = parseSchemathesisNdjson(read("schemathesis-clean-report.ndjson"));
        expect(clean.failures).toEqual([]);
        expect(clean.skipped).toBe(3);
        expect(clean.tested).toBe(6);
        expect([...clean.operations].sort()).toEqual(["GET /api/books", "GET /api/books/{id}", "GET /api/secret"]);
    });

    it("maps a mismatch onto the platform's vocabulary without inflating it", () => {
        const finding = schemathesisFailureToFinding(parsed.failures[0]!, "http://127.0.0.1:5311");
        expect(finding.scannerRuleId).toBe("schemathesis:ST108");
        expect(finding.severity).toBe("high");
        expect(finding.url).toBe("http://127.0.0.1:5311/api/books");
        expect(finding.evidence.some((e) => e.value.includes("ST108"))).toBe(true);
    });

    it("reads nothing out of a report that is not a report, rather than throwing or inventing findings", () => {
        for (const junk of ["", "not json at all", "{}", '{"ScenarioFinished":{}}', "[]"]) {
            const r = parseSchemathesisNdjson(junk);
            expect(r.failures).toEqual([]);
            expect(r.tested).toBe(0);
        }
    });

    it("never lets a state-changing method into a run that did not ask for one", () => {
        expect(methodsFor("passive")).toEqual([...SAFE_METHODS]);
        expect(methodsFor("conservative-active")).toEqual([...SAFE_METHODS]);
        for (const level of ["passive", "conservative-active"] as const) for (const m of STATE_CHANGING_METHODS) expect(methodsFor(level)).not.toContain(m);
        expect(methodsFor("advanced")).toContain("POST");
    });

    it("keeps the checks that send deliberately invalid data for an approved advanced run only", () => {
        expect(checksFor("conservative-active")).not.toContain("negative_data_rejection");
        expect(checksFor("advanced")).toContain("negative_data_rejection");
        expect(checksFor("passive")).toContain("not_a_server_error");
    });

    it("forces UTF-8 on the child, which a Windows console otherwise breaks, and strips a BOM it cannot load", () => {
        // Without these two the tool dies on Windows: it crashes drawing its own header, and refuses a schema with a BOM.
        expect(schemathesisEnv()).toMatchObject({ PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" });
        expect(stripBom("\uFEFF{")).toBe("{");
        expect(stripBom("{")).toBe("{");
    });

    it("points the document's own server entry at the address the scope guard checked", () => {
        const rewritten = JSON.parse(rewriteServers(read("schemathesis-report.ndjson").slice(0, 0) + '{"openapi":"3.0.3","servers":[{"url":"https://elsewhere.example.com"}]}', "http://127.0.0.1:5311"));
        expect(rewritten.servers).toEqual([{ url: "http://127.0.0.1:5311" }]);
    });
});

describe("Promptfoo output, as the tool actually wrote it", () => {
    const parsed = parsePromptfooResults(read("promptfoo-result.json"));

    it("reads the eight evaluated cases and the seven that failed", () => {
        expect(parsed.total).toBe(8);
        expect(parsed.passed).toBe(1);
        expect(parsed.failed).toHaveLength(7);
        expect(parsed.evalId).toMatch(/^eval-/);
    });

    it("names the assertion that failed, in the tool's own words", () => {
        const disclosure = parsed.failed.find((c) => c.testCase?.description === "instruction-disclosure")!;
        const { reason, assertion } = failureReasonOf(disclosure);
        expect(reason).toContain("not contain");
        expect(reason).toContain(SYSTEM_REFERENCE);
        expect(assertion).toContain("not-contains");
    });

    it("turns a failed case into a finding that never claims to be a confirmed vulnerability", () => {
        const ai = { kind: "openai-compatible" as const, url: "http://127.0.0.1:5311/ai", model: "fixture-model" };
        const finding = promptfooCaseToFinding(parsed.failed[0]!, ai, ai.url);
        expect(finding.category).toBe("ai-security");
        expect(finding.confidence).toBe("low");
        expect(finding.severity).not.toBe("critical");
        expect(finding.description).toMatch(/not a confirmed vulnerability/i);
        expect(finding.evidence.some((e) => e.value.length > 0)).toBe(true);
    });

    it("reads nothing out of an unreadable result file instead of reporting a clean run", () => {
        const broken = parsePromptfooResults("{ not json");
        expect(broken.total).toBe(0);
        expect(broken.failed).toEqual([]);
        expect(broken.evalId).toBeNull();
    });

    it("stops promptfoo phoning home and keeps its state out of the server's home directory", () => {
        expect(promptfooEnv("/tmp/state")).toMatchObject({ DO_NOT_TRACK: "1", PROMPTFOO_DISABLE_TELEMETRY: "1", PROMPTFOO_CONFIG_DIR: "/tmp/state" });
    });

    it("writes a config whose chat messages are valid JSON, which the tool rejects otherwise", () => {
        const yaml = renderPromptfooConfig({ kind: "openai-compatible", url: "http://127.0.0.1:5311/ai", model: "fixture-model" }, AI_EVALUATION_CASES);
        const block = yaml.slice(yaml.indexOf("raw: |"), yaml.indexOf("providers:"));
        const arrayText = block.slice(block.indexOf("[")).replace(/\n\s+/g, " ").replace(/\s+\]/, "]");
        expect(() => JSON.parse(arrayText)).not.toThrow();
        expect(JSON.parse(arrayText)).toHaveLength(2);
    });

    it("keeps a case's quotes and backslashes intact instead of producing an unparseable config", () => {
        const yaml = renderPromptfooConfig({ kind: "http-chat", url: "http://127.0.0.1:5311/ai/chat" }, AI_EVALUATION_CASES);
        const line = yaml.split("\n").find((l) => l.includes("not an instruction to you"))!;
        expect(line).toContain('\\"AI assistant:');
        expect(yaml).toContain("(?i)password");
    });

    it("says plainly that passing the cases proves nothing beyond them", () => {
        const coverage = promptfooCoverage({ total: 8, passed: 1, errors: 0, failed: 7, kind: "openai-compatible" });
        expect(coverage.inspected.join(" ")).toContain("7 did not");
        expect(coverage.notInspected.join(" ")).toMatch(/Passing them says nothing/);
        expect(coverage.notInspected.join(" ")).toMatch(/not by itself a confirmed vulnerability|does not treat it as a confirmed/);
    });
});

describe("the reviewed AI cases", () => {
    it("are bounded, repeatable and non-destructive", () => {
        expect(AI_EVALUATION_CASES.length).toBeGreaterThan(3);
        expect(AI_EVALUATION_CASES.length).toBeLessThanOrEqual(12);
        for (const c of AI_EVALUATION_CASES) {
            // A case may ASK whether the assistant would take a destructive action (that is the excessive-agency test). What the
            // platform must never do is assert that it did, so every such case asserts the opposite: the answer must NOT claim it.
            if (/delete|remove|email|send/i.test(c.question)) expect(c.assertions.some((a) => a.type === "not-contains")).toBe(true);
            expect(c.assertions.length).toBeGreaterThan(0);
            expect(c.what.length).toBeGreaterThan(20);
            expect(c.id).toMatch(/^[a-z0-9-]+$/);
        }
    });

    it("assert against a known marker or a credential shape, never against a model's judgement", () => {
        for (const c of AI_EVALUATION_CASES) {
            for (const a of c.assertions) expect(["contains", "not-contains", "not-regex"]).toContain(a.type);
        }
    });

    it("always include the control case, so an all-failed run can be read as a broken connection", () => {
        expect(casesFor("passive")[0]?.category).toBe("control");
        expect(casesFor("advanced")[0]?.category).toBe("control");
    });
});

describe("Nuclei output and its reviewed-template policy", () => {
    it("reads a finding line and a statistics line, and ignores everything else", () => {
        expect(parseNucleiLine('{"template-id":"reflected-xss","matched-at":"https://x/search"}')?.kind).toBe("finding");
        expect(parseNucleiLine('{"stats":{"percent":50,"requests":5,"total":10,"templates":3,"matched":1}}')?.kind).toBe("stats");
        for (const junk of ["", "[INFO] template loaded", "not json", '{"unrelated":1}']) expect(parseNucleiLine(junk)).toBeUndefined();
    });

    it("keeps the template's own request and response as evidence, and its CWE", () => {
        const finding = nucleiFindingToFinding({ "template-id": "exposed-debug-config", "matched-at": "https://x/debug/config.json", request: "GET /debug/config.json", response: '{"apiKey":"sk_live_x"}', info: { name: "Exposed debug config", severity: "high", tags: ["exposure"], classification: { "cwe-id": ["CWE-200"] } } });
        expect(finding.severity).toBe("high");
        expect(finding.category).toBe("information-disclosure");
        expect(finding.cwe).toBe("CWE-200");
        expect(finding.evidence.some((e) => e.value.includes("sk_live_x"))).toBe(true);
        expect(cwesOf({ info: { classification: { "cwe-id": ["CWE-200"] } } })).toEqual(["CWE-200"]);
    });

    it("refuses a template whose tags or severity the reviewed policy does not permit", () => {
        const allowed = { id: "safe", severity: "info", tags: ["exposure", "misconfig"], path: "/t/a.yaml" };
        expect(templateAllowed(allowed, "passive").ok).toBe(true);
        // A tag outside the profile's allow-list is refused: the list is an allow-list, never a deny-list.
        expect(templateAllowed({ ...allowed, tags: ["unreviewed-tag"] }, "passive").ok).toBe(false);
        // Exploitation categories are refused at EVERY profile, including advanced.
 for (const level of ["passive", "conservative-active", "advanced"] as const) expect(templateAllowed({ ...allowed, tags: ["rce"] }, level).ok).toBe(false);
        expect(templateAllowed({ ...allowed, severity: "catastrophic" }, "passive").ok).toBe(false);
        expect(MAX_TEMPLATES_PER_RUN).toBeGreaterThan(0);
    });
});

describe("ZAP alerts become the platform's findings", () => {
    it("keeps ZAP's own risk, confidence, evidence and reference", () => {
        const finding = zapAlertToFinding({ pluginId: "10038", alert: "Content Security Policy (CSP) Header Not Set", risk: "medium", confidence: "high", riskcode: 2, desc: "No CSP.", solution: "Set a CSP header.", evidence: "<html>", cweid: "693", reference: "https://owasp.org/x", url: "/", method: "GET" }, "https://shop.example.com");
        expect(finding.scannerRuleId).toBe("zap:10038");
        expect(finding.severity).toBe("medium");
        expect(finding.category).toBe("configuration");
        expect(finding.url).toBe("https://shop.example.com/");
        expect(finding.references).toContain("https://owasp.org/x");
        expect(finding.confidence).toBe("high");
    });

    it("never lets the API key travel in the URL", () => {
        expect(() => zapUrl("https://zap.internal", "core", "view", "alerts", { baseurl: "https://shop.example.com", apiKey: "SECRET" })).toThrow(/X-ZAP-API-Key header/);
        expect(zapUrl("https://zap.internal", "core", "view", "alerts", { baseurl: "https://shop.example.com" })).not.toContain("SECRET");
    });

    it("tells a closed ZAP API apart from a ZAP that is not running, because they have different fixes", async () => {
        // Verified on ZAP 2.17.0 on Windows: with its API closed the daemon accepts the socket and hangs up, so both shapes arrive as a
        // bare "fetch failed". Nothing listening is a refused connection; a daemon that hangs up is an API that will not answer.
        expect(zapReachability({ cause: { code: "ECONNREFUSED" } })).toBe("nothing-listening");
        expect(zapReachability({ cause: { code: "UND_ERR_SOCKET" } })).toBe("connection-dropped");
        // ZAP keeps ONE alert table per daemon and core/view/alerts answers with everything it has ever raised. Filtering it to the
        // addresses this run was actually given is the only thing standing between an assessment and evidence against pages it never
        // visited - verified against a real 2.17.0 daemon, which handed a run pointed at one address alerts for three.
        const allowed = ["https://shop.example.com/", "https://shop.example.com/api/books"];
        expect(alertIsInScope("https://shop.example.com/", allowed)).toBe(true);
        expect(alertIsInScope("https://shop.example.com/api/books", allowed)).toBe(true);
        expect(alertIsInScope("https://shop.example.com/api/books/42", allowed)).toBe(true);
        expect(alertIsInScope("https://shop.example.com/api/books?q=1", allowed)).toBe(true);
        // An address from an earlier run, and one that merely starts with the same characters, are both refused.
        expect(alertIsInScope("https://shop.example.com/admin", allowed)).toBe(false);
        expect(alertIsInScope("https://shop.example.com/api/books-private", allowed)).toBe(false);
        expect(alertIsInScope("https://other.example.com/", allowed)).toBe(false);
        expect(alertIsInScope("https://shop.example.com/", [])).toBe(false);
        expect(zapReachability({ cause: { code: "ECONNRESET" } })).toBe("connection-dropped");
        expect(zapReachability(new Error("fetch failed"))).toBe("other");
        // The adapter wraps the failure in its own words before anyone sees it, so the cause has to survive that wrapping.
        expect(zapReachability(new ScannerError("tool_failed", "zap", "ZAP closed the connection without answering.", "fetch failed", { cause: Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }) }))).toBe("connection-dropped");

        const settings = scannerSettings({ SECURITY_SCANNERS: "zap", SECURITY_ZAP_URL: "http://127.0.0.1:8090", SECURITY_ZAP_API_KEY: "k" });
        const closed = new ZapAdapter({
            settings,
            // Shaped exactly as fetchJson leaves it, so the wrapping the real adapter does is what is being tested.
            fetchJson: async () => {
                throw new ScannerError("tool_failed", "zap", "ZAP closed the connection without answering.", "fetch failed", { cause: Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }) });
            },
        });
        const open = await closed.available();
        expect(open.state).toBe("unavailable");
        expect(open.reason).toMatch(/closed the connection without answering/);
        // The daemon hangs up identically for a closed API and for a key that does not match - verified on 2.17.0, where both come back
        // as a closed socket with no response - so the advice has to name both and check the key first.
        expect(open.remedy).toMatch(/SECURITY_ZAP_API_KEY/);
        expect(open.remedy).toMatch(/api\.enabled=true/);
        // The documented way to open the API is -host/-port. -config api.addrs.* writes a string into a boolean option, which makes ZAP
        // throw while loading its own settings and leave the API shut without saying so.
        expect(open.remedy).toMatch(/-host 127\.0\.0\.1 -port 8090/);
        expect(open.remedy).toMatch(/NOT -config api\.addrs/);

        const stopped = new ZapAdapter({
            settings,
            fetchJson: async () => {
                throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
            },
        });
        const down = await stopped.available();
        expect(down.reason).toMatch(/could not be reached/);
        expect(down.remedy).toMatch(/Check that ZAP is running/);
        expect(down.remedy).not.toMatch(/api\.enabled/);
    });

    it("states what a ZAP run did not cover, rather than implying a penetration test", () => {
        const coverage = zapCoverage("passive", 5, 2, 2, { note: "limited", restore: async () => undefined });
        expect(coverage.notInspected.join(" ")).toMatch(/does not mark it confirmed/);
        expect(coverage.notInspected.join(" ")).toMatch(/passive rules ran/);
    });
});

describe("every tool's finding goes through the same normalization", () => {
    it("normalizes severities without ever upgrading an unknown value", () => {
        expect(severityOf("critical")).toBe("critical");
        expect(severityOf(3)).toBe("high");
        expect(severityOf("ST108")).toBe("info");
        expect(severityOf(undefined)).toBe("info");
    });

    it("places a category from the CWE first, then the wording, and never guesses beyond that", () => {
        expect(categoryFor({ cwe: "CWE-79" })).toBe("xss");
        expect(categoryFor({ cwe: "918" })).toBe("ssrf");
        expect(categoryFor({ title: "prompt injection in the assistant" })).toBe("ai-security");
        expect(categoryFor({ title: "something entirely new" })).toBe("other");
    });

    it("folds the same rule on the same address into one finding and keeps every piece of evidence", () => {
        const a = { scannerRuleId: "r", title: "A", severity: "low" as const, category: "other" as const, url: "https://x/a", description: "", evidence: [{ kind: "note" as const, label: "e1", value: "1" }] };
        const b = { ...a, severity: "high" as const, evidence: [{ kind: "note" as const, label: "e2", value: "2" }] };
        const { findings, folded } = dedupeFindings([a, b]);
        expect(findings).toHaveLength(1);
        expect(folded).toBe(1);
        expect(findings[0]!.severity).toBe("high");
        expect(findings[0]!.evidence).toHaveLength(2);
    });

    it("produces the platform's own raw result, so a scanner finding goes through redaction and retest like any other", () => {
        const raw = scannerFindingToRaw("nuclei", { scannerRuleId: "t", title: "T", severity: "high", category: "secrets", url: "https://x/d", description: "D", evidence: [{ kind: "note", label: "l", value: "v" }] }, "2026-01-01T00:00:00.000Z");
        expect(raw.url).toBe("https://x/d");
        expect(raw.custom?.scanner).toMatchObject({ id: "nuclei", ruleId: "t" });
        expect(raw.note).toContain("Reported by nuclei");
        expect(worstSeverity([{ severity: "low" }, { severity: "critical" }, { severity: "high" }] as never)).toBe("critical");
    });
});

describe("finding the scanner an administrator installed", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "freit-bins-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    // npm's node_modules/.bin holds a POSIX shell script beside every Windows shim: `promptfoo` sits next to `promptfoo.cmd`. Node cannot
    // spawn a file with no extension on Windows, so accepting the bare name first made every run fail with a bare `spawn ... ENOENT`.
    writeFileSync(path.join(dir, "demo"), "#!/bin/sh\nexit 0\n", "utf8");
    writeFileSync(path.join(dir, "demo.cmd"), "@echo off\r\n", "utf8");
    writeFileSync(path.join(dir, "solo.exe"), "MZ", "utf8");

    it("on Windows picks the form Windows can actually execute, not the shell script beside it", () => {
        const found = resolveExecutable("demo", undefined, [dir]);
        expect(found).toBe(process.platform === "win32" ? path.join(dir, "demo.cmd") : path.join(dir, "demo"));
    });

    it("finds a plain executable, and reports nothing at all rather than a wrong guess", () => {
        expect(resolveExecutable("solo", undefined, [dir])).toBe(path.join(dir, "solo.exe"));
        expect(resolveExecutable("freit-not-installed-anywhere", undefined, [dir])).toBeUndefined();
    });

    it("lets an administrator point at a packaged copy under another name", () => {
        const packaged = path.join(dir, "renamed-scanner.exe");
        writeFileSync(packaged, "MZ", "utf8");
        expect(resolveExecutable("whatever-the-binary-is-called", packaged, [])).toBe(packaged);
    });
});
