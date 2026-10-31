import { Blocks, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type ProjectDetail } from "../../api";
import { usePage } from "../../components/Shell";
import { Badge, Button, Callout, EmptyState, ErrorState, LinkButton, ListSkeleton, PageHeader } from "../../components/ui";
import { plural } from "../../lib/format";
import { useDocumentTitle, useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { blockError, KIND_TEXT, paramsText, usedByText, type Block, type BlockList } from "./blocks";
import { BlockEditor } from "./BlockEditor";
import "./blocks.css";

type Notice = { tone: "success" | "info" | "warning"; title: string; text: string };

/** `#/projects/:id/blocks`: named groups of steps that tests use. Change them here and every test that uses them follows. */
export function BlocksPage({ id, edit }: { id: string; edit?: string }) {
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    const list = useFetch<BlockList>(`/projects/${id}/blocks`);
    // `undefined` = the list; `{}` = new reusable steps; `{ block }` = change one.
    const [editing, setEditing] = useState<{ block?: Block } | undefined>(undefined);
    const [notice, setNotice] = useState<Notice | null>(null);
    const [confirming, setConfirming] = useState<string | null>(null);
    const [problem, setProblem] = useState<{ message: string; items: string[] } | null>(null);
    const [opened, setOpened] = useState(false);

    const name = project.data?.name;
    useDocumentTitle(name ? `Reusable steps, ${name}` : "Reusable steps");
    usePage({
        crumbs: [{ label: "Projects", href: routes.home }, { label: name ?? "…", href: routes.project(id) }, { label: "Test scripts", href: routes.scripts(id) }, { label: "Reusable steps" }],
        nav: "projects",
    });

    // A link from the test builder ("Edit the reusable steps") opens that set straight away.
    useEffect(() => {
        if (opened || !edit || !list.data) return;
        setOpened(true);
        const b = list.data.blocks.find((x) => x.name.toLowerCase() === edit.toLowerCase());
        if (b) setEditing({ block: b });
        else setNotice({ tone: "warning", title: "Those reusable steps were not found", text: `“${edit}” is not in this project any more.` });
    }, [edit, list.data, opened]);

    const blocks = list.data?.blocks ?? [];

    async function remove(b: Block) {
        setProblem(null);
        try {
            await api(`/projects/${id}/blocks/${encodeURIComponent(b.name)}`, { method: "DELETE" });
            setConfirming(null);
            setNotice({ tone: "info", title: "Reusable steps deleted", text: `“${b.name}” was removed.` });
            await list.reload();
        } catch (err) {
            setConfirming(null);
            setProblem(blockError(err));
        }
    }

    if (editing && list.data) {
        return (
            <>
                <PageHeader title={editing.block ? "Change reusable steps" : "Add reusable steps"} subtitle="Steps that many tests can use. Change them once and every test follows." />
                <BlockEditor
                    key={editing.block?.id ?? "new"}
                    projectId={id}
                    list={list.data}
                    existing={editing.block}
                    onCancel={() => setEditing(undefined)}
                    onSaved={(_b, n) => {
                        setEditing(undefined);
                        setNotice(n);
                        void list.reload();
                    }}
                />
            </>
        );
    }

    return (
        <>
            <PageHeader
                title="Reusable steps"
                subtitle="Save steps once, such as signing in, and use them in many tests."
                actions={
                    <>
                        <Button icon={Plus} variant="primary" onClick={() => setEditing({})} disabled={!list.data}>
                            Add reusable steps
                        </Button>
                        <LinkButton href={routes.tests(id)}>Back to the tests</LinkButton>
                    </>
                }
            />
            <div className="stack">
                {notice && (
                    <Callout tone={notice.tone} title={notice.title}>
                        {notice.text}
                    </Callout>
                )}
                {problem && (
                    <Callout tone="danger" title="That didn’t work">
                        {problem.message}
                        {problem.items.length > 0 && (
                            <ul className="bullets">
                                {problem.items.map((t, i) => (
                                    <li key={i}>{t}</li>
                                ))}
                            </ul>
                        )}
                    </Callout>
                )}

                {list.loading && <ListSkeleton rows={3} />}
                {list.error && !list.data && <ErrorState error={friendlyError(list.error.message)} onRetry={list.reload} />}
                {list.data && blocks.length === 0 && (
                    <div className="card">
                        <h2 className="sr-only">Your reusable steps</h2>
                        <EmptyState
                            icon={Blocks}
                            title="No reusable steps yet"
                            seeHow={{ topic: "reusable-steps" }}
                            actions={
                                <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>
                                    Add reusable steps
                                </Button>
                            }
                        >
                            Save steps you repeat, such as signing in, and use them in any test. You can also open a test, choose Edit steps, and save some of its steps as reusable steps.
                        </EmptyState>
                    </div>
                )}
                {blocks.length > 0 && (
                    <section aria-labelledby="blk-list-title">
                        <div className="section-head">
                            <h2 className="t-section" id="blk-list-title">
                                Your reusable steps
                            </h2>
                            <span className="t-meta">
                                {plural(blocks.length, "set")} of {list.data?.limit}
                            </span>
                        </div>
                        <ul className="card list divided" data-testid="block-list">
                            {blocks.map((b) => (
                                <li key={b.id} className="blk-row">
                                    <div className="blk-main">
                                        <div className="blk-name">
                                            <span className="title">{b.name}</span>
                                            <Badge tone={b.kind === "web" ? "brand" : b.kind === "api" ? "info" : "neutral"}>{KIND_TEXT[b.kind]}</Badge>
                                        </div>
                                        {b.description && <div className="t-secondary">{b.description}</div>}
                                        <div className="t-meta">
                                            {plural(b.stepCount, "step")}, {b.params.length === 0 ? "no values" : `values: ${paramsText(b.params)}`}
                                        </div>
                                        <div className="t-meta">
                                            {usedByText(b.usedBy.count)}
                                            {b.usedBy.tests.length > 0 && `: ${b.usedBy.tests.map((t) => t.title).join(", ")}${b.usedBy.count > b.usedBy.tests.length ? " and more" : ""}`}
                                            {b.usedBy.blocks.length > 0 && `${b.usedBy.count > 0 ? ". " : ""}Used inside ${b.usedBy.blocks.map((n) => `“${n}”`).join(", ")}`}
                                        </div>
                                    </div>
                                    <div className="blk-actions">
                                        {confirming === b.id ? (
                                            <>
                                                <span className="t-meta">{b.usedBy.count || b.usedBy.blocks.length ? "These steps are in use and can’t be deleted." : "Delete these reusable steps?"}</span>
                                                {b.usedBy.count === 0 && b.usedBy.blocks.length === 0 && (
                                                    <Button size="sm" variant="danger" onClick={() => void remove(b)}>
                                                        Delete reusable steps
                                                    </Button>
                                                )}
                                                <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                                                    Keep them
                                                </Button>
                                            </>
                                        ) : (
                                            <>
                                                <Button size="sm" onClick={() => (setNotice(null), setProblem(null), setEditing({ block: b }))} aria-label={`Edit ${b.name}`}>
                                                    Edit
                                                </Button>
                                                <Button size="sm" variant="ghost" onClick={() => setConfirming(b.id)} aria-label={`Delete ${b.name}`}>
                                                    Delete
                                                </Button>
                                            </>
                                        )}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </section>
                )}
            </div>
        </>
    );
}
