import { usePage } from "../components/Shell";
import { Badge, PageHeader } from "../components/ui";
import { StorageSettings } from "../features/storage/StorageSettings";
import { UsagePanel } from "../features/usage/UsagePanel";
import { ModelHealth } from "../features/usage/ModelHealth";
import { PromptCacheSetting } from "../features/usage/PromptCacheSetting";
import { CompactSnapshotsSetting } from "../features/usage/CompactSnapshotsSetting";
import { WithoutAiSetting } from "../features/usage/WithoutAiSetting";
import { FastModelSetting } from "../features/usage/FastModelSetting";
import { AiKeysSection } from "../features/aiconfig/AiKeysSection";
import { OrganisationalKeysCard } from "../features/aiconfig/OrganisationalKeysCard";
import { useMyAi } from "../features/aiconfig/aiconfig";
import { useCan } from "../features/auth/permissions";
import { useAuth } from "../features/auth/auth";
import { PeopleSettings } from "../features/auth/PeopleSettings";
import { QualityPanel } from "../features/eval/QualityPanel";
import { frameworkLabel } from "../lib/labels";
import { useConfig, useDocumentTitle } from "../lib/hooks";
import { YourRunnerSection } from "../features/runners/YourRunner";
import { MobileTooling } from "../features/workspace/GlobalPages";

export function Settings() {
    useDocumentTitle("Settings");
    usePage({ crumbs: [{ label: "Settings" }], nav: "settings" });
    const config = useConfig();
    const auth = useAuth();
    const can = useCan();
    // A person limited to some projects: the platform-wide panels (AI usage across projects, storage, evaluation) are not theirs.
    const limited = auth.state?.projectAccess === "only";
    // Someone who may run tests but not change the platform sees their runner, their AI keys, the Test formats card, and their account.
    const platform = can("ai_studio.platform.settings") || can("ai_studio.usage.view");
    const runs = can("ai_studio.tests.run") || can("ai_studio.runners.manage");
    // Anyone who may start AI work has their own AI keys here.
    const usesAi = can("ai_studio.tests.generate") || can("ai_studio.agent.run") || can("ai_studio.platform.settings");
    const myAi = useMyAi();

    return (
        <div style={{ maxWidth: 720 }}>
            <PageHeader title="Settings" subtitle={runs && usesAi ? "Your runner, your AI keys, and how this platform is set up." : runs ? "Your runner, and how this platform is set up." : usesAi ? "Your AI keys, and how this platform is set up." : "How this platform is set up."} />
            <div className="stack">
                {/* Your runner (round 45): one per person, set up once here and used for every run they start (features/runners/YourRunner.tsx). */}
                {runs && <YourRunnerSection />}

                {/* AI keys (round 57): the one key all of this person's AI work uses, their own keys, and organisational keys assigned to them. */}
                {usesAi && <AiKeysSection />}

                {/* Crowd4Test admins only: the organisational keys and who may use each (the server refuses everyone else). */}
                {myAi.data?.canManageOrganisational === true && <OrganisationalKeysCard />}

                {/* How the AI works on this platform, whichever key pays: for the people who change the platform. */}
                {can("ai_studio.platform.settings") && (
                    <section className="card card-pad stack-sm" data-testid="ai-behaviour">
                        <h2 className="t-section">How the AI works here</h2>
                        <p className="t-secondary">These apply to every key.</p>
                        {/* The server's own key is used only on a server without accounts: its health and fast model belong to it. */}
                        {myAi.data?.openServer?.configured && <ModelHealth />}
                        <PromptCacheSetting />
                        <CompactSnapshotsSetting />
                        <WithoutAiSetting />
                        {myAi.data?.openServer?.configured && <FastModelSetting />}
                    </section>
                )}

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
