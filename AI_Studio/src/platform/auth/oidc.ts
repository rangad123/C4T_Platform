/**
 * Single sign-on with OpenID Connect, written with Node's own `fetch` and `crypto` (no dependency): discovery, the authorization-code
 * flow with PKCE (S256), and the ID token check: RS256 signature against the provider's published keys (JWKS), issuer, audience,
 * expiry, nonce, a verified email at the allowed domain. Any other signing algorithm (including "none" and HS256) is refused.
 *
 * Not covered: other algorithms (ES256, PS256), encrypted ID tokens, front/back-channel logout, refresh tokens (a session is the
 * platform's own, 12 hours idle / 7 days), and reading groups or roles from the provider (the role is set in People).
 */
import { createHash, createPublicKey, randomBytes, verify as verifySig, type JsonWebKey } from "node:crypto";

export class SsoError extends Error {}

const MAX_BODY = 1_000_000;
const TIMEOUT_MS = 10_000;
const SKEW_S = 120;

/** The provider's addresses must be https; plain http only for this computer (a local test provider). */
export function idpUrlProblem(raw: string): string | undefined {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return "That is not a web address.";
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return "The sign-in provider's address must start with https://.";
    if (u.username || u.password) return "The address must not contain a user name or password.";
    return undefined;
}

async function getJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const problem = idpUrlProblem(url);
    if (problem) throw new SsoError(problem);
    let res: Response;
    try {
        res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
        throw new SsoError("The sign-in provider could not be reached.");
    }
    const text = await res.text();
    if (text.length > MAX_BODY) throw new SsoError("The sign-in provider sent an answer that is too large.");
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch {
        throw new SsoError(`The sign-in provider answered with something that is not JSON (HTTP ${res.status}).`);
    }
    if (!res.ok) {
        const err = (data as { error?: unknown; error_description?: unknown }) ?? {};
        throw new SsoError(`The sign-in provider refused (HTTP ${res.status}${typeof err.error === "string" ? `: ${err.error.slice(0, 80)}` : ""}).`);
    }
    if (!data || typeof data !== "object") throw new SsoError("The sign-in provider's answer has an unexpected shape.");
    return data as Record<string, unknown>;
}

export interface Discovery {
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    jwksUri: string;
    authMethods: string[];
}

const trimSlash = (s: string) => s.replace(/\/+$/, "");
const discoveryCache = new Map<string, { at: number; d: Discovery }>();
const jwksCache = new Map<string, { at: number; keys: JsonWebKey[] }>();

export async function discover(issuer: string, fresh = false): Promise<Discovery> {
    const hit = discoveryCache.get(issuer);
    if (hit && !fresh && Date.now() - hit.at < 10 * 60_000) return hit.d;
    const doc = await getJson(`${trimSlash(issuer)}/.well-known/openid-configuration`);
    const str = (k: string) => (typeof doc[k] === "string" ? (doc[k] as string) : "");
    if (trimSlash(str("issuer")) !== trimSlash(issuer)) throw new SsoError("The provider's discovery document names a different issuer. Check the issuer address.");
    const d: Discovery = {
        issuer: str("issuer"),
        authorizationEndpoint: str("authorization_endpoint"),
        tokenEndpoint: str("token_endpoint"),
        jwksUri: str("jwks_uri"),
        authMethods: Array.isArray(doc.token_endpoint_auth_methods_supported) ? (doc.token_endpoint_auth_methods_supported as unknown[]).filter((x): x is string => typeof x === "string") : [],
    };
    for (const [what, u] of [["sign-in", d.authorizationEndpoint], ["token", d.tokenEndpoint], ["key", d.jwksUri]] as const) {
        if (!u) throw new SsoError(`The provider's discovery document has no ${what} address.`);
        const problem = idpUrlProblem(u);
        if (problem) throw new SsoError(problem);
    }
    discoveryCache.set(issuer, { at: Date.now(), d });
    return d;
}

const b64url = (b: Buffer) => b.toString("base64url");

/** What the start of a sign-in needs: the address to send the browser to, and what to keep until it comes back. */
export async function startSignIn(o: { issuer: string; clientId: string; redirectUri: string }): Promise<{ url: string; state: string; nonce: string; verifier: string }> {
    const d = await discover(o.issuer);
    const state = b64url(randomBytes(24));
    const nonce = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const u = new URL(d.authorizationEndpoint);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: o.clientId, redirect_uri: o.redirectUri, scope: "openid email profile", state, nonce, code_challenge: challenge, code_challenge_method: "S256" })) u.searchParams.set(k, v);
    return { url: u.toString(), state, nonce, verifier };
}

