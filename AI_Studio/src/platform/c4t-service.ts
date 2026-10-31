/**
 * Crowd4Test's service endpoints, as this server asks them (ACCESS_MODEL.md, C4T change 5; C4T_Platform/api/src/modules/ai-studio):
 *
 *   GET /v1/ai-studio/organisations?limit=        → { data: [{ id, name, status }] }
 *   GET /v1/ai-studio/organisations/:id/projects  → { data: [{ id, reference, title, status }] }   404 for an unknown organisation
 *   GET /v1/ai-studio/people?q=                   → { data: [{ id, name, email, kind, organisationId }] }   at most 20
 *
 * They are read-only and cross every organisation, so they take a shared secret (C4T_SERVICE_TOKEN here, AI_STUDIO_SERVICE_TOKEN
 * there) and never a person's session; who may see which answer is decided here, by the callers. Without the token (or without
 * C4T_API_ORIGIN) the service is off and every caller falls back to what this server already knows.
 *
 * Every question has a 5-second limit. Organisations and an organisation's projects are kept for 5 minutes, people searches for 30
 * seconds, and a failed question for 15 seconds, so a Crowd4Test outage costs one wait, not one per request. Each question carries
 * the visitor's address (X-C4T-Client-IP), as the sign-in check does, so the API's per-visitor budget is not this server's.
 */
import type { FastifyRequest } from "fastify";
import type { Platform } from "./bootstrap.js";
import { HttpError } from "./http-error.js";
import type { ProjectAccessStore } from "./project-access-store.js";

export const C4T_SERVICE_UNREACHABLE = "Crowd4Test could not be reached. Try again in a minute.";
export const C4T_SERVICE_OFF = "This needs the connection to Crowd4Test, which is not set up on this server.";
export const C4T_SERVICE_REFUSED = "Crowd4Test refused this server's service token. Check C4T_SERVICE_TOKEN.";

const TIMEOUT_MS = 5_000;
export const ORGANISATIONS_CACHE_MS = 5 * 60_000;
export const PEOPLE_CACHE_MS = 30_000;
const FAILURE_CACHE_MS = 15_000;
const CACHE_MAX = 500;
/** The service's own ceiling for one organisations answer. */
const ORGANISATIONS_LIMIT = 500;
/** People served in a search, remembered so that adding one of them can be checked again (10 minutes, bounded). */
const SEEN_MS = 10 * 60_000;
const SEEN_MAX = 2_000;
/** Same length rule as the C4T side (middleware/serviceToken.ts): a shorter token is treated as unset there. */
const MIN_TOKEN_LENGTH = 32;

export interface C4tOrganisation {
    id: string;
    name: string;
    /** PENDING | ACTIVE | SUSPENDED | ARCHIVED */
    status: string;
}
export interface C4tProjectRef {
    id: string;
    reference: string;
    title: string;
    status: string;
}
export type C4tPersonKind = "CUSTOMER" | "TESTER" | "SUB_ADMIN" | "ADMIN";
export interface C4tPerson {
    id: string;
    name: string;
    email: string;
    kind: C4tPersonKind;
    organisationId: string | null;
}

export class C4tServiceUnreachable extends HttpError {
    constructor() {
        super(503, C4T_SERVICE_UNREACHABLE);
    }
}

/** The visitor's address, as the sign-in check sends it (auth/crowd4test.ts). */
export function clientIpOf(req: FastifyRequest | undefined): string | undefined {
    if (!req) return undefined;
    const ip = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]!.trim() || req.ip;
    return ip ? ip.slice(0, 45) : undefined;
}

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);
const KINDS = new Set<string>(["CUSTOMER", "TESTER", "SUB_ADMIN", "ADMIN"]);
const rows = (body: unknown): unknown[] => {
    const data = (body as { data?: unknown } | null)?.data;
    return Array.isArray(data) ? data : [];
};

export interface C4tServiceOptions {
    apiOrigin: string;
    token: string;
    fetch?: typeof fetch;
    now?: () => number;
}

export class C4tService {
    private readonly cache = new Map<string, { at: number; ttl: number; value: Promise<unknown> }>();
    private readonly seen = new Map<string, { at: number; person: C4tPerson }>();
    private readonly origin: string;

    constructor(private readonly opts: C4tServiceOptions) {
        this.origin = opts.apiOrigin.trim().replace(/\/+$/, "");
    }

    private now(): number {
        return (this.opts.now ?? Date.now)();
    }

