import { z } from "zod";
import { TrackerError, trackerRequest } from "../issues/http.js";
import { MAX_FETCHED, parseIssues, sentryTime, type Candidate, type SearchWindow } from "./match.js";

const slug = /^[A-Za-z0-9_-]+$/;

/** What a user enters to connect Sentry. The token only needs to read issues (see docs/features/notion-and-sentry.md). */
export const SentrySettings = z.object({
    baseUrl: z
        .string()
        .url()
        .max(300)
        .default("https://sentry.io")
        .transform((u) => u.replace(/\/+$/, "")),
    organization: z.string().trim().min(1).max(100).regex(slug, "The organisation is the short name in your Sentry address, with letters, numbers and dashes"),
    project: z.string().trim().min(1).max(100).regex(slug, "The project is the short name in your Sentry address, with letters, numbers and dashes"),
    token: z.string().min(1).max(500),
});
export type SentrySettings = z.infer<typeof SentrySettings>;

/** The non-secret part, stored as JSON. */
export interface SentryConfig {
    kind: "sentry";
    baseUrl: string;
    organization: string;
    project: string;
}

const TIMEOUT_MS = 8000;

/** Sentry's own wording for what went wrong; the generic tracker messages talk about repositories and project keys. */
function sentryError(e: unknown): TrackerError {
    if (!(e instanceof TrackerError)) throw e;
    switch (e.code) {
        case "unauthorized":
            return new TrackerError("unauthorized", "Sentry didn’t accept the token. Connect Sentry again with a new token.", e.upstreamStatus);
        case "forbidden":
            return new TrackerError("forbidden", "The Sentry token isn’t allowed to read this project. Create a token that can read issues and projects, then connect again.", e.upstreamStatus);
        case "not_found":
            return new TrackerError("not_found", "Sentry can’t find that organisation or project. Check both names in your Sentry address.", e.upstreamStatus);
        case "rate_limited":
            return new TrackerError("rate_limited", "Sentry is limiting how fast we can ask. Try again in a minute.", e.upstreamStatus);
        default:
            return e;
    }
}

/** Read-only client for one Sentry project. Never sends anything but GET requests. */
export class SentryClient {
    constructor(
        private readonly cfg: SentryConfig,
        private readonly token: string,
        private readonly opts: { timeoutMs?: number } = {},
    ) {}

    private get projectPath(): string {
        return `/api/0/projects/${encodeURIComponent(this.cfg.organization)}/${encodeURIComponent(this.cfg.project)}`;
    }

    private async get(path: string, query: Record<string, string> = {}): Promise<unknown> {
        const qs = new URLSearchParams(query).toString();
        // One more try after a network error or a 5xx answer, none after a timeout (the page would wait twice as long) or any other answer.
        for (let attempt = 1; ; attempt++) {
            try {
                return (
                    await trackerRequest({
                        method: "GET",
                        url: `${this.cfg.baseUrl}${path}${qs ? `?${qs}` : ""}`,
                        authorization: `Bearer ${this.token}`,
                        service: "Sentry",
                        timeoutMs: this.opts.timeoutMs ?? TIMEOUT_MS,
                    })
                ).json;
            } catch (e) {
                const transient = e instanceof TrackerError && e.code === "unreachable" && !/in time/.test(e.message);
                if (transient && attempt < 2) continue;
                throw sentryError(e);
            }
        }
    }

    /** A real call that proves the address, the names and the token. */
    async verify(): Promise<string> {
        const json = (await this.get(`${this.projectPath}/`)) as { name?: unknown; slug?: unknown } | undefined;
        const name = typeof json?.name === "string" ? json.name.slice(0, 100) : this.cfg.project;
        return `Connected to the Sentry project ${name}.`;
    }

    /** Issues active in the window, newest activity first, at most 25. Only the fields `parseIssues` keeps survive. */
    async issuesIn(w: SearchWindow): Promise<Candidate[]> {
        const json = await this.get(`${this.projectPath}/issues/`, { start: sentryTime(w.start), end: sentryTime(w.end), limit: String(MAX_FETCHED), sort: "date", query: "is:unresolved" });
        const list = parseIssues(json);
        if (!list) throw new TrackerError("rejected", "Sentry answered with something we did not expect. Check the address.");
        return list.slice(0, MAX_FETCHED);
    }
}
