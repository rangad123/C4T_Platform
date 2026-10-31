import { Download, FileText, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { Button, Callout, EmptyState, ErrorState, LinkButton, ListSkeleton, Skeleton } from "../../components/ui";
import { friendlyError } from "../../lib/labels";
import { useFetch } from "../../lib/hooks";
import { go, useRoute } from "../../lib/router";
import { SecurityLayout } from "./SecurityChrome";
import { SEC, STATE_WORDS, downloadFrom, isRunning, sec, securityError, useApps, useAssessments, when, type AssessmentRow } from "./security";

/**
 * Reports: the whole project or one assessment, read here as HTML (in a sandboxed frame: the report runs no script) and downloaded as
 * PDF or CSV. The server records every export in the security activity.
 */
export function ReportsPage({ id }: { id: string }) {
    const chosen = useRoute().query.get("assessment") ?? "";
    const list = useAssessments(id);
    const apps = useApps(id);
    const finished = [...list.list].filter((a) => !isRunning(a.state)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const base = chosen ? `${SEC}/assessments/${chosen}/report` : `${SEC}/projects/${id}/report`;
    const [html, setHtml] = useState<string>();
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState<"" | "pdf" | "csv" | "xlsx">("");
    const [dlError, setDlError] = useState("");
    const appName = (a: AssessmentRow) => a.applicationName ?? apps.list.find((x) => x.id === a.applicationId)?.name ?? "Application";
    // A project report also covers findings entered by hand, so it is offered once there is an assessment or any finding.
    const anyFinding = useFetch<{ total?: number }>(`${SEC}/projects/${id}/findings?limit=1`);
    const has = list.list.length > 0 || (anyFinding.data?.total ?? 0) > 0;

    useEffect(() => {
        if (!has) return;
        let gone = false;
        setLoading(true);
        setError("");
        setHtml(undefined);
        api<string>(`${base}?format=html`)
            .then((t) => !gone && setHtml(typeof t === "string" ? t : JSON.stringify(t)))
            .catch((e) => !gone && setError(securityError(e)))
            .finally(() => !gone && setLoading(false));
        return () => {
            gone = true;
        };
    }, [base, has]);

    async function download(format: "pdf" | "csv" | "xlsx") {
        setBusy(format);
        setDlError("");
        try {
            await downloadFrom(`${base}?format=${format}`, `security-report${chosen ? `-${chosen}` : ""}.${format}`);
        } catch (e) {
            setDlError(securityError(e));
        } finally {
            setBusy("");
        }
    }

    const content = () => {
        if (list.loading || anyFinding.loading) return <ListSkeleton rows={2} />;
        if (list.error) return <ErrorState error={friendlyError(list.error.message)} onRetry={list.reload} />;
        if (!has)
            return (
                <div className="card">
                    <EmptyState icon={FileText} title="No reports yet" actions={<LinkButton href={sec.newAssessment(id)} variant="primary" icon={ShieldCheck}>New assessment</LinkButton>}>
                        No assessments yet. Add an application and run your first passive assessment; its report appears here.
                    </EmptyState>
                </div>
            );
        return (
            <div className="stack">
                <div className="card card-pad stack-sm">
                    <div className="field" style={{ maxWidth: 560 }}>
                        <label htmlFor="rp-which">Report on</label>
                        <select id="rp-which" className="input" value={chosen} onChange={(e) => go(sec.reports(id, e.target.value || undefined))}>
                            <option value="">The whole project, every application</option>
                            {finished.map((a) => (
                                <option key={a.id} value={a.id}>
                                    {appName(a)}
                                    {a.retestOf ? ", retest" : ""}, {when(a.createdAt)}, {STATE_WORDS[a.state].label.toLowerCase()}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="row" data-tour="sec-downloads">
                        <Button icon={Download} loading={busy === "pdf"} disabled={!!busy} onClick={() => void download("pdf")} tip="Saves the report shown below as a PDF file to share with the client.">
                            Download PDF
                        </Button>
                        <Button icon={Download} loading={busy === "csv"} disabled={!!busy} onClick={() => void download("csv")} tip="Saves one row per finding: severity, state, location, description, fix and evidence.">
                            Download findings as CSV
                        </Button>
                        <Button icon={Download} loading={busy === "xlsx"} disabled={!!busy} onClick={() => void download("xlsx")} tip="Saves an Excel workbook: a Summary sheet and a Findings sheet with the CSV’s columns. Every cell is plain text or a number, never a formula.">
                            Download as Excel
                        </Button>
                        <span className="hint">The CSV and the Excel workbook open in any spreadsheet. Secret-looking values are hidden in every format.</span>
                    </div>
                    {dlError && (
                        <Callout tone="danger" title="The download did not work">
                            {dlError}
                        </Callout>
                    )}
                </div>
                {loading ? (
                    <Skeleton h={420} style={{ borderRadius: 12 }} />
                ) : error ? (
                    <Callout tone="danger" title="We couldn’t show the report">
                        {error}
                    </Callout>
                ) : html !== undefined ? (
                    <iframe className="sec-report" title="Security assessment report" sandbox="" srcDoc={html} data-testid="sec-report-frame" />
                ) : null}
            </div>
        );
    };
    return (
        <SecurityLayout id={id} active="reports" title="Reports" subtitle="Executive summary, scope and authorization, findings, coverage and limits, ready to share with the client.">
            {content()}
        </SecurityLayout>
    );
}
