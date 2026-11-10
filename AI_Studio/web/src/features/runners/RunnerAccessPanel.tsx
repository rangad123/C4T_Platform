import { Server } from "lucide-react";
import { useState } from "react";
import { ApiError, api } from "../../api";
import { Badge, Button, Callout, ErrorState, ListSkeleton } from "../../components/ui";
import { friendlyError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { useHere } from "../auth/project-access";
import { usePolled } from "../agents/agents";
import { HowToAddRunner } from "./RunnersPages";
import { STATUS_WORDS, type RunnerAccess } from "./runners";

/** Project settings: the runners this project may use, and (with "manage runners") giving or removing access. */
export function RunnerAccessPanel({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
    const can = useHere(projectId).may;
    const f = usePolled<RunnerAccess>(`/projects/${projectId}/runner-access`);
    const [choice, setChoice] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const data = f.data;
    const change = async (method: "PUT" | "DELETE", runnerId: string) => {
        setBusy(true);
        setError("");
        try {
            await api(`/projects/${projectId}/runner-access/${runnerId}`, { method });
            setChoice("");
            await f.reload();
            onChanged();
        } catch (e) {
            setError(e instanceof ApiError ? e.message : "That did not work. Try again.");
        } finally {
            setBusy(false);
        }
    };
    const pick = can("ai_studio.runners.manage") ? (data?.available ?? []) : [];
    const selected = choice || pick[0]?.id || "";
    return (
        <section className="card card-pad stack-sm" aria-labelledby="runner-access-title" data-testid="runner-access">
            <div className="row">
                <Server size={18} aria-hidden />
                <h2 className="t-section" id="runner-access-title">
                    Runners this project may use
                </h2>
            </div>
            {error && <Callout tone="danger">{error}</Callout>}
            {f.loading && !data ? (
                <ListSkeleton rows={2} />
            ) : f.error || !data ? (
                <ErrorState error={friendlyError(f.error?.message ?? "")} onRetry={f.reload} />
            ) : (
                <>
                    {data.runners.length === 0 ? (
                        <p className="t-secondary">
                            <HowToAddRunner canAddPersonal={can("ai_studio.tests.run")} canAddTeam={can("ai_studio.runners.manage")} />
                        </p>
                    ) : (
                        <ul className="list divided" aria-label="Runners this project may use">
                            {data.runners.map((r) => (
                                <li key={r.id} className="list-row">
                                    <span className="main">
                                        <a className="title truncate" href={routes.runner(r.id)}>
                                            {r.name}
                                        </a>
                                        <span className="meta">{r.ownerName}</span>
                                    </span>
                                    <Badge tone={STATUS_WORDS[r.status].tone} tip={STATUS_WORDS[r.status].tip} tipFocusable>
                                        {STATUS_WORDS[r.status].label}
                                    </Badge>
                                    {r.canManage && can("ai_studio.runners.manage") && (
                                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void change("DELETE", r.id)} aria-label={`Stop using ${r.name}`}>
                                            Stop using
                                        </Button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                    {pick.length > 0 && (
                        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                            <div className="field" style={{ flex: "1 1 240px" }}>
                                <label htmlFor="runner-give">Give this project a runner</label>
                                <select id="runner-give" className="input" value={selected} onChange={(e) => setChoice(e.target.value)}>
                                    {pick.map((r) => (
                                        <option key={r.id} value={r.id}>
                                            {r.name} ({r.ownerName})
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <Button loading={busy} disabled={busy} onClick={() => void change("PUT", selected)}>
                                Give access
                            </Button>
                        </div>
                    )}
                </>
            )}
        </section>
    );
}
