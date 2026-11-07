import type { Tone } from "../../lib/labels";
import type { ValidationStatus } from "../../api";

/** Review and approval of test versions (src/platform/routes/reviews.ts). */
export type VersionState = "draft" | "in_review" | "approved" | "rejected" | "superseded";
export type VersionSource = "ai" | "person" | "healing" | "import" | "shared" | "takeover" | "upgrade" | "dependency";
export type SyncStatus = "in_sync" | "text_changed" | "code_changed" | "needs_regeneration" | "code_only";

export interface VersionSummary {
    version: number;
    state: VersionState;
    source: VersionSource;
    sync: SyncStatus;
    regenNote: string | null;
    author: string;
    auto: boolean;
    createdAt: string;
    updatedAt: string;
    decision: { by: string; at: string; note: string | null } | null;
}

export interface ScriptRow {
    testId: string;
    testKey: string;
    title: string;
    framework: string;
    custom: boolean;
    validationStatus: ValidationStatus;
    latest: VersionSummary | null;
    approvedVersion: number | null;
    waiting: boolean;
}

export interface ReviewPolicy {
    aiGenerated: boolean;
    edits: boolean;
    healing: boolean;
    soleAdminSelfApprove: boolean;
}

export interface VersionComment {
    id: string;
    kind: "comment" | "submitted" | "approved" | "rejected" | "changes";
    body: string | null;
    authorName: string;
    createdAt: string;
}

export interface VersionDetail extends VersionSummary {
    testId: string;
    testKey: string;
    title: string;
    projectId: string;
    submittedAt: string | null;
    text: string;
    note: string | null;
    code: string | null;
    codeNote: string | null;
    approved: { version: number; text: string; code: string | null } | null;
    comments: VersionComment[];
    actions: { submit: boolean; approve: boolean; reject: boolean; requestChanges: boolean; comment: boolean; approveBlocked: string | null };
}

export interface QueueItem extends VersionSummary {
    projectId: string;
    projectName: string;
    testId: string;
    testKey: string;
    title: string;
    yours: boolean;
    canApprove: boolean;
}

export const STATE_ORDER: readonly VersionState[] = ["draft", "in_review", "approved", "rejected", "superseded"];
export const STATE: Record<VersionState, { label: string; tone: Tone; text: string }> = {
    draft: { label: "Draft", tone: "neutral", text: "Not approved yet. Runs leave it out and keep running the approved version, if there is one." },
    in_review: { label: "In review", tone: "info", text: "Sent to a Project Admin to approve. It does not run until approved." },
    approved: { label: "Approved", tone: "success", text: "A Project Admin approved it, or the project's review policy did. This is what runs." },
    rejected: { label: "Rejected", tone: "danger", text: "A Project Admin rejected it, with a reason. It never runs; a new change makes a new version." },
    superseded: { label: "Replaced", tone: "neutral", text: "A newer version took its place. Kept for the history." },
};

export const SYNC_ORDER: readonly SyncStatus[] = ["in_sync", "text_changed", "code_changed", "needs_regeneration", "code_only"];
export const SYNC: Record<SyncStatus, { label: string; tone: Tone; text: string }> = {
    in_sync: { label: "In step", tone: "success", text: "The code was made from these plain-English steps, or a person took it over and has not changed it." },
    text_changed: { label: "Steps changed", tone: "info", text: "The steps changed and no code was made from them yet. The code is made from them when this version runs." },
    code_changed: { label: "Code changed", tone: "warning", text: "A person changed code they own. The plain-English steps no longer describe it, and the platform never writes over it." },
    needs_regeneration: { label: "Needs regenerating", tone: "warning", text: "A change to the steps was not applied, because a person owns the code. Update the code by hand, or go back to the generated version." },
    code_only: { label: "Code only", tone: "neutral", text: "Written as code or imported from Git: there are no plain-English steps to keep in step." },
};

export const SOURCE_WORDS: Record<VersionSource, string> = {
    ai: "Written by the AI",
    person: "Edited by a person",
    healing: "Repaired after a failed run",
    import: "Imported",
    shared: "A shared element or reusable step was renamed",
    takeover: "Switched to code",
    upgrade: "Approved when review arrived",
    dependency: "Reusable steps, a shared element or a helper it uses changed",
};

export const COMMENT_WORDS: Record<VersionComment["kind"], string> = {
    comment: "commented",
    submitted: "sent it for review",
    approved: "approved it",
    rejected: "rejected it",
    changes: "asked for changes",
};

/** Where one version of a test's script is reviewed: the Scripts section of Test scripts, with the test and version in the query. */
export const versionHref = (projectId: string, testId: string, version: number) => `#/projects/${projectId}/scripts?test=${encodeURIComponent(testId)}&version=${version}`;
