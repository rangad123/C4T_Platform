import { Bug, ExternalLink } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { Button, Callout, LinkButton, Menu, MenuItem, Skeleton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { TRACKER_LABEL, describeConnection, type Integration, type IssueLink } from "./types";
import { Tooltip } from "../../components/Tooltip";

/**
 * "Issue tracker" row on a test that found a problem: links to the issues already created from it and a
 * button to create one in a connected tracker (a choice, when several are connected).
 */
export function IssueSection({ testId, projectId }: { testId: string; projectId: string }) {
    const integrations = useFetch<Integration[]>(`/projects/${projectId}/integrations`);
    const links = useFetch<IssueLink[]>(`/tests/${testId}/issues`);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    if (integrations.loading || links.loading) return <Skeleton h={52} style={{ borderRadius: 12 }} />;
    // A failure to load the tracker list should not get in the way of reading the test.
    if (integrations.error || links.error) return null;

    const conns = integrations.data ?? [];
    const made = links.data ?? [];
    const open = conns.filter((c) => !made.some((l) => l.integrationId === c.id));

    async function create(c: Integration) {
        setBusy(true);
        setError("");
        try {
            await api(`/tests/${testId}/issue`, { method: "POST", body: { integrationId: c.id } });
            await links.reload();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy(false);
        }
    }

    // Nothing connected and nothing made: one line and one action, not a card.
    if (conns.length === 0 && made.length === 0) {
        return (
            <p className="t-secondary row" data-testid="issue-empty" style={{ flexWrap: "wrap" }}>
                No issue tracker is connected, so this can’t go to GitHub, Jira or Notion yet.
                <LinkButton size="sm" href={routes.tests(projectId)}>Open Tests to connect one</LinkButton>
            </p>
        );
    }

    return (
        <section className="card card-pad stack-sm" aria-label="Issue tracker">
            <div className="row">
                <Bug size={17} aria-hidden />
                <h2 className="t-section">Issue tracker</h2>
                <span className="spacer" />
                {open.length === 1 && (
                    <Button icon={Bug} loading={busy} disabled={busy} onClick={() => void create(open[0]!)}>
                        {conns.length > 1 ? `Create issue in ${TRACKER_LABEL[open[0]!.kind]}` : "Create issue"}
                    </Button>
                )}
                {open.length > 1 && (
                    <Menu label={busy ? "Creating…" : "Create issue"} icon={Bug}>
                        {(close) =>
                            open.map((c) => (
                                <MenuItem key={c.id} onClick={() => { close(); void create(c); }} hint={describeConnection(c)}>
                                    {c.name}
                                </MenuItem>
                            ))
                        }
                    </Menu>
                )}
            </div>
            {made.length > 0 && (
                <ul className="chips" aria-label="Issues created from this test" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                    {made.map((l) => (
                        <li key={l.id}>
                            <Tooltip content={l.title ?? undefined}>
                                <a className="chip" href={l.url} target="_blank" rel="noreferrer">
                                    {TRACKER_LABEL[l.provider]} {l.externalId}
                                    <ExternalLink size={13} aria-hidden />
                                    <span className="sr-only"> (opens in a new tab)</span>
                                </a>
                            </Tooltip>
                        </li>
                    ))}
                </ul>
            )}
            {conns.length === 0 && made.length > 0 && <p className="t-meta">No issue tracker is connected now, so no new issue can be created from here.</p>}
            {conns.length > 0 && open.length === 0 && made.length > 0 && <p className="t-meta">An issue has been created in every connected tracker.</p>}
            {error && <Callout tone="danger" title="We couldn’t create the issue">{error}</Callout>}
        </section>
    );
}
