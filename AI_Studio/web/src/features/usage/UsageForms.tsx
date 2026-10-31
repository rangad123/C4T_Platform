import { useEffect, useState } from "react";
import { api } from "../../api";
import type { ProjectRow } from "../../api";
import { Button, Callout, Skeleton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import { exact, limitText, parseLimit, type BudgetsAnswer, type PricesAnswer, type ProjectBudget } from "./usage";

type Notice = { tone: "success" | "danger"; text: string } | null;

function Feedback({ notice }: { notice: Notice }) {
    if (!notice) return null;
    return (
        <div role="status">
            <Callout tone={notice.tone}>{notice.text}</Callout>
        </div>
    );
}

/** A limit field: empty means no limit. */
function LimitField({ id, label, hint, value, onChange, invalid }: { id: string; label: string; hint: string; value: string; onChange: (v: string) => void; invalid?: boolean }) {
    return (
        <div className="field">
            <label htmlFor={id}>{label}</label>
            <input id={id} className="input" inputMode="numeric" autoComplete="off" placeholder="No limit" value={value} aria-invalid={invalid || undefined} aria-describedby={`${id}-hint`} onChange={(e) => onChange(e.target.value)} />
            <span className="hint" id={`${id}-hint`}>
                {hint}
            </span>
        </div>
    );
}

const SOURCE_NOTE = (s: "app" | "environment" | "none", name: string) => (s === "environment" ? ` Now taken from ${name} in the server settings; saving here replaces it.` : "");

/** Platform-wide limits and a limit for one project. */
export function LimitsForms({ onSaved }: { onSaved: () => Promise<void> | void }) {
    const budgets = useFetch<BudgetsAnswer>("/usage/budgets");
    const projects = useFetch<ProjectRow[]>("/projects");
    const [month, setMonth] = useState("");
    const [job, setJob] = useState("");
    const [warn, setWarn] = useState("80");
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<Notice>(null);

    const b = budgets.data?.platform;
    useEffect(() => {
        if (!b) return;
        setMonth(limitText(b.monthlyTokens));
        setJob(limitText(b.jobTokens));
        setWarn(String(b.warnPercent));
    }, [b?.monthlyTokens, b?.jobTokens, b?.warnPercent]);

    const monthParsed = parseLimit(month);
    const jobParsed = parseLimit(job);
    const warnN = Number(warn);
    const warnOk = Number.isInteger(warnN) && warnN >= 1 && warnN <= 99;

    async function save() {
        setNotice(null);
        if (monthParsed === undefined || jobParsed === undefined || !warnOk) {
            setNotice({ tone: "danger", text: "Use whole numbers: limits of 1 or more (or empty for no limit) and a warning between 1 and 99 percent." });
            return;
        }
        setBusy(true);
        try {
            await api("/usage/budgets", { method: "PUT", body: { monthlyTokens: monthParsed, jobTokens: jobParsed, warnPercent: warnN } });
            setNotice({ tone: "success", text: "Limits saved. They apply to the next AI call." });
            await Promise.all([budgets.reload(), onSaved()]);
        } catch (e) {
            setNotice({ tone: "danger", text: describeApiError(e) });
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            <form
                className="usage-sub"
                aria-labelledby="usage-limits-h"
                onSubmit={(e) => {
                    e.preventDefault();
                    void save();
                }}
            >
                <h3 className="t-card" id="usage-limits-h">
                    Limits for the whole platform
                </h3>
                <p className="t-secondary">When a limit is reached, AI work stops cleanly. Tests already created are kept and still run. A limit counts input and output tokens together.</p>
                {budgets.loading ? (
                    <Skeleton h={70} />
                ) : (
                    <div className="usage-form">
                        <LimitField id="usage-month-limit" label="Tokens per month, all projects" hint={`Leave empty for no limit. The month is the calendar month in UTC.${SOURCE_NOTE(b?.monthlySource ?? "none", "AI_MONTHLY_TOKEN_LIMIT")}`} value={month} onChange={setMonth} invalid={monthParsed === undefined} />
                        <LimitField id="usage-job-limit" label="Tokens per job" hint={`Leave empty for no limit. One exploration or repair run stops when it reaches this.${SOURCE_NOTE(b?.jobSource ?? "none", "AI_JOB_TOKEN_LIMIT")}`} value={job} onChange={setJob} invalid={jobParsed === undefined} />
                        <div className="field">
                            <label htmlFor="usage-warn">Warn at (percent)</label>
                            <input id="usage-warn" className="input" inputMode="numeric" value={warn} aria-invalid={!warnOk || undefined} aria-describedby="usage-warn-hint" onChange={(e) => setWarn(e.target.value)} />
                            <span className="hint" id="usage-warn-hint">
                                A note appears in the job’s activity log when a limit is this full.
                            </span>
                        </div>
                    </div>
                )}
                <div className="row">
                    <Button type="submit" variant="primary" loading={busy} disabled={budgets.loading}>
                        Save limits
                    </Button>
                </div>
                <Feedback notice={notice} />
            </form>
            <ProjectLimit projects={projects.data ?? []} loading={projects.loading} used={budgets.data?.projects ?? []} onSaved={async () => { await budgets.reload(); await onSaved(); }} />
        </>
    );
}

function ProjectLimit({ projects, loading, used, onSaved }: { projects: ProjectRow[]; loading: boolean; used: BudgetsAnswer["projects"]; onSaved: () => Promise<void> | void }) {
    const [projectId, setProjectId] = useState("");
    const current = useFetch<ProjectBudget>(projectId ? `/projects/${projectId}/usage-budget` : null);
    const [month, setMonth] = useState("");
    const [job, setJob] = useState("");
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<Notice>(null);

    useEffect(() => {
        if (!current.data) return;
        setMonth(limitText(current.data.monthlyTokens));
        setJob(limitText(current.data.jobTokens));
    }, [current.data]);
    useEffect(() => {
        setNotice(null);
    }, [projectId]);

    const monthParsed = parseLimit(month);
    const jobParsed = parseLimit(job);

    async function save() {
        setNotice(null);
        if (monthParsed === undefined || jobParsed === undefined) {
            setNotice({ tone: "danger", text: "Use whole numbers of 1 or more, or leave a field empty for no limit." });
            return;
        }
        setBusy(true);
        try {
            await api(`/projects/${projectId}/usage-budget`, { method: "PUT", body: { monthlyTokens: monthParsed, jobTokens: jobParsed } });
            setNotice({ tone: "success", text: "Project limits saved." });
            await Promise.all([current.reload(), onSaved()]);
        } catch (e) {
            setNotice({ tone: "danger", text: describeApiError(e) });
        } finally {
            setBusy(false);
        }
    }

    return (
        <form
            className="usage-sub"
            aria-labelledby="usage-project-h"
            onSubmit={(e) => {
                e.preventDefault();
                if (projectId) void save();
            }}
        >
            <h3 className="t-card" id="usage-project-h">
                Limits for one project
            </h3>
            <p className="t-secondary">A project can have its own monthly limit and job limit. The platform limits above still apply.</p>
            <div className="usage-form">
                <div className="field">
                    <label htmlFor="usage-project">Project</label>
                    <select id="usage-project" className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={loading}>
                        <option value="">{loading ? "Loading projects" : projects.length ? "Choose a project" : "No projects yet"}</option>
                        {projects.map((p) => (
                            <option key={p.id} value={p.id}>
                                {p.name}
                            </option>
                        ))}
                    </select>
                </div>
                {projectId && (
                    <>
                        <LimitField id="usage-project-month" label="Tokens per month" hint="Leave empty for no limit." value={month} onChange={setMonth} invalid={monthParsed === undefined} />
                        <LimitField id="usage-project-job" label="Tokens per job" hint="Leave empty for no limit." value={job} onChange={setJob} invalid={jobParsed === undefined} />
                    </>
                )}
            </div>
            {projectId && current.data && <p className="t-meta">This project has used {exact(current.data.usedTokens)} tokens this month.</p>}
            {used.length > 0 && !projectId && (
                <ul className="usage-prices" aria-label="Projects with their own limits">
                    {used.map((u) => (
                        <li key={u.projectId}>
                            <span>{u.name}</span>
                            <span className="t-meta">
                                {u.monthlyTokens ? `${exact(u.usedTokens)} of ${exact(u.monthlyTokens)} tokens this month` : "no monthly limit"}
                                {u.jobTokens ? `, ${exact(u.jobTokens)} per job` : ""}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            <div className="row">
                <Button type="submit" variant="primary" loading={busy} disabled={!projectId || current.loading}>
                    Save project limits
                </Button>
            </div>
            <Feedback notice={notice} />
        </form>
    );
}

/** Prices are the user's own: none are built in, so a cost appears only for models they price. */
export function PricesForm({ onSaved }: { onSaved: () => Promise<void> | void }) {
    const prices = useFetch<PricesAnswer>("/usage/prices");
    const [model, setModel] = useState("");
    const [input, setInput] = useState("");
    const [output, setOutput] = useState("");
    // Optional prompt-cache prices; empty = cached input is charged at the input price.
    const [cachedIn, setCachedIn] = useState("");
    const [cacheWrite, setCacheWrite] = useState("");
    const [currency, setCurrency] = useState("");
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<Notice>(null);

    useEffect(() => {
        if (prices.data) setCurrency(prices.data.currency);
    }, [prices.data?.currency]);

    const num = (t: string) => (t.trim() === "" ? NaN : Number(t.replace(",", ".")));
    async function save() {
        setNotice(null);
        const body: Record<string, unknown> = { currency: currency.trim() };
        if (model.trim() || input.trim() || output.trim()) {
            if (!model.trim() || !(num(input) >= 0) || !(num(output) >= 0)) {
                setNotice({ tone: "danger", text: "Enter the model name and both prices as numbers, for example 3 and 15." });
                return;
            }
            if ((cachedIn.trim() && !(num(cachedIn) >= 0)) || (cacheWrite.trim() && !(num(cacheWrite) >= 0))) {
                setNotice({ tone: "danger", text: "Enter the cache prices as numbers, or leave them empty." });
                return;
            }
            Object.assign(body, {
                model: model.trim(),
                inputPerMTok: num(input),
                outputPerMTok: num(output),
                ...(cachedIn.trim() ? { cachedInputPerMTok: num(cachedIn) } : {}),
                ...(cacheWrite.trim() ? { cacheWritePerMTok: num(cacheWrite) } : {}),
            });
        }
        setBusy(true);
        try {
            await api("/usage/prices", { method: "PUT", body });
            setNotice({ tone: "success", text: body.model ? `Price saved for ${String(body.model)}.` : "Currency label saved." });
            setModel("");
            setInput("");
            setOutput("");
            setCachedIn("");
            setCacheWrite("");
            await Promise.all([prices.reload(), onSaved()]);
        } catch (e) {
            setNotice({ tone: "danger", text: describeApiError(e) });
        } finally {
            setBusy(false);
        }
    }
    async function remove(m: string) {
        setNotice(null);
        try {
            await api(`/usage/prices?model=${encodeURIComponent(m)}`, { method: "DELETE" });
            setNotice({ tone: "success", text: `Price removed for ${m}.` });
            await Promise.all([prices.reload(), onSaved()]);
        } catch (e) {
            setNotice({ tone: "danger", text: describeApiError(e) });
        }
    }

    return (
        <form
            className="usage-sub"
            aria-labelledby="usage-prices-h"
            onSubmit={(e) => {
                e.preventDefault();
                void save();
            }}
        >
            <h3 className="t-card" id="usage-prices-h">
                Prices
            </h3>
            <p className="t-secondary">No prices are built in, because they change. Enter what your provider charges per million tokens to see a cost. Without a price only tokens are shown.</p>
            <div className="usage-form">
                <div className="field">
                    <label htmlFor="usage-price-model">Model name</label>
                    <input id="usage-price-model" className="input" autoComplete="off" value={model} onChange={(e) => setModel(e.target.value)} aria-describedby="usage-price-model-hint" />
                    <span className="hint" id="usage-price-model-hint">The name shown in the table above.</span>
                </div>
                <div className="field">
                    <label htmlFor="usage-price-in">Input, per million tokens</label>
                    <input id="usage-price-in" className="input" inputMode="decimal" autoComplete="off" value={input} onChange={(e) => setInput(e.target.value)} />
                </div>
                <div className="field">
                    <label htmlFor="usage-price-out">Output, per million tokens</label>
                    <input id="usage-price-out" className="input" inputMode="decimal" autoComplete="off" value={output} onChange={(e) => setOutput(e.target.value)} />
                </div>
                <div className="field">
                    <label htmlFor="usage-price-cached">Cached input, per million tokens</label>
                    <input id="usage-price-cached" className="input" inputMode="decimal" autoComplete="off" placeholder="Optional" value={cachedIn} onChange={(e) => setCachedIn(e.target.value)} aria-describedby="usage-price-cache-hint" />
                </div>
                <div className="field">
                    <label htmlFor="usage-price-cache-write">Cache writes, per million tokens</label>
                    <input id="usage-price-cache-write" className="input" inputMode="decimal" autoComplete="off" placeholder="Optional" value={cacheWrite} onChange={(e) => setCacheWrite(e.target.value)} aria-describedby="usage-price-cache-hint" />
                    <span className="hint" id="usage-price-cache-hint">What your provider charges for input read from and written to its prompt cache. Empty: charged at the input price.</span>
                </div>
                <div className="field">
                    <label htmlFor="usage-currency">Currency label</label>
                    <input id="usage-currency" className="input" maxLength={8} autoComplete="off" placeholder="None" value={currency} onChange={(e) => setCurrency(e.target.value)} aria-describedby="usage-currency-hint" />
                    <span className="hint" id="usage-currency-hint">For example USD or EUR. Shown next to amounts.</span>
                </div>
            </div>
            <div className="row">
                <Button type="submit" variant="primary" loading={busy}>
                    Save price
                </Button>
            </div>
            <Feedback notice={notice} />
            {prices.data && prices.data.prices.length > 0 && (
                <ul className="usage-prices" aria-label="Prices you set" data-testid="usage-price-list">
                    {prices.data.prices.map((p) => (
                        <li key={p.model}>
                            <span>
                                <strong>{p.model}</strong>
                                <span className="t-meta">
                                    {" "}
                                    {p.inputPerMTok} in, {p.outputPerMTok} out
                                    {p.cachedInputPerMTok !== undefined ? `, ${p.cachedInputPerMTok} cached in` : ""}
                                    {p.cacheWritePerMTok !== undefined ? `, ${p.cacheWritePerMTok} cache writes` : ""}, per million tokens
                                </span>
                            </span>
                            <Button size="sm" variant="ghost" type="button" onClick={() => void remove(p.model)} aria-label={`Remove the price for ${p.model}`}>
                                Remove
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
        </form>
    );
}
