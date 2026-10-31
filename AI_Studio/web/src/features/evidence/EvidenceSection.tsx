import { useMemo, useState } from "react";
import { Badge, Button, Disclosure, Skeleton } from "../../components/ui";
import { duration } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { HelpTip, Tooltip } from "../../components/Tooltip";
import { LINE_TYPE, isFailed, isNearFailure, requestName, requestResult, sizeText, whenText, type EvidenceAnswer, type EvidenceLine, type EvidenceRequest } from "./evidence";
import "./evidence.css";

const FIRST_ROWS = 100;
const FAILED_ROWS = 8;

/**
 * "What the page did": for a web test that did not pass, the network calls and console messages recorded during the failed run,
 * starting with one sentence on what likely matters. Addresses are shown without secret values; nothing here is a request or
 * response body (those are never recorded).
 */
export function EvidenceSection({ testId }: { testId: string }) {
    const data = useFetch<EvidenceAnswer>(`/tests/${testId}/evidence`);
    const a = data.data;
    return (
        <section className="section stack-sm" aria-labelledby="evidence-title" data-testid="page-evidence">
            <h2 className="t-section" id="evidence-title">
                What the page did
            </h2>
            {data.loading && <Skeleton h={48} />}
            {!data.loading && (data.error || !a) && (
                <p className="t-secondary">
                    We couldn’t load what the page did.{" "}
                    <Button size="sm" onClick={() => void data.reload()}>
                        Try again
                    </Button>
                </p>
            )}
            {a && !a.available && (
                <p className="t-secondary" data-testid="evidence-empty">
                    {a.message ?? "Nothing was recorded for this run."}
                </p>
            )}
            {a?.available && a.summary && a.evidence && a.highlights && <Details a={a} />}
        </section>
    );
}

function Details({ a }: { a: EvidenceAnswer }) {
    const failedStep = a.execution?.failedStep;
    const h = a.highlights!;
    const ev = a.evidence!;
    const worth = [...h.failed.slice(0, FAILED_ROWS), ...h.slow];
    const hiddenFailed = Math.max(0, h.failed.length - FAILED_ROWS);
    return (
        <>
            <p className="evidence-summary" data-testid="evidence-summary">
                {a.summary!.sentence}
            </p>
            {worth.length > 0 && (
                <div className="stack-sm">
                    <h3 className="t-card">
                        Requests that failed or were slow{" "}
                        <HelpTip label="failed or slow requests" text="Failed: no answer, or an answer with status 400 or higher. Slow: took 2 seconds or more; the five slowest are listed." />
                    </h3>
                    <RequestTable rows={worth} failedStep={failedStep} label="Requests that failed or were slow" />
                    {hiddenFailed > 0 && <p className="t-meta">And {hiddenFailed} more that failed. Open “Show all requests” to see them.</p>}
                </div>
            )}
            {h.errors.length > 0 && (
                <div className="stack-sm">
                    <h3 className="t-card">Console errors</h3>
                    <ul className="evidence-console" aria-label="Console errors">
                        {h.errors.slice(0, 10).map((l, i) => (
                            <ConsoleItem key={i} line={l} failedStep={failedStep} />
                        ))}
                    </ul>
                    {h.errors.length > 10 && <p className="t-meta">And {h.errors.length - 10} more.</p>}
                </div>
            )}
            <Disclosure label={`Show all requests (${ev.counts.requests})`}>
                <AllRequests requests={ev.requests} total={ev.counts.requests} failedStep={failedStep} />
            </Disclosure>
        </>
    );
}

function ConsoleItem({ line, failedStep }: { line: EvidenceLine; failedStep?: number }) {
    return (
        <li className={`evidence-line${isNearFailure(line.step, failedStep) ? " near" : ""}`}>
            <Badge tone={line.type === "warning" ? "warning" : line.type === "error" || line.type === "pageerror" ? "danger" : "neutral"}>{LINE_TYPE[line.type] ?? line.type}</Badge>
            <span className="evidence-text">{line.text}</span>
            <span className="t-meta">
                {whenText(line.step, failedStep)}
                {line.loc ? `, ${line.loc}` : ""}
            </span>
        </li>
    );
}

