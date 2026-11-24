import { HeartPulse, ImageIcon } from "lucide-react";
import { Badge, Metric } from "../../../components/ui";
import type { Tone } from "../../../lib/labels";
import { routes } from "../../../lib/router";
import type { AgentView } from "../registry";
import { InputsFrame, LIST, ListCard, OutcomeFrame, RunLink, WRAP } from "./accessibility";

const ID = "ux";

/** GET /api/projects/:id/workspace/ux/outcome (src/platform/agent-outcomes/ux.ts). */
type Check = "noBrokenLinks" | "noConsoleErrors" | "noFailedRequests" | "noMixedContent" | "pageBasics";
interface Problem {
    severity: "critical" | "high" | "medium" | "low" | null;
    text: string;
}
interface Visual {
    state: "looks-right" | "please-look" | "could-not-run" | "not-checked";
    notes: Problem[];
    note: string | null;
    screenshot: string | null;
    run: number;
    jobId: string;
}
interface Page {
    path: string;
    state: "problems" | "healthy" | "not-checked";
    checks: Array<{ check: Check; summary: string; problems: Problem[]; advice: string }>;
    note: string | null;
    run: number;
    jobId: string;
    visual: Visual | null;
}
interface Outcome {
    runs: number;
    pages: Page[];
    counts: { problems: number; healthy: number; notChecked: number };
    visualReview: boolean;
}

const CHECK_WORDS: Record<Check, string> = {
    noBrokenLinks: "Broken links",
    noConsoleErrors: "Script errors",
    noFailedRequests: "Failed requests",
    noMixedContent: "Insecure content",
    pageBasics: "Page basics",
};
const SEVERITY: Record<NonNullable<Problem["severity"]>, { label: string; tone: Tone }> = {
    critical: { label: "Critical", tone: "danger" },
    high: { label: "High", tone: "danger" },
    medium: { label: "Medium", tone: "warning" },
    low: { label: "Low", tone: "neutral" },
};
const STATE: Record<Page["state"], { label: string; tone: Tone }> = {
    problems: { label: "Problems", tone: "warning" },
    healthy: { label: "Healthy", tone: "success" },
    "not-checked": { label: "Not checked", tone: "neutral" },
};
const LOOK: Record<Visual["state"], { label: string; tone: Tone }> = {
    "looks-right": { label: "Looks right", tone: "success" },
    "please-look": { label: "Please look", tone: "warning" },
    "could-not-run": { label: "Could not run", tone: "neutral" },
    "not-checked": { label: "Not checked", tone: "neutral" },
};

function Problems({ list }: { list: Problem[] }) {
    return (
        <ul className="stack-sm" style={{ ...LIST, gap: 6 }}>
            {list.map((p, i) => (
                <li key={i} className="row" style={{ alignItems: "baseline", gap: 8, flexWrap: "nowrap" }}>
                    {p.severity && <Badge tone={SEVERITY[p.severity].tone}>{SEVERITY[p.severity].label}</Badge>}
                    <span className="mono" style={WRAP}>
                        {p.text}
                    </span>
                </li>
            ))}
        </ul>
    );
}

/** What the AI screen review said of the page: a model's judgement, so it says so and links the screenshot it saw. */
function VisualNotes({ v }: { v: Visual }) {
    return (
        <div className="stack-sm" data-testid="ux-visual">
            <div className="row" style={{ gap: 8 }}>
                <ImageIcon size={16} aria-hidden />
                <strong>Visual notes</strong>
                <Badge tone={LOOK[v.state].tone}>{LOOK[v.state].label}</Badge>
                <span className="t-meta">AI judgement, not a measurement</span>
                {v.screenshot && (
                    <a href={`/api/artifacts/${v.screenshot}`} target="_blank" rel="noopener noreferrer">
                        Open the screenshot
                    </a>
                )}
            </div>
            {v.notes.length > 0 && <Problems list={v.notes} />}
            {v.note && (
                <p className="t-meta" style={{ margin: 0 }}>
                    {v.note}
                </p>
            )}
        </div>
    );
}

