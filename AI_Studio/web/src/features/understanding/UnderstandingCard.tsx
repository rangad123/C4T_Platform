import { useState } from "react";
import { Square, Telescope, RefreshCw } from "lucide-react";
import { api } from "../../api";
import { Badge, Button, Callout, Metric, Skeleton } from "../../components/ui";
import { relativeTime } from "../../lib/format";
import { useFetch, useOnFinish } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import { useHere } from "../auth/project-access";
import { rulesLine, SOURCE_WORDS, STATUS_TONE, STATUS_WORDS, useLatestModel, type Rule, type SourcesAnswer } from "./understanding";
import "./understanding.css";

/**
 * "Application understanding" on the Dashboard of a project tested by the AI agent: what the latest analysis of the application found
 * (pages, workflows, endpoints, rules), the sources it came from and which failed, what it could not work out, when it ran and which
 * version of the application it describes. A person who may change tests can analyse again or stop a running analysis.
 */
export function UnderstandingCard({ projectId }: { projectId: string }) {
    const sources = useFetch<SourcesAnswer>(`/projects/${projectId}/intel/sources`, (d) => (d?.running ? 3000 : null));
    const latest = useLatestModel(projectId);
    const rules = useFetch<{ rules: Rule[] }>(`/projects/${projectId}/intel/rules`);
    const canWrite = useHere(projectId).may("ai_studio.tests.write");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const running = sources.data?.running ?? null;
    useOnFinish(Boolean(running), () => void Promise.all([latest.reload(), rules.reload()]));

    async function act(method: "POST" | "DELETE") {
        setError("");
        setBusy(true);
        try {
            await api(`/projects/${projectId}/intel/analyse`, { method });
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy(false);
            await sources.reload();
        }
    }

    const head = (
        <div className="section-head">
            <Telescope size={18} aria-hidden />
            <h2 className="t-section" id="understanding-title">
                Application understanding
            </h2>
        </div>
    );
    if (sources.loading || latest.loading) {
        return (
            <section className="stack-sm" aria-labelledby="understanding-title">
                {head}
                <Skeleton h={90} />
            </section>
        );
    }
    const loadError = sources.error ?? latest.error ?? rules.error;
    const v = latest.data;
    const last = sources.data?.last;
    const list = rules.data?.rules ?? [];
    const version = v?.appVersion.label ? `, version ${v.appVersion.label}` : v ? ", no version label" : "";

    return (
        <section aria-labelledby="understanding-title" data-testid="understanding">
            {head}
            <div className="card card-pad stack-sm">
                <div className="row understanding-status-row">
                    <p className="t-secondary" data-testid="understanding-status">
                        {running
                            ? `Reading the application, started ${relativeTime(running.since)}.`
                            : v
                              ? `Last read ${relativeTime(last?.at ?? v.createdAt)}${version}.`
                              : "Not read yet. Exploring the application reads it."}
                    </p>
                    <span className="spacer" />
                    {canWrite && running && (
                        <Button size="sm" icon={Square} loading={busy} onClick={() => void act("DELETE")}>
                            Stop
                        </Button>
                    )}
                    {canWrite && !running && (
                        <Button size="sm" icon={RefreshCw} loading={busy} onClick={() => void act("POST")}>
                            {v ? "Read again" : "Read now"}
                        </Button>
                    )}
                </div>
                {error && (
                    <Callout tone="warning">
                        <span data-testid="understanding-error">{error}</span>
                    </Callout>
                )}
                {loadError && <Callout tone="warning" title="Some of what we know could not be loaded">{describeApiError(loadError)}</Callout>}
                {!running && last?.error && <Callout tone="warning" title="The last reading did not finish">{last.error}</Callout>}
                {v && (
                    <>
                        <div className="metrics understanding-metrics" data-testid="understanding-counts">
                            <Metric value={v.model.pages.length} label="Pages" />
                            <Metric value={v.model.workflows.length} label="Workflows" />
                            <Metric value={v.model.endpoints.length} label="Endpoints" />
                            <Metric value={list.length} label="Rules" />
                        </div>
                        {list.length > 0 && (
                            <p className="t-secondary" data-testid="understanding-rules">
                                {rulesLine(list)}
                            </p>
                        )}
                    </>
                )}
                {(sources.data?.sources.length ?? 0) > 0 && (
                    <div className="understanding-group">
                        <h3 className="t-card">Sources</h3>
                        <ul className="understanding-list" data-testid="understanding-sources">
                            {sources.data!.sources.map((s) => (
                                <li key={s.id}>
                                    <span className="understanding-source">
                                        <span>{SOURCE_WORDS[s.kind] ?? "Source"}</span>
                                        <span className="t-meta truncate">{s.ref}</span>
                                        <Badge tone={STATUS_TONE[s.status]}>{STATUS_WORDS[s.status]}</Badge>
                                    </span>
                                    {s.status === "failed" && s.error && <span className="t-secondary understanding-why">{s.error}</span>}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
                {(v?.model.missingContext.length ?? 0) > 0 && (
                    <div className="understanding-group">
                        <h3 className="t-card">What is missing</h3>
                        <ul className="understanding-list" data-testid="understanding-missing">
                            {v!.model.missingContext.map((m) => (
                                <li key={m.text}>{m.text}</li>
                            ))}
                        </ul>
                    </div>
                )}
            </div>
        </section>
    );
}
