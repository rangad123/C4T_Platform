import { GitCompareArrows } from "lucide-react";
import { Badge, Button, Callout, Skeleton } from "../../components/ui";
import { plural, relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { SHOWN, type ApiChange, type ApiChanges } from "./apiChanges";
import "./contracts.css";

function Group({ title, tone, items, testId, tip }: { title: string; tone: "danger" | "neutral"; items: ApiChange[]; testId: string; tip: string }) {
    if (items.length === 0) return null;
    const rows = (list: ApiChange[]) =>
        list.map((c, i) => (
            <li key={`${c.operation}-${i}`} className="api-change">
                <code>{c.operation}</code>
                <span className="what">{c.message}</span>
            </li>
        ));
    return (
        <div className="api-changes-group" data-testid={testId}>
            <div className="row">
                <Badge tone={tone} tip={tip} tipFocusable>{title}</Badge>
                <span className="t-meta">{items.length}</span>
            </div>
            <ul className="api-change-list">{rows(items.slice(0, SHOWN))}</ul>
            {items.length > SHOWN && (
                <details>
                    <summary>Show {items.length - SHOWN} more</summary>
                    <ul className="api-change-list">{rows(items.slice(SHOWN))}</ul>
                </details>
            )}
        </div>
    );
}

/**
 * What the live API changed since the previous run, found by comparing the shapes of its real responses (no API
 * description needed). Shown on the project Overview only once there are two runs to compare.
 */
export function ApiChangesCard({ projectId }: { projectId: string }) {
    const changes = useFetch<ApiChanges>(`/projects/${projectId}/api-changes`);
    if (changes.loading) {
        return (
            <section className="stack-sm" aria-label="API changes">
                <Skeleton h={18} w={120} />
                <Skeleton h={60} />
            </section>
        );
    }
    if (changes.error) {
        return (
            <section data-testid="api-changes" aria-label="API changes">
                <div className="section-head">
                    <h2 className="t-section">API changes</h2>
                </div>
                <div className="card card-pad">
                    <Callout tone="warning" title="Could not check the API for changes" actions={<Button size="sm" onClick={() => void changes.reload()}>Try again</Button>}>
                        The comparison with the previous run could not be loaded.
                    </Callout>
                </div>
            </section>
        );
    }
    const data = changes.data;
    if (!data || !data.from || !data.to) return null; // fewer than two runs: nothing to compare yet
    const none = data.breaking.length === 0 && data.nonBreaking.length === 0;
    return (
        <section data-testid="api-changes" aria-label="API changes">
            <div className="section-head">
                <GitCompareArrows size={18} aria-hidden />
                <h2 className="t-section">API changes</h2>
                <span className="t-meta">Compared with the run from {relativeTime(data.from.at)}</span>
            </div>
            <div className="card card-pad stack-sm">
                {data.breaking.length > 0 && (
                    <Callout tone="danger" title={`${plural(data.breaking.length, "change")} that can break existing clients`}>
                        Applications that use this API the way the previous run saw it may stop working.
                    </Callout>
                )}
                {none && <p className="t-secondary">The API answered the same way as in the previous run: no fields, types or endpoints changed.</p>}
                <Group title="Can break clients" tone="danger" items={data.breaking} testId="api-changes-breaking" tip="A client written against the previous run may stop working: a field or operation was removed, a type changed, or a request that used to succeed now fails." />
                <Group title="Other changes" tone="neutral" items={data.nonBreaking} testId="api-changes-other" tip="New fields or operations, or a request that now succeeds. Clients that worked before keep working." />
            </div>
        </section>
    );
}