/** Each page's health: broken links, script errors and the rest the check found, and the visual notes when screen review ran (SPEC §3). */
function Report({ o, projectId, inRun }: { o: Outcome; projectId: string; inRun: boolean }) {
    const looks = o.pages.filter((p) => p.visual?.state === "please-look").length;
    return (
        <>
            <div className="card divided" style={{ overflow: "hidden" }}>
                <div className="metrics">
                    <Metric value={o.counts.problems} label="Pages with problems" tone={o.counts.problems ? "warn" : undefined} />
                    <Metric value={o.counts.healthy} label="Healthy pages" tone={o.counts.healthy ? "ok" : undefined} />
                    <Metric value={o.counts.notChecked} label="Not checked" />
                    <Metric value={o.visualReview ? looks : "Off"} label="Visual notes to look at" />
                </div>
                <p className="section t-meta" style={{ margin: 0 }} data-testid="ux-scope">
                    Each key page is opened like a visitor would: broken links, script errors, failed requests to the site, insecure content and page basics are facts.{" "}
                    {o.visualReview
                        ? "Visual notes come from AI screen review: a model's judgement of a screenshot, so open it and decide."
                        : "AI screen review was not part of these runs, so there are no visual notes: it runs at Deep and Everything when your model can read images, or when you turn it on for a run."}
                </p>
            </div>
            <ListCard title="Pages" testId="ux-pages">
                {o.pages.length === 0 ? (
                    <p className="section t-secondary" style={{ margin: 0 }}>
                        No page checked yet.
                    </p>
                ) : (
                    <ul className="divided" style={LIST}>
                        {o.pages.map((p) => (
                            <li key={p.path} className="section stack-sm" data-testid="ux-page">
                                <div className="row">
                                    <span className="mono" style={WRAP}>
                                        {p.path}
                                    </span>
                                    <Badge tone={STATE[p.state].tone}>{STATE[p.state].label}</Badge>
                                    <span className="spacer" />
                                    <RunLink projectId={projectId} agentId={ID} page={p} inRun={inRun} />
                                </div>
                                {p.note && (
                                    <p className="t-meta" style={{ margin: 0 }}>
                                        {p.note}
                                    </p>
                                )}
                                {p.checks.map((c) => (
                                    <div key={c.check} className="stack-sm" style={{ gap: 6 }}>
                                        <p style={{ margin: 0 }}>
                                            <strong>{CHECK_WORDS[c.check]}</strong>: {c.summary}
                                        </p>
                                        <Problems list={c.problems} />
                                        <p className="t-meta" style={{ margin: 0 }}>
                                            {c.advice}
                                        </p>
                                    </div>
                                ))}
                                {p.visual && <VisualNotes v={p.visual} />}
                            </li>
                        ))}
                    </ul>
                )}
            </ListCard>
        </>
    );
}

const WHAT = "It opens the key pages of the application like a visitor and lists what spoils the visit: broken links, script errors, failed requests.";

function Outcome({ projectId }: { projectId: string }) {
    return (
        <OutcomeFrame<Outcome> projectId={projectId} agentId={ID} icon={HeartPulse} what={WHAT}>
            {(o) => <Report o={o} projectId={projectId} inRun={false} />}
        </OutcomeFrame>
    );
}

/** One run: what it checked, the same way (a stopped run's part too). */
function Run({ projectId, jobId }: { projectId: string; jobId: string }) {
    return (
        <OutcomeFrame<Outcome> projectId={projectId} agentId={ID} jobId={jobId} icon={HeartPulse} what={WHAT}>
            {(o) => <Report o={o} projectId={projectId} inRun />}
        </OutcomeFrame>
    );
}

function Setup({ projectId }: { projectId: string }) {
    return (
        <InputsFrame projectId={projectId}>
            {(d) => (
                <>
                    <p className="t-secondary" style={{ margin: 0 }}>
                        It explores the application to find its key pages, then opens each one like a visitor and watches what goes wrong. Nothing is clicked or submitted.
                    </p>
                    <dl className="ws-inputs">
                        <dt>Application address</dt>
                        <dd>
                            {d.application?.url || "None yet"} · <a href={routes.projectSettings(projectId, "general")}>Settings → General</a>
                        </dd>
                        <dt>AI model</dt>
                        <dd>
                            To explore and find the pages · <a href={routes.aiKeys}>Settings → AI keys</a>
                        </dd>
                        <dt>AI screen review</dt>
                        <dd>Needs a model that can read images, and each picture is a paid AI call. It is on at Deep and Everything when your model can read images; turn it on or off for a run when you start it.</dd>
                    </dl>
                </>
            )}
        </InputsFrame>
    );
}

/** The UX Testing Agent's screens (SPEC §3); its Runs tab is the default list. */
export const view: AgentView = { Outcome, Run, Setup };
