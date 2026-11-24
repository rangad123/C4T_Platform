import { ArrowLeft, MonitorSmartphone, Sparkles } from "lucide-react";
import { artifactUrl, type Job } from "../../../api";
import { JobProgress } from "../../../components/JobProgress";
import { BadgeKey } from "../../../components/Tooltip";
import { Badge, EmptyState, ErrorState, LinkButton, ListSkeleton } from "../../../components/ui";
import type { Tone } from "../../../lib/labels";
import { isActive } from "../../../lib/labels";
import { useFetch, useOnFinish } from "../../../lib/hooks";
import { routes } from "../../../lib/router";
import type { AgentInputs } from "../../requirements/AgentInputs";
import type { AgentView } from "../registry";

const ID = "responsive-ui";

/** GET /api/projects/:id/workspace/responsive-ui/outcome (src/platform/agent-outcomes/responsive-ui.ts). */
type CellStatus = "same" | "changed" | "pictured" | "passed" | "failed" | "could-not-run" | "not-checked" | "not-run";
interface Viewport {
    id: string;
    label: string;
    width: number;
    height: number;
}
interface Cell {
    status: CellStatus;
    testKey: string;
    reason: string | null;
    shot: string | null;
    diff: string | null;
    finding: { id: string; label: string; verified: boolean } | null;
}
interface Issue {
    path: string;
    viewport: string;
    kind: "changed" | "fails";
    testKey: string;
    reason: string | null;
    shots: string[];
    finding: { id: string; label: string } | null;
}
interface Outcome {
    runs: number;
    viewports: Viewport[];
    pages: Array<{ path: string; cells: Record<string, Cell> }>;
    issues: Issue[];
}

const STATUS: Record<CellStatus, { label: string; tone: Tone; help: string }> = {
    same: { label: "Same", tone: "success", help: "The page looks the same as its approved picture." },
    changed: { label: "Changed", tone: "warning", help: "The page looks different from its approved picture: the new picture and the difference are kept." },
    pictured: { label: "Pictured", tone: "success", help: "The page opened at this size and its picture is kept. Only desktop has an approved picture to compare with." },
    passed: { label: "Works", tone: "success", help: "The test at this page passed on this screen size." },
    failed: { label: "Fails", tone: "danger", help: "The test at this page passes on desktop but failed on this screen size." },
    "could-not-run": { label: "Could not run", tone: "neutral", help: "The check could not run here (for example, that browser is not installed); it says nothing about the page." },
    "not-checked": { label: "Not checked", tone: "neutral", help: "This page was not repeated on this screen size; the reason is under the grid." },
    "not-run": { label: "Not run", tone: "neutral", help: "Its check was made but has not run yet (the run was stopped first)." },
};
const size = (v: Viewport) => `${v.width} × ${v.height}`;
const thumb = { display: "block", width: 160, maxWidth: "100%", height: 100, objectFit: "cover", objectPosition: "top", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)" } as const;

function Shot({ id, alt }: { id: string; alt: string }) {
    return (
        <a href={artifactUrl(id)} target="_blank" rel="noreferrer" aria-label={`Open ${alt}`}>
            <img src={artifactUrl(id)} alt={alt} loading="lazy" width={160} height={100} style={thumb} />
        </a>
    );
}

