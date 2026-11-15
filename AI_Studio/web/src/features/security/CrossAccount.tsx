/**
 * On the application's page: the read-only cross-account checks (src/security/assessment/cross-account.ts). The person chooses two of the
 * project's test accounts (A and B) and lists addresses whose owner they know; an assessment then asks whether A can read what is B's.
 *
 *   GET    /api/v1/security/applications/:appId/cross-account   viewer   { designation | null, ready: { ok, problems[] }, signIns: { A, B } }
 *   PUT    /api/v1/security/applications/:appId/cross-account   editor   Designation -> the same answer
 *   DELETE /api/v1/security/applications/:appId/cross-account   editor   { deleted }
 *
 * The server checks everything again (environment, accounts, scope, sign-out and mutation addresses) and enforces who may change it.
 */
import { Plus, Save, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { Modal } from "../../components/Modal";
import { Button, Callout, Disclosure, Skeleton } from "../../components/ui";
import { FieldHelp, HelpTip } from "../../components/Tooltip";
import { useFetch } from "../../lib/hooks";
import { describeApiError, friendlyError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { SIGNIN_WORDS, signInLabel, useSignIns } from "./ApplicationExtras";
import { canRun, useRole } from "./SecurityChrome";
import { SEC, type AppRow } from "./security";

type Kind = "item" | "nested" | "list" | "search";
type Owner = "A" | "B" | "shared" | "public";
interface Resource {
    path: string;
    kind: Kind;
    owner: Owner;
    label?: string;
}
interface Designation {
    accountA: string;
    accountB: string;
    resources: Resource[];
    ownerField?: string;
    ownerValueA?: string;
    ownerValueB?: string;
}
interface Answer {
    designation: Designation | null;
    ready: { ok: boolean; problems: string[] };
}

/** Most resources (src/security/assessment/cross-account.ts CROSS_ACCOUNT_LIMITS.resources). */
const MAX_RESOURCES = 50;
const KIND_WORDS: Record<Kind, string> = { item: "One item", nested: "An item inside another", list: "A list", search: "A search" };
const OWNER_WORDS: Record<Owner, string> = { B: "Account B’s", A: "Account A’s", shared: "Shared by both", public: "Public" };
const CHECK_ENVIRONMENTS = ["development", "staging"];

const blank = (): Resource => ({ path: "", kind: "item", owner: "B", label: "" });

export function CrossAccountPanel({ projectId, app, onChanged }: { projectId: string; app: AppRow; onChanged: () => void }) {
    const role = useRole();
    const x = useFetch<Answer>(`${SEC}/applications/${app.id}/cross-account`);
    const [draft, setDraft] = useState<Designation | null>(null);
    const [removing, setRemoving] = useState(false);
    const d = x.data?.designation ?? null;
    const envOk = CHECK_ENVIRONMENTS.includes(app.environment);
    const done = () => {
        setDraft(null);
        void x.reload();
        onChanged();
    };

    return (
        <section className="card card-pad stack-sm" aria-labelledby="sa-xacct-h" data-testid="sa-xacct">
            <div className="field-label-row">
                <h2 className="t-section" id="sa-xacct-h">
                    Cross-account checks
                </h2>
                <HelpTip
                    label="Cross-account checks"
                    text="Read-only: each address is requested as account B, as account A and signed out, with GET requests only. A finding is A (or a visitor) seeing B’s own data, never a status code alone. They run only on development or staging, and only when the authorization names both accounts."
                />
            </div>
            {x.loading ? (
                <Skeleton h={40} />
            ) : x.error ? (
                <p className="hint">The cross-account settings could not be read ({friendlyError(x.error.message).title}).</p>
            ) : draft ? (
                <CrossAccountForm projectId={projectId} app={app} initial={draft} onCancel={() => setDraft(null)} onDone={done} />
            ) : (
                <>
                    {!d ? (
                        <p className="t-secondary">Not set up. Choose two test accounts and the addresses whose owner you know, and an assessment checks whether account A can read what belongs to account B.</p>
                    ) : (
                        <dl className="kv" data-testid="sa-xacct-summary">
                            <dt>Account A</dt>
                            <dd>{signInLabel(d.accountA)}</dd>
                            <dt>Account B</dt>
                            <dd>{signInLabel(d.accountB)}</dd>
                            <dt>Addresses</dt>
                            <dd>
                                <ul className="sec-plain-list">
                                    {d.resources.map((r, i) => (
                                        <li key={i}>
                                            <span className="sec-loc">{r.path}</span>
                                            <span className="t-meta">
                                                {" "}
                                                {KIND_WORDS[r.kind].toLowerCase()}, {OWNER_WORDS[r.owner].toLowerCase()}
                                                {r.label ? `: ${r.label}` : ""}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </dd>
                            {d.ownerField && (
                                <>
                                    <dt>Owner field</dt>
                                    <dd className="sec-loc">{d.ownerField}</dd>
                                </>
                            )}
                        </dl>
                    )}
                    {!envOk && (
                        <p className="hint" data-testid="sa-xacct-env">
                            This application is not marked as development or staging, so cross-account checks are never made on it. Change its environment first.
                        </p>
                    )}
                    {d && x.data && (
                        <div data-testid="sa-xacct-ready">
                            {x.data.ready.ok ? (
                                <p className="t-secondary">Ready: both accounts have a usable saved sign-in. The checks run when the authorization names both accounts.</p>
                            ) : (
                                <Callout tone="warning" title="Not ready yet">
                                    <ul className="sec-plain-list">
                                        {x.data.ready.problems.map((p) => (
                                            <li key={p}>{p}</li>
                                        ))}
                                    </ul>
                                </Callout>
                            )}
                        </div>
                    )}
                    {canRun(role) ? (
                        <div className="row">
                            {envOk && (
                                <Button icon={Users} onClick={() => setDraft(d ? { ...d, resources: d.resources.map((r) => ({ ...r, label: r.label ?? "" })) } : { accountA: "", accountB: "", resources: [blank()] })}>
                                    {d ? "Change" : "Set up cross-account checks"}
                                </Button>
                            )}
                            {d && (
                                <Button variant="ghost" icon={Trash2} onClick={() => setRemoving(true)}>
                                    Remove
                                </Button>
                            )}
                        </div>
                    ) : (
                        <p className="hint">Only a project owner or editor can change the cross-account checks.</p>
                    )}
                </>
            )}
            {removing && (
                <RemoveCrossAccount
                    app={app}
                    onClose={() => setRemoving(false)}
                    onDone={() => {
                        setRemoving(false);
                        done();
                    }}
                />
            )}
        </section>
    );
}

function CrossAccountForm({ projectId, app, initial, onCancel, onDone }: { projectId: string; app: AppRow; initial: Designation; onCancel: () => void; onDone: () => void }) {
    const s = useSignIns(projectId, app.id);
    const [d, setD] = useState<Designation>(initial);
    const [problem, setProblem] = useState("");
    const [busy, setBusy] = useState(false);
    const accounts = [...new Set([...s.list.map((x) => x.account), ...(initial.accountA ? [initial.accountA] : []), ...(initial.accountB ? [initial.accountB] : [])])];
    const stateOf = (a: string) => s.list.find((x) => x.account === a);
    const put = (i: number, patch: Partial<Resource>) => setD({ ...d, resources: d.resources.map((r, j) => (j === i ? { ...r, ...patch } : r)) });

    async function save(e: React.FormEvent) {
        e.preventDefault();
        if (!d.accountA || !d.accountB) return setProblem("Choose account A and account B.");
        if (d.accountA === d.accountB) return setProblem("Choose two different test accounts.");
        const resources = d.resources.filter((r) => r.path.trim()).map((r) => ({ path: r.path.trim(), kind: r.kind, owner: r.owner, ...(r.label?.trim() ? { label: r.label.trim() } : {}) }));
        if (!resources.length) return setProblem("List at least one address.");
        const opt = (v?: string) => (v?.trim() ? v.trim() : undefined);
        const body = { accountA: d.accountA, accountB: d.accountB, resources, ownerField: opt(d.ownerField), ownerValueA: opt(d.ownerValueA), ownerValueB: opt(d.ownerValueB) };
        setBusy(true);
        setProblem("");
        try {
            await api(`${SEC}/applications/${app.id}/cross-account`, { method: "PUT", body });
            onDone();
        } catch (err) {
            setProblem(describeApiError(err));
            setBusy(false);
        }
    }

    const accountSelect = (which: "A" | "B") => {
        const id = `sa-xacct-${which}`;
        const value = which === "A" ? d.accountA : d.accountB;
        const st = value ? stateOf(value) : undefined;
        return (
            <div className="field">
                <FieldHelp htmlFor={id} label={`Account ${which}`} help={which === "A" ? "The account that must not see account B’s data." : "The account whose data account A must not see."} />
                <select id={id} className="input" value={value} onChange={(e) => setD({ ...d, [which === "A" ? "accountA" : "accountB"]: e.target.value })} aria-describedby={st?.message ? `${id}-state` : undefined}>
                    <option value="">Choose a test account</option>
                    {accounts.map((a) => {
                        const x = stateOf(a);
                        return (
                            <option key={a} value={a}>
                                {signInLabel(a)}
                                {x ? `, ${SIGNIN_WORDS[x.state] ?? x.state}` : ""}
                            </option>
                        );
                    })}
                </select>
                {st?.message && (
                    <p className="hint" id={`${id}-state`}>
                        {st.message}
                    </p>
                )}
            </div>
        );
    };

    return (
        <form className="stack-sm" onSubmit={(e) => void save(e)} data-testid="sa-xacct-form" noValidate>
            <p className="hint">
                Accounts come from the project’s <a href={routes.library(projectId, "accounts")}>Test accounts</a>; each needs a saved sign-in. Only GET requests are sent, and only to addresses in this application’s scope.
            </p>
            <div className="grid-2">
                {accountSelect("A")}
                {accountSelect("B")}
            </div>
            <fieldset className="stack-sm sec-workflows" data-testid="sa-xacct-resources">
                <legend>
                    <span className="sec-legend">Addresses to check</span>
                </legend>
                <p className="hint">Paths of this application, such as /api/notes/42. Say whose each one is, so the check knows what account A should and should not see.</p>
                {d.resources.map((r, i) => (
                    <div key={i} className="sec-workflow stack-sm" role="group" aria-label={`Address ${i + 1}`}>
                        <div className="field">
                            <label htmlFor={`sa-xr-${i}-path`}>Path</label>
                            <input id={`sa-xr-${i}-path`} className="input" value={r.path} maxLength={500} onChange={(e) => put(i, { path: e.target.value })} placeholder="/api/notes/42" />
                        </div>
                        <div className="grid-2">
                            <div className="field">
                                <label htmlFor={`sa-xr-${i}-owner`}>Whose it is</label>
                                <select id={`sa-xr-${i}-owner`} className="input" value={r.owner} onChange={(e) => put(i, { owner: e.target.value as Owner })}>
                                    {(Object.keys(OWNER_WORDS) as Owner[]).map((o) => (
                                        <option key={o} value={o}>
                                            {OWNER_WORDS[o]}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className="field">
                                <label htmlFor={`sa-xr-${i}-kind`}>What it is</label>
                                <select id={`sa-xr-${i}-kind`} className="input" value={r.kind} onChange={(e) => put(i, { kind: e.target.value as Kind })}>
                                    {(Object.keys(KIND_WORDS) as Kind[]).map((k) => (
                                        <option key={k} value={k}>
                                            {KIND_WORDS[k]}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>
                        <div className="field">
                            <label htmlFor={`sa-xr-${i}-label`}>Note (optional)</label>
                            <input id={`sa-xr-${i}-label`} className="input" value={r.label ?? ""} maxLength={120} onChange={(e) => put(i, { label: e.target.value })} placeholder="B’s private note" />
                        </div>
                        <div className="row">
                            <Button type="button" variant="ghost" icon={Trash2} disabled={d.resources.length === 1} onClick={() => setD({ ...d, resources: d.resources.filter((_, j) => j !== i) })}>
                                Remove address
                            </Button>
                        </div>
                    </div>
                ))}
                <div className="row">
                    <Button type="button" icon={Plus} disabled={d.resources.length >= MAX_RESOURCES} onClick={() => setD({ ...d, resources: [...d.resources, blank()] })}>
                        Add an address
                    </Button>
                    {d.resources.length >= MAX_RESOURCES && <span className="hint">At most {MAX_RESOURCES} addresses.</span>}
                </div>
            </fieldset>
            <Disclosure label="How the application names an owner (optional)">
                <div className="stack-sm">
                    <p className="hint">Needed for lists: the field of each item that names its owner, and what it holds for each account.</p>
                    <div className="field">
                        <label htmlFor="sa-xacct-field">Owner field</label>
                        <input id="sa-xacct-field" className="input" value={d.ownerField ?? ""} maxLength={80} onChange={(e) => setD({ ...d, ownerField: e.target.value })} placeholder="ownerId" />
                    </div>
                    <div className="grid-2">
                        <div className="field">
                            <label htmlFor="sa-xacct-va">Value for account A</label>
                            <input id="sa-xacct-va" className="input" value={d.ownerValueA ?? ""} maxLength={200} onChange={(e) => setD({ ...d, ownerValueA: e.target.value })} />
                        </div>
                        <div className="field">
                            <label htmlFor="sa-xacct-vb">Value for account B</label>
                            <input id="sa-xacct-vb" className="input" value={d.ownerValueB ?? ""} maxLength={200} onChange={(e) => setD({ ...d, ownerValueB: e.target.value })} />
                        </div>
                    </div>
                </div>
            </Disclosure>
            <p className="hint">If the current authorization names these accounts, a change here means recording the authorization again before the next assessment.</p>
            {problem && (
                <Callout tone="danger" title="We couldn’t save the cross-account checks">
                    {problem}
                </Callout>
            )}
            <div className="row">
                <Button type="submit" variant="primary" icon={Save} loading={busy}>
                    Save cross-account checks
                </Button>
                <Button type="button" onClick={onCancel}>
                    Cancel
                </Button>
            </div>
        </form>
    );
}

function RemoveCrossAccount({ app, onClose, onDone }: { app: AppRow; onClose: () => void; onDone: () => void }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    async function remove() {
        setBusy(true);
        setError("");
        try {
            await api(`${SEC}/applications/${app.id}/cross-account`, { method: "DELETE" });
            onDone();
        } catch (e) {
            setError(describeApiError(e));
            setBusy(false);
        }
    }
    return (
        <Modal
            title="Remove the cross-account checks?"
            titleId="sa-xacct-del"
            onClose={onClose}
            foot={
                <>
                    <Button onClick={onClose}>Keep them</Button>
                    <Button variant="danger" icon={Trash2} loading={busy} onClick={() => void remove()}>
                        Remove
                    </Button>
                </>
            }
        >
            <p className="t-secondary">Later assessments of {app.name} make no cross-account checks. Finished assessments and their reports keep what they found.</p>
            {error && <Callout tone="danger">{error}</Callout>}
        </Modal>
    );
}