    /** One question, shared by everyone asking the same thing at once, kept for `ttl` (a failure for FAILURE_CACHE_MS). */
    private ask<T>(path: string, ttl: number, read: (res: Response) => Promise<T>, clientIp?: string): Promise<T> {
        const now = this.now();
        const hit = this.cache.get(path);
        if (hit && now - hit.at < hit.ttl) return hit.value as Promise<T>;
        const value = (async () => {
            const headers: Record<string, string> = { authorization: `Bearer ${this.opts.token}`, accept: "application/json" };
            if (clientIp) headers["x-c4t-client-ip"] = clientIp;
            let res: Response;
            try {
                res = await (this.opts.fetch ?? fetch)(`${this.origin}${path}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
            } catch {
                throw new C4tServiceUnreachable();
            }
            if (res.status === 401 || res.status === 403) throw new HttpError(503, C4T_SERVICE_REFUSED);
            return read(res);
        })();
        const entry = { at: now, ttl, value: value as Promise<unknown> };
        if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(path, entry);
        value.catch(() => {
            if (this.cache.get(path) === entry) entry.ttl = FAILURE_CACHE_MS;
        });
        return value;
    }

    /** Every organisation (up to the service's 500), by name. */
    organisations(clientIp?: string): Promise<C4tOrganisation[]> {
        return this.ask(
            `/v1/ai-studio/organisations?limit=${ORGANISATIONS_LIMIT}`,
            ORGANISATIONS_CACHE_MS,
            async (res) => {
                if (!res.ok) throw new C4tServiceUnreachable();
                return rows(await res.json().catch(() => null)).flatMap((r) => {
                    const o = r as Record<string, unknown>;
                    const id = str(o.id, 64);
                    return id ? [{ id, name: str(o.name, 300) ?? id, status: str(o.status, 40) ?? "" }] : [];
                });
            },
            clientIp,
        );
    }

    /**
     * One organisation, or undefined when Crowd4Test has none with that id. When the list is full (more organisations than one
     * answer holds), an id missing from it is asked about through its projects: found, its status is unknown ("").
     */
    async organisation(id: string, clientIp?: string): Promise<C4tOrganisation | undefined> {
        const list = await this.organisations(clientIp);
        const found = list.find((o) => o.id === id);
        if (found || list.length < ORGANISATIONS_LIMIT) return found;
        return (await this.projectsOf(id, clientIp)) ? { id, name: id, status: "" } : undefined;
    }

    /** An organisation's Crowd4Test projects, newest first; undefined for an unknown organisation. */
    projectsOf(organisationId: string, clientIp?: string): Promise<C4tProjectRef[] | undefined> {
        return this.ask(
            `/v1/ai-studio/organisations/${encodeURIComponent(organisationId)}/projects`,
            ORGANISATIONS_CACHE_MS,
            async (res) => {
                if (res.status === 404) return undefined;
                if (!res.ok) throw new C4tServiceUnreachable();
                return rows(await res.json().catch(() => null)).flatMap((r) => {
                    const o = r as Record<string, unknown>;
                    const id = str(o.id, 64);
                    return id ? [{ id, reference: str(o.reference, 100) ?? "", title: str(o.title, 300) ?? "", status: str(o.status, 40) ?? "" }] : [];
                });
            },
            clientIp,
        );
    }

    /** Active people whose name or email matches (Crowd4Test returns at most 20). */
    async searchPeople(q: string, clientIp?: string): Promise<C4tPerson[]> {
        const query = q.trim().slice(0, 120);
        const found = await this.ask(
            `/v1/ai-studio/people${query ? `?q=${encodeURIComponent(query)}` : ""}`,
            PEOPLE_CACHE_MS,
            async (res) => {
                if (!res.ok) throw new C4tServiceUnreachable();
                return rows(await res.json().catch(() => null)).flatMap((r): C4tPerson[] => {
                    const o = r as Record<string, unknown>;
                    const id = str(o.id, 64);
                    const email = str(o.email, 320);
                    const kind = str(o.kind, 20);
                    if (!id || !email || !kind || !KINDS.has(kind)) return [];
                    return [{ id, email, name: str(o.name, 300) ?? email, kind: kind as C4tPersonKind, organisationId: str(o.organisationId, 64) ?? null }];
                });
            },
            clientIp,
        );
        const now = this.now();
        for (const person of found) {
            this.seen.delete(person.id);
            if (this.seen.size >= SEEN_MAX) this.seen.delete(this.seen.keys().next().value!);
            this.seen.set(person.id, { at: now, person });
        }
        return found;
    }

    /**
     * A person served by a recent search, asked about again (by their email) so that adding them uses Crowd4Test's current answer.
     * Undefined when they were not served lately or are no longer active.
     */
    async personAgain(c4tId: string, clientIp?: string): Promise<C4tPerson | undefined> {
        const s = this.seen.get(c4tId);
        if (!s || this.now() - s.at > SEEN_MS) return undefined;
        return (await this.searchPeople(s.person.email, clientIp)).find((p) => p.id === c4tId);
    }

    /**
     * Brings the mirrored name and status of an organisation up to date, in the background (the sign-in check calls this on each
     * arrival; the organisations answer is cached, so it costs a question at most every 5 minutes). Never throws.
     */
    refreshOrganisation(store: ProjectAccessStore, id: string, clientIp?: string): void {
        this.organisations(clientIp)
            .then((list) => {
                const o = list.find((x) => x.id === id);
                if (o) store.recordOrganization(o.id, o.name, o.status);
            })
            .catch(() => {
                /* unreachable: the mirror keeps what it had */
            });
    }
}

const services = new WeakMap<Platform, C4tService | null>();

/**
 * The service of a platform, or undefined when it is off (no C4T_API_ORIGIN or no C4T_SERVICE_TOKEN). A token shorter than
 * Crowd4Test accepts counts as unset, with a warning, as it does there: one misconfigured integration does not stop the server.
 */
export function c4tServiceOf(p: Platform): C4tService | undefined {
    const hit = services.get(p);
    if (hit !== undefined) return hit ?? undefined;
    const origin = p.config.C4T_API_ORIGIN?.trim();
    const token = p.config.C4T_SERVICE_TOKEN?.trim();
    let svc: C4tService | null = null;
    if (origin && token) {
        if (token.length < MIN_TOKEN_LENGTH) console.warn(`[crowd4test] C4T_SERVICE_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters, so the Crowd4Test service connection is off.`);
        else svc = new C4tService({ apiOrigin: origin, token });
    }
    services.set(p, svc);
    return svc ?? undefined;
}
