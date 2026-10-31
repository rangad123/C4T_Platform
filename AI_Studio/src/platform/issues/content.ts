/**
 * The text of an issue created from a finding, built once as a small neutral document and then rendered
 * in each tracker's markup (GitHub Markdown, Jira's Atlassian Document Format).
 */
import { describeStep, type TestSpec } from "../../engine/spec/schema.js";

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
