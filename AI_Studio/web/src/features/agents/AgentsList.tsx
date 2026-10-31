import { ChevronRight, Laptop, Plus } from "lucide-react";
import { useState } from "react";
import { Badge, Button, EmptyState, ErrorState, ListSkeleton } from "../../components/ui";
import { relativeTime } from "../../lib/format";
import { friendlyError } from "../../lib/labels";
import { browserName, browserSentence, capabilitySummary, deviceState, OS_LABEL, phoneToolsSentence, usePolled, type Agent } from "./agents";
import { networkSentence, RunnerNetworkProblem } from "./network";
import { RunnerCheckDetails, RunnerCheckNote } from "./check";
import { RunnerUpdates } from "./updates";
import { BadgeKey, Tooltip } from "../../components/Tooltip";
import { help, helpFor } from "../../lib/help";
import type { AccessTarget } from "./RemoveAccess";
import "./agents.css";

/** Connected runners: who is online, what each can run, and (on request) the devices it sees. */
export function AgentsList({ agents, addOpen, atLimit = false, maxRunners = 1, onAdd, onRemove, projectId }: { agents: ReturnType<typeof usePolled<Agent[]>>; addOpen: boolean; atLimit?: boolean; maxRunners?: number; onAdd: () => void; onRemove: (t: AccessTarget) => void; projectId?: string }) {
    const list = agents.data;
    // One runner per project by default: once it exists, adding another is refused until it is removed, so the UI says so instead of offering it.
    const limitNote = maxRunners === 1 ? "This project already has a runner. Remove it to add another." : `This project already has ${maxRunners} runners. Remove one to add another.`;
    return (
        <section className="card" aria-labelledby="ag-agents-title" data-tour="add-runner">
            <div className="card-head wrap">
                <Laptop size={18} aria-hidden />
                <h2 className="t-section" id="ag-agents-title">Connected runners</h2>
                {list && list.length > 0 && <span className="t-meta">{list.filter((a) => a.online).length} of {list.length} online</span>}
                <span className="spacer" />
                {atLimit ? (
                    <span className="t-meta" data-testid="runner-limit-note">{limitNote}</span>
                ) : (
                    list && list.length > 0 && !addOpen && (
                        <Button size="sm" icon={Plus} onClick={onAdd}>
                            Add a runner
                        </Button>
                    )
                )}
            </div>
            {agents.loading ? (
                <ListSkeleton rows={2} />
            ) : agents.error || !list ? (
                <div className="card-pad">
                    <ErrorState error={friendlyError(agents.error?.message)} onRetry={agents.reload} />
                </div>
            ) : list.length === 0 ? (
                <EmptyState
                    icon={Laptop}
                    title="No runners yet"
                    actions={
                        atLimit ? (
                            <span className="t-meta" data-testid="runner-limit-note">{limitNote}</span>
                        ) : (
                            !addOpen && (
                                <Button variant="primary" icon={Plus} onClick={onAdd}>
                                    Add a runner
                                </Button>
                            )
                        )
                    }
                >
                    {atLimit ? "This project has its runner set up, but none is connected right now. Start it, or remove it below to set up a different one." : "Add one to run tests on a computer where your app can be reached. Once it connects it appears here with its browsers and devices."}
                </EmptyState>
            ) : (
                <ul className="list divided" aria-label="Runners">
                    {list.map((a) => (
                        <li key={a.id}>
                            <AgentRow a={a} onRemove={onRemove} projectId={projectId} onChanged={() => void agents.reload()} />
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

function AgentRow({ a, onRemove, projectId, onChanged }: { a: Agent; onRemove: (t: AccessTarget) => void; projectId?: string; onChanged: () => void }) {
    const [open, setOpen] = useState(false);
    const panel = `ag-detail-${a.id}`;
    return (
        <div className="ag-agent" data-agent={a.id} data-online={a.online}>
            <div className="ag-agent-head">
                <h3 className="t-card ag-name">{a.name}</h3>
                <Tooltip content={a.online ? help("runner", "online") : "Nothing heard from the runner in the last 45 seconds. Start it again on its computer."}>
                    <span className={`ag-state ${a.online ? "on" : "off"}`} tabIndex={0}>
                        <i className="ag-dot" aria-hidden />
                        {a.online ? "Online" : "Offline"}
                    </span>
                </Tooltip>
                <span className="spacer" />
                <Button size="sm" variant="ghost" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((o) => !o)}>
                    <ChevronRight size={16} className={`ag-chev ${open ? "open" : ""}`} aria-hidden />
                    {open ? "Hide details" : "Show details"}
                    <span className="sr-only"> for {a.name}</span>
                </Button>
            </div>
            <div className="ag-facts">
                <span>Version <b>{a.version}</b></span>
                {a.capabilities.kitVersion && (
                    <Tooltip content="The version of the runner download it was started from. “Version” is the runner program inside it.">
                        <span tabIndex={0}>Runner download <b>{a.capabilities.kitVersion}</b></span>
                    </Tooltip>
                )}
                <span><b>{OS_LABEL[a.os]}</b></span>
                <span>Last seen <b>{relativeTime(a.lastSeenAt)}</b></span>
                <Tooltip content="Tasks it is working on now, out of how many it takes at once. That number is set when the runner starts (1 to 8).">
                    <span tabIndex={0}><b>{a.activeTasks}</b> of <b>{a.concurrency}</b> {a.concurrency === 1 ? "task" : "tasks"} running</span>
                </Tooltip>
            </div>
            <p className="t-secondary" data-testid="agent-capabilities">{capabilitySummary(a.capabilities)}</p>
            {a.capabilities.browser ? (
                <p className="t-secondary" data-testid="agent-browser">Web tests run in {browserSentence(a.capabilities.browser, a.name)}.</p>
            ) : a.capabilities.browserNote ? (
                <p className="t-secondary" data-testid="agent-browser">Web tests: {a.capabilities.browserNote}</p>
            ) : null}
            <RunnerNetworkProblem network={a.capabilities.network} />
            <RunnerCheckNote check={a.capabilities.check} name={a.name} />
            {a.update && projectId && <RunnerUpdates projectId={projectId} a={a} onChanged={onChanged} />}
            {open && <AgentDetails a={a} id={panel} />}
            <div>
                <Button size="sm" variant="danger" onClick={() => onRemove({ tokenId: a.tokenId, name: a.name })} aria-label={`Remove access for ${a.name}`}>
                    Remove access
                </Button>
            </div>
        </div>
    );
}

function AgentDetails({ a, id }: { a: Agent; id: string }) {
    const c = a.capabilities;
    const devices = c.android?.devices ?? [];
    return (
        <div className="ag-detail" id={id}>
            <dl className="ag-dl">
                <dt>Computer</dt>
                <dd>
                    {OS_LABEL[a.os]}, {a.arch}, Node {a.node.replace(/^v/, "")}
                </dd>
                <dt>First connected</dt>
                <dd>{relativeTime(a.firstSeenAt)}</dd>
                {c.network && (
                    <>
                        <dt>Network</dt>
                        <dd data-testid="agent-network">{networkSentence(c.network)}</dd>
                    </>
                )}
                {c.check && (
                    <>
                        <dt>Computer check</dt>
                        <dd>
                            <RunnerCheckDetails check={c.check} />
                        </dd>
                    </>
                )}
                <dt>Browsers</dt>
                <dd>{c.browsers.length ? c.browsers.map((b) => ({ chromium: "Chromium", firefox: "Firefox", webkit: "WebKit" })[b]).join(", ") : "None installed. Web and API tests cannot run here."}</dd>
                {c.installedBrowsers?.length ? (
                    <>
                        <dt>Found on the computer</dt>
                        <dd>
                            <ul className="ag-found" aria-label={`Browsers found on ${a.name}`}>
                                {c.installedBrowsers.map((b) => (
                                    <li key={b.name}>
                                        {browserName(b)}
                                        {b.usable ? (c.browser?.name === b.name ? ", used for web tests" : ", can be used") : `, not used: ${b.reason ?? "unknown reason"}`}
                                    </li>
                                ))}
                            </ul>
                        </dd>
                    </>
                ) : null}
            </dl>

            {c.android && (
                <div className="stack-sm">
                    <div className="row" style={{ gap: 4 }}>
                        <h4 className="t-card">Android</h4>
                        <BadgeKey label={`the device states on ${a.name}`} entries={devices.map((d) => ({ word: deviceState(d.state), text: helpFor("device", d.state) }))} />
                    </div>
                    {!c.android.adb ? (
                        <p className="t-secondary">Android’s <code>adb</code> was not found on this computer, so phones and emulators cannot be used.</p>
                    ) : devices.length === 0 ? (
                        <p className="t-secondary">No phone or emulator is connected. Plug in a phone with USB debugging on, or start an emulator.</p>
                    ) : (
                        <ul className="ag-devices" aria-label={`Android devices on ${a.name}`}>
                            {devices.map((d) => (
                                <li key={d.serial} data-device={d.serial}>
                                    <span className="ag-serial">{d.serial}</span>
                                    <span>{d.model ?? "Unknown model"}</span>
                                    <Badge tone={d.state === "device" ? "success" : "warning"} tip={helpFor("device", d.state)}>{deviceState(d.state)}</Badge>
                                    <span className="t-meta">{d.emulator ? "Emulator" : "Phone"}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                    {c.android.avds.length > 0 && <p className="t-meta">Emulators it can start: {c.android.avds.join(", ")}</p>}
                </div>
            )}
            {c.phoneTools && (
                <div className="stack-sm" data-testid="agent-phone-tools">
                    <h4 className="t-card">Android phone tools</h4>
                    <p className="t-secondary">{phoneToolsSentence(c.phoneTools)}</p>
                </div>
            )}

            {c.ios && (
                <div className="stack-sm">
                    <h4 className="t-card">iPhone and iPad simulators</h4>
                    <p className="t-secondary">
                        {c.ios.xcode || c.ios.simulators.length > 0 ? `Detected${c.ios.simulators.length ? ` (${c.ios.simulators.join(", ")})` : ""}, not supported yet.` : "Not found."}
                    </p>
                </div>
            )}
            {c.windows && (
                <div className="stack-sm">
                    <h4 className="t-card">Windows desktop apps</h4>
                    <p className="t-secondary">{windowsDesktopStatus(c.windows)}</p>
                    {c.windows.uiautomation && !c.windows.elevated && c.windows.interactive !== false && (
                        <p className="t-meta">{c.windows.allowedApps?.length ? `May start: ${c.windows.allowedApps.join(", ")}` : "No application is allowed yet. Start the runner with --allow-app to choose which ones tests may open."}</p>
                    )}
                </div>
            )}
        </div>
    );
}

/** What this agent can do with Windows desktop apps, in plain words. */
function windowsDesktopStatus(w: NonNullable<Agent["capabilities"]["windows"]>): string {
    if (!w.uiautomation) return "Not found.";
    if (w.elevated) return "Windows desktop apps: the runner runs as administrator, and desktop tests do not run that way. Restart it as a normal user.";
    if (w.interactive === false) return "Windows desktop apps: needs an interactive desktop session. Start the runner from a signed-in Windows session, not a service.";
    return "Windows desktop apps: ready";
}
