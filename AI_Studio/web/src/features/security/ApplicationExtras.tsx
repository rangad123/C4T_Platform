/**
 * Round 20 (UI2 screens for SIGN's work): the saved sign-in an assessment loads and the uploaded API document of an application.
 *
 *   GET    /api/v1/security/projects/:id/sign-ins?applicationId=      { signIns: SignInStatus[] }   never a cookie or a value
 *   PUT    /api/v1/security/applications/:appId/saved-sign-in         { account, storageState, checkUrl? } -> { signIn }
 *   GET    /api/v1/security/applications/:appId/api-document          { document, operations, baseUrl }
 *   PUT    /api/v1/security/applications/:appId/api-document          { fileName, content } -> { document, operations, baseUrl }
 *   DELETE /api/v1/security/applications/:appId/api-document          { deleted }
 */
import { KeyRound, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { Modal } from "../../components/Modal";
import { Button, Callout, Disclosure, FilePicker, Skeleton } from "../../components/ui";
import { BadgeKey, FieldHelp, HelpTip, keyEntries } from "../../components/Tooltip";
import { formatBytes } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { API_OPERATION, SIGN_IN_STATE } from "../../lib/help";
import { friendlyError, describeApiError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { canRun, useRole } from "./SecurityChrome";
import { SEC, when, type ApiDocumentSummary, type AppRow } from "./security";

// ── the saved sign-in ─────────────────────────────────────────────────────────

/** A saved sign-in as SIGN's GET /projects/:id/sign-ins judges it (src/security/signin.ts SignInStatus): never a value. */
export interface SignInStatus {
    account: string;
    label?: string;
    state: "ready" | "not-checked" | "expired" | "missing" | "other-site" | "unreadable";
    /** The server's plain sentence for the page. */
    message?: string;
    savedAt?: string | null;
    expiresAt?: string | null;
    site?: string | null;
}
export const signInLabel = (account: string) => (account === "main" ? "The project’s own sign-in" : `Test account “${account}”`);
const SIGNIN_WORDS: Record<SignInStatus["state"], string> = {
    ready: "saved sign-in ready",
    "not-checked": "saved sign-in, not checked yet",
    expired: "saved sign-in expired",
    missing: "no saved sign-in yet",
    "other-site": "saved for another site",
    unreadable: "saved sign-in cannot be read",
};
/** States in which the assessment would carry on signed out. */
const SIGNIN_UNUSABLE: Array<SignInStatus["state"]> = ["expired", "missing", "other-site", "unreadable"];
/** The BadgeKey lines for the states the sign-in choice lists (the words after each account, with their definitions from help.ts). */
const signInKey = (present: Iterable<SignInStatus["state"]>) =>
    keyEntries(Object.keys(SIGNIN_WORDS) as Array<SignInStatus["state"]>, present, (s) => SIGNIN_WORDS[s].replace(/^./, (c) => c.toUpperCase()), (s) => SIGN_IN_STATE[s]);
/** The BadgeKey lines for what an assessment does with the operations listed (api-document.ts kinds). */
const OPERATION_WORDS: Record<keyof typeof API_OPERATION, string> = {
    request: "Requested read-only",
    "not-get": "Not a GET operation",
    "needs-values": "Needs values",
    "sign-out": "Sign-out address",
    "bad-path": "No usable address",
    refused: "Outside the scope or excluded",
};
const operationKey = (present: Iterable<string | undefined>) =>
    keyEntries(Object.keys(OPERATION_WORDS) as Array<keyof typeof API_OPERATION>, [...present].filter((k): k is keyof typeof API_OPERATION => !!k && k in OPERATION_WORDS), (k) => OPERATION_WORDS[k], (k) => API_OPERATION[k]);
export function useSignIns(projectId: string, appId?: string) {
    const f = useFetch<{ signIns?: SignInStatus[] }>(`${SEC}/projects/${projectId}/sign-ins${appId ? `?applicationId=${encodeURIComponent(appId)}` : ""}`);
    return { ...f, list: f.data?.signIns ?? [] };
}

/** Which saved sign-in the assessment loads: "main" (the project's own) or a test account, judged by the server for this application. */
export function SignInChoice({ projectId, appId, value, onChange }: { projectId: string; appId?: string; value: string; onChange: (v: string) => void }) {
    const o = useSignIns(projectId, appId);
    const accounts = [...new Set([...o.list.map((s) => s.account), ...(value ? [value] : [])])];
    const status = (a: string) => o.list.find((s) => s.account === a);
    const chosen = value ? status(value) : undefined;
    const unusable = !!value && !!o.data && (!chosen || SIGNIN_UNUSABLE.includes(chosen.state));
    return (
        <>
            {/* The "?" beside the list explains the state words after each account (only those listed). */}
            <div className="row" style={{ gap: 4, flexWrap: "nowrap", alignItems: "center" }}>
                <select id="sa-signInAccount" className="input" style={{ flex: 1, minWidth: 0 }} value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={["sa-signInAccount-hint", value && o.data ? "sa-signInAccount-state" : ""].filter(Boolean).join(" ")}>
                    <option value="">No sign-in: visit as an anonymous visitor</option>
                    {accounts.map((a) => {
                        const s = status(a);
                        return (
                            <option key={a} value={a}>
                                {signInLabel(a)}
                                {s ? `, ${SIGNIN_WORDS[s.state] ?? s.state}` : ""}
                            </option>
                        );
                    })}
                </select>
                <BadgeKey label="the sign-in states in this list" entries={signInKey(o.list.map((s) => s.state))} />
            </div>
            {value && o.data && (
                <p className="hint" id="sa-signInAccount-state" data-testid={unusable ? "sa-signin-warning" : "sa-signin-state"}>
                    {chosen?.message ?? "No sign-in is saved for this account yet; until then the assessment visits signed out."}{" "}
                    {unusable && <a href={routes.library(projectId, "accounts")}>Open Test accounts</a>}
                </p>
            )}
            {o.error && <p className="hint">The project’s saved sign-ins could not be read ({friendlyError(o.error.message).title}). The choice can still be saved.</p>}
        </>
    );
}

/** Most bytes of a saved sign-in file (the route takes a million characters). */
const MAX_SIGNIN_FILE = 1_000_000;

/**
 * On the application's page: whether the chosen saved sign-in will be used, and uploading one from a file (a browser state saved after
 * signing in by hand). Nothing of the file is shown back: the server keeps it encrypted and answers only its state.
 */
export function SignInPanel({ projectId, app, onChanged }: { projectId: string; app: AppRow; onChanged: () => void }) {
    const role = useRole();
    const account = app.signInAccount ?? "";
    const s = useSignIns(projectId, app.id);
    const chosen = s.list.find((x) => x.account === account);
    const [file, setFile] = useState<File | null>(null);
    const [checkUrl, setCheckUrl] = useState("");
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState("");
    const [done, setDone] = useState("");

    async function upload() {
        if (!file) return setProblem("Choose the saved sign-in file first.");
        if (file.size > MAX_SIGNIN_FILE) return setProblem("This file is larger than 1 MB. A saved sign-in is usually a few kilobytes: check that it is the right file.");
        setBusy(true);
        setProblem("");
        setDone("");
        try {
            const storageState = await file.text();
            const a = await api<{ signIn?: SignInStatus }>(`${SEC}/applications/${app.id}/saved-sign-in`, { method: "PUT", body: { account, storageState, ...(checkUrl.trim() ? { checkUrl: checkUrl.trim() } : {}) } });
            setDone(a?.signIn?.message ?? "Saved.");
            setFile(null);
            setCheckUrl("");
            await s.reload();
            onChanged();
        } catch (e) {
            setProblem(describeApiError(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="card card-pad stack-sm" aria-labelledby="sa-signin-h" data-testid="sa-signin-panel">
            <div className="field-label-row">
                <h2 className="t-section" id="sa-signin-h">
                    Signed-in assessment
                </h2>
                <HelpTip label="Signed-in assessment" text="The assessment loads the saved sign-in into its browser. It never types a password or submits a sign-in form, and does not follow sign-out links." />
            </div>
            {!account ? (
                <p className="t-secondary">It visits as an anonymous visitor, so pages behind a sign-in are not inspected. Choose a saved sign-in with Change.</p>
            ) : s.loading ? (
                <Skeleton h={40} />
            ) : (
                <p className="t-secondary" data-testid="sa-signin-status">
                    {chosen?.message ?? `${signInLabel(account)}: its state could not be read.`}
                </p>
            )}
            {account && canRun(role) && (
                <Disclosure label="Upload a saved sign-in from a file">
                    <div className="stack-sm">
                        <p className="hint">
                            For {signInLabel(account).toLowerCase()}: a file a browser saved after you signed in by hand, such as the one Playwright’s --save-storage writes. Its cookies are stored encrypted and never shown again; only those for addresses in scope are used. You can also <a href={routes.library(projectId, "accounts")}>sign in once yourself under Test accounts</a>.
                        </p>
                        <div className="field">
                            <label htmlFor="sa-signin-file">Saved sign-in file</label>
                            <FilePicker id="sa-signin-file" accept=".json,application/json" file={file} onChange={(f) => (setFile(f), setProblem(""))} />
                        </div>
                        <div className="field">
                            <FieldHelp htmlFor="sa-signin-check" label="Signed-in page (optional)" help="A page only a signed-in person sees, such as /account. The assessment opens it first to tell whether the sign-in still works." hint="On the application’s own site. Leave empty to use its address." />
                            <input id="sa-signin-check" className="input" value={checkUrl} onChange={(e) => setCheckUrl(e.target.value)} placeholder="/account" aria-describedby="sa-signin-check-hint" />
                        </div>
                        {problem && (
                            <Callout tone="danger" title="We couldn’t save the sign-in">
                                {problem}
                            </Callout>
                        )}
                        <div className="row">
                            <Button icon={KeyRound} loading={busy} onClick={() => void upload()} tip="Replaces the saved sign-in of this account for the whole project; the old one is gone.">
                                Save the sign-in
                            </Button>
                            {done && (
                                <span className="t-meta" role="status">
                                    {done}
                                </span>
                            )}
                        </div>
                    </div>
                </Disclosure>
            )}
        </section>
    );
}

// ── the uploaded API document ─────────────────────────────────────────────────

interface Operation {
    method: string;
    path: string;
    url?: string | null;
    request: boolean;
    reason?: string | null;
    kind?: string;
}
interface DocAnswer {
    document: ApiDocumentSummary | null;
    operations?: Operation[];
    baseUrl?: string | null;
}

/** Most bytes of an API document (src/security/api-document.ts API_DOCUMENT_MAX_BYTES). */
export const MAX_API_DOCUMENT = 2 * 1024 * 1024;
/** Operations the page lists (the count says how many there are). */
const SHOWN_OPERATIONS = 300;

/**
 * On the application's page: the uploaded OpenAPI or Swagger document (JSON or YAML, at most 2 MB). The page shows what the server read
 * from it (never its text) and which operations an assessment would request: GET operations without required parameters only.
 */
export function ApiDocumentPanel({ app, onChanged }: { app: AppRow; onChanged: () => void }) {
    const role = useRole();
    const doc = useFetch<DocAnswer>(`${SEC}/applications/${app.id}/api-document`);
    const [file, setFile] = useState<File | null>(null);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState("");
    const [asking, setAsking] = useState(false);
    const d = doc.data?.document ?? null;
    const ops = doc.data?.operations ?? [];

    async function upload() {
        if (!file) return setProblem("Choose the API document first.");
        if (file.size > MAX_API_DOCUMENT) return setProblem(`This file is ${formatBytes(file.size)}; an API document can be at most 2 MB.`);
        setBusy(true);
        setProblem("");
        try {
            const content = await file.text();
            await api<DocAnswer>(`${SEC}/applications/${app.id}/api-document`, { method: "PUT", body: { fileName: file.name, content } });
            setFile(null);
            await doc.reload();
            onChanged();
        } catch (e) {
            setProblem(describeApiError(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="card card-pad stack-sm" aria-labelledby="sa-doc-h" data-testid="sa-apidoc">
            <div className="field-label-row">
                <h2 className="t-section" id="sa-doc-h">
                    API document
                </h2>
                <HelpTip label="API document" text="Only GET operations without required parameters are requested, read-only, through the same scope checks. Nothing from the document is ever sent: no examples, parameters or bodies." />
            </div>
            {doc.loading ? (
                <Skeleton h={60} />
            ) : doc.error ? (
                <Callout tone="danger" title="We couldn’t read the API document">
                    {friendlyError(doc.error.message).title}
                </Callout>
            ) : d ? (
                <>
                    <dl className="kv" data-testid="sa-apidoc-summary">
                        <dt>File</dt>
                        <dd>
                            <span className="sec-loc">{d.fileName}</span> ({d.format.toUpperCase()}, {formatBytes(d.sizeBytes)})
                        </dd>
                        {(d.title || d.version) && (
                            <>
                                <dt>Describes</dt>
                                <dd>{[d.title, d.version ? `version ${d.version}` : null].filter(Boolean).join(", ")}</dd>
                            </>
                        )}
                        <dt>Operations</dt>
                        <dd>
                            {d.operations} listed; {d.requestable} {d.requestable === 1 ? "is a GET" : "are GETs"} without required parameters and may be requested read-only. The rest are never called.{" "}
                            <BadgeKey label="what happens to each operation" entries={operationKey(ops.map((o) => o.kind ?? (o.request ? "request" : undefined)))} />
                        </dd>
                        <dt>Uploaded</dt>
                        <dd>
                            {when(d.uploadedAt)} by {d.uploadedBy}
                        </dd>
                    </dl>
                    {ops.length > 0 && (
                        <Disclosure label={`What an assessment would do with each operation (${ops.length})`}>
                            <ul className="sec-history" data-testid="sa-apidoc-ops">
                                {ops.slice(0, SHOWN_OPERATIONS).map((o, i) => (
                                    <li key={`${o.method} ${o.path} ${i}`}>
                                        <span className="sec-loc">
                                            {o.method.toUpperCase()} {o.path}
                                        </span>
                                        <span className="t-meta">{o.request ? "Requested read-only." : (o.reason ?? "Not called.")}</span>
                                    </li>
                                ))}
                            </ul>
                            {ops.length > SHOWN_OPERATIONS && <p className="hint">And {ops.length - SHOWN_OPERATIONS} more, treated by the same rules.</p>}
                        </Disclosure>
                    )}
                </>
            ) : (
                <p className="t-secondary">None uploaded. An OpenAPI or Swagger document (JSON or YAML) lets the assessment list the API’s operations as coverage and request the safe ones.</p>
            )}
            {canRun(role) && !doc.loading && (
                <div className="stack-sm">
                    <div className="field">
                        <FieldHelp htmlFor="sa-apidoc-file" label={d ? "Replace with another file" : "Upload an API document"} help="JSON or YAML, at most 2 MB. The file is kept with the application and never shown again; the platform only reads it." />
                        <FilePicker id="sa-apidoc-file" accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml" file={file} onChange={(f) => (setFile(f), setProblem(""))} />
                    </div>
                    {problem && (
                        <Callout tone="danger" title="We couldn’t use this API document">
                            {problem}
                        </Callout>
                    )}
                    <div className="row">
                        <Button icon={Upload} loading={busy} disabled={!file} onClick={() => void upload()} tip={file ? "Reads the file and lists its operations. Nothing is sent to the application until an assessment runs." : "Choose a JSON or YAML file first."}>
                            {d ? "Replace API document" : "Upload API document"}
                        </Button>
                        {d && (
                            <Button variant="ghost" icon={Trash2} onClick={() => setAsking(true)} tip="Asks first. Later assessments then list no API operations from a document.">
                                Remove API document
                            </Button>
                        )}
                    </div>
                </div>
            )}
            {asking && d && (
                <RemoveDocument
                    app={app}
                    fileName={d.fileName}
                    onClose={() => setAsking(false)}
                    onDone={() => {
                        setAsking(false);
                        void doc.reload();
                        onChanged();
                    }}
                />
            )}
        </section>
    );
}

function RemoveDocument({ app, fileName, onClose, onDone }: { app: AppRow; fileName: string; onClose: () => void; onDone: () => void }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    async function remove() {
        setBusy(true);
        setError("");
        try {
            await api(`${SEC}/applications/${app.id}/api-document`, { method: "DELETE" });
            onDone();
        } catch (e) {
            setError(describeApiError(e));
            setBusy(false);
        }
    }
    return (
        <Modal
            title="Remove the API document?"
            titleId="sa-doc-del"
            onClose={onClose}
            foot={
                <>
                    <Button onClick={onClose}>Keep it</Button>
                    <Button variant="danger" icon={Trash2} loading={busy} onClick={() => void remove()}>
                        Remove
                    </Button>
                </>
            }
        >
            <p className="t-secondary">“{fileName}” is removed from {app.name}. Later assessments list no operations from a document; finished assessments and their reports keep what they saw.</p>
            {error && <Callout tone="danger">{error}</Callout>}
        </Modal>
    );
}
