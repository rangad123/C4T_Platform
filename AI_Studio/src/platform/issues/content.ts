/**
 * The text of an issue created from a finding, built once as a small neutral document and then rendered
 * in each tracker's markup (GitHub Markdown, Jira's Atlassian Document Format).
 */
import { classify, reproduction } from "../../engine/findings/classify.js";
import type { Explanation } from "../../engine/findings/explain.js";
import { ROOT_CAUSE_LABEL_TEXT, type RootCause } from "../../engine/findings/root-cause.js";
import { confidenceScore, severityOf } from "../../engine/findings/score.js";
import type { FindingView } from "../../engine/findings/view.js";
import { describeStep, type TestSpec } from "../../engine/spec/schema.js";
import { HIDDEN, redactText } from "../../shared/redact-text.js";

export type Block =
    | { t: "heading"; text: string }
    | { t: "paragraph"; text: string }
    | { t: "list"; items: string[]; ordered?: boolean }
    | { t: "code"; text: string }
    | { t: "link"; label: string; url: string };

export interface IssueDraft {
    title: string;
    labels: string[];
    blocks: Block[];
}

export interface IssueSource {
    testKey: string;
    title: string;
    suite: string;
    spec: TestSpec;
    validationStatus: "NEEDS_REVIEW" | "FAILED_VALIDATION";
    reason: string | null;
    severity?: { severity: string; basis: string };
    /** Result of each step in the latest run, by step index. */
    stepResults: Array<{ index: number; status: string }>;
    lastRun?: { status: string; startedAt: string; durationMs: number | null };
    /** Address of the tested application, if known. */
    appUrl?: string;
    /** Link to the test in this platform. */
    testUrl: string;
    /** One sentence on what the page did during the failed run (network calls, console), already redacted. See ../evidence-read.ts. */
    evidenceSummary?: string;
    /** The most likely related Sentry issue the test page already looked up (never a fresh lookup). Worded as "might be related". */
    relatedSentry?: { title: string; url: string };
}

const SEVERITY_WORD: Record<string, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The failure message without terminal colour codes or Playwright's call log. */
export function failureText(reason: string | null): string {
    const text = stripAnsi(reason ?? "").replace(/\(automatic repair skipped: no LLM configured\)/, "").trim();
    return clip(text.split(/\n\s*Call log:/)[0]!.trim() || "No further detail was recorded.", 1500);
}

export function buildIssueDraft(src: IssueSource): IssueDraft {
    const sev = src.severity ? SEVERITY_WORD[src.severity.severity] ?? src.severity.severity : undefined;
    const isFinding = src.validationStatus === "NEEDS_REVIEW";
    // Title: severity first so trackers sort and scan well; the test title is the human-readable part.
    const title = clip(`${isFinding ? `[${sev ?? "Finding"}]` : "[Failing test]"} ${src.title}`, 240);

    const labels = ["ai-testing"];
    if (src.severity) labels.push(`severity-${src.severity.severity}`);
    labels.push(isFinding ? "finding" : "test-failure");

    const failedIndex = src.stepResults.find((s) => s.status === "failed")?.index;
    const steps = src.spec.steps.map((s, i) => {
        const r = src.stepResults.find((x) => x.index === i);
        const mark = r?.status === "passed" ? "" : r?.status === "failed" ? "  ← failed here" : "";
        return `${clip(describeStep(s), 200)}${mark}`;
    });

    const blocks: Block[] = [];
    blocks.push({ t: "heading", text: "What failed" });
    blocks.push({
        t: "paragraph",
        text: isFinding
            ? "An automated test found behaviour in the application that needs a human look."
            : "An automated test could not be made to pass. It may need changes, or the application may be broken.",
    });
    blocks.push({ t: "code", text: failureText(src.reason) });
    if (src.evidenceSummary) {
        blocks.push({ t: "heading", text: "What the page did" });
        blocks.push({ t: "paragraph", text: clip(src.evidenceSummary, 600) });
    }

    blocks.push({ t: "heading", text: "Details" });
    const facts = [`Test: ${src.testKey} — ${src.title}`, `Area: ${src.suite}`, `Priority: ${src.spec.priority}`, `Kind: ${src.spec.kind}, ${src.spec.type}`];
    if (src.severity) facts.splice(1, 0, `Severity: ${sev} (${src.severity.basis})`);
    if (src.lastRun) facts.push(`Last run: ${src.lastRun.status === "passed" ? "passed" : "did not pass"} at ${src.lastRun.startedAt}`);
    if (src.appUrl) facts.push(`Application: ${src.appUrl}`);
    blocks.push({ t: "list", items: facts });

    blocks.push({ t: "heading", text: "Steps" });
    blocks.push({ t: "list", ordered: true, items: steps });
    if (src.spec.expectedResults.length) {
        blocks.push({ t: "paragraph", text: "Expected result" });
        blocks.push({ t: "list", items: src.spec.expectedResults.map((e) => clip(e, 300)) });
    }

    blocks.push({ t: "heading", text: "How to reproduce" });
    blocks.push({
        t: "paragraph",
        text:
            failedIndex !== undefined
                ? `Follow the steps above; step ${failedIndex + 1} is where it went wrong. You can also open the test in the platform and choose “Run again”.`
                : "Follow the steps above, or open the test in the platform and choose “Run again”.",
    });
    blocks.push({ t: "link", label: "Open this test in the AI Testing Platform", url: src.testUrl });
    if (src.relatedSentry) {
        blocks.push({ t: "paragraph", text: "This Sentry issue might be related (it was seen around the time of the failed run; that does not mean it caused it):" });
        blocks.push({ t: "link", label: clip(src.relatedSentry.title, 200), url: src.relatedSentry.url });
    }
    blocks.push({ t: "paragraph", text: "Created automatically by the AI Testing Platform." });
    return { title, labels, blocks };
}

