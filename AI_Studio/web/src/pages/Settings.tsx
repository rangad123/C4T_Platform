import { KeyRound } from "lucide-react";
import { useState } from "react";
import { getKey, setKey } from "../api";
import { usePage } from "../components/Shell";
import { Badge, Button, Callout, PageHeader, Skeleton } from "../components/ui";
import { StorageSettings } from "../features/storage/StorageSettings";
import { UsagePanel } from "../features/usage/UsagePanel";
import { ModelHealth } from "../features/usage/ModelHealth";
import { PromptCacheSetting } from "../features/usage/PromptCacheSetting";
import { CompactSnapshotsSetting } from "../features/usage/CompactSnapshotsSetting";
import { WithoutAiSetting } from "../features/usage/WithoutAiSetting";
import { FastModelSetting } from "../features/usage/FastModelSetting";
import { AiConfigurationsCard } from "../features/aiconfig/AiConfigurationsCard";
import { useCan } from "../features/auth/permissions";
import { useAuth } from "../features/auth/auth";
import { PeopleSettings } from "../features/auth/PeopleSettings";
import { QualityPanel } from "../features/eval/QualityPanel";
import { frameworkLabel } from "../lib/labels";
import { useConfig, useDocumentTitle } from "../lib/hooks";

const PROVIDER_NAME: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", google: "Google", "openai-compatible": "custom or OpenRouter endpoint" };

export function Settings() {
    useDocumentTitle("Settings");
    usePage({ crumbs: [{ label: "Settings" }], nav: "settings" });
    const config = useConfig();
    const auth = useAuth();
    const can = useCan();
    // A person limited to some projects: the platform-wide panels (AI usage across projects, storage, evaluation) are not theirs.
    const limited = auth.state?.projectAccess === "only";
    const [key, setKeyValue] = useState(getKey());
    const [saved, setSaved] = useState(false);

    return (
        <div style={{ maxWidth: 720 }}>
            <PageHeader title="Settings" subtitle="How this platform is set up." />
            <div className="stack">
                <section className="card card-pad stack-sm">
                    <div className="row">
                        <h2 className="t-section">AI model</h2>
                        <span className="spacer" />
                        {config ? <Badge tone={config.llm.configured ? "success" : "warning"}>{config.llm.configured ? "Connected" : "Not set up"}</Badge> : <Skeleton w={80} h={22} />}
                    </div>
                    {!config ? (
                        <Skeleton h={40} />
                    ) : config.llm.configured ? (
                        <>
                            <p className="t-secondary">
                                Using <strong>{config.llm.model}</strong> ({PROVIDER_NAME[config.llm.provider] ?? config.llm.provider}). It explores applications, plans tests and writes them.
                            </p>
                            <ModelHealth />
                            <PromptCacheSetting />
                            <CompactSnapshotsSetting />
                            <WithoutAiSetting />
                            <FastModelSetting />
                        </>
                    ) : (
                        <>
                            <Callout tone="warning" title="Web testing won’t work until an AI model is set up">
                                API tests from an OpenAPI document and accessibility checks still work without one.
                            </Callout>
                            <p className="t-secondary">Add your key to the server’s <code>.env</code> file and restart. For example, for Anthropic:</p>
                            <pre className="raw">ANTHROPIC_API_KEY=your-key-here</pre>
                            <p className="t-meta">OpenAI, Google, OpenRouter and local models are supported too — see the admin guide.</p>
                        </>
                    )}
                </section>

                {/* The keys projects can use: the organisation's or the platform's (features/aiconfig). */}
                {can("ai_studio.ai_keys.manage") && <AiConfigurationsCard />}

                <section className="card card-pad stack-sm">
                    <h2 className="t-section">Access to this platform</h2>
                    {config?.authRequired ? (
                        <>
                            <p className="t-secondary">This platform requires an access key. It is stored only in this browser. The AI provider key stays on the server and is never shown or shared.</p>
                            <form
                                className="row"
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    setKey(key);
                                    setSaved(true);
                                    setTimeout(() => location.reload(), 600);
                                }}
                            >
                                <div className="input-wrap" style={{ flex: "1 1 260px" }}>
                                    <KeyRound size={16} className="lead" aria-hidden />
                                    <input className="input" type="password" autoComplete="off" aria-label="Access key" value={key} onChange={(e) => { setKeyValue(e.target.value); setSaved(false); }} />
                                </div>
                                <Button type="submit" variant="primary">{saved ? "Saved" : "Save key"}</Button>
                            </form>
                        </>
                    ) : auth.state?.mode === "protected" ? (
                        <p className="t-secondary">Everyone signs in with their own account (see People). Set <code>API_KEY</code> in <code>.env</code> if scripts need a shared owner-level key.</p>
                    ) : (
                        <p className="t-secondary">Anyone who can reach this server can use it. Set <code>API_KEY</code> in <code>.env</code> to require a key before exposing it on a network, or add the first owner below so everyone signs in.</p>
                    )}
                </section>

                {/* People and access: the first owner, your account, people, activity, single sign-on (features/auth). */}
                <PeopleSettings />

                {/* Mobile testing (the Android emulator on this computer) moved to Runners → Mobile tooling: it is about the machines. */}

                {!limited && <UsagePanel />}

                <section className="card card-pad stack-sm">
                    <h2 className="t-section">Test formats</h2>
                    <p className="t-secondary">Every test is stored in a framework-independent form, then turned into a script for each format.</p>
                    <ul className="list divided" style={{ border: "1px solid var(--border-default)", borderRadius: 8, overflow: "hidden" }}>
                        {(config?.frameworks ?? []).map((f) => {
                            // A framework added by an adapter plug-in is named by its own label and marked as one.
                            const plugin = config?.adapters?.find((a) => a.id === f.framework && a.plugin);
                            return (
                                <li className="list-row" key={f.framework} style={{ padding: "10px 14px" }}>
                                    <span className="main">
                                        <span className="title">{plugin ? plugin.label : frameworkLabel(f.framework)}</span>
                                        <span className="meta">{f.kind === "web" ? "Web application tests" : f.kind === "api" ? "API tests" : f.kind === "desktop" && plugin ? "Desktop tests" : "Mobile tests (Appium)"}</span>
                                    </span>
                                    {plugin && <Badge tone="brand">Plug-in</Badge>}
                                    <Badge tone={f.executable ? "success" : "neutral"}>{f.executable ? "Created and run here" : "Created, run elsewhere"}</Badge>
                                </li>
                            );
                        })}
                    </ul>
                </section>

                {!limited && <StorageSettings />}

                {!limited && <QualityPanel />}
            </div>
        </div>
    );
}
