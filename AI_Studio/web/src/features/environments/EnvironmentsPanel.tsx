import { Layers, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { ApiError, api } from "../../api";
import { Badge, Button, Callout, ListSkeleton } from "../../components/ui";
import { BadgeKey } from "../../components/Tooltip";
import { plural } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { useHere } from "../auth/project-access";
import { describeApiError } from "../../lib/labels";
import { PRODUCTION_WARNING, shortAddress, type Environment } from "./environments";
import "./environments.css";

interface VarRow {
    key: number;
    name: string;
    value: string;
}
interface Form {
    /** Set when editing an existing environment (its name cannot change). */
    editing: string | null;
    name: string;
    baseUrl: string;
    apiBaseUrl: string;
    production: boolean;
    useProjectAccounts: boolean;
    vars: VarRow[];
    username: string;
    password: string;
    totpSecret: string;
    apiToken: string;
    apiAuthHeader: string;
    /** Remove everything saved for sign-in on save. */
    clearSecrets: boolean;
    saved: Pick<Environment, "hasPassword" | "hasTotp" | "hasApiToken" | "hasApiAuthHeader">;
}

/** What "default" does (environments-store.ts): listed first, and preselected in the Run panel and for a new run step of a run sequence. */
const DEFAULT_TIP = "Preselected as the place to run in the Run panel and in a new run sequence step; you can still choose another. A production environment can’t be the default.";

const NO_SAVED = { hasPassword: false, hasTotp: false, hasApiToken: false, hasApiAuthHeader: false };
const blank = (): Form => ({ editing: null, name: "", baseUrl: "", apiBaseUrl: "", production: false, useProjectAccounts: true, vars: [], username: "", password: "", totpSecret: "", apiToken: "", apiAuthHeader: "", clearSecrets: false, saved: NO_SAVED });
const NAME_OK = /^[a-z][a-z0-9_-]{0,23}$/;
const VAR_OK = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

function saveError(e: unknown): string {
    if (e instanceof ApiError && e.status === 400 && Array.isArray(e.details)) {
        const msgs = (e.details as Array<{ message?: string }>).map((d) => d.message).filter(Boolean);
        if (msgs.length) return msgs.join(" ");
    }
    return describeApiError(e);
}

/**
 * Tests → ⋯ More actions → Environments. Named places the same tests can run against (staging, production...), each with its own
 * address, sign-in and variables. A production environment is read-only and every run there needs a confirmation.
 * Sign-in details are write-only: they are never shown again, only whether one is saved.
 */
export function EnvironmentsPanel({ projectId, onStarted, onClose }: { projectId: string; onStarted: () => void; onClose?: () => void }) {
    const list = useFetch<{ environments: Environment[]; max: number }>(`/projects/${projectId}/environments`);
    const [form, setForm] = useState<Form | null>(null);
    const [next, setNext] = useState(1);
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    /** Production environments whose run the person has confirmed in this panel. */
    const [confirmed, setConfirmed] = useState<Set<string>>(new Set());

    // Adding, changing and removing environments is a project setting; running on one is running tests (as the server asks).
    const here = useHere(projectId);
    const noSettings = here.why("ai_studio.project.settings");
    const noRun = here.why("ai_studio.tests.run");
    const envs = list.data?.environments ?? [];
    const patch = (p: Partial<Form>) => setForm((f) => (f ? { ...f, ...p } : f));

    function edit(e: Environment) {
        setError("");
        setNotice("");
        setForm({
            ...blank(),
            editing: e.name,
            name: e.name,
            baseUrl: e.baseUrl,
            apiBaseUrl: e.apiBaseUrl ?? "",
            production: e.production,
            useProjectAccounts: e.useProjectAccounts,
            vars: Object.entries(e.variables).map(([name, value], i) => ({ key: i, name, value })),
            username: e.username ?? "",
            saved: e,
        });
        setNext(Object.keys(e.variables).length);
    }

    async function save() {
        if (!form) return;
        setBusy("save");
        setError("");
        setNotice("");
        try {
            const variables = Object.fromEntries(form.vars.filter((v) => v.name.trim()).map((v) => [v.name.trim(), v.value]));
            const body = { baseUrl: form.baseUrl.trim(), apiBaseUrl: form.apiBaseUrl.trim() || (form.editing ? null : undefined), production: form.production, useProjectAccounts: form.useProjectAccounts, variables };
            const name = form.editing ?? form.name.trim();
            if (form.editing) await api(`/projects/${projectId}/environments/${name}`, { method: "PUT", body });
            else await api(`/projects/${projectId}/environments`, { method: "POST", body: { name, ...body } });
            const secrets = form.clearSecrets
                ? { username: "", password: "", totpSecret: "", apiToken: "", apiAuthHeader: "" }
                : {
                      ...(form.username.trim() !== (form.editing ? (envs.find((e) => e.name === name)?.username ?? "") : "") ? { username: form.username.trim() } : {}),
                      ...(form.password ? { password: form.password } : {}),
                      ...(form.totpSecret.trim() ? { totpSecret: form.totpSecret.trim() } : {}),
                      ...(form.apiToken ? { apiToken: form.apiToken } : {}),
                      ...(form.apiAuthHeader ? { apiAuthHeader: form.apiAuthHeader } : {}),
                  };
            if (Object.keys(secrets).length) await api(`/projects/${projectId}/environments/${name}/secrets`, { method: "PUT", body: secrets });
            setForm(null);
            setNotice(`Saved “${name}”.`);
            await list.reload();
        } catch (e) {
            setError(saveError(e));
        } finally {
            setBusy("");
        }
    }

    async function remove(e: Environment) {
        setBusy(`rm-${e.name}`);
        setError("");
        setNotice("");
        try {
            await api(`/projects/${projectId}/environments/${e.name}`, { method: "DELETE" });
            setNotice(`Removed “${e.name}” and the results kept for it.`);
            await list.reload();
        } catch (err) {
            setError(describeApiError(err));
        } finally {
            setBusy("");
        }
    }

    async function makeDefault(e: Environment) {
        setBusy(`def-${e.name}`);
        setError("");
        try {
            await api(`/projects/${projectId}/environments/${e.name}/default`, { method: "POST" });
            await list.reload();
        } catch (err) {
            setError(describeApiError(err));
        } finally {
            setBusy("");
        }
    }

    async function run(e: Environment) {
        setBusy(`run-${e.name}`);
        setError("");
        setNotice("");
        try {
            const res = await api<{ testCount: number; skipped: Array<{ reason: string }> }>(`/projects/${projectId}/environments/${e.name}/runs`, { method: "POST", body: e.production ? { confirmProduction: true } : {} });
            setNotice(`Running ${plural(res.testCount, "test")} on ${e.name}.${res.skipped.length ? ` ${plural(res.skipped.length, "test")} won’t run${e.production ? " (they change data, and production is read-only)" : ""}.` : ""} Results appear on each test when it finishes.`);
            onStarted();
        } catch (err) {
            setError(describeApiError(err));
        } finally {
            setBusy("");
        }
    }

    const problems = form
        ? [
              !form.editing && !NAME_OK.test(form.name.trim()) && "The name uses lower-case letters, digits, - or _, and starts with a letter.",
              !/^https?:\/\/[^/\s]+\/?$/i.test(form.baseUrl.trim()) && "The address should be just the site, like https://staging.example.com.",
              form.vars.some((v) => v.name.trim() && !VAR_OK.test(v.name.trim())) && "A variable name uses letters, digits and _, and starts with a letter.",
          ].filter(Boolean) as string[]
        : [];

    return (
        <section className="card card-pad stack-sm" aria-label="Environments">
            <div className="row">
                <Layers size={18} aria-hidden />
                <h2 className="t-section">Environments</h2>
                <BadgeKey label="the environment badges" entries={[envs.some((e) => e.production) && { word: "Production, read-only", text: PRODUCTION_WARNING }, envs.some((e) => e.isDefault) && { word: "Default", text: DEFAULT_TIP }]} />
                <span className="spacer" />
                {onClose &&<Button size="sm" variant="ghost" onClick={onClose}>Close</Button>}
            </div>
            <p className="t-secondary">
                Run the same tests against more than one place, such as staging and production, each with its own address, sign-in and values. Each place keeps its own results; your tests’ main results don’t change.
            </p>

            {list.loading ? (
                <ListSkeleton rows={2} />
            ) : list.error ? (
                <Callout tone="danger">We couldn’t load the environments. Close this panel and try again.</Callout>
            ) : (
                <>
                    {envs.length === 0 && !form && <p className="t-meta">No environments yet.</p>}
                    <ul className="env-list" aria-label="Saved environments">
                        {envs.map((e) => (
                            <li key={e.id} className={e.production ? "production" : undefined}>
                                <div className="row">
                                    <strong>{e.name}</strong>
                                    {e.production && <Badge tone="danger" tip={PRODUCTION_WARNING}>Production · read-only</Badge>}
                                    {e.isDefault && <Badge tone="info" tip={DEFAULT_TIP}>Default</Badge>}
                                    <span className="t-meta">{shortAddress(e.baseUrl)}</span>
                                </div>
                                <p className="t-meta">
                                    {Object.keys(e.variables).length ? `${plural(Object.keys(e.variables).length, "value")}` : "No values"}
                                    {" · "}
                                    {e.hasPassword || e.hasApiToken || e.hasApiAuthHeader || e.hasTotp ? "Sign-in saved" : "No sign-in saved"}
                                    {e.useProjectAccounts ? " · uses the project’s test accounts" : ""}
                                </p>
                                {e.production && (
                                    <label className="check env-confirm">
                                        <input type="checkbox" checked={confirmed.has(e.name)} onChange={(ev) => setConfirmed((c) => { const n = new Set(c); ev.target.checked ? n.add(e.name) : n.delete(e.name); return n; })} />
                                        <span>
                                            <span className="title">Yes, run on {e.name}</span>
                                            <span className="hint">{PRODUCTION_WARNING}</span>
                                        </span>
                                    </label>
                                )}
                                <div className="row">
                                    <Button size="sm" icon={Play} loading={busy === `run-${e.name}`} disabled={!!busy || Boolean(noRun) || (e.production && !confirmed.has(e.name))} tip={noRun} onClick={() => void run(e)} aria-label={`Run all tests on ${e.name}`}>
                                        Run all tests here
                                    </Button>
                                    {!noSettings && <Button size="sm" variant="ghost" icon={Pencil} disabled={!!busy} onClick={() => edit(e)} aria-label={`Edit ${e.name}`}>Edit</Button>}
                                    {!noSettings && !e.isDefault && !e.production && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void makeDefault(e)} aria-label={`Make ${e.name} the default`} tip={DEFAULT_TIP}>Make default</Button>}
                                    <span className="spacer" />
                                    {!noSettings && <Button size="sm" variant="ghost" icon={Trash2} loading={busy === `rm-${e.name}`} disabled={!!busy} onClick={() => void remove(e)} aria-label={`Remove ${e.name}`} tip="Removes it at once, with the results kept for it. Your tests and their main results stay.">Remove</Button>}
                                </div>
                            </li>
                        ))}
                    </ul>

                    {form && !noSettings ? (
                        <fieldset className="card card-pad stack-sm env-form" style={{ margin: 0 }}>
                            <legend className="t-card">{form.editing ? `Edit ${form.editing}` : "New environment"}</legend>
                            <div className="grid-2">
                                <div className="field">
                                    <label htmlFor="env-name">Environment name</label>
                                    <input id="env-name" className="input" value={form.name} disabled={!!form.editing} placeholder="staging" autoComplete="off" onChange={(e) => patch({ name: e.target.value.toLowerCase() })} />
                                </div>
                                <div className="field">
                                    <label htmlFor="env-url">Address</label>
                                    <input id="env-url" className="input" value={form.baseUrl} placeholder="https://staging.example.com" autoComplete="off" onChange={(e) => patch({ baseUrl: e.target.value })} />
                                </div>
                                <div className="field">
                                    <label htmlFor="env-api">API address (optional)</label>
                                    <input id="env-api" className="input" value={form.apiBaseUrl} placeholder="Same as the address" autoComplete="off" onChange={(e) => patch({ apiBaseUrl: e.target.value })} />
                                </div>
                            </div>
                            <label className={`check${form.production ? " env-production" : ""}`}>
                                <input type="checkbox" checked={form.production} onChange={(e) => patch({ production: e.target.checked })} />
                                <span>
                                    <span className="title">This is a production environment</span>
                                    <span className="hint">{PRODUCTION_WARNING}</span>
                                </span>
                            </label>
                            <label className="check">
                                <input type="checkbox" checked={form.useProjectAccounts} onChange={(e) => patch({ useProjectAccounts: e.target.checked })} />
                                <span>
                                    <span className="title">Use the project’s test accounts here</span>
                                    <span className="hint">For access-control checks that sign in as different accounts. Turn off if the accounts don’t exist in this environment.</span>
                                </span>
                            </label>

                            <div className="stack-sm">
                                <h3 className="t-card">Values for this environment</h3>
                                <p className="t-meta">Tests can use them as {"{{env.NAME}}"}. They are not secret; keep passwords in the sign-in section below.</p>
                                {form.vars.map((v) => (
                                    <div className="env-var-row" key={v.key}>
                                        <input className="input" aria-label={`Value name ${v.key + 1}`} placeholder="NAME" value={v.name} onChange={(e) => patch({ vars: form.vars.map((x) => (x.key === v.key ? { ...x, name: e.target.value } : x)) })} />
                                        <input className="input" aria-label={`Value ${v.key + 1}`} placeholder="value" value={v.value} onChange={(e) => patch({ vars: form.vars.map((x) => (x.key === v.key ? { ...x, value: e.target.value } : x)) })} />
                                        <Button size="sm" variant="ghost" icon={Trash2} aria-label={`Remove value ${v.name || v.key + 1}`} onClick={() => patch({ vars: form.vars.filter((x) => x.key !== v.key) })} />
                                    </div>
                                ))}
                                <div>
                                    <Button size="sm" icon={Plus} disabled={form.vars.length >= 30} onClick={() => { patch({ vars: [...form.vars, { key: next, name: "", value: "" }] }); setNext((n) => n + 1); }}>
                                        Add a value
                                    </Button>
                                </div>
                            </div>

                            <div className="stack-sm">
                                <h3 className="t-card">Sign-in for this environment (optional)</h3>
                                <p className="t-meta">Saved encrypted and never shown again. Leave a field empty to keep what is saved.</p>
                                <div className="grid-2">
                                    <div className="field">
                                        <label htmlFor="env-user">Username or email</label>
                                        <input id="env-user" className="input" value={form.username} autoComplete="off" disabled={form.clearSecrets} onChange={(e) => patch({ username: e.target.value })} />
                                    </div>
                                    <div className="field">
                                        <label htmlFor="env-pass">Password</label>
                                        <input id="env-pass" className="input" type="password" autoComplete="new-password" value={form.password} disabled={form.clearSecrets} placeholder={form.saved.hasPassword ? "Saved — leave empty to keep" : ""} onChange={(e) => patch({ password: e.target.value })} />
                                    </div>
                                    <div className="field">
                                        <label htmlFor="env-token">API token</label>
                                        <input id="env-token" className="input" type="password" autoComplete="off" spellCheck={false} value={form.apiToken} disabled={form.clearSecrets} placeholder={form.saved.hasApiToken ? "Saved — leave empty to keep" : ""} onChange={(e) => patch({ apiToken: e.target.value })} />
                                    </div>
                                    <div className="field">
                                        <label htmlFor="env-header">Authorization header (optional)</label>
                                        <input id="env-header" className="input" type="password" autoComplete="off" spellCheck={false} value={form.apiAuthHeader} disabled={form.clearSecrets} placeholder={form.saved.hasApiAuthHeader ? "Saved — leave empty to keep" : "Name: value"} onChange={(e) => patch({ apiAuthHeader: e.target.value })} />
                                    </div>
                                    <div className="field">
                                        <label htmlFor="env-totp">Authenticator secret (optional)</label>
                                        <input id="env-totp" className="input" type="password" autoComplete="off" spellCheck={false} value={form.totpSecret} disabled={form.clearSecrets} placeholder={form.saved.hasTotp ? "Saved — leave empty to keep" : ""} onChange={(e) => patch({ totpSecret: e.target.value })} />
                                    </div>
                                </div>
                                {form.editing && (form.saved.hasPassword || form.saved.hasApiToken || form.saved.hasApiAuthHeader || form.saved.hasTotp) && (
                                    <div>
                                        <Button size="sm" variant="ghost" onClick={() => patch({ clearSecrets: !form.clearSecrets })}>
                                            {form.clearSecrets ? "Keep the saved sign-in" : "Remove the saved sign-in"}
                                        </Button>
                                    </div>
                                )}
                            </div>

                            {problems.length > 0 && <Callout tone="warning">{problems.join(" ")}</Callout>}
                            <div className="row">
                                <Button variant="primary" loading={busy === "save"} disabled={!!busy || problems.length > 0 || !form.baseUrl.trim() || (!form.editing && !form.name.trim())} onClick={() => void save()}>
                                    {form.editing ? "Save changes" : "Save environment"}
                                </Button>
                                <Button variant="ghost" disabled={!!busy} onClick={() => { setForm(null); setError(""); }}>Cancel</Button>
                            </div>
                        </fieldset>
                    ) : (
                        <div>
                            <Button icon={Plus} disabled={Boolean(noSettings) || envs.length >= (list.data?.max ?? 8)} tip={noSettings} onClick={() => { setError(""); setNotice(""); setForm(blank()); setNext(0); }}>
                                Add an environment
                            </Button>
                        </div>
                    )}
                    {error && <Callout tone="danger">{error}</Callout>}
                    {notice && <Callout tone="success">{notice}</Callout>}
                </>
            )}
        </section>
    );
}