/** GitHub-flavoured Markdown. */
export function toMarkdown(blocks: Block[]): string {
    const fence = (text: string) => {
        // A fence longer than any backtick run inside keeps stray ``` in the failure text from ending the block.
        const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
        const f = "`".repeat(longest + 1);
        return `${f}\n${text}\n${f}`;
    };
    return blocks
        .map((b) => {
            switch (b.t) {
                case "heading":
                    return `### ${b.text}`;
                case "paragraph":
                    return b.text;
                case "list":
                    return b.items.map((it, i) => `${b.ordered ? `${i + 1}.` : "-"} ${it.replace(/\n/g, " ")}`).join("\n");
                case "code":
                    return fence(b.text);
                case "link":
                    return `[${b.label}](${b.url})`;
            }
        })
        .join("\n\n");
}

type AdfNode = Record<string, unknown>;
const adfText = (text: string, marks?: AdfNode[]): AdfNode => ({ type: "text", text, ...(marks ? { marks } : {}) });
const adfPara = (text: string): AdfNode => ({ type: "paragraph", content: [adfText(text)] });

/** Atlassian Document Format (what Jira Cloud's v3 API requires for descriptions). */
export function toAdf(blocks: Block[]): AdfNode {
    const content: AdfNode[] = blocks.map((b): AdfNode => {
        switch (b.t) {
            case "heading":
                return { type: "heading", attrs: { level: 3 }, content: [adfText(b.text)] };
            case "paragraph":
                return adfPara(b.text);
            case "list":
                return { type: b.ordered ? "orderedList" : "bulletList", content: b.items.map((it) => ({ type: "listItem", content: [adfPara(it.replace(/\n/g, " "))] })) };
            case "code":
                return { type: "codeBlock", content: [adfText(b.text)] };
            case "link":
                return { type: "paragraph", content: [adfText(b.label, [{ type: "link", attrs: { href: b.url } }])] };
        }
    });
    return { type: "doc", version: 1, content };
}

// ── a bug report from a finding group (testing-engine Phase 5 C3, spec §5.1 item 7) ─────────────────────────────────────────────

/** The owner's 13 fields of a bug report, in order. */
export const REPORT_FIELDS = ["title", "severity", "confidence", "area", "environment", "preconditions", "steps", "expected", "actual", "reproduction", "evidence", "likelyCause", "nextStep"] as const;
export type ReportField = (typeof REPORT_FIELDS)[number];
export const REPORT_FIELD_LABEL: Record<ReportField, string> = {
    title: "Title",
    severity: "Severity",
    confidence: "Confidence",
    area: "Area",
    environment: "Environment",
    preconditions: "Preconditions",
    steps: "Steps",
    expected: "Expected",
    actual: "Actual",
    reproduction: "Reproduction",
    evidence: "Evidence",
    likelyCause: "Likely cause",
    nextStep: "Next step",
};
/** Each field as lines of masked text (one line for most). */
export type FindingReport = Record<ReportField, string[]>;

