/**
 * Tooltips and definitions (round 19, TT-CORE): the rules that can be checked without a browser.
 * - every icon-only control in web/src has an accessible name (the tooltip shows it);
 * - no empty, label-only or "Click here" tips in help.ts or in literal tips at call sites;
 * - the shared components carry no native title= on buttons, links or badges (the tooltip replaces it);
 * - help.ts defines every value of the enums the UI shows (labels.ts, run-text.ts, the security contract, overview risk levels);
 * - the panel placement keeps the tooltip inside the window (flip and shift).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ASSESSMENT_STATES, CATEGORIES, CONFIDENCES, SEVERITIES as SEC_SEVERITIES, VALIDATION_STATES } from "../src/security/contract.js";
import { RISK_RULES, RISK_WORDS } from "../src/security/findings/overview.js";
import { HELP, help, helpFor, jobHelp, METRIC_HELP } from "../web/src/lib/help.js";
import { GLOSSARY, SEVERITY, VALIDATION, jobLabel } from "../web/src/lib/labels.js";
import { STATE_WORD } from "../web/src/features/runs/run-text.js";
import { placePanel } from "../web/src/components/tooltip-place.js";

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "web/src");

function tsxFiles(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...tsxFiles(p));
        else if (/\.tsx$/.test(e.name)) out.push(p);
    }
    return out;
}
const FILES = tsxFiles(WEB).map((f) => ({ file: path.relative(ROOT, f).replace(/\\/g, "/"), text: fs.readFileSync(f, "utf8") }));

/** The opening tag of every JSX element named `name` (from "<Name" to its closing ">" or "/>"), braces and strings respected. */
function openingTags(text: string, name: string): Array<{ tag: string; at: number; selfClosing: boolean }> {
    const out: Array<{ tag: string; at: number; selfClosing: boolean }> = [];
    const re = new RegExp(`<${name}(?=[\\s/>])`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
        const i = tagEnd(text, m.index + m[0].length);
        out.push({ tag: text.slice(m.index, i + 1), at: m.index, selfClosing: text[i - 1] === "/" });
    }
    return out;
}
/** Index of the ">" that ends the opening tag started before `from`. */
function tagEnd(text: string, from: number): number {
    let depth = 0;
    let quote: string | null = null;
    let i = from;
    for (; i < text.length; i++) {
        const c = text[i]!;
        if (quote) {
            if (c === "\\") i++;
            else if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'" || c === "`") quote = c;
        else if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === ">" && depth === 0) break;
    }
    return i;
}
/** The literal string value of attribute `attr` in an opening tag ("..." or {"..."} or {`...`} without ${}), or undefined. */
function literalAttr(tag: string, attr: string): string | undefined {
    const m = new RegExp(`\\s${attr}=(?:"([^"]*)"|\\{"([^"]*)"\\}|\\{\`([^\`$]*)\`\\})`).exec(tag);
    return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}
const hasAttr = (tag: string, attr: string) => new RegExp(`\\s${attr}=`).test(tag);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const BANNED = /\b(click here|more options|tap here)\b/i;

