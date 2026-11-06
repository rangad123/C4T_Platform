/**
 * The two cookies of a signed-in browser, written and read by hand (no cookie plug-in is installed):
 * - `aitp_session`: the session value. HttpOnly (page scripts cannot read it), SameSite=Lax, Secure when the platform is reached over https.
 * - `aitp_csrf`: the session's CSRF token, readable by the page on purpose. The page echoes it in `x-csrf-token` on every state-changing
 *   request; the server compares it with the token stored for the session (a site that is not this one can neither read nor set it).
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { SESSION_ABSOLUTE_MS } from "../user-store.js";

export const SESSION_COOKIE = "aitp_session";
export const CSRF_COOKIE = "aitp_csrf";

export function readCookie(req: FastifyRequest, name: string): string | undefined {
    const header = req.headers.cookie;
    // No size cap of its own: Node refuses requests whose headers pass its limit (16 KB) before they get here, and a cap below it
    // dropped every cookie of a browser whose crowd4test.com cookies add up to more than 8 KB (they arrive in pieces over HTTP/2),
    // so that person was sent to crowd4test.com to sign in, and back, without end.
    if (!header) return undefined;
    for (const part of header.split(";")) {
        const i = part.indexOf("=");
        if (i < 0) continue;
        if (part.slice(0, i).trim() !== name) continue;
        const v = part.slice(i + 1).trim();
        try {
            return decodeURIComponent(v);
        } catch {
            return undefined;
        }
    }
    return undefined;
}

/**
 * Secure when the browser reached the platform over https: the request itself, PUBLIC_URL, or COOKIE_SECURE=true (behind a proxy that
 * ends TLS and forwards plain http, set PUBLIC_URL to the https address or COOKIE_SECURE=true).
 */
export function secureCookies(req: FastifyRequest): boolean {
    if (process.env.COOKIE_SECURE === "true") return true;
    if (process.env.COOKIE_SECURE === "false") return false;
    if (req.protocol === "https") return true;
    return /^https:/i.test(process.env.PUBLIC_URL ?? "");
}

function cookie(name: string, value: string, opts: { httpOnly: boolean; maxAgeMs: number; secure: boolean }): string {
    return [`${name}=${encodeURIComponent(value)}`, "Path=/", `Max-Age=${Math.floor(opts.maxAgeMs / 1000)}`, "SameSite=Lax", opts.httpOnly ? "HttpOnly" : "", opts.secure ? "Secure" : ""].filter(Boolean).join("; ");
}

export function setSessionCookies(req: FastifyRequest, reply: FastifyReply, token: string, csrf: string): void {
    const secure = secureCookies(req);
    reply.header("set-cookie", [cookie(SESSION_COOKIE, token, { httpOnly: true, maxAgeMs: SESSION_ABSOLUTE_MS, secure }), cookie(CSRF_COOKIE, csrf, { httpOnly: false, maxAgeMs: SESSION_ABSOLUTE_MS, secure })]);
}

export function clearSessionCookies(req: FastifyRequest, reply: FastifyReply): void {
    const secure = secureCookies(req);
    reply.header("set-cookie", [cookie(SESSION_COOKIE, "", { httpOnly: true, maxAgeMs: 0, secure }), cookie(CSRF_COOKIE, "", { httpOnly: false, maxAgeMs: 0, secure })]);
}
