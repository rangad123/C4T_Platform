/**
 * Turns an AppModel into the compact, structural SiteKnowledge record.
 *
 * Safety rules, enforced here and tested by grepping the stored JSON for sentinel values:
 *  - no page text, aria snapshots, link text, form labels/placeholders or form values: pages contribute a path, a type,
 *    a short title and a HASH of their headings and form field names;
 *  - every free-text string (title, purpose, journey and scenario names) is scrubbed of known credential values,
 *    e-mail addresses, bearer/JWT tokens and long opaque strings;
 *  - paths lose their query string and fragment, and id/e-mail/token-looking segments become `{id}` / `{email}` / `{token}`;
 *  - the whole record is capped at MAX_MEMORY_BYTES.
 */
import { createHash } from "node:crypto";
import type { AppModel, PageModel } from "../understanding/app-model.js";
import { MAX_MEMORY_BYTES, MEMORY_VERSION, type SiteKnowledge } from "./types.js";

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const AUTH_SCHEME = /\b(?:bearer|basic)\s+[\w.~+/=-]{6,}/gi;
const JWT = /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g;
/** Long strings mixing letters and digits: keys, tokens, ids. */
const OPAQUE = /(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_MIN_LENGTH = 4;

/** Remove known secret values and anything that looks like a credential or an e-mail address, then cap the length. */
export function scrubText(text: string | undefined, secrets: string[] = [], max = 120): string {
    let out = String(text ?? "").replace(/\s+/g, " ").trim();
    // Shapes first (so "name@host" becomes one "[email]" rather than leaving "@host" behind), then the exact known values.
    out = out.replace(JWT, "[token]").replace(AUTH_SCHEME, "[token]").replace(EMAIL, "[email]");
    for (const s of secrets) if (s.length >= SECRET_MIN_LENGTH) out = out.split(s).join("[redacted]");
    out = out.replace(OPAQUE, "[token]");
    return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** A page or endpoint path as memory keeps it: no query/fragment, no ids, e-mail addresses or tokens. */
export function memoryPath(raw: string, secrets: string[] = []): string {
    let p = String(raw ?? "");
    try {
        if (/^https?:\/\//i.test(p)) p = new URL(p).pathname;
    } catch {
        // keep as given
    }
    p = p.split("#")[0]!.split("?")[0]!.split(";")[0]!;
    if (!p.startsWith("/")) p = `/${p}`;
    const segments = p.split("/").map((seg) => {
        if (!seg) return seg;
        let s = seg;
        try {
            s = decodeURIComponent(seg);
        } catch {
            // keep raw segment
        }
        if (s.includes("@")) return "{email}";
        if (UUID.test(s) || /^\d{10,}$/.test(s)) return "{id}";
        if (/^[0-9a-f]{16,}$/i.test(s) || new RegExp(`^${OPAQUE.source}$`).test(s)) return "{token}";
        for (const secret of secrets) if (secret.length >= SECRET_MIN_LENGTH && s.includes(secret)) return "{redacted}";
        return seg;
    });
    p = segments.join("/").replace(/\/{2,}/g, "/");
    if (p.length > 1) p = p.replace(/\/$/, "");
    return p.length > 240 ? p.slice(0, 240) : p;
}

const norm = (s: string) => s.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

/**
 * Hash of what makes a page structurally what it is: its headings (digits blurred so counters, dates and prices do not
 * make the page look changed on every visit) and, per form, its purpose and field names. Only the hash is stored.
 */
export function pageFingerprint(p: Pick<PageModel, "headings" | "forms">): string {
    const headings = p.headings.slice(0, 12).map(norm).filter(Boolean);
    const forms = p.forms.map((f) => `${f.purpose}:${f.fields.map((x) => norm(x.name || x.type || "")).sort().join(",")}`).sort();
    return createHash("sha256").update(JSON.stringify({ h: headings, f: forms })).digest("hex").slice(0, 16);
}

/**
 * Exploration reuse (reuse.ts): a hash of what the understanding step is shown about a page beyond its snapshot: the fingerprint above,
 * the title, every control's role and name and the API calls it makes (numbers blurred, query strings dropped). Stricter than the
 * fingerprint on purpose: a renamed button or a new API call means the page is sent to the AI again. Only the hash is stored.
 */
export function understandingFingerprint(p: Pick<PageModel, "headings" | "forms" | "components" | "apiCalls" | "title">): string {
    const controls = p.components.slice(0, 60).map((c) => `${c.role}:${norm(c.name)}`).sort();
    const apis = [...new Set(p.apiCalls.map((a) => norm(a.split("?")[0]!)))].sort();
    return createHash("sha256").update(JSON.stringify({ fp: pageFingerprint(p), t: norm(p.title), c: controls, a: apis })).digest("hex").slice(0, 16);
}

export interface ScenarioResult {
    title: string;
    /** The journey the planner linked the scenario to (name), if any. */
    journey?: string;
    startPath: string;
    validated: boolean;
}

export interface DistillOptions {
    /** Credential values that must never appear (usernames, passwords, tokens...). */
    secrets?: string[];
    /** What the planned scenarios did. Omit when this analysis planned/validated nothing. */
    scenarios?: ScenarioResult[];
    /** Memory from the previous analysis: carries journey validation forward when this run measured none. */
    previous?: SiteKnowledge | null;
    now?: Date;
}

const MAX_PAGES = 300;
const MAX_APIS = 200;
const MAX_JOURNEYS = 40;

const bytes = (k: SiteKnowledge) => Buffer.byteLength(JSON.stringify(k), "utf8");
const key = (s: string) => s.trim().toLowerCase();

export function distillKnowledge(model: AppModel, opts: DistillOptions = {}): SiteKnowledge {
    const secrets = (opts.secrets ?? []).filter((s) => typeof s === "string" && s.length >= SECRET_MIN_LENGTH);
    const seen = new Set<string>();
    const pages: SiteKnowledge["pages"] = [];
    for (const p of model.pages) {
        const path = memoryPath(p.path, secrets);
        if (seen.has(path)) continue;
        seen.add(path);
        const purpose = p.purpose ? scrubText(p.purpose, secrets, 200) : "";
        pages.push({ path, type: p.type, title: scrubText(p.title, secrets, 80), fp: pageFingerprint(p), ufp: understandingFingerprint(p), ...(purpose ? { purpose } : {}) });
    }
    pages.sort((a, b) => a.path.localeCompare(b.path));

    const apiSeen = new Set<string>();
    const apis: SiteKnowledge["apis"] = [];
    for (const a of model.apis) {
        const path = memoryPath(a.path, secrets).replace(/\/\{(?:id|token|email)\}/g, "/{}");
        const id = `${a.method.toUpperCase()} ${path}`;
        if (apiSeen.has(id)) continue;
        apiSeen.add(id);
        apis.push({ method: a.method.toUpperCase().slice(0, 10), path, ...(a.requiresAuth === undefined ? {} : { requiresAuth: Boolean(a.requiresAuth) }) });
    }
    apis.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));

    const known = opts.scenarios !== undefined && opts.scenarios.length > 0;
    const previousByName = new Map((opts.previous?.journeys ?? []).map((j) => [key(j.name), j]));
    const journeys: SiteKnowledge["journeys"] = model.journeys.slice(0, MAX_JOURNEYS).map((j) => {
        const jpages = j.pages.map((x) => memoryPath(x, secrets));
        const name = scrubText(j.name, secrets, 120);
        let validated: string[];
        if (known) {
            // A scenario belongs to a journey by the planner's link, or else by starting on one of the journey's pages.
            const mine = opts.scenarios!.filter((s) => (s.journey ? key(s.journey) === key(j.name) : jpages.includes(memoryPath(s.startPath, secrets))));
            validated = mine.filter((s) => s.validated).map((s) => scrubText(s.title, secrets, 120));
        } else {
            validated = previousByName.get(key(j.name))?.validated ?? [];
        }
        return { name, priority: j.priority, requiresAuth: j.requiresAuth, pages: jpages.slice(0, 20), validated: [...new Set(validated)].slice(0, 12) };
    });

    const loginPath = model.authentication.loginPath ? memoryPath(model.authentication.loginPath, secrets) : undefined;
    const validatingJourneys = journeys.filter((j) => j.validated.length > 0).length;
    const learned = [
        `${scrubText(model.siteType, secrets, 60) || "unknown"} site`,
        `${pages.length} page${pages.length === 1 ? "" : "s"}`,
        `${journeys.length} journey${journeys.length === 1 ? "" : "s"}${known ? ` (${validatingJourneys} with validated tests)` : ""}`,
        `${apis.length} API endpoint${apis.length === 1 ? "" : "s"}`,
        loginPath ? `sign-in at ${loginPath}` : "no sign-in found",
    ].join(", ");

    const knowledge: SiteKnowledge = {
        version: MEMORY_VERSION,
        origin: model.origin.slice(0, 200),
        analysedAt: (opts.now ?? new Date()).toISOString(),
        siteType: scrubText(model.siteType, secrets, 60),
        purpose: scrubText(model.purpose, secrets, 300),
        pages: pages.slice(0, MAX_PAGES),
        journeys,
        ...(loginPath ? { loginPath } : {}),
        apis: apis.slice(0, MAX_APIS),
        validationKnown: known,
        learned: `${learned}.`.slice(0, 600),
    };
    return capSize(knowledge);
}

/** Shrink a record until it fits: fewer pages and endpoints first, then per-journey detail. Always terminates. */
export function capSize(k: SiteKnowledge, max = MAX_MEMORY_BYTES): SiteKnowledge {
    let out = k;
    for (let i = 0; i < 12 && bytes(out) > max; i++) {
        out = {
            ...out,
            pages: out.pages.slice(0, Math.max(0, Math.floor(out.pages.length * 0.75))),
            apis: out.apis.slice(0, Math.max(0, Math.floor(out.apis.length * 0.75))),
            journeys: out.journeys.slice(0, Math.max(0, Math.floor(out.journeys.length * 0.9))).map((j) => ({ ...j, pages: j.pages.slice(0, 5), validated: j.validated.slice(0, 3) })),
        };
    }
    return out;
}