export interface FindingReportInput {
    /** The group; the first member is the one shown. */
    members: readonly FindingView[];
    /** The first member's saved test, when it has one (its preconditions and steps as written). */
    spec?: TestSpec;
    area?: string | null;
    environment: { appUrl?: string | null; appVersion?: string | null; browser?: string | null };
    /** Where the evidence is kept (the test's page in AI Studio); left out of the report when empty. */
    evidenceUrl?: string;
    explanation?: Explanation;
    rootCause?: RootCause;
    /** The answers the failing attempt received, as its evidence package kept them (masked, verify-service.ts bodiesOf). */
    answers?: ReadonlyArray<{ request: string; body: string; cut?: true }>;
    /** The project's test accounts' sign-in names by account name ("main": the project's own test account); never a secret. */
    accounts?: ReadonlyMap<string, string>;
}

/**
 * Text that leaves AI Studio (an issue in another company's tracker, a shared report) is masked harder than stored text: the shared
 * pattern filter (redactText: cards, phones, addresses, API keys among them), after URL-decoding so an encoded value is seen, then
 * token-like words (10+ characters mixing upper case, lower case and digits, no hyphen), which stored text keeps readable.
 */
export function maskForTracker(s: string): string {
    const decoded = s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => {
        try {
            return decodeURIComponent(m);
        } catch {
            return m;
        }
    });
    return redactText(decoded, 4000)
        .replace(/(?<![\w-])(?=[\w!@#$%^&*+=~]*[A-Z])(?=[\w!@#$%^&*+=~]*[a-z])(?=[\w!@#$%^&*+=~]*\d)[\w!@#$%^&*+=~]{10,}(?![\w-])/g, HIDDEN);
}

const line = (s: string | null | undefined, max = 600) => clip(maskForTracker(String(s ?? "").replace(/\s+/g, " ").trim()), max);

/** What to look at next when the AI wrote nothing: from the cause's location, else from the class. */
const NEXT_BY_CLASS: Record<string, string> = {
    app_defect: "Follow the steps on the application and compare the answer of the requests listed under Evidence with the expected result.",
    incorrect_expectation: "Check the expected result against the requirement it comes from; the test may expect something the application never promised.",
    automation: "Check the failing step of the test: it may point at the wrong element or wait for the wrong thing.",
    infrastructure: "Run it again once the runner and browser are healthy; nothing yet shows the application is at fault.",
    network: "Check the network between the runner and the application, then run it again.",
    environment: "Check the test account, the run's secrets and the environment settings, then run it again.",
    flaky: "Run it several times and compare the passing and failing attempts.",
    unsupported: "Check the documentation that calls this not supported, and whether the test should expect it.",
    open: "Follow the steps on the application by hand and see which of the possible causes it is.",
};

/** The check's own value pasted after the expected text by an adapter: a settings object, a list, or "undefined". Engine text, not a result. */
const RAW_VALUE = /\s*\((?:\{.*?\}|\[.*?\]|undefined|null)\)(?=\s*(?:\(source:|$))/g;
const comparable = (s: string) => s.replace(/^Error:\s*/i, "").replace(/\s+/g, " ").trim().toLowerCase();

/** What the failing check found, in a few words: "got 201, expected 400", a relation's values, or a field the answer should not hold. */
function gotPhrase(f: FindingView, failed: FindingView["attempts"][number] | undefined): string {
    if (failed?.check === "jsonType" && failed.value === "undefined" && failed.target) return `the answer has “${failed.target}”`;
    const pair = /^Expected (.+?), got (.+)$/.exec(f.observed.trim());
    if (pair && pair[1]!.length <= 80 && pair[2]!.length <= 80) return `got ${pair[2]}, expected ${pair[1]}`;
    const values = /check failed \([^)]*\):.*?Values?:\s*(.+?)\.?$/s.exec(failed?.error ?? f.observed);
    return values ? values[1]!.split(/\n/)[0]!.slice(0, 120) : "";
}

/**
 * The report's title says what went wrong, not the test's name (a test's title states what should happen and reads as a passing test in
 * a tracker): an engine check's own sentence about the defect ("A signed-in “ben” user can open /notes/n1 …"), first clause only; else
 * the check that failed, where it was sent, and what it found.
 */
function reportTitle(f: FindingView, spec: TestSpec | undefined, failed: FindingView["attempts"][number] | undefined): string {
    const said = f.observed.trim();
    if (/^(?:A signed-in|After (?:the|signing))\b/.test(said)) return said.split(/,? so |: check | \(documented| \(each |; it was changed back|\. /)[0]!.replace(/[,.;]$/, "");
    // An exploration's own one-sentence observation is what went wrong ("Two items of 15.00 show a subtotal of 15.00.").
    if (/^[^\n]{12,160}$/.test(said) && !/^(?:Error\b|Expected\b)|\.\s+\S/.test(said)) return said.replace(/\.$/, "");
    const step = failed?.failedStep ? spec?.steps[failed.failedStep - 1] : undefined;
    const ruleOnly = /^As stated: rule\b/i.test(f.title);
    const check = step?.description && step.action !== "request" ? step.description : ruleOnly ? f.expected.text.replace(RAW_VALUE, "") : f.title;
    const api = spec?.steps.some((s) => s.action === "request") ? failed?.requests.filter((r) => r.own).at(-1) : undefined;
    const at = api && !check.includes(api.path) ? ` on ${api.method} ${api.path}` : "";
    const got = gotPhrase(f, failed);
    return `Failed: ${check.replace(/[.\s]+$/, "")}${at}${got ? ` (${got})` : ""}`;
}

/** A step in words; a request step also names the body it sends when its own words leave it out (the discount code, the broken value). */
function stepWords(s: TestSpec["steps"][number]): string {
    const words = describeStep(s);
    if (s.action !== "request" || s.body === undefined || s.body === null || words.includes("{")) return words;
    return `${words} with ${typeof s.body === "string" ? s.body : JSON.stringify(s.body)}`;
}

/** "the “ana” test account" → "the “ana” test account (ana@example.test)": the sign-in name, so someone outside AI Studio can sign in as it. */
function withSignIn(account: string, accounts: ReadonlyMap<string, string> | undefined): string {
    const masked = line(account, 200);
    if (!accounts?.size) return masked;
    return masked
        .replace(/the “([^”]+)” test account/g, (m, name: string) => (accounts.get(name) ? `${m} (${accounts.get(name)})` : m))
        .replace(/the project's test account/, (m) => (accounts.get("main") ? `${m} (${accounts.get("main")})` : m));
}

const where = (l: { file: string; line: number; function?: string; route?: string }) => `${l.file}:${l.line}${l.function ? ` in ${l.function}()` : ""}${l.route ? ` (${l.route})` : ""}`;

/** The 13 fields from a finding group, every text masked for leaving AI Studio. */
export function buildFindingReport(src: FindingReportInput): FindingReport {
    const f = src.members[0]!;
    const aiClass = src.explanation?.aiClass ?? false;
    const sev = severityOf(f);
    const conf = src.explanation?.confidence ?? confidenceScore(f, { aiClass });
    const cls = src.explanation?.class ?? classify(f).class;
    const rep = reproduction(f.attempts);
    const failed = f.attempts.find((a) => a.outcome !== "passed");

    const steps = src.spec
        ? src.spec.steps.map((s, i) => `${line(stepWords(s), 300)}${failed?.failedStep === i + 1 ? "  ← failed here" : ""}`)
        : f.steps.map((s, i) => `${line(`${s.action}${s.target ? ` ${s.target}` : ""}${s.url ? ` ${s.url}` : ""}`, 200)}${failed?.failedStep === i + 1 ? "  ← failed here" : ""}`);
    const area = src.area ?? src.spec?.category ?? failed?.page ?? null;
    const env = [
        src.environment.appUrl ? `Application: ${line(src.environment.appUrl, 300)}` : "",
        src.environment.appUrl || src.environment.browser ? `App version: ${line(src.environment.appVersion ?? "not recorded", 100)}` : "",
        src.environment.browser ? `Browser: ${line(src.environment.browser, 100)}` : "",
    ].filter(Boolean);
    const requests = (failed?.requests ?? []).slice(0, 10).map((r) => `${line(r.method, 10)} ${line(r.path, 200)}${r.body ? ` ${line(r.body, 300)}` : ""} → ${r.error ? line(r.error, 120) : (r.status ?? "no answer")}`);
    const answers = (src.answers ?? []).slice(-3).map((a) => `Answer to ${line(a.request.replace(/ -> /, " → "), 200)}: ${line(a.body, 600)}${a.cut ? " (cut)" : ""}`);
    // The failure's own text once: the error when it holds the headline (or is the headline, rawer), else both.
    const said = line(f.observed.replace(/^Error:\s*/i, ""), 1000);
    const err = failed?.error ? line(failed.error.replace(/^Error:\s*/i, ""), 600) : "";
    const jsonField = failed?.check === "jsonType" && failed.value === "undefined" && failed.target ? `The answer has a “${line(failed.target, 100)}” field; it should have none.` : "";
    const actual = jsonField
        ? [jsonField]
        : !err || comparable(said).includes(comparable(err))
          ? [said]
          : comparable(err).includes(comparable(said))
            ? [/^Error:/i.test(f.observed.trim()) ? err : said]
            : [said, err];
    const rc = src.rootCause;
    const cause = rc?.location
        ? [`${ROOT_CAUSE_LABEL_TEXT[rc.label]}: ${line(where(rc.location), 300)}`, line(rc.location.explanation ?? rc.reason, 600)]
        : [`Unknown: ${line(rc?.reason ?? "no code source was searched for this finding.", 600)}`];
    const next = src.explanation?.next ?? (rc?.location ? `Look at ${where(rc.location)} first. ${NEXT_BY_CLASS[cls] ?? NEXT_BY_CLASS.open}` : NEXT_BY_CLASS[cls] ?? NEXT_BY_CLASS.open!);

    return {
        title: [line(reportTitle(f, src.spec, failed), 240)],
        severity: [`${SEVERITY_WORD[sev.severity] ?? sev.severity}: ${line(sev.basis, 300)}`],
        confidence: [`${conf.confidence[0]!.toUpperCase()}${conf.confidence.slice(1)}: ${line(conf.basis, 300)}`],
        area: area ? [line(area, 200)] : [],
        environment: env,
        preconditions: [
            ...(src.spec?.preconditions.length ? src.spec.preconditions.map((p) => line(p, 300)) : ["None stated: the steps start in a new browser session."]),
            ...(f.account ? [`Signed in as ${withSignIn(f.account, src.accounts)}.`] : []),
        ],
        steps,
        expected: [`${line(f.expected.text.replace(RAW_VALUE, ""), 600)}${f.expected.source ? ` (source: ${line(f.expected.source, 100)})` : ""}`],
        actual: actual.filter(Boolean),
        reproduction: rep.of ? [`${rep.same} of ${rep.of} attempts failed the same way.`] : [],
        evidence: [
            ...requests,
            ...answers,
            ...(failed?.stack.length ? [`Stack: ${failed.stack.slice(0, 4).map((s) => line(s, 120)).join(" < ")}`] : []),
            src.evidenceUrl ? "Screenshots, traces and the full request list are kept in AI Studio (link below)." : "Screenshots, traces and the full request list are kept in AI Studio.",
        ],
        likelyCause: cause.filter(Boolean),
        nextStep: [line(next, 600)],
    };
}

/** Fields a report lacks: empty, or "unknown" without a reason. Only the likely cause may be unknown, and then it says why. */
export function missingFields(r: FindingReport): ReportField[] {
    return REPORT_FIELDS.filter((k) => {
        const text = r[k].join(" ").trim();
        if (!text) return true;
        return k === "likelyCause" ? /^unknown\W*$/i.test(text) : /^(?:unknown|not recorded)\b/i.test(text);
    });
}

/** The issue a tracker gets for a finding group. */
export function findingIssueDraft(r: FindingReport, evidenceUrl?: string): IssueDraft {
    const sev = r.severity[0]!.split(":")[0]!;
    const blocks: Block[] = [];
    for (const k of REPORT_FIELDS) {
        if (k === "title") continue;
        blocks.push({ t: "heading", text: REPORT_FIELD_LABEL[k] });
        if (k === "steps") blocks.push({ t: "list", ordered: true, items: r.steps });
        else if (r[k].length > 1) blocks.push({ t: "list", items: r[k] });
        else blocks.push({ t: "paragraph", text: r[k][0] ?? "" });
    }
    if (evidenceUrl) blocks.push({ t: "link", label: "Open the evidence in AI Studio", url: evidenceUrl });
    blocks.push({ t: "paragraph", text: "Created automatically by the AI Testing Platform from a verified finding." });
    return { title: clip(`[${sev}] ${r.title[0]}`, 240), labels: ["ai-testing", `severity-${sev.toLowerCase()}`, "finding"], blocks };
}
