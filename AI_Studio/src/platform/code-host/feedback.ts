/**
 * Results back on the pull request (Phase 6, G2), only when the project's switch is on (code_repos.feedback): the one sticky comment the
 * CLI already writes (cli/github-comment.ts, the same body), and a check on the head commit. GitHub lets only GitHub Apps create check
 * runs, so with the connection's personal access token a refused check run falls back to a commit status with the same verdict.
 * Never throws: a refusal or a network problem comes back as a warning without the token.
 */
import { postStickyComment, type CommentOutcome } from "../../cli/github-comment.js";
import type { CiReport } from "../../cli/model.js";
import { headline, renderMarkdown } from "../../cli/render.js";
import { trackerRequest, TrackerError } from "../issues/http.js";
import type { CodeHostStore } from "./store.js";

const CHECK_NAME = "AI Studio";
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export type CheckOutcome = { posted: "check_run" | "status" } | { posted: false; warning: string };
export type FeedbackOutcome = { skipped: string } | { comment: CommentOutcome; check: CheckOutcome };

const why = (e: unknown) => (e instanceof TrackerError || e instanceof Error ? e.message : String(e));

export async function postPrFeedback(store: CodeHostStore, projectId: string, f: { pr: number; headSha: string; report: CiReport }): Promise<FeedbackOutcome> {
    if (!Number.isInteger(f.pr) || f.pr < 1 || !SHA.test(f.headSha)) return { skipped: "No pull request number or head commit to report on." };
    const t = store.feedbackTarget(projectId);
    if (!t) return { skipped: "Pull request feedback is off for this project." };
    const body = renderMarkdown(f.report, { comment: true });
    const comment = await postStickyComment({ ...t, pr: f.pr }, body);

    const base = `${t.apiUrl}/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}`;
    const post = (path: string, payload: unknown) =>
        trackerRequest({ method: "POST", url: `${base}${path}`, authorization: `Bearer ${t.token}`, headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }, body: payload, service: "GitHub" });
    const passed = f.report.gate.passed;
    const title = headline(f.report);
    let check: CheckOutcome;
    try {
        await post("/check-runs", { name: CHECK_NAME, head_sha: f.headSha, status: "completed", conclusion: passed ? "success" : "failure", output: { title, summary: body.slice(0, 60_000) } });
        check = { posted: "check_run" };
    } catch (e) {
        if (!(e instanceof TrackerError && (e.code === "forbidden" || e.code === "not_found"))) check = { posted: false, warning: `Could not post the check: ${why(e)}` };
        else
            try {
                await post(`/statuses/${f.headSha}`, { state: passed ? "success" : "failure", context: CHECK_NAME, description: title.slice(0, 140) });
                check = { posted: "status" };
            } catch (e2) {
                check = { posted: false, warning: `Could not post the check: ${why(e2)}` };
            }
    }
    return { comment, check };
}
