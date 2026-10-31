/**
 * The passive assessment's own shapes. Every request it makes goes through a `Guard` (the scope guard of src/security/scope.ts, adapted
 * in ./guard.ts), so the discovery and the checks never touch the network themselves and can be tested against a stand-in.
 */
import type { SecurityCall } from "../../engine/security/checks.js";

/** An answer received through the guard. Header names are lower case; `text` is at most the bytes asked for. */
export interface GuardedAnswer {
    url: string;
    status: number;
    headers: Record<string, string>;
    setCookies: string[];
    body: Buffer;
    text: string;
    /** True when redirects were followed (each hop checked) and `url` is where they ended. */
    redirected?: boolean;
    /** A redirect that was not followed because its target is refused; the answer is then the 3xx itself. */
    blockedRedirect?: { url: string; reason: string } | null;
}

export interface GuardFetchInit {
    method?: "GET" | "HEAD" | "OPTIONS";
    headers?: Record<string, string>;
    signal?: AbortSignal;
    /** Most body bytes read (the rest is not downloaded). */
    maxBytes?: number;
    /**
     * "follow" (default): each redirect hop is checked against the scope before it is requested. "manual": a 3xx answer is returned
     * as it is. Never hand a 3xx to the browser: Chromium follows it itself without asking the route handler (seen in the tests).
     */
    redirect?: "manual" | "follow";
    /** Signed-in assessments (round 20): false = do not add the saved sign-in's cookies (the browser passes its own). Default true. */
    savedCookies?: boolean;
}

/** Thrown when the scope guard refuses an address (out of scope, excluded, a private or metadata address). */
export class RefusedError extends Error {
    constructor(
        readonly url: string,
        readonly reason: string,
        /** The scope guard's refusal code ("out-of-scope", "excluded-path", "blocked-address" …). */
        readonly code = "refused",
    ) {
        super(reason);
        this.name = "RefusedError";
    }
}

/** Thrown when the assessment used up its request budget (SECURITY_MAX_REQUESTS). */
export class RequestCapError extends Error {
    constructor(message = "The most requests one assessment may send was reached.") {
        super(message);
        this.name = "RequestCapError";
    }
}

export interface Guard {
    /** Undefined when the address may be requested; otherwise the plain reason it may not. Resolves DNS where the guard does. */
    refusal(url: string): Promise<string | undefined>;
    /** One request through the guard (rate-limited, counted, address pinned). Throws RefusedError / RequestCapError / network errors. */
    fetch(url: string, init?: GuardFetchInit): Promise<GuardedAnswer>;
    /** The address the guard checked and pinned for a host (for the one TLS handshake), when it can tell. */
    pinnedAddress?(url: string): Promise<string | undefined>;
    /** Count one connection the assessment makes itself (the TLS handshake) against the rate limit and the request budget. */
    take?(): Promise<void>;
    /** Requests sent so far by this assessment. */
    requestsSent(): number;
    /** Checks what must hold before the first request (the company proxy, when one is used); throws the plain reason. */
    ready?(): Promise<void>;
    /** A raw connection to an https address through the company proxy (for the TLS handshake), or undefined to connect directly. */
    tunnel?(url: string, signal: AbortSignal): Promise<import("node:net").Socket | undefined>;
    /** Round 21: the saved sign-in stopped working: from now on plain requests carry none of its cookies (sign-out addresses stay refused). */
    endSignIn?(): void;
}

export interface FormSeen {
    page: string;
    method: string;
    action: string;
    /** Field names and types only, never values. */
    fields: Array<{ name: string; type: string }>;
}

/** What discovery saw. Stored in the assessment's work data (bounded) so a restart does not crawl again. */
export interface DiscoveryResult {
    startUrl: string;
    pages: Array<{ url: string; status: number; title: string }>;
    /** Main-document answers (HTML pages), as received, text capped. */
    documents: SecurityCall[];
    /** API answers the pages fetched (headers, short text). */
    apiAnswers: SecurityCall[];
    /** "GET /api/items" style, ids folded. */
    apiCalls: string[];
    forms: FormSeen[];
    /** "Server: Apache/2.4.1" style lines and generator meta tags. */
    technologies: string[];
    /** Addresses not followed or blocked because they are outside the scope (with the reason), capped. */
    outOfScope: Array<{ url: string; reason: string }>;
    /** Links under excluded paths that were not requested. */
    excluded: string[];
    /** Requests the pages tried to send that could change data (POST, PUT …): blocked, never sent. */
    blockedWrites: Array<{ method: string; url: string }>;
    /** Pages found but not visited because of the page or depth cap. */
    notVisited: number;
    signInSeen: boolean;
    apiSpec: { url: string; status: number; operations: number } | { url: string; skipped: string } | null;
    /** Pages that could not be loaded, with the plain reason. */
    failures: Array<{ url: string; reason: string }>;
    // ── round 20 (SIGN), all optional so stored work data of earlier assessments still reads ──
    /** Sign-out links and addresses that were never requested (path only). */
    signOutSkipped?: string[];
    /** Signed in with a saved sign-in: the signed-in page opened first, and whether it still showed a signed-in page. */
    signedInCheck?: { url: string; ok: boolean; reason: string } | null;
    /** Round 21: the pages seen when the saved sign-in was last found still working (re-checked every few pages and before the checks). */
    signInConfirmedAfter?: number;
    /**
     * Round 21: the saved sign-in stopped working while the assessment ran (found by a re-check). From then on nothing was sent signed in:
     * `afterPages` pages had been seen, `url` is the signed-in page's path (null when it was the cookies that were gone), `when` says
     * whether it was found while looking at the pages or right before the read-only checks.
     */
    signInEnded?: { when: "discovery" | "before-checks"; afterPages: number; lastOkAfterPages: number; url: string | null; reason: string } | null;
    /** The uploaded API document's operations: what was requested (GET without required parameters) and what was not, with why. */
    apiDocument?: {
        fileName: string;
        operations: number;
        requested: Array<{ path: string; status: number }>;
        notRequested: { notGet: number; needValues: number; signOut: number; refused: Array<{ path: string; reason: string }>; overLimit: number };
    };
}
