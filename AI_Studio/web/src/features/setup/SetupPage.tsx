import type { ReactNode } from "react";
import { projectKind, projectShape, type Job, type ProjectDetail } from "../../api";
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
import { KeepThumbnailsSetting } from "../explore/KeepThumbnails";
import { ExploreObjectivesSetting } from "../explore/ExploreObjectives";
import { NotesCard } from "../notes/NotesCard";
import { MembersPanel } from "../workspace/MembersPanel";
import { ReviewPolicyCard } from "../review/ReviewCards";
import { ProjectGeneral } from "../workspace/ProjectGeneral";
import { ProjectAiModelSetting } from "../workspace/ProjectAiModel";
import { CleanupCard } from "../cleanup/CleanupCard";
import { TestDataPanel } from "../environments/TestDataPanel";
import { SignInTab } from "../identity/SignInTab";
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
    // A code project never explores: no "Explore with AI", and the summary says nothing about the AI exploring the app.
    const explores = projectKind(project.data) !== "code";
    const summary = project.loading ? "Loading…" : m ? `Phone tests use ${m.appPackage || m.iosBundleId || m.apk || "the uploaded app"}.${!explores ? "" : appState(m) === "ready" ? " The AI can explore it and plan tests." : appState(m) === "needs-package" ? " Add its package name and the AI can explore it." : ""}` : "No app is set. Only needed when you test an Android or iOS app.";
    return (
        <>
            <CollapsedSetting title="Mobile app" summary={summary} testId="setting-mobile" tour="mobile-app" extra={project.loading || !explores ? undefined : <ExploreWithAi projectId={id} auto={auto} />}>
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

/** One part of a tab that a link can open (`routes.projectSettings(id, "frameworks")`; ProjectHub scrolls to it and focuses it). */
const Part = ({ id, tour, children }: { id: string; /** The guided tour's mark, where a step points at this part. */ tour?: string; children: ReactNode }) => (
    <div id={id} tabIndex={-1} className="stack" data-tour={tour}>
        {children}
    </div>
);

/** The project's details, what it tests and how, its organisation, and the one-time setup: frameworks, storage and backup. */
function GeneralSetting({ id }: { id: string }) {
    return (
        <div className="stack">
            <ProjectGeneral id={id} />
            {/* The project's testing type (functional, security assessment or both); it shows only when the security module is on. */}
            <TestingTypeSetting id={id} />
            {/* How much later explorations, "Explore again" and schedules explore (engine/levels.ts). */}
            <ExploreLevelSetting id={id} />
            {/* Which AI model the project's AI work uses, from the asking person's own AI keys (features/workspace/ProjectAiModel.tsx). */}
            <ProjectAiModelSetting id={id} />
            {/* Whether explorations keep a covered thumbnail of each page (sheet #8; on unless switched off). */}
            <KeepThumbnailsSetting id={id} />
            {/* Whether explorations also explore by objectives (on by default for an AI agent project; owner, 2026-11-21). */}
            <ExploreObjectivesSetting id={id} />
            {/* Hints people write for the AI, by page; "never ..." notes are rules (features/notes/NotesCard.tsx). */}
            <NotesCard projectId={id} />
            <Part id="frameworks">
                <FrameworksSetting id={id} />
            </Part>
            <Part id="storage" tour="settings-storage">
                <StorageSetting id={id} />
            </Part>
        </div>
    );
}

/**
 * The project's Settings place (it used to be called Setup): General (with frameworks and storage), Members, Sign-in (the project's
 * sign-in and the other test accounts), Environments, Test data, Connections (alerts and the issue tracker), and Mobile app for a
 * project that tests a phone app. Runners are per person: each person sets up their own runner in Settings (round 45).
 * Settings that rarely change sit behind a titled row with "Change".
 */
export function SetupPage({ id }: { id: string }) {
    const section = (useRoute().query.get("section") as SettingsSection | null) ?? "general";
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    // Mobile app only for a project that tests a phone app (or already has one saved); shown while the project loads.
    const phone = !project.data || projectShape(project.data).platforms.some((p) => p !== "web") || !!project.data.mobile;
    const sections: HubSection[] = [
        { key: "general", label: "General", hint: "The project, its platform and testing mode, its AI model, frameworks, storage and backup", render: () => <GeneralSetting id={id} /> },
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
        {
            key: "signin",
            label: "Sign-in",
            hint: "Who your tests sign in as: the main account and other test accounts, each with how it signs in, and the test mailbox",
            render: () => <SignInTab projectId={id} />,
        },
        { key: "environments", label: "Environments", hint: "Staging, production and other addresses to run against, with their values", render: () => <EnvironmentsPanel projectId={id} onStarted={() => undefined} /> },
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
            key: "connections",
            label: "Connections",
            hint: "Who is told when a run finds something, and the issue tracker problems are filed in",
            render: () => (
                <div className="stack">
                    <Part id="alerts" tour="settings-alerts">
                        <AlertsPanel projectId={id} reloadKey={0} />
                    </Part>
                    <Part id="issues" tour="settings-issues">
                        <IssueTrackerPanel projectId={id} />
                    </Part>
                </div>
            ),
        },
        ...(phone ? [{ key: "mobile", label: "Mobile app", hint: "The app your phone tests run against", render: () => <MobileSetting id={id} /> }] : []),
    ];
    return <ProjectHub id={id} place="settings" title="Settings" subtitle="The project, who works on it, what tests use, how they run, and who is told." sections={sections} current={section} hrefOf={(k) => routes.projectSettings(id, k as SettingsSection)} />;
}
