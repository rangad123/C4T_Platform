/**
 * Security Assessment findings (FIND): redaction, normalization of the existing read-only checks' wording, deduplication across
 * assessments, validation states and history, manual entry, retests, the overview's risk rules, and the HTML/CSV report contents.
 * Pure and database-only: no browser, no server, no network (the PDF and the routes are covered in security-findings-api.test.ts).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { evaluateSecurity, type SecurityCall, type SecurityCheck } from "../src/engine/security/checks.js";
import { Db } from "../src/platform/db.js";
import { Repo } from "../src/platform/repo.js";
import { SecretBox } from "../src/platform/secrets.js";
import { SecurityStore } from "../src/security/store.js";
import { fromCheckFailure, ingest, retestTargets, type RawResult } from "../src/security/findings/ingest.js";
import { normalize, splitProblemFix } from "../src/security/findings/normalize.js";
import { assessRisk, computeOverview } from "../src/security/findings/overview.js";
import { redactCookie, redactExcerpt, redactHeader, redactText } from "../src/security/findings/redact.js";
import { buildReport, csvCell, renderReportCsv, renderReportHtml } from "../src/security/findings/report.js";
import { changeValidation, createManualFinding, FindingError, ManualFinding } from "../src/security/findings/service.js";

// Values that must never survive into anything stored or exported.
const SENTINELS = {
    cookie: "COOKIEVALUE-SENTINEL-77aa",
    env: "ENVSECRET-SENTINEL-55bb",
    bearer: "BEARERTOKEN-SENTINEL-99cc",
    email: "jane.client@sentinel-mail.example",
    hex: "a3f9c2e1b4d5f6a7b8c9d0e1f2a3b4c5d6e7f8a9",
    password: "PASSWORD-SENTINEL-11dd",
};

const call = (url: string, over: Partial<SecurityCall> = {}): SecurityCall => ({ status: 200, headers: { "content-type": "text/html" }, text: "<html><body>ok</body></html>", url, ...over });

async function results(check: SecurityCheck, c: SecurityCall, expected?: string): Promise<RawResult[]> {
    const msg = await evaluateSecurity(check, [c], expected);
    return msg ? fromCheckFailure(check, msg, c) : [];
}

describe("redaction", () => {
    it("hides secrets, cookie values, e-mail addresses and long keys, and keeps what the evidence is about", () => {
        const t = redactText(`Authorization: Bearer ${SENTINELS.bearer} sent by ${SENTINELS.email} key ${SENTINELS.hex} https://bob:${SENTINELS.password}@x.example/a?token=${SENTINELS.bearer}&page=2 {"password": "${SENTINELS.password}"} password=${SENTINELS.password}`);
        for (const s of Object.values(SENTINELS)) expect(t).not.toContain(s);
        expect(t).toContain("page=2");
        expect(t).toContain("[email hidden]");
        expect(redactText("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk")).toBe("[hidden]");
        // The facts a finding is about survive.
        expect(redactText("Access-Control-Allow-Credentials: true")).toBe("Access-Control-Allow-Credentials: true");
        expect(redactHeader("Server", "nginx/1.18.0 (Ubuntu)")).toBe("nginx/1.18.0 (Ubuntu)");
        expect(redactHeader("Authorization", "Basic dXNlcjpwYXNz")).toBe("[hidden]");
        expect(redactCookie(`sid=${SENTINELS.cookie}; Path=/; SameSite=Lax`)).toBe("sid=[hidden]; Path=/; SameSite=Lax");
        expect(redactHeader("cookie", `a=${SENTINELS.cookie}; b=2`)).toBe("a=[hidden]; b=[hidden]");
    });

    it("keeps only the key names of an .env-like excerpt", () => {
        const out = redactExcerpt(`APP_NAME=shop\nDB_PASSWORD=${SENTINELS.env}\nexport STRIPE_KEY = ${SENTINELS.env}\n# comment`);
        expect(out).not.toContain(SENTINELS.env);
        expect(out).not.toContain("shop");
        expect(out).toContain("APP_NAME=[hidden]");
        expect(out).toContain("DB_PASSWORD=[hidden]");
        expect(out).toContain("export STRIPE_KEY = [hidden]");
    });
});

describe("normalization of the existing checks' lines", () => {
    it("splits problem and fix as the checks write them", () => {
        expect(splitProblemFix('The Server header reveals the software version ("nginx/1.2"), which helps. Hide the version in the server settings.')).toEqual({
            problem: 'The Server header reveals the software version ("nginx/1.2"), which helps.',
            fix: "Hide the version in the server settings.",
        });
    });

    it("missing headers are one site-wide finding each, with the header as received and browser steps", async () => {
        const a = await results("securityHeaders", call("http://shop.test:8080/products?id=7"));
        const b = await results("securityHeaders", call("http://shop.test:8080/about"));
        expect(a.length).toBe(4); // plain http: no HSTS judgement
        const da = a.map((r) => normalize(r)!);
        const db = b.map((r) => normalize(r)!);
        expect(da.map((d) => d.fingerprint).sort()).toEqual(db.map((d) => d.fingerprint).sort());
        const csp = da.find((d) => d.title === "Content-Security-Policy header missing")!;
        expect(csp).toMatchObject({ category: "headers", severity: "medium", confidence: "high", location: "http://shop.test:8080", seenOn: "http://shop.test:8080/products", initialValidation: "probable" });
        expect(csp.remediation).toMatch(/^Add a Content-Security-Policy header/);
        expect(csp.description).toMatch(/^Content-Security-Policy is missing/);
        expect(csp.reproduction).toMatch(/F12/);
        expect(csp.evidence[0]).toMatchObject({ kind: "response-header", label: "Content-Security-Policy", value: "(not sent)" });
    });

    it("a session cookie keeps its name and flags, never its value", async () => {
        const [r] = await results("cookieFlags", call("https://shop.test/login", { setCookies: [`session_id=${SENTINELS.cookie}; Path=/`] }));
        const d = normalize(r!)!;
        expect(d.title).toBe('Session cookie "session_id" missing protective flags');
        expect(d.severity).toBe("medium");
        expect(d.category).toBe("cookies");
        expect(JSON.stringify(d)).not.toContain(SENTINELS.cookie);
        expect(d.evidence.find((e) => e.kind === "cookie")!.value).toBe("session_id=[hidden]; Path=/");
    });

    it("an exposed .env is critical, per path, with key names only", async () => {
        const [r] = await results("noExposedFiles", call("http://shop.test/.env", { headers: { "content-type": "text/plain" }, text: `APP_KEY=${SENTINELS.env}\nDB_PASSWORD=${SENTINELS.env}\n` }));
        const d = normalize(r!)!;
        expect(d).toMatchObject({ category: "exposed-files", severity: "critical", location: "http://shop.test/.env", title: "Sensitive file publicly readable: /.env" });
        expect(JSON.stringify(d)).not.toContain(SENTINELS.env);
        expect(d.evidence.find((e) => e.kind === "body-excerpt")!.value).toContain("DB_PASSWORD=[hidden]");
    });

    it("CORS, version banners and directory listings keep their severity and evidence", async () => {
        const [cors] = await results("corsPolicy", call("http://shop.test/api/me", { headers: { "access-control-allow-origin": "https://untrusted-origin.example", "access-control-allow-credentials": "true" }, sent: { origin: "https://untrusted-origin.example" } }));
        const c = normalize(cors!)!;
        expect(c).toMatchObject({ category: "cors", severity: "high", location: "http://shop.test/api/me" });
        expect(c.evidence.map((e) => e.value)).toContain("true");
        const banner = await results("noInfoDisclosure", call("http://shop.test/", { headers: { server: "Apache/2.4.1", "content-type": "text/html" } }));
        expect(normalize(banner[0]!)).toMatchObject({ title: "Server header reveals the software version", severity: "low", location: "http://shop.test" });
        const listing = await results("noInfoDisclosure", call("http://shop.test/uploads/", { text: "<html><title>Index of /uploads</title></html>" }));
        expect(normalize(listing[0]!)).toMatchObject({ title: "Directory listing enabled: /uploads/", severity: "medium", location: "http://shop.test/uploads" });
    });

    it("ignores lines that are not problems, and takes custom problems with their own wording", () => {
        expect(normalize({ check: "securityHeaders", line: "- ...and 2 more", url: "http://x.test/" })).toBeUndefined();
        const d = normalize({ check: "other", url: "http://x.test/a", custom: { key: "mixed", title: "Mixed content", category: "configuration", severity: "low", description: "d", impact: "i", remediation: "r" } })!;
        expect(d).toMatchObject({ title: "Mixed content", initialValidation: "needs-review", confidence: "medium" });
    });
});

describe("findings in the store", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-secfind-"));
    const db = new Db(path.join(tmp, "db.sqlite"));
    const repo = new Repo(db, new SecretBox(tmp, "x".repeat(32)));
    repo.ensureDefaultUser();
    const projectId = String(repo.createProject({ name: "Client A" }).id);
    const store = new SecurityStore(db);
    const app = store.createApplication(projectId, { name: "Shop", targetUrl: "http://shop.test/", environment: "staging", excludedPaths: ["/admin"] });
    const auth = store.addAuthorization(app.id, { basis: "client-permission", approverName: "Jane Client", approverEmail: SENTINELS.email, documentReference: "SOW-12", restrictions: "Weekdays only", statement: "I confirm.", confirmedByName: "Tester" });
    const newAssessment = (retestOf?: string) => store.createAssessment({ applicationId: app.id, authorizationId: auth.id, startedBy: "Tester", retestOf });
    afterAll(() => {
        db.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    const pageResults = async (url: string, cookie = true) => [
        ...(await results("securityHeaders", call(url))),
        ...(cookie ? await results("cookieFlags", call(url, { setCookies: [`sid=${SENTINELS.cookie}`] })) : []),
    ];

    let first: ReturnType<typeof newAssessment>;
    it("deduplicates within and across assessments and keeps what people decided", async () => {
        first = newAssessment();
        const rs = [...(await pageResults("http://shop.test/")), ...(await pageResults("http://shop.test/about")), ...(await results("noExposedFiles", call("http://shop.test/.env", { headers: { "content-type": "text/plain" }, text: `SECRET=${SENTINELS.env}\n` })))];
        const s1 = await ingest(store, first, rs);
        expect(s1).toMatchObject({ created: 6, updated: 0 });
        const all = store.listFindings({ projectId });
        expect(all.length).toBe(6);
        const csp = all.find((f) => f.title === "Content-Security-Policy header missing")!;
        expect(csp.validation).toBe("probable");
        expect(csp.evidence.find((e) => /^Seen on 2 addresses/.test(e.label))!.value).toBe("http://shop.test/\nhttp://shop.test/about");
        store.setValidation(csp.id, "false-positive", { comment: "CSP is set by the CDN" });

        const second = newAssessment();
        const s2 = await ingest(store, second, await pageResults("http://shop.test/"));
        expect(s2).toMatchObject({ created: 0, updated: 5 });
        const again = store.getFinding(csp.id)!;
        expect(again.validation).toBe("false-positive");
        expect(again.firstAssessmentId).toBe(first.id);
        expect(again.lastAssessmentId).toBe(second.id);
        expect(store.listFindings({ projectId }).every((f) => f.validation !== "confirmed")).toBe(true);
    });

    it("a retest marks what is gone as fixed and notes what is still there; an unfinished retest marks nothing", async () => {
        const original = newAssessment();
        await ingest(store, original, [...(await pageResults("http://shop.test/")), ...(await results("noExposedFiles", call("http://shop.test/.env", { headers: { "content-type": "text/plain" }, text: "A=1\n" })))]);
        const targets = retestTargets(store, original.id);
        expect(targets.some((t) => t.location === "http://shop.test/.env")).toBe(true);

        const partial = newAssessment(original.id);
        const sp = await ingest(store, partial, await pageResults("http://shop.test/", false), { retestComplete: false });
        expect(sp.markedFixed).toBe(0);
        const env = store.listFindings({ projectId, categories: ["exposed-files"] })[0]!;
        expect(env.validation).toBe("probable");
        expect(store.findingHistory(env.id).at(-1)!.comment).toMatch(/did not finish/);

        const retest = newAssessment(original.id);
        const s = await ingest(store, retest, await pageResults("http://shop.test/", false));
        expect(s.markedFixed).toBe(2); // the .env file and the cookie
        expect(s.stillPresent).toBe(3); // three open headers (CSP is a false positive)
        const fixed = store.getFinding(env.id)!;
        expect(fixed.validation).toBe("fixed");
        expect(store.findingHistory(env.id).at(-1)).toMatchObject({ from: "probable", to: "fixed", assessmentId: retest.id });

        const report = buildReport(db, { assessmentId: retest.id })!;
        expect(report.retest!.fixed.map((f) => f.title).sort()).toEqual(["Sensitive file publicly readable: /.env", 'Session cookie "sid" missing protective flags']);
        expect(report.retest!.stillPresent.length).toBe(3);

        // Seen again later: open again, for a person to look at.
        const later = newAssessment();
        const s3 = await ingest(store, later, await results("noExposedFiles", call("http://shop.test/.env", { headers: { "content-type": "text/plain" }, text: "A=1\n" })));
        expect(s3.reopened).toBe(1);
        expect(store.getFinding(env.id)!.validation).toBe("needs-review");
    });

    it("validation changes keep history; false positive and accepted risk need a reason", () => {
        const f = store.listFindings({ projectId, validations: ["probable"] })[0]!;
        expect(() => changeValidation(store, f, { validation: "accepted-risk" })).toThrow(FindingError);
        const after = changeValidation(store, f, { validation: "confirmed", comment: `Checked with ${SENTINELS.email}` });
        expect(after.validation).toBe("confirmed");
        const h = store.findingHistory(f.id).at(-1)!;
        expect(h).toMatchObject({ from: "probable", to: "confirmed" });
        expect(h.comment).not.toContain(SENTINELS.email);
        expect(() => changeValidation(store, after, { validation: "confirmed" })).toThrow(/already has this state/);
    });

    it("manual findings are redacted, never merged, and start where the person says", () => {
        const input = ManualFinding.parse({
            title: "Weak TLS ciphers (from the client's scanner)",
            category: "tls",
            severity: "medium",
            location: `https://shop.test/login?token=${SENTINELS.bearer}`,
            description: `Reported to ${SENTINELS.email}`,
            impact: "Old clients can be downgraded.",
            remediation: "Disable CBC ciphers.",
            evidence: [{ kind: "note", label: "Scanner output", value: `password=${SENTINELS.password}` }],
            sourceNote: "Client scanner export, 3 May",
        });
        const a = createManualFinding(store, app, input);
        const b = createManualFinding(store, app, input);
        expect(a.id).not.toBe(b.id);
        expect(a).toMatchObject({ source: "manual", validation: "needs-review", location: "https://shop.test/login" });
        expect(JSON.stringify(a)).not.toMatch(new RegExp(`${SENTINELS.bearer}|${SENTINELS.email}|${SENTINELS.password}`));
        expect(() => ManualFinding.parse({ ...input, extra: 1 })).toThrow();
    });

    it("no secret is stored anywhere in the security tables", () => {
        const dump = JSON.stringify(["security_findings", "security_finding_history", "security_finding_sightings"].map((t) => db.all(`SELECT * FROM ${t}`)));
        for (const [k, s] of Object.entries(SENTINELS)) if (k !== "email") expect(dump, k).not.toContain(s);
        expect(dump).not.toContain(SENTINELS.email);
    });

    it("the project report and CSV carry every section and no secret", () => {
        const d = buildReport(db, { projectId })!;
        const html = renderReportHtml(d);
        for (const h of ["Executive summary", "Scope and authorization", "Risk overview", "Findings by category", "Top issues", "Affected locations", "Coverage and limitations", "Configuration and timestamps"]) expect(html).toContain(`<h2>${h}`);
        expect(html).toContain("Jane Client");
        expect(html).toContain("Weekdays only");
        expect(html).toContain("High risk: at least one open critical or high finding.");
        const csv = renderReportCsv(d);
        expect(csv.charCodeAt(0)).toBe(0xfeff);
        expect(csv.split("\r\n")[0]).toContain('"Severity"');
        for (const out of [html, csv]) for (const s of Object.values(SENTINELS)) expect(out).not.toContain(s);
        expect(csvCell("=HYPERLINK(1)")).toBe(`"'=HYPERLINK(1)"`);
        expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    });

    it("tenancy: a report of another project's id is not built from this one", () => {
        const other = String(repo.createProject({ name: "Client B" }).id);
        const d = buildReport(db, { projectId: other })!;
        expect(d.findings.length).toBe(0);
        expect(buildReport(db, { projectId: "nope" })).toBeUndefined();
        expect(buildReport(db, { assessmentId: "nope" })).toBeUndefined();
    });
});

describe("risk rules and overview", () => {
    const f = (severity: "critical" | "high" | "medium" | "low" | "info", validation: string) => ({ severity, validation }) as never;
    it("decides the level from open findings only, by written rules", () => {
        expect(assessRisk([], false).level).toBe("not-assessed");
        expect(assessRisk([], true).level).toBe("no-open-findings");
        expect(assessRisk([f("critical", "false-positive"), f("medium", "probable")], true)).toMatchObject({ level: "medium", label: "Medium risk" });
        expect(assessRisk([f("high", "needs-review")], true).level).toBe("high");
        expect(assessRisk([f("low", "confirmed"), f("high", "fixed")], true).level).toBe("low");
        expect(assessRisk([], true).rules.join(" ")).toMatch(/not a statement that the application is secure/);
    });

    it("counts what the dashboard shows", () => {
        const base = { projectId: "p", applicationId: "a1", firstAssessmentId: null, lastAssessmentId: null, fingerprint: "x", category: "headers", confidence: "high", location: "l", description: "", impact: "", remediation: "", reproduction: null, evidence: [], source: "built-in", aiNote: null, firstSeenAt: "2026-01-01", lastSeenAt: "2026-01-02" } as const;
        const findings = [
            { ...base, id: "1", title: "a", severity: "high", validation: "probable" },
            { ...base, id: "2", title: "b", severity: "low", validation: "confirmed" },
            { ...base, id: "3", title: "c", severity: "critical", validation: "fixed" },
            { ...base, id: "4", title: "d", severity: "medium", validation: "false-positive" },
        ] as never[];
        const o = computeOverview({
            applications: [{ id: "a1", name: "Shop", targetUrl: "http://x", environment: "staging" } as never],
            assessments: [{ id: "s1", applicationId: "a1", state: "COMPLETED", createdAt: "2026-01-01", finishedAt: "2026-01-01" } as never],
            findings,
            fixedByRetest: new Map([["3", { at: "2026-01-03", retestId: "s2" }]]),
        });
        expect(o.counts).toMatchObject({ applications: 1, applicationsAssessed: 1, assessmentsCompleted: 1, openCriticalHigh: 1, awaitingReview: 1, fixedAfterRetest: 1, remediationRemaining: 2, falsePositives: 1 });
        expect(o.risk.level).toBe("high");
        expect(o.needsAttention.map((x) => x.id)).toEqual(["1", "2"]);
        expect(o.fixedRecently[0]).toMatchObject({ id: "3", retestId: "s2" });
    });
});

/**
 * Two rules of one weakness class, folded into one finding (observed against a real ZAP 2.17.0 daemon: rules 10038 and 10021 both
 * carry CWE-693, so `canonicalRule` keys them both as `zap:cwe-693`). Before this was fixed the second rule's evidence was dropped on
 * the floor: the finding named one problem while the other stayed open with nothing in the record to say so.
 */
