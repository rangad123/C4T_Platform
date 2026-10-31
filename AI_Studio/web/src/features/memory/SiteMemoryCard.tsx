import { Brain, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { Button, Callout, Disclosure, Skeleton } from "../../components/ui";
import { plural, relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { plainWords } from "../../lib/labels";
import { changeGroups, type SiteMemory } from "./memory";
import "./memory.css";

/**
 * What we remember about the application between analyses, and what changed in the latest one. Shown on the project
 * Overview once an analysis has finished. "Forget" starts the next analysis from scratch (after a confirmation).
 */
export function SiteMemoryCard({ projectId }: { projectId: string }) {
    const memory = useFetch<SiteMemory>(`/projects/${projectId}/memory`);
    const [confirm, setConfirm] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [forgotten, setForgotten] = useState(false);

    const forget = async () => {
        setBusy(true);
        setError(null);
        try {
            await api(`/projects/${projectId}/memory`, { method: "DELETE" });
            setConfirm(false);
            setForgotten(true);
            await memory.reload();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Something went wrong");
        } finally {
            setBusy(false);
        }
    };

    const head = (
        <div className="section-head">
            <Brain size={18} aria-hidden />
            <h2 className="t-section">What we remember about this site</h2>
        </div>
    );

    if (memory.loading) {
        return (
            <section className="stack-sm" aria-label="Site memory">
                <Skeleton h={18} w={220} />
                <Skeleton h={60} />
            </section>
        );
    }
    if (memory.error) {
        return (
            <section data-testid="site-memory" aria-label="Site memory">
                {head}
                <div className="card card-pad">
                    <Callout tone="warning" title="Could not load what we remember" actions={<Button size="sm" onClick={() => void memory.reload()}>Try again</Button>}>
                        This does not affect your tests. Try again in a moment.
                    </Callout>
                </div>
            </section>
        );
    }
    const data = memory.data;
    // Nothing remembered yet: no card (an empty card on a first run only adds noise), except to confirm that it was just forgotten.
    if (!forgotten && (!data || !data.remembered)) return null;
    if (!data || !data.remembered) {
        return (
            <section data-testid="site-memory" aria-label="Site memory">
                {head}
                <div className="card card-pad stack-sm">
                    {forgotten && <Callout tone="success">Forgotten. The next exploration starts from scratch.</Callout>}
                    <p className="t-secondary" data-testid="site-memory-empty">
                        {data && !data.remembered ? plainWords(data.message) : "Nothing has been learned about this application yet."}
                    </p>
                </div>
            </section>
        );
    }

    const groups = data.changes ? changeGroups(data.changes) : [];
    return (
        <section data-testid="site-memory" aria-label="Site memory">
            {head}
            <div className="card card-pad stack-sm">
                {data.changes ? (
                    <p data-testid="site-memory-changes" style={{ margin: 0, fontWeight: 600 }}>
                        {plainWords(data.changes.text)}
                    </p>
                ) : (
                    <p className="t-secondary" data-testid="site-memory-first" style={{ margin: 0 }}>
                        This was the first exploration, so there is nothing to compare with yet. What was learned is saved, and the next exploration will start from it and show what changed.
                    </p>
                )}
                {groups.length > 0 && (
                    <Disclosure label="See what changed">
                        <div className="memory-changes">
                            {groups.map((g) => (
                                <div className="memory-group" key={g.key}>
                                    <h3>{g.title}</h3>
                                    <ul className="memory-list">
                                        {g.items.map((item) => (
                                            <li key={item}>
                                                <code>{item}</code>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            ))}
                        </div>
                    </Disclosure>
                )}
                <ul className="memory-facts" aria-label="What is remembered">
                    <li>
                        <strong>{plural(data.counts.pages, "page")}</strong>
                    </li>
                    <li>
                        <strong>{plural(data.counts.journeys, "journey")}</strong>
                        {data.counts.journeys > 0 && ` (${data.counts.journeysWithValidatedTests} with passing tests)`}
                    </li>
                    <li>
                        <strong>{plural(data.counts.endpoints, "API endpoint")}</strong>
                    </li>
                    <li>Last explored {relativeTime(data.analysedAt)}</li>
                </ul>
                <p className="t-meta" style={{ margin: 0 }}>
                    Only the structure is kept (page addresses, types and journey names), never page text, passwords or personal data. The next exploration starts from it, but still explores the whole site.
                </p>
                {error && <Callout tone="danger">{error}</Callout>}
                <div className="memory-acts">
                    {confirm ? (
                        <>
                            <span className="t-secondary">Forget what we learned about this site? The next exploration starts from scratch.</span>
                            <Button size="sm" variant="danger" loading={busy} onClick={() => void forget()}>
                                Yes, forget it
                            </Button>
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(false)}>
                                Keep it
                            </Button>
                        </>
                    ) : (
                        <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setConfirm(true)}>
                            Forget what we learned
                        </Button>
                    )}
                </div>
            </div>
        </section>
    );
}
