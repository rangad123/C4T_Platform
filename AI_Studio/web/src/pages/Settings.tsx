import { usePage } from "../components/Shell";
import { Badge, Callout, PageHeader, Skeleton } from "../components/ui";
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
import { YourRunnerSection } from "../features/runners/YourRunner";
import { MobileTooling } from "../features/workspace/GlobalPages";

const PROVIDER_NAME: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", google: "Google", "openai-compatible": "custom or OpenRouter endpoint" };

export function Settings() {
    useDocumentTitle("Settings");
    usePage({ crumbs: [{ label: "Settings" }], nav: "settings" });
    const config = useConfig();
    const auth = useAuth();
    const can = useCan();
    // A person limited to some projects: the platform-wide panels (AI usage across projects, storage, evaluation) are not theirs.
    const limited = auth.state?.projectAccess === "only";
    // Someone who may run tests but not change the platform sees their runner, the read-only AI model and Test formats cards, and their account.
    const platform = can("ai_studio.platform.settings") || can("ai_studio.usage.view");
    const runs = can("ai_studio.tests.run") || can("ai_studio.runners.manage");

    return (
        <div style={{ maxWidth: 720 }}>
            <PageHeader title="Settings" subtitle={runs ? "Your runner, and how this platform is set up." : "How this platform is set up."} />
            <div className="stack">
                {/* Your runner (round 45): one per person, set up once here and used for every run they start (features/runners/YourRunner.tsx). */}
                {runs && <YourRunnerSection />}

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
                                Using <strong>{config.llm.model}</strong> ({PROVIDER_NAME[config.llm.provider] ?? config.llm.provider})
                                {config.llm.via === "configuration" && config.llm.label ? (
                                    <>
                                        {" "}
                                        from the AI configuration <strong>{config.llm.label}</strong>, as this server has no key of its own
                                    </>
                                ) : null}
                                . It explores applications, plans tests and writes them.
                            </p>
                            {config.llm.via !== "configuration" && <ModelHealth />}
                            <PromptCacheSetting />
                            <CompactSnapshotsSetting />
                            <WithoutAiSetting />
                            {config.llm.via !== "configuration" && <FastModelSetting />}
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

                {/* No access-key card: the sign-in screen asks for the key when a server requires one (features/auth/AuthGate). */}

                {/* People and access: the first owner, your account, people, activity, single sign-on (features/auth). */}
                <PeopleSettings />

                {/* The Android emulator on the platform's own computer (it was on the Runners page until round 45). */}
                {platform && !limited && <MobileTooling />}

                {platform && !limited && <UsagePanel />}

                {/* Read-only: shown to anyone who opens Settings, as before round 45. */}
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

                {platform && !limited && <StorageSettings />}

                {platform && !limited && <QualityPanel />}
            </div>
        </div>
    );
}
