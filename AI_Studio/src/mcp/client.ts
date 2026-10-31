import type { McpConfig } from "./config.js";

/** A refusal or failure from the platform, already worded for a person (and for the AI tool reading it). */
export class PlatformError extends Error {
    constructor(
        message: string,
        readonly status: number | null,
        readonly details?: unknown,
    ) {
        super(message);
    }
}

const REQUEST_TIMEOUT_MS = 30_000;

/** The first few problems of a rejected request, as one sentence. */
function issueText(details: unknown): string {
    if (!Array.isArray(details)) return "";
    const parts = details.slice(0, 3).map((d: any) => {
        const where = Array.isArray(d?.path) && d.path.length ? `${d.path.join(".")}: ` : "";
        return `${where}${String(d?.message ?? "invalid")}`;
    });
    return parts.length ? ` (${parts.join("; ")})` : "";
}

/**
 * The platform REST API as the MCP server uses it: the same routes and the same `x-api-key` as the web app, nothing more.
 * Every failure becomes a PlatformError with a plain message; the key never appears in one.
 */
export class PlatformClient {
    constructor(
        private readonly cfg: McpConfig,
        private readonly fetchImpl: typeof fetch = fetch,
    ) {}

    get host(): string {
        return this.cfg.host;
    }

    private async send(method: string, path: string, body?: unknown): Promise<Response> {
        const headers: Record<string, string> = { accept: "application/json" };
        if (body !== undefined) headers["content-type"] = "application/json";
        if (this.cfg.apiKey) headers["x-api-key"] = this.cfg.apiKey;
        try {
            return await this.fetchImpl(`${this.cfg.baseUrl}/api${path}`, {
                method,
                headers,
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
        } catch (e) {
            if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
                throw new PlatformError(`The platform at ${this.cfg.host} did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds.`, null);
            }
            throw new PlatformError(`Could not reach the platform at ${this.cfg.host}. Is it running?`, null);
        }
    }

    private async fail(res: Response): Promise<PlatformError> {
        const text = await res.text().catch(() => "");
        let message = "";
        let details: unknown;
        try {
            const o = JSON.parse(text) as { error?: unknown; message?: unknown; details?: unknown };
            message = typeof o.error === "string" ? o.error : typeof o.message === "string" ? o.message : "";
            details = o.details;
        } catch {
            /* not JSON: use the generic wording below */
        }
        if (res.status === 401) {
            return new PlatformError(
                this.cfg.apiKey
                    ? "The platform refused the API key. Set AITP_API_KEY in this MCP server's configuration to the platform's current key."
                    : "The platform needs an API key. Set AITP_API_KEY in this MCP server's configuration.",
                401,
            );
        }
        if (res.status >= 500) return new PlatformError(`The platform reported an internal error (HTTP ${res.status}). Try again, and check the platform's log if it keeps happening.`, res.status);
        const base = message || `The platform answered HTTP ${res.status}.`;
        return new PlatformError(`${base}${message === "Invalid request" ? issueText(details) : ""}`.slice(0, 600), res.status, details);
    }

    async json<T = any>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
        const res = await this.send(method, path, body);
        if (!res.ok) throw await this.fail(res);
        const text = await res.text();
        if (!text) return undefined as T;
        try {
            return JSON.parse(text) as T;
        } catch {
            throw new PlatformError("The platform answered with something that is not JSON. Is AITP_URL pointing at the platform?", res.status);
        }
    }

    async text(path: string): Promise<string> {
        const res = await this.send("GET", path);
        if (!res.ok) throw await this.fail(res);
        return res.text();
    }
}
