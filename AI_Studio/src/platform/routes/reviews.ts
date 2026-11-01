/**
 * Review and approval of test versions (review-store.ts):
 *
 *   GET  /api/projects/:id/scripts                         every test's script: latest version, its state and sync status, who changed it
 *   GET  /api/projects/:id/review-policy                   what needs approval in this project
 *   PUT  /api/projects/:id/review-policy                   { aiGenerated?, edits?, healing?, soleAdminSelfApprove? }
 *   GET  /api/tests/:id/review                             the test's versions, newest first
 *   GET  /api/tests/:id/review/:version                    one version: text and code beside the approved version's, comments, what you may do
 *   POST /api/tests/:id/review/:version/submit             { note? }          a draft goes to review
 *   POST /api/tests/:id/review/:version/approve            { seen, note? }    `seen` is the version's updatedAt the reviewer read
 *   POST /api/tests/:id/review/:version/reject             { reason }
 *   POST /api/tests/:id/review/:version/request-changes    { comment }        back to draft with what to change
 *   POST /api/tests/:id/review/:version/comments           { body }
 *   GET  /api/reviews                                      the review queue: drafts across the projects the caller may approve in
 *   GET  /api/jobs/:id/test-versions                       the version each test of a run ran, and the tests it left out (waiting)
 *
 * Approving needs ai_studio.tests.approve and Project Admin on the project (canApprove). Nobody approves their own change, unless they
 * are the project's only Project Admin and its policy allows it. Approvals, rejections, requests for changes and policy changes go
 * into the activity log.
 */
import { z } from "zod";
import { renderWithAdapter } from "../../engine/frameworks/index.js";
import { isAppUri } from "../../engine/desktop/target.js";
import { printSpec } from "../../engine/dsl/index.js";
import type { TestSpec } from "../../engine/spec/schema.js";
import { accessControlOf, actorOf } from "../auth/access.js";
import { currentActor, type Actor } from "../auth/actor.js";
import { visibleProjectsOf } from "../auth/project-scope.js";
import { blocksFor } from "../block-store.js";
import { HttpError } from "../http-error.js";
import { ReviewStore, starterKey, type ReviewPolicy, type TestVersion } from "../review-store.js";
import { dataSetsFor } from "./environments.js";
import { objectsFor } from "./locators.js";
import { parsePlain } from "./project-settings.js";
import type { RouteCtx } from "./types.js";

export const NOT_A_REVIEWER = "Only a Project Admin of this project who may approve tests can do this.";
export const OWN_CHANGE = "You made this change, so another Project Admin of this project approves it.";
export const NOT_OPEN = "This version is no longer open for review.";
export const CHANGED_WHILE_READING = "This draft changed while you were reading it. Read it again, then decide.";
export const NOT_LATEST = "A newer version of this test exists. Review that one instead.";

const Params = z.object({ id: z.string().min(1).max(64) });
const VersionParams = Params.extend({ version: z.coerce.number().int().min(1).max(1_000_000) });
const PolicyBody = z.object({ aiGenerated: z.boolean(), edits: z.boolean(), healing: z.boolean(), soleAdminSelfApprove: z.boolean() }).partial().strict();
const NoteBody = z.object({ note: z.string().max(2000, "A note is at most 2,000 characters.").optional() }).strict();
const ApproveBody = NoteBody.extend({ seen: z.string().min(1, "Say which state of the draft you read (seen).").max(40) }).strict();
const RejectBody = z.object({ reason: z.string().trim().min(1, "Say why it is rejected.").max(2000, "A reason is at most 2,000 characters.") }).strict();
const ChangesBody = z.object({ comment: z.string().trim().min(1, "Say what should change.").max(4000, "A comment is at most 4,000 characters.") }).strict();
const CommentBody = z.object({ body: z.string().trim().min(1, "Write a comment first.").max(4000, "A comment is at most 4,000 characters.") }).strict();

/**
 * The person or key a change is by, compared with who is acting. The AI's work is the change of the person who started the job that made it
 * (its author id, review-store.ts); the platform's own changes, and the AI's in a job nobody started, are nobody's own.
 */
const isOwn = (v: TestVersion, actor: Actor) => {
    if (v.author.kind === "ai") return v.author.id !== null && v.author.id === starterKey(actor);
    return v.author.kind !== "system" && v.author.kind === actor.kind && (v.author.id ?? "") === (actor.id ?? "");
};