async function signingKey(d: Discovery, kid: string | undefined): Promise<JsonWebKey> {
    const pick = (keys: JsonWebKey[]) => {
        const rsa = keys.filter((k) => k.kty === "RSA" && (k.use === undefined || k.use === "sig") && (k.alg === undefined || k.alg === "RS256"));
        return kid ? rsa.find((k) => (k as { kid?: string }).kid === kid) : rsa.length === 1 ? rsa[0] : undefined;
    };
    const load = async () => {
        const doc = await getJson(d.jwksUri);
        const keys = Array.isArray(doc.keys) ? (doc.keys as JsonWebKey[]).slice(0, 50) : [];
        jwksCache.set(d.jwksUri, { at: Date.now(), keys });
        return keys;
    };
    const hit = jwksCache.get(d.jwksUri);
    let key = hit && Date.now() - hit.at < 10 * 60_000 ? pick(hit.keys) : undefined;
    // A key the cache does not know: the provider may have rotated its keys, so fetch them once more.
    if (!key) key = pick(await load());
    if (!key) throw new SsoError("The ID token was signed with a key the provider does not publish.");
    return key;
}

export interface SsoIdentity {
    /** Issuer and subject together: the person's stable identity at the provider. */
    subject: string;
    email: string;
    name: string;
}

function decodePart(part: string): Record<string, unknown> {
    try {
        const v = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
        if (v && typeof v === "object") return v as Record<string, unknown>;
    } catch {
        /* falls through */
    }
    throw new SsoError("The ID token is not readable.");
}

/** Checks an ID token completely; throws an SsoError in words when anything is wrong. Exported for tests. */
export async function verifyIdToken(idToken: string, o: { issuer: string; clientId: string; nonce: string; allowedDomain: string; now?: number }): Promise<SsoIdentity> {
    const parts = idToken.split(".");
    if (parts.length !== 3 || idToken.length > 20_000) throw new SsoError("The ID token is not readable.");
    const header = decodePart(parts[0]!);
    if (header.alg !== "RS256") throw new SsoError(`The ID token uses the ${String(header.alg).slice(0, 20)} signature, and only RS256 is accepted.`);
    const d = await discover(o.issuer);
    const jwk = await signingKey(d, typeof header.kid === "string" ? header.kid : undefined);
    let ok = false;
    try {
        ok = verifySig("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2]!, "base64url"));
    } catch {
        ok = false;
    }
    if (!ok) throw new SsoError("The ID token's signature is not valid.");
    const c = decodePart(parts[1]!);
    const now = Math.floor((o.now ?? Date.now()) / 1000);
    if (trimSlash(String(c.iss ?? "")) !== trimSlash(o.issuer)) throw new SsoError("The ID token comes from a different issuer.");
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!aud.includes(o.clientId)) throw new SsoError("The ID token was made for a different application.");
    if (aud.length > 1 && c.azp !== undefined && c.azp !== o.clientId) throw new SsoError("The ID token was made for a different application.");
    if (typeof c.exp !== "number" || c.exp + SKEW_S < now) throw new SsoError("The ID token has expired. Try signing in again.");
    if (typeof c.iat === "number" && c.iat - SKEW_S > now) throw new SsoError("The ID token is dated in the future. Check the clocks of the two servers.");
    if (c.nonce !== o.nonce) throw new SsoError("The ID token does not belong to this sign-in. Try again.");
    const email = typeof c.email === "string" ? c.email.trim().toLowerCase() : "";
    if (!email || email.length > 254 || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new SsoError("The sign-in provider did not share an email address. Ask its administrator to include the email scope.");
    if (c.email_verified === false || c.email_verified === "false") throw new SsoError("The sign-in provider says this email address is not verified.");
    const domain = email.split("@")[1]!;
    if (domain !== o.allowedDomain.trim().toLowerCase()) throw new SsoError(`Only addresses at ${o.allowedDomain} can sign in here.`);
    if (typeof c.sub !== "string" || !c.sub) throw new SsoError("The ID token has no subject.");
    const name = typeof c.name === "string" ? c.name.slice(0, 120) : "";
    return { subject: `${trimSlash(o.issuer)}|${c.sub}`.slice(0, 500), email, name };
}

/** Exchanges the code for tokens and checks the ID token. */
export async function finishSignIn(o: { issuer: string; clientId: string; clientSecret: string; code: string; redirectUri: string; verifier: string; nonce: string; allowedDomain: string }): Promise<SsoIdentity> {
    const d = await discover(o.issuer);
    const body = new URLSearchParams({ grant_type: "authorization_code", code: o.code, redirect_uri: o.redirectUri, code_verifier: o.verifier, client_id: o.clientId });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    // client_secret_post unless the provider lists only client_secret_basic.
    const basic = d.authMethods.length > 0 && !d.authMethods.includes("client_secret_post") && d.authMethods.includes("client_secret_basic");
    if (basic) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(o.clientId)}:${encodeURIComponent(o.clientSecret)}`).toString("base64")}`;
    else body.set("client_secret", o.clientSecret);
    const tokens = await getJson(d.tokenEndpoint, { method: "POST", headers, body: body.toString() });
    if (typeof tokens.id_token !== "string") throw new SsoError("The sign-in provider sent no ID token.");
    return verifyIdToken(tokens.id_token, o);
}

/** Forget cached discovery documents and keys (tests, and after the settings change). */
export function clearSsoCaches(): void {
    discoveryCache.clear();
    jwksCache.clear();
}
