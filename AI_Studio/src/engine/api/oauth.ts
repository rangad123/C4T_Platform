/**
 * OAuth2 client-credentials grant (RFC 6749 §4.4) for API tests against services that issue
 * short-lived tokens instead of accepting a static key.
 *
 * The token is fetched once per validation run and reaches generated scripts only through the
 * API_TOKEN environment variable — it is never written into a script, spec or event.
 */
import type { EngineContext } from "../context.js";

export interface OAuth2ClientCredentials {
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    scope?: string;
    audience?: string;
    /** How the client authenticates to the token endpoint. RFC 6749 recommends HTTP Basic. */
    authMethod?: "basic" | "body";
}

export class OAuth2Error extends Error {
    constructor(message: string) {
        super(message);
        this.name = "OAuth2Error";
    }
}

export async function fetchClientCredentialsToken(cfg: OAuth2ClientCredentials, timeoutMs = 15_000): Promise<string> {
    const body = new URLSearchParams({ grant_type: "client_credentials" });
    if (cfg.scope) body.set("scope", cfg.scope);
    if (cfg.audience) body.set("audience", cfg.audience);
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    if ((cfg.authMethod ?? "basic") === "basic") {
        // RFC 6749 §2.3.1: id and secret are form-urlencoded before being base64-encoded.
        const basic = `${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`;
        headers.authorization = `Basic ${Buffer.from(basic).toString("base64")}`;
    } else {
        body.set("client_id", cfg.clientId);
        body.set("client_secret", cfg.clientSecret);
    }

    let res: Response;
    try {
        // Redirects are not followed: a token endpoint that redirects is misconfigured, and following
        // would send the client credentials to wherever it points.
        res = await fetch(cfg.tokenUrl, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
        throw new OAuth2Error(`Token request to ${cfg.tokenUrl} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
        json = JSON.parse(text);
    } catch {
        /* reported below */
    }
    if (!res.ok) {
        const err = typeof json.error === "string" ? `${json.error}${typeof json.error_description === "string" ? `: ${json.error_description}` : ""}` : `HTTP ${res.status}`;
        throw new OAuth2Error(`Token endpoint rejected the client credentials (${err})`);
    }
    if (typeof json.access_token !== "string" || !json.access_token) throw new OAuth2Error("Token endpoint response has no access_token");
    if (typeof json.token_type === "string" && json.token_type.toLowerCase() !== "bearer") {
        throw new OAuth2Error(`Unsupported token_type "${json.token_type}" (only Bearer tokens are supported)`);
    }
    return json.access_token;
}

/**
 * The bearer token API tests should use: a static apiToken, or one obtained via OAuth2. A failed
 * token request is reported and the run continues without a token (authenticated tests then fail
 * visibly instead of the whole job aborting).
 */
export async function resolveApiToken(
    ctx: EngineContext,
    credentials: { apiToken?: string; oauth2?: OAuth2ClientCredentials } | undefined,
): Promise<string | undefined> {
    if (!credentials?.oauth2) return credentials?.apiToken;
    try {
        const token = await fetchClientCredentialsToken(credentials.oauth2);
        ctx.emit({ stage: "validation", kind: "oauth2_token_obtained", message: `OAuth2 access token obtained from ${credentials.oauth2.tokenUrl}` });
        return token;
    } catch (e) {
        ctx.emit({ stage: "validation", kind: "oauth2_token_failed", level: "error", message: e instanceof Error ? e.message : String(e) });
        return credentials.apiToken;
    }
}