/** The page × screen size grid and its layout issues, over all its runs or for one (`run`). */
function OutcomeBody({ projectId, run }: { projectId: string; run?: string }) {
    const runs = useFetch<Job[]>(`/projects/${projectId}/workspace/${ID}/runs`, (d) => (isActive(d?.[0]?.status) ? 2000 : null));
    const job = run ? runs.data?.find((j) => j.jobId === run) : runs.data?.[0];
    const active = isActive(job?.status);
    const outcome = useFetch<Outcome>(`/projects/${projectId}/workspace/${ID}/outcome${run ? `?run=${encodeURIComponent(run)}` : ""}`, () => (active ? 3000 : null));
    useOnFinish(active, () => void outcome.reload());
    if (!outcome.data && !outcome.error) return <ListSkeleton rows={4} />;
    if (!outcome.data) return <ErrorState error={{ title: "What the Responsive UI agent found could not be loaded", body: outcome.error?.message ?? "" }} onRetry={() => void outcome.reload()} />;
    const o = outcome.data;
    const progress = job && active ? <JobProgress job={job} onChanged={() => void runs.reload()} /> : null;
    if (!o.pages.length)
        return (
            <div className="stack" data-testid="responsive-outcome">
                {progress}
                <div className="card">
                    <EmptyState
                        icon={MonitorSmartphone}
                        title={o.runs ? "No pages pictured yet" : "Not run yet"}
                        actions={
                            !run && !active ? (
                                <LinkButton href={routes.newProject({ project: projectId, agent: ID })} variant="primary" icon={Sparkles}>
                                    Take the pictures
                                </LinkButton>
                            ) : undefined
                        }
                    >
                        It takes a picture of each key page and compares later runs with it, so a layout that breaks shows up as a change.
                    </EmptyState>
                </div>
            </div>
        );
    const label = (id: string) => o.viewports.find((v) => v.id === id)?.label ?? id;
    const present = new Set(o.pages.flatMap((p) => Object.values(p.cells).map((c) => c.status)));
    // Why cells were not checked or could not run, once each: the same reason repeats down a column.
    const notes = [...new Set(o.pages.flatMap((p) => Object.entries(p.cells).filter(([, c]) => (c.status === "not-checked" || c.status === "could-not-run") && c.reason).map(([v, c]) => `${label(v)}: ${c.reason}`)))];
    return (
        <div className="stack" data-testid="responsive-outcome">
            {progress}
            <section className="card card-pad stack-sm" aria-labelledby="rui-issues" data-testid="responsive-issues">
                <h3 className="t-card" id="rui-issues">
                    Layout issues ({o.issues.length})
                </h3>
                {o.issues.length === 0 ? (
                    <p className="t-meta" style={{ margin: 0 }}>
                        None. A change from the approved picture becomes an issue once it is verified: replayed and seen again.
                    </p>
                ) : (
                    <ul className="stack-sm" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                        {o.issues.map((i) => (
                            <li key={`${i.path}|${i.viewport}`} className="stack-sm" style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: 12 }} data-testid="responsive-issue">
                                <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                                    <strong style={{ overflowWrap: "anywhere" }}>
                                        {i.path} on {label(i.viewport)}
                                    </strong>
                                    <Badge tone={i.kind === "fails" ? "danger" : "warning"}>{i.kind === "fails" ? "Fails on this screen size" : "Looks different"}</Badge>
                                    {i.finding && <Badge tone="danger">{i.finding.label}</Badge>}
                                </div>
                                {i.reason && (
                                    <span className="t-secondary" style={{ whiteSpace: "pre-line", overflowWrap: "anywhere" }}>
                                        {i.reason}
                                    </span>
                                )}
                                {i.shots.length > 0 && (
                                    <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                                        {i.shots.map((s, n) => (
                                            <Shot key={s} id={s} alt={i.kind === "changed" ? (n === 0 ? `the new picture of ${i.path}` : `the difference on ${i.path}, in red`) : `${i.path} on ${label(i.viewport)} when it failed`} />
                                        ))}
                                    </div>
                                )}
                                <span className="t-meta">{i.kind === "fails" ? "It passes on desktop. The failed run on this screen size is kept with its evidence." : "Desktop, compared with the approved picture."} · {i.testKey}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
            <section className="card card-pad stack-sm" aria-labelledby="rui-grid" data-testid="responsive-grid">
                <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                    <h3 className="t-card" id="rui-grid" style={{ margin: 0 }}>
                        Pages on each screen size
                    </h3>
                    <BadgeKey label="the grid’s words" entries={[...present].map((s) => ({ word: STATUS[s].label, text: STATUS[s].help }))} />
                </div>
                <p className="t-meta" style={{ margin: 0 }}>
                    {o.pages.length === 1 ? "1 page" : `${o.pages.length} pages`}
                    {run ? " in this run" : ` over ${o.runs === 1 ? "1 run" : `${o.runs} runs`}`}. Each page is pictured on the phone and tablet sizes; another browser or size keeps a picture only when the page failed there.
                </p>
                <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--type-body-sm-size)" }}>
                        <thead>
                            <tr>
                                <th scope="col" style={{ textAlign: "left", padding: 8 }}>
                                    Page
                                </th>
                                {o.viewports.map((v) => (
                                    <th key={v.id} scope="col" style={{ textAlign: "left", padding: 8, whiteSpace: "nowrap" }}>
                                        {v.label} <span className="t-meta">{size(v)}</span>
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {o.pages.map((p) => (
                                <tr key={p.path} style={{ borderTop: "1px solid var(--border-subtle)" }}>
                                    <th scope="row" style={{ textAlign: "left", padding: 8, verticalAlign: "top", minWidth: 112, overflowWrap: "anywhere", fontWeight: "var(--fw-medium)" }}>
                                        {p.path}
                                    </th>
                                    {o.viewports.map((v) => {
                                        const c = p.cells[v.id];
                                        return (
                                            <td key={v.id} style={{ padding: 8, verticalAlign: "top", minWidth: 176 }} data-testid={`cell-${v.id}`}>
                                                {!c ? (
                                                    <span className="t-meta">Not tried</span>
                                                ) : (
                                                    <div className="stack-sm">
                                                        {c.shot && <Shot id={c.shot} alt={`${p.path} on ${v.label}`} />}
                                                        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                                                            <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge>
                                                            {c.finding && !c.finding.verified && <span className="t-meta">{c.finding.label}</span>}
                                                        </div>
                                                    </div>
                                                )}
                                            </td>
                                        );
                                    })}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                {notes.length > 0 && (
                    <ul className="t-meta" style={{ margin: 0, paddingLeft: 20 }} data-testid="responsive-notes">
                        {notes.map((n) => (
                            <li key={n}>{n}</li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}

function Outcome({ projectId }: { projectId: string }) {
    return <OutcomeBody projectId={projectId} />;
}

/** One run: its pages and screen sizes, this agent's items only. */
function Run({ projectId, jobId }: { projectId: string; jobId: string }) {
    return (
        <div className="stack">
            <a href={routes.projectAgent(projectId, ID, "runs")} className="t-meta">
                <ArrowLeft size={14} aria-hidden style={{ verticalAlign: "-2px", marginRight: 4 }} />
                All runs
            </a>
            <OutcomeBody projectId={projectId} run={jobId} />
        </div>
    );
}

/** Its inputs: the address, the sign-in for pages behind it, and the screen sizes. */
function Setup({ projectId }: { projectId: string }) {
    const inputs = useFetch<AgentInputs>(`/projects/${projectId}/agent-inputs`);
    if (inputs.loading) return <ListSkeleton rows={3} />;
    const d = inputs.data;
    if (!d) return <ErrorState error={{ title: "What this agent uses could not be loaded", body: inputs.error?.message ?? "" }} onRetry={() => void inputs.reload()} />;
    return (
        <section className="card card-pad stack-sm" data-testid="agent-setup">
            <p className="t-secondary">The first run takes the approved picture of each key page; later runs compare with it.</p>
            <dl className="ws-inputs">
                <dt>Application address</dt>
                <dd>
                    {d.application?.url || "None yet"} · <a href={routes.projectSettings(projectId, "general")}>Settings → General</a>
                </dd>
                <dt>Sign in</dt>
                <dd>
                    {d.signIn.username ? `As ${d.signIn.username}: pages behind the sign-in are pictured too` : "None: only pages a visitor can open are pictured"} · <a href={routes.projectSettings(projectId, "signin")}>Settings → Sign-in</a>
                </dd>
                <dt>Screen sizes</dt>
                <dd>Phone (375 wide), tablet (768 wide) and desktop (1280 wide) on every run. Untick the phone or the tablet when you start a run to leave it out.</dd>
            </dl>
        </section>
    );
}

/** The Responsive UI agent's screen sizes beside desktop (src/engine/validation/variants.ts SIZE_VARIANT_IDS): all on by default. */
export const SIZE_DEFAULT = ["phone-375", "tablet-768"];
const SIZES = [
    { id: "phone-375", label: "Phone, 375 wide", hint: "Each page is pictured on a phone-sized screen with touch." },
    { id: "tablet-768", label: "Tablet, 768 wide", hint: "Each page is pictured on a tablet-sized screen with touch." },
    { id: "desktop", label: "Desktop, 1280 wide", hint: "Always: the approved picture of each page is taken here and later runs compare with it." },
];

/** The run form's choice of screen sizes for a Responsive UI run (#/new?agent=responsive-ui): sent as the run's `variants`. */
export function SizePicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
    return (
        <fieldset className="stack-sm" style={{ border: 0, margin: 0, padding: 0 }} data-testid="size-picker">
            <legend className="t-card" style={{ marginBottom: 8 }}>
                Screen sizes
            </legend>
            {SIZES.map((s) => (
                <label key={s.id} className="check">
                    <input type="checkbox" checked={s.id === "desktop" || value.includes(s.id)} disabled={s.id === "desktop"} onChange={(e) => onChange(e.target.checked ? [...value, s.id] : value.filter((x) => x !== s.id))} />
                    <span>
                        <span className="title">{s.label}</span>
                        <span className="hint">{s.hint}</span>
                    </span>
                </label>
            ))}
        </fieldset>
    );
}

export const view: AgentView = { Outcome, Run, Setup };
