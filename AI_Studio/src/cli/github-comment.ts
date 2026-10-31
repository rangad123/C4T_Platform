import fs from "node:fs";
import { TrackerError, trackerRequest } from "../platform/issues/http.js";
import { COMMENT_MARKER } from "./render.js";

export interface CommentTarget {
    apiUrl: string;
    owner: string;
    repo: string;
    pr: number;
    token: string;
}

export type CommentOutcome = { posted: "created" | "updated"; url?: string } | { posted: false; warning: string };

/** GitHub rejects comments over 65,536 characters. */
const MAX_BODY = 60_000;

/** Pull request number from a GitHub Actions event file (pull_request, issue_comment... events). */
export function prFromEvent(eventPath: string | undefined): number | undefined {
    if (!eventPath) return undefined;
    try {
        const ev = JSON.parse(fs.readFileSync(eventPath, "utf8")) as { number?: number; pull_request?: { number?: number }; issue?: { number?: number } };
        return ev.pull_request?.number ?? ev.number ?? ev.issue?.number;
    } catch {
        return undefined;
    }
}

/**
 * Create the pull-request comment, or update the one this tool wrote earlier (found by its hidden marker),
 * so reruns never pile up comments. Never throws: a token without permission, a fork pull request with a
 * read-only token, or a network problem is reported as a warning and the pipeline result is unaffected.
 */
export async function postStickyComment(t: CommentTarget, body: string): Promise<CommentOutcome> {
    const text = body.includes(COMMENT_MARKER) ? body : `${COMMENT_MARKER}\n${body}`;
    const clipped = text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}\n\n…(truncated)` : text;
    const base = `${t.apiUrl.replace(/\/+$/, "")}/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}`;
    const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
        trackerRequest({ method, url, authorization: `Bearer ${t.token}`, headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }, body: payload, service: "GitHub" });
    try {
        let existing: { id: number; html_url?: string } | undefined;
        // Comments come oldest first, 100 per page; the sticky one is usually near the start.
        for (let page = 1; page <= 10 && !existing; page++) {
            const { json } = await call("GET", `${base}/issues/${t.pr}/comments?per_page=100&page=${page}`);
            const list = Array.isArray(json) ? (json as Array<{ id: number; body?: string; html_url?: string }>) : [];
            existing = list.find((c) => typeof c.body === "string" && c.body.includes(COMMENT_MARKER));
            if (list.length < 100) break;
        }
        if (existing) {
            const { json } = await call("PATCH", `${base}/issues/comments/${existing.id}`, { body: clipped });
            return { posted: "updated", url: (json as { html_url?: string } | undefined)?.html_url ?? existing.html_url };
        }
        const { json } = await call("POST", `${base}/issues/${t.pr}/comments`, { body: clipped });
        return { posted: "created", url: (json as { html_url?: string } | undefined)?.html_url };
    } catch (e) {
        const why = e instanceof TrackerError ? e.message : e instanceof Error ? e.message : String(e);
        const hint = e instanceof TrackerError && (e.code === "forbidden" || e.code === "unauthorized") ? " In GitHub Actions, give the job “pull-requests: write” permission (pull requests from forks get a read-only token)." : "";
        return { posted: false, warning: `Could not post the pull request comment: ${why}${hint}` };
    }
}
