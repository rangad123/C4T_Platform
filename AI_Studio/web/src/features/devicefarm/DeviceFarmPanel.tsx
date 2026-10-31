import { Cloud, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { Badge, Button, Callout, EmptyState, ErrorState, ListSkeleton } from "../../components/ui";
import { BadgeKey, keyEntries } from "../../components/Tooltip";
import { DEVICE_FARM_RESULT } from "../../lib/help";
import { useFetch } from "../../lib/hooks";
import { describeApiError, friendlyError } from "../../lib/labels";

/** Settings → Mobile app → Device farm: connect a cloud phone provider (or an Appium server), pick phones, and choose where phone tests run. */

type ProviderId = "browserstack" | "saucelabs" | "lambdatest" | "appium";
interface Provider {
    id: ProviderId;
    label: string;
    hint: string;
    userLabel?: string;
    keyLabel?: string;
    uploadsApp: boolean;
    regions?: string[];
    needsHubUrl?: boolean;
    docsHint: string;
}
interface Device {
    name: string;
    osVersion?: string;
}
interface Farm {
    id: string;
    provider: ProviderId;
    label: string;
    region: string | null;
    hubUrl: string | null;
    devices: Device[];
    credentialsSet: boolean;
}
interface Choice {
    runOn: "device" | "farm";
    farmId: string | null;
    parallel: number;
    matrix: boolean;
}
interface Answer {
    providers: Provider[];
    limits: { connectionsPerProject: number; devicesPerConnection: number; maxParallel: number };
    farms: Farm[];
    choice: Choice;
}
interface Session {
    id: number;
    testId: string;
    device: string;
    status: string;
    link: string | null;
    at: string;
}

const deviceText = (d: Device) => (d.osVersion ? `${d.name} (Android ${d.osVersion})` : d.name);

/** "Google Pixel 8, 14" per line → devices. */
function parseDevices(text: string): Device[] {
    return text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
            const m = /^(.*?)(?:\s*,\s*([0-9][0-9.]*))?$/.exec(l)!;
            return { name: m[1]!.trim(), ...(m[2] ? { osVersion: m[2] } : {}) };
        });
}

function ConnectForm({ projectId, providers, onDone, onCancel }: { projectId: string; providers: Provider[]; onDone: () => void; onCancel: () => void }) {
    const [provider, setProvider] = useState<ProviderId>("browserstack");
    const [label, setLabel] = useState("");
    const [region, setRegion] = useState("us-west-1");
    const [hubUrl, setHubUrl] = useState("");
    const [username, setUsername] = useState("");
    const [accessKey, setAccessKey] = useState("");
    const [devices, setDevices] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const info = providers.find((p) => p.id === provider)!;

    async function save() {
        setBusy(true);
        setError("");
        try {
            await api(`/projects/${projectId}/device-farms`, {
                method: "POST",
                body: {
                    provider,
                    label: label.trim() || info.label,
                    devices: parseDevices(devices),
                    ...(info.regions ? { region } : {}),
                    ...(info.needsHubUrl ? { hubUrl: hubUrl.trim() } : {}),
                    ...(username.trim() ? { username: username.trim() } : {}),
                    ...(accessKey.trim() ? { accessKey: accessKey.trim() } : {}),
                },
            });
            onDone();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <form
            className="card card-pad stack-sm"
            aria-label="Connect a device farm"
            onSubmit={(e) => {
                e.preventDefault();
                void save();
            }}
        >
            <div className="field">
                <label htmlFor="farm-provider">Provider</label>
                <select id="farm-provider" className="input" value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)}>
                    {providers.map((p) => (
                        <option key={p.id} value={p.id}>
                            {p.label}
                        </option>
                    ))}
                </select>
                <p className="t-meta">{info.hint}</p>
            </div>
            <div className="field">
                <label htmlFor="farm-label">Name</label>
                <input id="farm-label" className="input" value={label} placeholder={info.label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
            </div>
            {info.regions && (
                <div className="field">
                    <label htmlFor="farm-region">Data centre</label>
                    <select id="farm-region" className="input" value={region} onChange={(e) => setRegion(e.target.value)}>
                        {info.regions.map((r) => (
                            <option key={r} value={r}>
                                {r}
                            </option>
                        ))}
                    </select>
                </div>
            )}
            {info.needsHubUrl && (
                <div className="field">
                    <label htmlFor="farm-hub">Server address</label>
                    <input id="farm-hub" className="input" value={hubUrl} placeholder="https://appium.example.com/wd/hub" autoComplete="off" onChange={(e) => setHubUrl(e.target.value)} />
                </div>
            )}
            <div className="field">
                <label htmlFor="farm-user">{info.userLabel ?? "User name"}</label>
                <input id="farm-user" className="input" value={username} autoComplete="off" onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div className="field">
                <label htmlFor="farm-key">{info.keyLabel ?? "Access key"}</label>
                <input id="farm-key" className="input" type="password" value={accessKey} autoComplete="new-password" onChange={(e) => setAccessKey(e.target.value)} />
                <p className="t-meta">{info.docsHint} It is stored encrypted and never shown again.</p>
            </div>
            <div className="field">
                <label htmlFor="farm-devices">Phones to run on</label>
                <textarea id="farm-devices" className="input" rows={3} value={devices} placeholder={"Google Pixel 8, 14\nSamsung Galaxy S23, 13"} onChange={(e) => setDevices(e.target.value)} />
                <p className="t-meta">One per line: the phone’s name as the provider lists it, then a comma and the Android version.</p>
            </div>
            {!info.uploadsApp && <Callout tone="info">The app must already be installed on the server’s phone. The platform does not upload it there.</Callout>}
            {error && <Callout tone="danger" title="Not saved">{error}</Callout>}
            <div className="row">
                <Button type="submit" variant="primary" loading={busy}>
                    Save connection
                </Button>
                <Button type="button" variant="ghost" onClick={onCancel}>
                    Cancel
                </Button>
            </div>
        </form>
    );
}

