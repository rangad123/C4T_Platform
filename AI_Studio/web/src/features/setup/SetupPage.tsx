import type { Job, ProjectDetail } from "../../api";
import { CollapsedSetting, ProjectHub, type HubSection } from "../../components/ProjectHub";
import { MobileAppPanel } from "../../components/MobileAppPanel";
import { formatBytes } from "../../lib/format";
import { useConfig, useFetch, usePolled } from "../../lib/hooks";
import { describeApiError, isActive } from "../../lib/labels";
import { routes, useRoute, type SettingsSection } from "../../lib/router";
import { ExploreWithAi } from "../phone/PhoneStart";
import { DeviceFarmPanel } from "../devicefarm/DeviceFarmPanel";
import { PhoneDeviceSection } from "../phonedevice/PhoneDevicePanel";
import { hasAndroidApp } from "../phone/phone";
import { appState } from "../phone/phone";
import { EnvironmentsPanel } from "../environments/EnvironmentsPanel";
import { FrameworksSection } from "../frameworks/FrameworksSection";
import { settingsSentence, type FrameworkSettingsAnswer } from "../frameworks/frameworks";
import { IssueTrackerPanel } from "../integrations/IssueTrackerPanel";
import { AlertsPanel } from "../schedules/AlertsPanel";
import { ProjectStorage } from "../storage/ProjectStorage";
import { type ProjectStorage as ProjectStorageData } from "../storage/storage";
import { TestingTypeSetting } from "../security/TestingType";
import { ExploreLevelSetting } from "../explore/ExploreLevel";
import { NotesCard } from "../notes/NotesCard";
import { ProjectAiSettings } from "../aiconfig/ProjectAiSettings";
import { MembersPanel } from "../workspace/MembersPanel";
import { ReviewPolicyCard } from "../review/ReviewCards";
import { ProjectGeneral } from "../workspace/ProjectGeneral";
import { CleanupCard } from "../cleanup/CleanupCard";
import { TestDataPanel } from "../environments/TestDataPanel";
import { HardSignInPanel } from "../identity/HardSignInPanel";
import { TestAccountsPanel } from "../identity/TestAccountsPanel";
import { ResetHookCard } from "../webpages/ResetHookCard";
import { TestFilesCard } from "../webpages/TestFilesCard";
import "./setup.css";

function FrameworksSetting({ id }: { id: string }) {
    const settings = useFetch<FrameworkSettingsAnswer>(`/projects/${id}/framework-settings`);
    const jobs = usePolled<Job[]>(`/projects/${id}/jobs`);
    const running = !!jobs.data?.some((j) => isActive(j.status));
    const d = settings.data;
    const changed = d ? settingsSentence(d.settings, d.defaults) : "";
    return (
        <CollapsedSetting title="Frameworks" summary={d ? (changed ? `${changed}.` : "Tests run with the platform’s standard settings.") : settings.error ? `Could not load the framework settings: ${describeApiError(settings.error)}` : "Loading…"} testId="setting-frameworks">
            <FrameworksSection projectId={id} jobRunning={running} />
        </CollapsedSetting>
    );
}

function MobileSetting({ id }: { id: string }) {
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    const config = useConfig();
    const m = project.data?.mobile;
    // Reached from the welcome page right after it saved an Android app: go on to the start panel.
    const auto = useRoute().query.get("start") === "phone";
    const summary = project.loading ? "Loading…" : m ? `Phone tests use ${m.appPackage || m.iosBundleId || m.apk || "the uploaded app"}.${appState(m) === "ready" ? " The AI can explore it and plan tests." : appState(m) === "needs-package" ? " Add its package name and the AI can explore it." : ""}` : "No app is set. Only needed when you test an Android or iOS app.";
    return (
        <>
            <CollapsedSetting title="Mobile app" summary={summary} testId="setting-mobile" tour="mobile-app" extra={project.loading ? undefined : <ExploreWithAi projectId={id} auto={auto} />}>
                <MobileAppPanel projectId={id} current={m ?? null} mobile={config?.mobile} onSaved={() => void project.reload()} />
                <DeviceFarmPanel projectId={id} />
            </CollapsedSetting>
            {/* Round 24: is the phone ready, where phone tests run, how thorough, already signed in (features/phonedevice). Android apps only. */}
            {hasAndroidApp(m) && <PhoneDeviceSection projectId={id} cleanStart={m?.cleanStart === true} />}
        </>
    );
}