/** Comments on one version, decisions included. */
export const MAX_COMMENTS_PER_VERSION = 500;

export function registerReviewRoutes(ctx: RouteCtx): void {
    const { app, p, repo, project } = ctx;
    const control = accessControlOf(app);
    const scope = control.projects;
    const store = new ReviewStore(p.db);
    const who = (req: Parameters<typeof actorOf>[0]): Actor => actorOf(req) ?? currentActor();

    const audit = (actor: Actor, projectId: string, action: string, path: string, detail: string | null) =>
        control.users.addActivity({ actorKind: actor.kind, actorId: actor.id ?? null, actorName: actor.name, action, projectId, path, status: 200, detail: detail?.slice(0, 500) ?? null });

    /** Others on the project who could approve: flagged Project Admins other than the actor. */
    const otherApprovers = (projectId: string, actor: Actor) => scope.store.members(projectId).filter((m) => m.projectAdmin && m.personId !== actor.id).length;

    /** Why the actor may not approve this version, or undefined when they may. */
    const approveProblem = (v: TestVersion, actor: Actor, policy: ReviewPolicy): string | undefined => {
        if (!scope.canApprove(actor, v.projectId)) return NOT_A_REVIEWER;
        if (isOwn(v, actor) && !(policy.soleAdminSelfApprove && otherApprovers(v.projectId, actor) === 0)) return OWN_CHANGE;
        return undefined;
    };

    const testOr404 = (id: string) => {
        const t = repo.getTest(id);
        if (!t) throw new HttpError(404, "Test not found");
        return t;
    };
    const versionOr404 = (testId: string, version: number) => {
        const v = store.get(testId, version);
        if (!v) throw new HttpError(404, "Version not found");
        return v;
    };
    /** Open for a decision: a draft or in review, and the test's newest version. */
    const open = (v: TestVersion) => {
        if (v.state !== "draft" && v.state !== "in_review") throw new HttpError(409, NOT_OPEN);
        if (store.latest(v.testId)?.id !== v.id) throw new HttpError(409, NOT_LATEST);
    };

    const summaryOf = (v: TestVersion) => ({
        version: v.version,
        state: v.state,
        source: v.source,
        sync: store.sync(v),
        regenNote: v.regenNote,
        author: v.author.name,
        auto: v.auto,
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
        decision: v.decision ? { by: v.decision.byName, at: v.decision.at, note: v.decision.note } : null,
    });

    /** The plain-English text of a version's steps, or why there is none. */
    const textOf = (v: TestVersion): { text: string; note: string | null } => {
        try {
            const r = printSpec(v.spec as TestSpec);
            return { text: r.text, note: r.expressible ? null : r.reasons.join(" ") || "Part of this test has no plain-English form." };
        } catch {
            return { text: "", note: "These steps cannot be shown as text." };
        }
    };

    /** A version's code: a person's code as stored, the script a run made from it, or the steps rendered now (not stored). */
    const codeOf = (v: TestVersion): { code: string | null; note: string | null } => {
        if (v.code !== null) return { code: v.code, note: null };
        if (v.scriptId) {
            const s = p.db.get<{ content: string }>("SELECT content FROM generated_scripts WHERE id = ?", v.scriptId);
            if (s) return { code: s.content, note: null };
        }
        const app = repo.getLatestApplicationPublic(v.projectId);
        const url = app?.url as string | undefined;
        if (!url) return { code: null, note: "The code is made from these steps when they run. This project has no application address yet." };
        try {
            const objects = objectsFor(repo, v.projectId);
            const blocks = blocksFor(p.db, v.projectId);
            const script = renderWithAdapter(v.spec as TestSpec, v.framework as never, { baseUrl: isAppUri(url) ? url : new URL(url).origin, dataSets: dataSetsFor(repo, v.projectId), ...(objects ? { objects } : {}), ...(blocks ? { blocks } : {}) });
            return { code: script.content, note: "Made from these steps now, to read. The run makes it again when this version runs." };
        } catch (e) {
            return { code: null, note: `The code cannot be made from these steps: ${e instanceof Error ? e.message : String(e)}` };
        }
    };

    // ── the scripts list ────────────────────────────────────────────────────
    app.get("/api/projects/:id/scripts", async (req) => {
        const { id } = Params.parse(req.params);
        project(id);
        const byTest = new Map<string, TestVersion[]>();
        for (const r of p.db.all("SELECT test_case_id, version FROM test_versions WHERE project_id = ? AND state <> 'superseded' ORDER BY version DESC", id)) {
            const v = store.get(r.test_case_id as string, Number(r.version));
            if (v) byTest.set(v.testId, [...(byTest.get(v.testId) ?? []), v]);
        }
        const custom = new Set(p.db.all<{ test_case_id: string }>("SELECT test_case_id FROM custom_tests WHERE project_id = ?", id).map((r) => r.test_case_id));
        const scripts = repo.listTests(id).map((t) => {
            const versions = byTest.get(t.id) ?? [];
            const latest = versions[0];
            const approved = versions.find((v) => v.state === "approved");
            return {
                testId: t.id,
                testKey: t.testKey,
                title: t.title,
                framework: t.framework,
                custom: custom.has(t.id),
                validationStatus: t.validationStatus,
                latest: latest ? summaryOf(latest) : null,
                approvedVersion: approved?.version ?? null,
                /** No approved version: runs leave this test out until one is approved. */
                waiting: !approved,
            };
        });
        return { scripts, policy: store.policy(id), canApprove: scope.canApprove(who(req), id) };
    });

    // ── the project's policy ────────────────────────────────────────────────
    app.get("/api/projects/:id/review-policy", async (req) => {
        const { id } = Params.parse(req.params);
        project(id);
        return store.policy(id);
    });
    app.put("/api/projects/:id/review-policy", async (req) => {
        const { id } = Params.parse(req.params);
        project(id);
        const actor = who(req);
        // Whoever could switch review off could then edit approved tests unseen: only someone who approves here may change it.
        if (!scope.canApprove(actor, id)) throw new HttpError(403, "Changing the review policy needs permission to approve tests, as a Project Admin of this project.");
        const body = parsePlain(PolicyBody, req.body);
        const before = store.policy(id);
        const next = store.setPolicy(id, body, actor.name);
        const words: Record<keyof ReviewPolicy, string> = { aiGenerated: "tests the AI writes", edits: "changes by people", healing: "repairs after a failed run", soleAdminSelfApprove: "the only Project Admin approving their own change" };
        const changed = (Object.keys(words) as Array<keyof ReviewPolicy>).filter((k) => before[k] !== next[k]).map((k) => `${words[k]}: ${next[k] ? "on" : "off"}`);
        if (changed.length) audit(actor, id, "changed the review policy", `/api/projects/${id}/review-policy`, changed.join("; "));
        return next;
    });

    // ── one test's versions ─────────────────────────────────────────────────
    app.get("/api/tests/:id/review", async (req) => {
        const { id } = Params.parse(req.params);
        const t = testOr404(id);
        store.track(t.id); // anything written outside the usual paths is a version before it is shown
        const versions = store.list(t.id);
        return { testId: t.id, testKey: t.testKey, title: t.title, projectId: t.projectId, approvedVersion: versions.find((v) => v.state === "approved")?.version ?? null, versions: versions.map(summaryOf) };
    });

    app.get("/api/tests/:id/review/:version", async (req) => {
        const { id, version } = VersionParams.parse(req.params);
        const t = testOr404(id);
        const v = versionOr404(t.id, version);
        const approved = store.approved(t.id);
        const actor = who(req);
        const policy = store.policy(t.projectId);
        const here = scope.permissionsIn(actor, t.projectId);
        const isOpen = (v.state === "draft" || v.state === "in_review") && store.latest(t.id)?.id === v.id;
        const problem = approveProblem(v, actor, policy);
        const reviewer = scope.canApprove(actor, t.projectId);
        const canWrite = Boolean(here?.has("ai_studio.tests.write"));
        return {
            testId: t.id,
            testKey: t.testKey,
            title: t.title,
            projectId: t.projectId,
            ...summaryOf(v),
            submittedAt: v.submittedAt,
            ...textOf(v),
            ...(() => {
                const c = codeOf(v);
                return { code: c.code, codeNote: c.note };
            })(),
            approved: approved && approved.id !== v.id ? { version: approved.version, text: textOf(approved).text, code: codeOf(approved).code } : null,
            comments: store.comments(v.id),
            actions: {
                submit: isOpen && v.state === "draft" && canWrite,
                approve: isOpen && !problem,
                reject: isOpen && reviewer,
                requestChanges: isOpen && reviewer,
                comment: canWrite || reviewer,
                /** Why Approve is not offered on an open version, in words the page can show. */
                approveBlocked: isOpen && problem ? problem : null,
            },
        };
    });

    const decide = (name: "submit" | "approve" | "reject" | "request-changes") =>
        app.post(`/api/tests/:id/review/:version/${name}`, async (req) => {
            const { id, version } = VersionParams.parse(req.params);
            const t = testOr404(id);
            const v = versionOr404(t.id, version);
            const actor = who(req);
            const path = `/api/tests/${t.id}/review/${v.version}/${name}`;
            open(v);
            if (name === "submit") {
                const { note } = parsePlain(NoteBody, req.body);
                if (v.state !== "draft") throw new HttpError(409, "This version is already in review.");
                store.submit(v, actor, note?.trim() || null);
            } else if (name === "approve") {
                const { seen, note } = parsePlain(ApproveBody, req.body);
                const problem = approveProblem(v, actor, store.policy(t.projectId));
                if (problem) throw new HttpError(403, problem);
                if (seen !== v.updatedAt) throw new HttpError(409, CHANGED_WHILE_READING);
                store.approve(v, actor, note?.trim() || null);
                audit(actor, t.projectId, "approved a test version", path, `${t.testKey} version ${v.version}${note?.trim() ? `. ${note.trim()}` : ""}`);
            } else {
                if (!scope.canApprove(actor, t.projectId)) throw new HttpError(403, NOT_A_REVIEWER);
                if (name === "reject") {
                    const { reason } = parsePlain(RejectBody, req.body);
                    store.reject(v, actor, reason);
                    audit(actor, t.projectId, "rejected a test version", path, `${t.testKey} version ${v.version}. ${reason}`);
                } else {
                    const { comment } = parsePlain(ChangesBody, req.body);
                    store.requestChanges(v, actor, comment);
                    audit(actor, t.projectId, "asked for changes to a test version", path, `${t.testKey} version ${v.version}. ${comment}`);
                }
            }
            return summaryOf(versionOr404(t.id, v.version));
        });
    decide("submit");
    decide("approve");
    decide("reject");
    decide("request-changes");

    app.post("/api/tests/:id/review/:version/comments", async (req) => {
        const { id, version } = VersionParams.parse(req.params);
        const t = testOr404(id);
        const v = versionOr404(t.id, version);
        const actor = who(req);
        const here = scope.permissionsIn(actor, t.projectId);
        if (!here?.has("ai_studio.tests.write") && !scope.canApprove(actor, t.projectId)) throw new HttpError(403, "Commenting needs permission to edit tests, or to approve them here.");
        const { body } = parsePlain(CommentBody, req.body);
        if (store.commentCount(v.id) >= MAX_COMMENTS_PER_VERSION) throw new HttpError(409, `A version can have at most ${MAX_COMMENTS_PER_VERSION} comments. Continue on a new version.`);
        store.addComment(v.id, "comment", body, actor);
        return { comments: store.comments(v.id) };
    });

    // ── the review queue across projects ────────────────────────────────────
    app.get("/api/reviews", async (req) => {
        const actor = who(req);
        const visible = visibleProjectsOf(req, actor);
        const projects = repo.listProjects().filter((r) => !r.archived_at && (!visible || visible.has(r.id as string)) && scope.canApprove(actor, r.id as string));
        const items = [];
        for (const pr of projects) {
            const projectId = pr.id as string;
            const policy = store.policy(projectId);
            const rows = p.db.all(
                "SELECT v.test_case_id, v.version, t.test_key, t.title FROM test_versions v JOIN test_cases t ON t.id = v.test_case_id WHERE v.project_id = ? AND v.state IN ('draft', 'in_review') ORDER BY v.updated_at DESC LIMIT 200",
                projectId,
            );
            for (const r of rows) {
                const v = store.get(r.test_case_id as string, Number(r.version));
                if (!v) continue;
                items.push({ projectId, projectName: pr.name as string, testId: v.testId, testKey: r.test_key as string, title: r.title as string, ...summaryOf(v), yours: isOwn(v, actor), canApprove: !approveProblem(v, actor, policy) });
            }
        }
        items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
        return { reviewer: projects.length > 0, items: items.slice(0, 200) };
    });

    // ── what a run ran ──────────────────────────────────────────────────────
    app.get("/api/jobs/:id/test-versions", async (req) => {
        const { id } = Params.parse(req.params);
        const job = repo.getJob(id);
        if (!job) throw new HttpError(404, "Job not found");
        return { tests: store.runVersions(id) };
    });
}