describe("icon-only controls have a name", () => {
    it("every <Button iconOnly> has an aria-label and every <Menu iconOnly> a label", () => {
        const missing: string[] = [];
        let seen = 0;
        for (const { file, text } of FILES) {
            for (const name of ["Button", "Menu"]) {
                for (const t of openingTags(text, name)) {
                    if (!/\siconOnly(?=[\s/>=])/.test(t.tag) || /iconOnly=\{false\}/.test(t.tag)) continue;
                    // ui.tsx's own Menu passes the label through to its Button.
                    if (file.endsWith("components/ui.tsx") && /aria-label=\{iconOnly \? label/.test(t.tag)) continue;
                    seen++;
                    const attr = name === "Menu" ? "label" : "aria-label";
                    const value = literalAttr(t.tag, attr);
                    if (!hasAttr(t.tag, attr) || (value !== undefined && value.trim().length < 3)) missing.push(`${file}: ${t.tag.slice(0, 120)}`);
                }
            }
        }
        expect(seen).toBeGreaterThan(10);
        expect(missing).toEqual([]);
    });
});

describe("tips say something", () => {
    it("every definition in help.ts is a sentence, not a label, and avoids banned phrases", () => {
        const bad: string[] = [];
        let n = 0;
        for (const [group, entries] of Object.entries(HELP)) {
            for (const [key, text] of Object.entries(entries as Record<string, string>)) {
                n++;
                if (typeof text !== "string" || text.trim().length < 12) bad.push(`${group}.${key}: too short`);
                else if (norm(text) === norm(key)) bad.push(`${group}.${key}: repeats its key`);
                else if (BANNED.test(text)) bad.push(`${group}.${key}: banned phrase`);
                else if (!/[.!?:]$/.test(text.trim()) && !text.trim().endsWith(")")) bad.push(`${group}.${key}: not a sentence`);
                // Two sentences at most (decimal points and "e.g." aside).
                else if (text.split(/(?<=[a-z)])\.\s+(?=[A-Z])/).length > 2) bad.push(`${group}.${key}: more than two sentences`);
                // The decided vocabulary: never the old words for states and actions.
                else if (/\b(validated|validation failed|needs review|analysis|runbook|take over|hand-written|healing)\b/i.test(text)) bad.push(`${group}.${key}: old vocabulary`);
            }
        }
        expect(n).toBeGreaterThan(100);
        expect(bad).toEqual([]);
    });

    it("a definition does not repeat the word on the badge it explains", () => {
        for (const [k, v] of Object.entries(VALIDATION)) expect(norm(HELP.testStatus[k as keyof typeof VALIDATION]), k).not.toBe(norm(v.label));
        for (const s of ["QUEUED", "DISCOVERING", "VALIDATING", "COMPLETED", "PARTIALLY_COMPLETED", "FAILED"] as const) {
            for (const mode of [undefined, "validate", "plain", "variants", "environment"]) {
                const j = { status: s, error: null, mode } as never;
                const text = jobHelp(j);
                expect(text.length, `${s}/${mode}`).toBeGreaterThan(12);
                expect(norm(text)).not.toBe(norm(jobLabel(j).label));
            }
        }
        expect(jobHelp({ status: "FAILED", error: "Cancelled", mode: "validate" })).toMatch(/stopped/i);
        expect(jobHelp({ status: "COMPLETED", planOnly: true })).toMatch(/plan/i);
    });

    it("literal tips at call sites are not empty, not the visible label, and not 'Click here'", () => {
        const bad: string[] = [];
        let seen = 0;
        for (const { file, text } of FILES) {
            for (const name of ["Button", "LinkButton", "MenuItem", "Menu", "Badge", "Metric", "Tooltip", "HelpTip", "FieldHelp"]) {
                for (const t of openingTags(text, name)) {
                    const attr = name === "Tooltip" ? "content" : name === "HelpTip" ? "text" : name === "FieldHelp" ? "help" : "tip";
                    const value = literalAttr(t.tag, attr);
                    if (value === undefined) {
                        if (/\s(tip|content|text|help)=(""|\{""\})/.test(t.tag)) bad.push(`${file}: empty tip in ${t.tag.slice(0, 80)}`);
                        continue;
                    }
                    seen++;
                    if (name === "Tooltip") {
                        // A Tooltip that shows the name of an icon-only control (its aria-label, no visible text) is the point, not a repeat.
                        const start = text.indexOf("<", t.at + t.tag.length);
                        const end = tagEnd(text, start + 1);
                        const child = text.slice(start, end + 1);
                        const childText = text[end - 1] === "/" ? "" : (/^([^<]*)</.exec(text.slice(end + 1))?.[1]?.trim() ?? "");
                        const named = literalAttr(child, "aria-label");
                        if (named && norm(named) === norm(value) && !childText) continue;
                    }
                    const label = literalAttr(t.tag, "label") ?? literalAttr(t.tag, "aria-label");
                    // The visible text of a simple <Button ...>Text</Button>.
                    const body = !t.selfClosing ? /^([^<{]*)<\//.exec(text.slice(t.at + t.tag.length))?.[1]?.trim() : undefined;
                    if (value.trim().length < 12) bad.push(`${file}: too short "${value}"`);
                    else if (BANNED.test(value)) bad.push(`${file}: banned phrase "${value}"`);
                    else if ((label && norm(value) === norm(label)) || (body && norm(value) === norm(body))) bad.push(`${file}: repeats its label "${value}"`);
                }
            }
        }
        expect(bad, bad.join("\n")).toEqual([]);
        // Call sites are added by the area builders; this test guards them as they appear.
        expect(seen).toBeGreaterThanOrEqual(0);
    });
});

describe("shared components use the tooltip, not native title", () => {
    it("ui.tsx and Tooltip.tsx put no title= on buttons, links, badges or spans", () => {
        for (const f of ["components/ui.tsx", "components/Tooltip.tsx"]) {
            const text = fs.readFileSync(path.join(WEB, f), "utf8");
            const native = [...text.matchAll(/<(button|a|span|div|i)\b[^>]*?\stitle=/g)].map((m) => m[0].slice(0, 80));
            expect(native, f).toEqual([]);
        }
    });

    it("no shared component gets both a tip and a native title (two different pop-ups for one control)", () => {
        const both: string[] = [];
        for (const { file, text } of FILES)
            for (const name of ["Button", "LinkButton", "MenuItem", "Badge"])
                for (const t of openingTags(text, name)) if (hasAttr(t.tag, "tip") && hasAttr(t.tag, "title")) both.push(`${file}: ${t.tag.slice(0, 100)}`);
        expect(both).toEqual([]);
    });

    it("StatusBadge, SeverityBadge and JobBadge read their definitions from help.ts", () => {
        const ui = fs.readFileSync(path.join(WEB, "components/ui.tsx"), "utf8");
        expect(ui).toMatch(/tip=\{TEST_STATUS\[status\]\}/);
        expect(ui).toMatch(/SEVERITY_HELP\[severity\]/);
        expect(ui).toMatch(/tip=\{jobHelp\(job\)\}/);
    });
});

describe("the keyboard reaches every badge's explanation (round 21)", () => {
    const BADGES = ["StatusBadge", "JobBadge", "SeverityBadge", "StateTag", "ValidationTag", "SeverityTag", "AuthTag"];

    it("a file that shows status badges outside the tab order also has a BadgeKey (one '?' per list instead of one stop per row)", () => {
        const missing: string[] = [];
        for (const { file, text } of FILES) {
            if (file.endsWith("components/ui.tsx") || file.endsWith("security/SecurityChrome.tsx")) continue;
            const quiet = BADGES.flatMap((n) => openingTags(text, n)).filter((t) => !/\stipFocusable(?=[\s/>=])/.test(t.tag));
            if (quiet.length && !text.includes("<BadgeKey")) missing.push(`${file}: ${quiet[0]!.tag.slice(0, 100)}`);
        }
        expect(missing).toEqual([]);
    });

    it("the lists and tables with status-like badges or words have their key", () => {
        const lists = [
            "pages/ProjectTests.tsx", "pages/ProjectOverview.tsx", "pages/ProjectRuns.tsx", "pages/Home.tsx", "features/dashboard/FleetDashboard.tsx",
            "features/runs/RunDetail.tsx", "features/runners/YourRunner.tsx", "features/schedules/SchedulesPanel.tsx",
            "features/schedules/AlertsPanel.tsx", "features/schedules/FlakyPanel.tsx", "features/manual/ReleasesPage.tsx", "features/manual/ReleaseDetail.tsx",
            "features/runbooks/RunbooksPanel.tsx", "features/environments/EnvironmentStrip.tsx", "features/environments/EnvironmentsPanel.tsx",
            "features/devicefarm/DeviceFarmPanel.tsx", "features/workbench/HistoryTab.tsx", "features/auth/PeopleSettings.tsx", "features/eval/QualityPanel.tsx",
            "features/security/Assessments.tsx", "features/security/Applications.tsx", "features/security/Findings.tsx", "features/security/Overview.tsx",
            "features/security/Notifications.tsx",
        ];
        const without = lists.filter((f) => !fs.readFileSync(path.join(WEB, f), "utf8").includes("<BadgeKey"));
        expect(without).toEqual([]);
    });

    it("a disabled Button with a tip is aria-disabled (still a tab stop), not disabled", () => {
        const ui = fs.readFileSync(path.join(WEB, "components/ui.tsx"), "utf8");
        expect(ui).toMatch(/disabled=\{off && !soft\}/);
        expect(ui).toMatch(/aria-disabled=\{soft \? true/);
        // Pressing it does nothing: the click (and the form submit it would cause) is cancelled.
        expect(ui).toMatch(/soft\s*\?\s*\(e\) => \{\s*e\.preventDefault\(\);\s*e\.stopPropagation\(\);/);
    });
});

describe("help.ts covers every value the UI shows", () => {
    const keys = (o: object) => Object.keys(o).sort();
    const union = (file: string, type: string) => {
        const src = fs.readFileSync(path.join(WEB, file), "utf8");
        const m = new RegExp(`export type ${type} = ([^;]+);`).exec(src);
        return [...(m?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((x) => x[1]!).sort();
    };

    it("tests, findings on tests, runs and jobs", () => {
        expect(keys(HELP.testStatus)).toEqual(keys(VALIDATION));
        expect(keys(HELP.testStatus)).toEqual(union("api.ts", "ValidationStatus"));
        expect(keys(HELP.severity)).toEqual(keys(SEVERITY));
        expect(keys(HELP.runTest)).toEqual(keys(STATE_WORD));
        expect(keys(HELP.job)).toEqual(union("api.ts", "JobStatus"));
        expect(keys(HELP.phase)).toEqual(union("api.ts", "PhaseState"));
        expect(keys(HELP.ribbon)).toEqual(["attention", "fail", "idle", "pass"]);
    });

    it("the Security Assessment contract", () => {
        expect(keys(HELP.assessment)).toEqual([...ASSESSMENT_STATES].sort());
        expect(keys(HELP.findingValidation)).toEqual([...VALIDATION_STATES].sort());
        expect(keys(HELP.securitySeverity)).toEqual([...SEC_SEVERITIES].sort());
        expect(keys(HELP.confidence)).toEqual([...CONFIDENCES].sort());
        expect(keys(HELP.category)).toEqual([...CATEGORIES].sort());
        expect(keys(HELP.risk)).toEqual(keys(RISK_WORDS));
        // Each risk level's definition is the rule the server applies (overview.ts RISK_RULES), in the same words.
        for (const [level, text] of Object.entries(HELP.risk)) {
            const label = RISK_WORDS[level as keyof typeof RISK_WORDS];
            const rule = RISK_RULES.find((r) => r.startsWith(`${label}:`));
            expect(rule, level).toBeDefined();
            const ruleWords = norm(rule!.slice(label.length + 1)).split(" ").filter((w) => w.length > 4);
            const shared = ruleWords.filter((w) => norm(text).includes(w)).length;
            expect(shared / ruleWords.length, `${level}: ${text}`).toBeGreaterThan(0.5);
        }
    });

    it("the security pages' own word tables (security.ts) have a definition for every key", () => {
        const src = fs.readFileSync(path.join(WEB, "features/security/security.ts"), "utf8");
        const tableKeys = (name: string) => {
            const body = new RegExp(`export const ${name}[^=\\n]*= \\{([^\\n]*)\\};`).exec(src)?.[1] ?? new RegExp(`export const ${name}[^=\\n]*= \\{\\n([\\s\\S]*?)\\n\\};`).exec(src)?.[1] ?? "";
            // One entry per line (four-space indent), or all on one line.
            const re = body.includes("\n") ? /^ {4}"?([\w-]+)"?:/gm : /(?:^|,)\s*"?([\w-]+)"?:\s*"/g;
            return [...body.matchAll(re)].map((m) => m[1]!).sort();
        };
        expect(tableKeys("STATE_WORDS")).toEqual(keys(HELP.assessment));
        expect(tableKeys("VALIDATION_WORDS")).toEqual(keys(HELP.findingValidation));
        expect(tableKeys("SEVERITY_WORDS")).toEqual(keys(HELP.securitySeverity));
        expect(tableKeys("CONFIDENCE_WORDS")).toEqual(keys(HELP.confidence));
        expect(tableKeys("CATEGORY_WORDS")).toEqual(keys(HELP.category));
    });

    it("rounds 20-21: saved sign-in states, message reasons, API document operations, per-project access and roles", () => {
        // The union as the server code spells it, so a new state, reason or kind fails here until it has a sentence.
        const unionIn = (file: string, re: RegExp) => [...(re.exec(fs.readFileSync(path.join(ROOT, file), "utf8"))?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((x) => x[1]!).sort();
        expect(keys(HELP.signIn)).toEqual(unionIn("src/security/signin.ts", /export type SignInState = ([^;]+);/));
        expect(keys(HELP.notifyReason)).toEqual(unionIn("src/security/notify.ts", /export type NoticeReason = ([^;]+);/));
        expect(keys(HELP.apiOperation)).toEqual(unionIn("src/security/api-document.ts", /\bkind: ("request"[^;]+);/));
        expect(keys(HELP.projectAccess)).toEqual(unionIn("src/platform/project-access-store.ts", /\bmode: ("all"[^;]*);/));
        expect(keys(HELP.projectRole)).toEqual(unionIn("src/platform/auth/actor.ts", /export type Role = ([^;]+);/));
        expect(keys(HELP.signIn).length).toBe(6);
        expect(keys(HELP.notifyReason).length).toBe(4);
        expect(keys(HELP.apiOperation).length).toBe(6);
        // The pages' own word tables for them have the same keys (the words shown; the definitions come from help.ts).
        const table = (file: string, name: string) => {
            const src = fs.readFileSync(path.join(WEB, file), "utf8");
            const body = new RegExp(`const ${name}[^=\\n]*= \\{([\\s\\S]*?)\\n?\\};`).exec(src)?.[1] ?? "";
            return [...body.matchAll(/(?:^|[{,\n])\s*"?([\w-]+)"?:\s*"/g)].map((m) => m[1]!).sort();
        };
        expect(table("features/security/ApplicationExtras.tsx", "SIGNIN_WORDS")).toEqual(keys(HELP.signIn));
        expect(table("features/security/ApplicationExtras.tsx", "OPERATION_WORDS")).toEqual(keys(HELP.apiOperation));
        expect(table("features/security/Notifications.tsx", "REASON_WORDS")).toEqual(keys(HELP.notifyReason));
        // What changed in rounds 20-21 is in the definitions: the authorization covers the sign-in and the sensitive workflows, a
        // restored backup withdraws it, a finding marked fixed comes back as Needs a look.
        expect(HELP.authorization.current).toMatch(/saved sign-in and sensitive workflows/);
        expect(HELP.authorization.revoked).toMatch(/backup/);
        expect(HELP.findingValidation["needs-review"]).toMatch(/came back/);
        expect(HELP.findingValidation.fixed).toMatch(/opens again/);
        expect(HELP.projectAccess.only).toMatch(/as if they did not exist/);
    });

    it("lookups: typed help(), loose helpFor(), and no overlap with the glossary", () => {
        expect(help("findingValidation", "probable")).toMatch(/evidence/);
        expect(helpFor("runTest", "not_run")).toMatch(/no result/);
        expect(helpFor("runTest", "nonsense")).toBeUndefined();
        expect(helpFor("runTest", null)).toBeUndefined();
        expect(helpFor("metric", "toString")).toBeUndefined();
        expect(METRIC_HELP.passRate).toMatch(/quarantine/);
        // A definition never copies a glossary sentence: Term explains words, help.ts explains values.
        const glossary = new Set(Object.values(GLOSSARY).map(norm));
        for (const entries of Object.values(HELP)) for (const t of Object.values(entries as Record<string, string>)) expect(glossary.has(norm(t))).toBe(false);
    });
});

describe("placement stays inside the window", () => {
    const rect = (left: number, top: number, w = 40, h = 20) => ({ left, top, width: w, height: h, right: left + w, bottom: top + h });
    const view = { width: 375, height: 700 };
    const panel = { width: 200, height: 40 };

    it("goes where asked when there is room", () => {
        const p = placePanel(rect(150, 300), panel, "top", view);
        expect(p.placement).toBe("top");
        expect(p.top).toBe(300 - 8 - 40);
        expect(p.left).toBe(Math.round(170 - 100));
    });
    it("flips to the other side at the top edge and shifts away from the side edges", () => {
        const p = placePanel(rect(2, 4), panel, "top", view);
        expect(p.placement).toBe("bottom");
        expect(p.left).toBeGreaterThanOrEqual(8);
        const q = placePanel(rect(360, 300, 10), panel, "top", view);
        expect(q.left + panel.width).toBeLessThanOrEqual(view.width - 8);
    });
    it("a side placement that does not fit falls back to top or bottom, unless strict", () => {
        const p = placePanel(rect(150, 300), panel, "left", view);
        expect(["top", "bottom"]).toContain(p.placement);
        const s = placePanel(rect(150, 300), panel, "left", view, true);
        expect(s.fits).toBe(false);
        const ok = placePanel(rect(300, 300), { width: 100, height: 40 }, "left", { width: 800, height: 700 }, true);
        expect(ok).toMatchObject({ placement: "left", fits: true });
    });
});