describe("a rule that folds into another one is not lost", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-secfold-"));
    const db = new Db(path.join(tmp, "db.sqlite"));
    const repo = new Repo(db, new SecretBox(tmp, "y".repeat(32)));
    repo.ensureDefaultUser();
    const projectId = String(repo.createProject({ name: "Client Fold" }).id);
    const store = new SecurityStore(db);
    const app = store.createApplication(projectId, { name: "Fold", targetUrl: "http://fold.test/", environment: "staging" });
    const auth = store.addAuthorization(app.id, { basis: "owner", approverName: "Owner", statement: "I confirm.", confirmedByName: "Tester" });
    afterAll(() => {
        db.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    const zapResult = (ruleId: string, title: string, severity: "medium" | "low", description: string, remediation: string, note: string): RawResult => ({
        check: "other",
        url: "http://fold.test/",
        note,
        custom: { key: "zap:cwe-693", title, category: "headers", severity, description, impact: "A browser is less protected than it should be.", remediation, scope: "path", confidence: "high", scanner: { id: "zap", ruleId, reference: "693" } },
    });

    it("keeps the folded rule's evidence, names it, and records that a tool reported it", async () => {
        const assessment = store.createAssessment({ applicationId: app.id, authorizationId: auth.id, startedBy: "Tester" });
        const summary = await ingest(store, assessment, [
            zapResult("10038", "Content-Security-Policy header missing", "medium", "No CSP header was sent.", "Send a Content-Security-Policy header.", "ZAP's own record: alert 10038"),
            zapResult("10021", "X-Content-Type-Options header missing", "low", "No nosniff header was sent.", "Send X-Content-Type-Options: nosniff.", "ZAP's own record: alert 10021"),
        ]);
        expect(summary).toMatchObject({ created: 1, ignored: 0 });

        const stored = store.listFindings({ projectId });
        expect(stored.length, "one weakness class at one address is one finding").toBe(1);
        const merged = stored[0];
        const text = merged.evidence.map((e) => `${e.label}: ${e.value}`).join("\n");

        // The more serious wording wins the title and the fix that is shown.
        expect(merged.title).toBe("Content-Security-Policy header missing");
        expect(merged.severity).toBe("medium");
        // The rule that folded in is named, and everything it brought is still readable.
        expect(text).toMatch(/Also matched by[\s\S]*zap:cwe-693/);
        expect(text, "the folded rule's own evidence must survive").toContain("alert 10021");
        expect(text).toContain("alert 10038");
        // And it is recorded as an outside tool's finding, never as the platform's own check.
        expect(merged.checkId).toBe("zap");
        expect(merged.source).toBe("external");
    });

    it("keeps a second tool's report of the same weakness separate, each naming the tool that said it", async () => {
        // Deliberate, and the opposite of what an earlier comment here claimed: the fingerprint keys on the tool, so two tools stay two
        // findings. A client can see which tool said what, and fixing the problem does not silently close the other tool's finding.
        const next = store.createAssessment({ applicationId: app.id, authorizationId: auth.id, startedBy: "Tester" });
        const fromAnotherTool: RawResult = {
            check: "other",
            url: "http://fold.test/",
            custom: { key: "schemathesis:cwe-693", title: "Security header missing", category: "headers", severity: "medium", description: "A header is missing.", impact: "Less protection.", remediation: "Send the header.", scope: "path", confidence: "high", scanner: { id: "schemathesis", ruleId: "cwe-693" } },
        };
        const summary = await ingest(store, next, [fromAnotherTool]);
        expect(summary).toMatchObject({ created: 1, updated: 0 });
        const by = store.listFindings({ projectId });
        expect(by.length).toBe(2);
        expect(by.map((f) => f.checkId).sort()).toEqual(["schemathesis", "zap"]);
        for (const f of by) expect(f.source).toBe("external");
    });
});