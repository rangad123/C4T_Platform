import { guardedFetch } from "../guarded-fetch.js";
import { assertAllowedTarget } from "../net-guard.js";

/** Why an outbound call to an issue tracker (or GitHub) failed, in terms a user can act on. */
export type TrackerErrorCode = "unauthorized" | "forbidden" | "not_found" | "rate_limited" | "rejected" | "unreachable" | "blocked";

export class TrackerError extends Error {
    constructor(
        readonly code: TrackerErrorCode,
        message: string,
        readonly upstreamStatus?: number,
    ) {
        super(message);
    }
}

export interface TrackerRequest {
    method: "GET" | "POST" | "PATCH";
    url: string;
    /** Sent as the Authorization header; never logged and never part of an error message. */
    authorization: string;
    headers?: Record<string, string>;
    body?: unknown;
    /** What the user called this service ("GitHub", "Jira"): used in error messages. */
    service: string;
    timeoutMs?: number;
}

export interface TrackerResponse {
    status: number;
    json: unknown;
    headers: Headers;
}

const TIMEOUT_MS = 10_000;

/**
 * One outbound JSON call with an SSRF check, a short timeout and plain-language errors.
 * Any non-2xx answer is thrown as a TrackerError; the token never appears in a message or a log line.
 */
export async function trackerRequest(req: TrackerRequest): Promise<TrackerResponse> {
    try {
        await assertAllowedTarget(req.url);
    } catch (e) {
        throw new TrackerError("blocked", e instanceof Error ? e.message : `${req.service} address is not allowed`);
    }
    let res: Response;
    try {
        // The same fetch as an AI configuration's: no redirect is followed, and with BLOCK_PRIVATE_TARGETS on the address is checked on
        // the very connection (so a name that turns private after the check above is refused too).
        res = await guardedFetch(req.url, {
            method: req.method,
            headers: {
                accept: "application/json",
                "user-agent": "ai-testing-platform",
                authorization: req.authorization,
                ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
                ...req.headers,
            },
            body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
            signal: AbortSignal.timeout(req.timeoutMs ?? TIMEOUT_MS),
            // A redirect would resend the Authorization header to wherever it points: guardedFetch refuses it.
            redirect: "manual",
        });
    } catch (e) {
        const cause = (e as { cause?: unknown }).cause;
        if (cause instanceof Error && /redirect/i.test(cause.message)) throw new TrackerError("rejected", `${req.service} redirected the request; check the address you entered.`, (cause as { status?: number }).status);
        if (cause instanceof Error && cause.name === "BlockedAddressError") throw new TrackerError("blocked", cause.message);
        const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
        throw new TrackerError("unreachable", timedOut ? `${req.service} did not answer in time. Try again in a moment.` : `We couldn’t reach ${req.service}. Check the address and your network.`);
    }
    const text = await res.text().catch(() => "");
    let json: unknown = undefined;
    try {
        json = text ? JSON.parse(text) : undefined;
    } catch {
        /* non-JSON error pages are handled by status below */
    }
    if (res.status >= 200 && res.status < 300) return { status: res.status, json, headers: res.headers };
    throw describeFailure(req.service, res.status, res.headers, json);
}

/** Best short message the tracker gave us ("Bad credentials", Jira's errorMessages...), without echoing arbitrary pages. */
function upstreamMessage(json: unknown): string {
    if (!json || typeof json !== "object") return "";
    const o = json as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof o.message === "string") parts.push(o.message);
    if (Array.isArray(o.errorMessages)) parts.push(...o.errorMessages.filter((m): m is string => typeof m === "string"));
    if (o.errors && typeof o.errors === "object") parts.push(...Object.entries(o.errors as Record<string, unknown>).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`));
    return parts.join("; ").slice(0, 300);
}

function describeFailure(service: string, status: number, headers: Headers, json: unknown): TrackerError {
    const detail = upstreamMessage(json);
    const rateLimited = status === 429 || ((status === 403 || status === 503) && (headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after")));
    if (rateLimited) return new TrackerError("rate_limited", `${service} is limiting how fast we can send requests. Wait a minute and try again.`, status);
    if (status === 401) return new TrackerError("unauthorized", `${service} did not accept the token. Check that it is correct and has not expired.`, status);
    if (status === 403) return new TrackerError("forbidden", `${service} accepted the token but it is not allowed to do this. Check what the token may do in this ${service === "GitHub" ? "repository" : "project"} (creating issues or comments needs write access).`, status);
    if (status === 404) return new TrackerError("not_found", `${service} could not find it. Check the ${service === "GitHub" ? "owner and repository name" : "address and project key"} — private ones also need a token that can see them.`, status);
    if (status >= 300 && status < 400) return new TrackerError("rejected", `${service} redirected the request; check the address you entered.`, status);
    if (status >= 500) return new TrackerError("unreachable", `${service} is having problems right now (error ${status}). Try again later.`, status);
    return new TrackerError("rejected", `${service} rejected the request${detail ? `: ${detail}` : ` (error ${status})`}.`, status);
}