function StorageSetting({ id }: { id: string }) {
    const storage = useFetch<ProjectStorageData>(`/projects/${id}/storage`);
    const u = storage.data?.usage;
    const summary = storage.loading ? "Loading…" : u ? `This project’s files use ${u.text || formatBytes(u.bytes)}. Old files are ${storage.data?.retention.enabled ? "removed on a schedule" : "kept until you remove them"}.` : "Files, how long they are kept, and a backup to download or restore.";
    return (
        <CollapsedSetting title="Storage and backup" summary={summary} testId="setting-storage">
            <ProjectStorage projectId={id} />
        </CollapsedSetting>
    );
}

/** The project's details, what it tests and how, and its organisation (features/workspace/ProjectGeneral.tsx). */
function GeneralSetting({ id }: { id: string }) {
    return (
        <div className="stack">
            <ProjectGeneral id={id} />
            {/* The project's testing type (functional, security assessment or both); it shows only when the security module is on. */}
            <TestingTypeSetting id={id} />
            {/* How much later explorations, "Explore again" and schedules explore (engine/levels.ts). */}
            <ExploreLevelSetting id={id} />
            {/* Hints people write for the AI, by page; "never ..." notes are rules (features/notes/NotesCard.tsx). */}
            <NotesCard projectId={id} />
        </div>
    );
}

/**
 * The project's Settings place (it used to be called Setup). General and members first, then what tests use (environments, test
 * data, accounts, AI), how they run (frameworks, the mobile app), who is told (alerts, issue tracker) and storage. Runners are
 * per person: each person sets up their own runner in Settings (round 45).
 * Settings that rarely change sit behind a titled row with "Change".
 */
export function SetupPage({ id }: { id: string }) {
    const section = (useRoute().query.get("section") as SettingsSection | null) ?? "general";
    const sections: HubSection[] = [
        { key: "general", label: "General", hint: "The project, its platform, testing mode and app", render: () => <GeneralSetting id={id} /> },
        {
            key: "members",
            label: "Members",
            hint: "Who can work on this project, who approves, and what needs approval",
            render: () => (
                <div className="stack">
                    <MembersPanel projectId={id} />
                    {/* What needs a Project Admin's approval before it runs (features/review/ReviewCards.tsx). */}
                    <ReviewPolicyCard projectId={id} />
                </div>
            ),
        },
        { key: "environments", label: "Environments", hint: "Staging, production and other addresses to run against", render: () => <EnvironmentsPanel projectId={id} onStarted={() => undefined} /> },
        {
            key: "data",
            label: "Test data",
            hint: "Tables of values tests read, files they upload, the reset before a run, and the records tests create",
            render: () => (
                <div className="stack">
                    <TestDataPanel projectId={id} />
                    <TestFilesCard projectId={id} />
                    <ResetHookCard projectId={id} />
                    <CleanupCard projectId={id} variant="panel" />
                </div>
            ),
        },
        {
            key: "accounts",
            label: "Test accounts",
            hint: "Logins your tests sign in with",
            render: () => (
                <div className="stack">
                    <TestAccountsPanel projectId={id} />
                    <HardSignInPanel projectId={id} />
                </div>
            ),
        },
        { key: "ai", label: "AI configuration", hint: "Who pays, which key this project uses, and its budget", render: () => <ProjectAiSettings id={id} /> },
        { key: "frameworks", label: "Frameworks", hint: "Which test technologies run and their limits", render: () => <FrameworksSetting id={id} /> },
        { key: "mobile", label: "Mobile app", hint: "The app your phone tests run against", render: () => <MobileSetting id={id} /> },
        { key: "alerts", label: "Alerts", hint: "Who is told when a run finds something", render: () => <AlertsPanel projectId={id} reloadKey={0} /> },
        { key: "issues", label: "Issue tracker", hint: "GitHub, Jira or Notion, to file problems from a test", render: () => <IssueTrackerPanel projectId={id} /> },
        { key: "storage", label: "Storage and backup", hint: "What the files use, how long they are kept, backups", render: () => <StorageSetting id={id} /> },
    ];
    return <ProjectHub id={id} place="settings" title="Settings" subtitle="The project, who works on it, what tests use, how they run, and who is told." sections={sections} current={section} hrefOf={(k) => routes.projectSettings(id, k as SettingsSection)} />;
}