function FarmRow({ projectId, farm, providers, onChanged }: { projectId: string; farm: Farm; providers: Provider[]; onChanged: () => void }) {
    const [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const p = providers.find((x) => x.id === farm.provider);
    async function run(fn: () => Promise<void>) {
        setBusy(true);
        setError("");
        try {
            await fn();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy(false);
        }
    }
    return (
        <li className="card card-pad stack-sm" data-testid="farm-row">
            <div className="row">
                <strong>{farm.label}</strong>
                <span className="t-meta">{p?.label ?? farm.provider}</span>
                <span className="spacer" />
                {!farm.credentialsSet && farm.provider !== "appium" && <Badge tone="warning">Sign-in details missing</Badge>}
            </div>
            <p className="t-secondary">Phones: {farm.devices.map(deviceText).join(", ")}</p>
            {check && <Callout tone={check.ok ? "success" : "danger"}>{check.message}</Callout>}
            {error && <Callout tone="danger">{error}</Callout>}
            <div className="row">
                <Button size="sm" loading={busy} tip="Checks the sign-in details with one read-only request to the provider. No phone session starts." onClick={() => void run(async () => setCheck(await api(`/projects/${projectId}/device-farms/${farm.id}/check`, { method: "POST" })))}>
                    Check connection
                </Button>
                <Button
                    size="sm"
                    variant="ghost"
                    icon={Trash2}
                    onClick={() => {
                        if (window.confirm(`Remove “${farm.label}”? Phone tests that run on it go back to this computer’s phone or the project’s runner.`)) void run(async () => {
                            await api(`/projects/${projectId}/device-farms/${farm.id}`, { method: "DELETE" });
                            onChanged();
                        });
                    }}
                >
                    Remove
                </Button>
            </div>
        </li>
    );
}

function RunChoice({ projectId, data, onSaved }: { projectId: string; data: Answer; onSaved: () => void }) {
    const [choice, setChoice] = useState<Choice>(data.choice);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
    const farm = data.farms.find((f) => f.id === choice.farmId);
    async function save() {
        setBusy(true);
        setMsg(null);
        try {
            await api(`/projects/${projectId}/device-farm-choice`, { method: "PUT", body: { runOn: choice.runOn, farmId: choice.runOn === "farm" ? choice.farmId : null, parallel: choice.parallel, matrix: choice.runOn === "farm" && choice.matrix } });
            setMsg({ ok: true, text: "Saved. The next run uses it." });
            onSaved();
        } catch (e) {
            setMsg({ ok: false, text: describeApiError(e) });
        } finally {
            setBusy(false);
        }
    }
    return (
        <fieldset className="card card-pad stack-sm" aria-label="Device farm or this computer">
            {/* Round 24: "Where phone tests run" is now the project-wide setting under Phone test settings; this choice is its device-farm part. */}
            <legend className="t-section">Device farm or this computer</legend>
            <label className="row">
                <input type="radio" name="farm-run-on" checked={choice.runOn === "device"} onChange={() => setChoice({ ...choice, runOn: "device" })} />
                <span>This computer’s phone, or the project’s runner</span>
            </label>
            <label className="row">
                <input type="radio" name="farm-run-on" checked={choice.runOn === "farm"} disabled={data.farms.length === 0} onChange={() => setChoice({ ...choice, runOn: "farm", farmId: choice.farmId ?? data.farms[0]?.id ?? null })} />
                <span>A device farm</span>
            </label>
            {choice.runOn === "farm" && (
                <div className="field">
                    <label htmlFor="farm-choice">Device farm</label>
                    <select id="farm-choice" className="input" value={choice.farmId ?? ""} onChange={(e) => setChoice({ ...choice, farmId: e.target.value })}>
                        {data.farms.map((f) => (
                            <option key={f.id} value={f.id}>
                                {f.label}
                            </option>
                        ))}
                    </select>
                </div>
            )}
            <div className="field">
                <label htmlFor="farm-parallel">Phone tests at once</label>
                <input id="farm-parallel" className="input" type="number" min={1} max={data.limits.maxParallel} value={choice.parallel} onChange={(e) => setChoice({ ...choice, parallel: Math.max(1, Math.min(data.limits.maxParallel, Number(e.target.value) || 1)) })} />
                <p className="t-meta">{choice.runOn === "farm" ? "Each test gets its own phone session on the farm. More at once is faster and may cost more on the provider." : "Used when that many phones or emulators are connected and ready. With one phone, tests run one after another."}</p>
            </div>
            {choice.runOn === "farm" && (farm?.devices.length ?? 0) > 1 && (
                <label className="row">
                    <input type="checkbox" checked={choice.matrix} onChange={(e) => setChoice({ ...choice, matrix: e.target.checked })} />
                    <span>Run on several phones: every test on each of {farm!.devices.map(deviceText).join(", ")}</span>
                </label>
            )}
            {msg && <Callout tone={msg.ok ? "success" : "danger"}>{msg.text}</Callout>}
            <div>
                <Button variant="primary" loading={busy} onClick={() => void save()}>
                    Save choice
                </Button>
            </div>
        </fieldset>
    );
}

const farmResult = (status: string) => (status === "passed" ? "passed" : status === "failed" ? "failed" : "other") as "passed" | "failed" | "other";
const FARM_WORD = { passed: "Passing", failed: "Failing", other: "Could not run" } as const;

function RecentSessions({ projectId }: { projectId: string }) {
    const s = useFetch<{ sessions: Session[] }>(`/projects/${projectId}/device-farms/sessions?limit=10`);
    if (!s.data?.sessions.length) return null;
    return (
        <section className="stack-sm" aria-label="Recent farm sessions">
            <div className="row" style={{ gap: 4 }}>
                <h3 className="t-section">Recent farm sessions</h3>
                <BadgeKey label="the farm results" entries={keyEntries(["passed", "failed", "other"] as const, s.data.sessions.map((x) => farmResult(x.status)), (k) => FARM_WORD[k], (k) => DEVICE_FARM_RESULT[k])} />
            </div>
            <ul className="stack-sm">
                {s.data.sessions.map((x) => (
                    <li key={x.id} className="row">
                        <span className="mono">{x.testId}</span>
                        <span>{x.device}</span>
                        <Badge tone={x.status === "passed" ? "success" : x.status === "failed" ? "danger" : "warning"} tip={DEVICE_FARM_RESULT[farmResult(x.status)]}>{x.status === "passed" ? "Passing" : x.status === "failed" ? "Failing" : "Could not run"}</Badge>
                        {x.link && (
                            <a href={x.link} target="_blank" rel="noreferrer noopener">
                                Video and logs
                            </a>
                        )}
                    </li>
                ))}
            </ul>
        </section>
    );
}

export function DeviceFarmPanel({ projectId }: { projectId: string }) {
    const data = useFetch<Answer>(`/projects/${projectId}/device-farms`);
    const [adding, setAdding] = useState(false);
    if (data.loading) return <ListSkeleton rows={2} />;
    if (data.error || !data.data) return <ErrorState error={friendlyError(data.error?.message)} onRetry={() => void data.reload()} />;
    const d = data.data;
    return (
        <section className="card card-pad stack" aria-label="Device farm" data-testid="device-farm">
            <div className="row">
                <Cloud size={18} aria-hidden />
                <h2 className="t-section">Device farm</h2>
                <span className="spacer" />
                {!adding && d.farms.length < d.limits.connectionsPerProject && (
                    <Button size="sm" icon={Plus} onClick={() => setAdding(true)}>
                        Connect a device farm
                    </Button>
                )}
            </div>
            <p className="t-secondary">Run phone tests on real phones in the cloud (BrowserStack, Sauce Labs, LambdaTest) or on any Appium server, instead of a phone on this computer.</p>
            {adding && (
                <ConnectForm
                    projectId={projectId}
                    providers={d.providers}
                    onCancel={() => setAdding(false)}
                    onDone={() => {
                        setAdding(false);
                        void data.reload();
                    }}
                />
            )}
            {d.farms.length === 0 && !adding ? (
                <EmptyState icon={Cloud} title="No device farm connected" actions={<Button onClick={() => setAdding(true)}>Connect a device farm</Button>}>
                    Phone tests run on this computer’s phone or emulator, or on the project’s runner.
                </EmptyState>
            ) : (
                <ul className="stack-sm">
                    {d.farms.map((f) => (
                        <FarmRow key={f.id} projectId={projectId} farm={f} providers={d.providers} onChanged={() => void data.reload()} />
                    ))}
                </ul>
            )}
            <RunChoice key={JSON.stringify(d.choice) + d.farms.length} projectId={projectId} data={d} onSaved={() => void data.reload()} />
            <RecentSessions projectId={projectId} />
        </section>
    );
}
