import { useState } from "react";
import { useFetch } from "../../lib/hooks";
import { Button, Callout, Skeleton } from "../../components/ui";

/** How every phone test starts. Off by default: nothing changes until the person switches it on. */
export interface StartStateValue {
    cleanStart: boolean;
    grantPermissions: string[];
}

interface PermissionList {
    available: boolean;
    reason?: string;
    permissions: Array<{ name: string; label: string; granted?: boolean }>;
}

const PERMISSION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*\.permission\.[A-Z][A-Z0-9_]{1,80}$/;
const MAX = 30;

/** The plain sentence shown under the options (the same idea as the one in the plan and the run). */
export function startStateLine(v: StartStateValue): string {
    if (v.cleanStart && v.grantPermissions.length) return `Each test starts from fresh app data, with ${v.grantPermissions.length} permission${v.grantPermissions.length === 1 ? "" : "s"} granted.`;
    if (v.cleanStart) return "Each test starts from fresh app data.";
    if (v.grantPermissions.length) return `${v.grantPermissions.length} permission${v.grantPermissions.length === 1 ? " is" : "s are"} granted before each test.`;
    return "Tests start with whatever the app kept from the test before.";
}

/**
 * Setup > Mobile app: "Start every test from a fresh install of the app's data" and "Grant these permissions before each test". The checklist is read
 * from a phone connected to the platform's computer; without one, the names can be typed.
 */
export function StartStateFields({ projectId, hasPackage, value, onChange }: { projectId: string; hasPackage: boolean; value: StartStateValue; onChange: (v: StartStateValue) => void }) {
    const [asked, setAsked] = useState(false);
    const list = useFetch<PermissionList>(asked && hasPackage ? `/projects/${projectId}/mobile-app/permissions` : null);
    const [typed, setTyped] = useState("");
    const [typedError, setTypedError] = useState("");
    const toggle = (name: string, on: boolean) => onChange({ ...value, grantPermissions: on ? [...new Set([...value.grantPermissions, name])].slice(0, MAX) : value.grantPermissions.filter((p) => p !== name) });

    function addTyped() {
        const names = typed.split(/[\s,]+/).filter(Boolean);
        const bad = names.find((n) => !PERMISSION.test(n));
        if (bad) {
            setTypedError(`“${bad}” is not a permission name. Write it like android.permission.CAMERA.`);
            return;
        }
        setTypedError("");
        setTyped("");
        onChange({ ...value, grantPermissions: [...new Set([...value.grantPermissions, ...names])].slice(0, MAX) });
    }

    const known = new Set((list.data?.permissions ?? []).map((p) => p.name));
    const others = value.grantPermissions.filter((p) => !known.has(p));

    return (
        <fieldset className="stack-sm" aria-describedby="ss-line">
            <legend className="t-card">How each test starts</legend>
            {!hasPackage && <p className="t-meta">These options need the app’s package name.</p>}
            <label className={`check${hasPackage ? "" : " is-off"}`}>
                <input type="checkbox" checked={value.cleanStart} disabled={!hasPackage} onChange={(e) => onChange({ ...value, cleanStart: e.target.checked })} />
                <span>
                    <span className="title">Start every test from a fresh install of the app’s data</span>
                    <span className="hint">The app’s data is cleared before each test, so no test depends on what the one before it left behind (a signed-in account, a full cart, an answered question). Only this app’s data is cleared. Each test then runs on its own, which takes longer.</span>
                </span>
            </label>
            <div className="stack-sm">
                <p className="t-card">Grant these permissions before each test</p>
                <p className="hint">The app gets these permissions without asking, so tests never stop at a permission question. Leave all unticked to let the tests answer the questions themselves.</p>
                {!asked ? (
                    <div className="row">
                        <Button size="sm" disabled={!hasPackage} onClick={() => setAsked(true)} tip={hasPackage ? "Asks a phone or emulator connected to the platform’s computer which permissions this app requests." : "Add the app’s package name first."}>Read the app’s permissions</Button>
                    </div>
                ) : list.loading ? (
                    <div className="stack-sm" aria-busy="true" aria-label="Loading">
                        <Skeleton h={20} w="50%" />
                        <Skeleton h={20} w="40%" />
                    </div>
                ) : list.error ? (
                    <Callout tone="danger" title="We couldn’t read the app’s permissions" actions={<Button size="sm" onClick={() => void list.reload()}>Try again</Button>}>
                        {list.error.message}
                    </Callout>
                ) : !list.data?.available ? (
                    <Callout tone="info">{list.data?.reason ?? "The app’s permissions can’t be read here."}</Callout>
                ) : list.data.permissions.length === 0 ? (
                    <p className="t-secondary">This app asks for no permissions a person has to allow.</p>
                ) : (
                    list.data.permissions.map((p) => (
                        <label key={p.name} className="check">
                            <input type="checkbox" checked={value.grantPermissions.includes(p.name)} onChange={(e) => toggle(p.name, e.target.checked)} />
                            <span>
                                <span className="title">{p.label}</span>
                                <span className="hint mono">{p.name}</span>
                            </span>
                        </label>
                    ))
                )}
                {others.map((p) => (
                    <label key={p} className="check">
                        <input type="checkbox" checked onChange={(e) => toggle(p, e.target.checked)} />
                        <span>
                            <span className="title mono">{p}</span>
                        </span>
                    </label>
                ))}
                <div className="field">
                    <label htmlFor="ss-typed">Add by name</label>
                    <div className="row">
                        <input id="ss-typed" className="input" value={typed} disabled={!hasPackage} placeholder="android.permission.CAMERA" autoComplete="off" onChange={(e) => setTyped(e.target.value)} aria-invalid={typedError ? true : undefined} aria-describedby={typedError ? "ss-typed-error" : undefined} />
                        <Button size="sm" disabled={!hasPackage || !typed.trim()} onClick={addTyped}>Add</Button>
                    </div>
                    {typedError && <p id="ss-typed-error" className="t-meta" role="alert">{typedError}</p>}
                </div>
            </div>
            <p id="ss-line" className="t-meta" data-testid="start-state-line">{startStateLine(value)}</p>
        </fieldset>
    );
}