function RequestTable({ rows, failedStep, label }: { rows: EvidenceRequest[]; failedStep?: number; label: string }) {
    return (
        <table className="evidence-table">
            <caption className="sr-only">{label}</caption>
            <thead>
                <tr>
                    <th scope="col">Request</th>
                    <th scope="col">Result</th>
                    <th scope="col">Took</th>
                </tr>
            </thead>
            <tbody>
                {rows.map((r, i) => {
                    const res = requestResult(r);
                    return (
                        <tr key={i} className={isNearFailure(r.step, failedStep) && isFailed(r) ? "near" : undefined}>
                            <td>
                                <code className="evidence-addr">{requestName(r)}</code>
                                <span className="t-meta evidence-when">{whenText(r.step, failedStep)}</span>
                            </td>
                            <td>
                                <Badge tone={res.tone}>{res.text}</Badge>
                            </td>
                            <td className="evidence-num">
                                {r.ms !== undefined ? duration(r.ms) : "–"}
                                {r.size !== undefined && r.size > 0 && <span className="t-meta evidence-when">{sizeText(r.size)}</span>}
                            </td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );
}

type Filter = "all" | "failed" | "slow";

/** What each filter keeps (the same tests as the filter below). */
const FILTER_TIP: Record<Filter, string> = { all: "", failed: "No answer, an answer with status 400 or higher, or cancelled.", slow: "Took 1 second or more." };

function AllRequests({ requests, total, failedStep }: { requests: EvidenceRequest[]; total: number; failedStep?: number }) {
    const [filter, setFilter] = useState<Filter>("all");
    const [query, setQuery] = useState("");
    const [shown, setShown] = useState(FIRST_ROWS);
    const rows = useMemo(() => {
        const q = query.trim().toLowerCase();
        return requests.filter((r) => (filter === "failed" ? isFailed(r) || Boolean(r.aborted) : filter === "slow" ? (r.ms ?? 0) >= 1000 : true) && (!q || `${r.method} ${r.host ?? ""}${r.path}`.toLowerCase().includes(q)));
    }, [requests, filter, query]);
    const counts = { all: requests.length, failed: requests.filter((r) => isFailed(r) || r.aborted).length, slow: requests.filter((r) => (r.ms ?? 0) >= 1000).length };
    return (
        <div className="stack-sm">
            {total > requests.length && (
                <p className="t-meta">
                    The page made {total} requests. The {requests.length} most useful ones are listed: failed ones and recent ones first.
                </p>
            )}
            <div className="evidence-filter">
                <input className="input" type="search" aria-label="Filter requests" placeholder="Filter by address, for example /api/cart" value={query} onChange={(e) => { setQuery(e.target.value); setShown(FIRST_ROWS); }} />
                <div className="chips" role="group" aria-label="Show">
                    {(["all", "failed", "slow"] as const).map((f) => (
                        <Tooltip key={f} content={FILTER_TIP[f]}>
                            <button type="button" className="chip" aria-pressed={filter === f} onClick={() => { setFilter(f); setShown(FIRST_ROWS); }}>
                                {f === "all" ? "All" : f === "failed" ? "Failed" : "Slow"} <span className="n">{counts[f]}</span>
                            </button>
                        </Tooltip>
                    ))}
                </div>
            </div>
            {rows.length === 0 ? <p className="t-secondary">No request matches.</p> : <RequestTable rows={rows.slice(0, shown)} failedStep={failedStep} label="All recorded requests" />}
            {rows.length > shown && (
                <div>
                    <Button size="sm" onClick={() => setShown((n) => n + FIRST_ROWS)}>
                        Show {Math.min(FIRST_ROWS, rows.length - shown)} more
                    </Button>
                    <span className="t-meta"> {shown} of {rows.length} shown</span>
                </div>
            )}
        </div>
    );
}
