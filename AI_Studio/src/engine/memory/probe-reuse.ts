/**
 * Reuse earlier runs (sheet #8 (a)): what the crawl's probes found on a page the last time it was explored, taken again for a page that has
 * not changed since, so a repeat exploration spends its time on what is new or changed.
 *
 * The crawl still visits every page it would visit (and starts from the pages it knows, so deep pages are reached without walking the
 * menus again). Only the probes of an unchanged page are skipped: opening its menus, tabs and dialogs, trying its drop-downs for fields
 * that appear, and typing invalid values to read its validation messages. Their results come from the project's latest application
 * model and the page is marked `reusedFrom`. Nothing here skips a check: tests, oracles, validations and repairs always run.
 *
 * "Unchanged" is strict: the same address, the same structural fingerprint and the same understanding fingerprint (distill.ts), read from
 * the page as it loads now. Bounds on what the fingerprints cannot see (a changed message behind the same field):
 *  - results older than PROBE_TTL_DAYS, or reused MAX_REUSES runs in a row, are found again;
 *  - every SPOT_CHECK_EVERY-th reusable page (the first one always) is probed anyway and compared: any difference turns reuse off for
 *    the rest of the run, and the pages reused before it are probed again;
 *  - when more than half of the known pages changed (likely a new release), reuse is off for the run, the same way.
 * Pure apart from the clock; the crawler decides when to ask (discovery/crawler.ts).
 */
import type { ApiEndpointModel, AppModel, FormFieldModel, FormModel, PageModel } from "../understanding/app-model.js";
import { pageFingerprint, understandingFingerprint } from "./distill.js";

export const PROBE_TTL_DAYS = 30;
export const MAX_REUSES = 5;
/** One reusable page in this many is probed anyway and compared (20%; the first reusable page always). */
export const SPOT_CHECK_EVERY = 5;
/** Reuse is off for the run when more than this share of the known pages changed. */
export const CHANGED_SHARE_OFF = 0.5;
const MAX_KNOWN_PAGES = 400;

/** What the probes of one page found. */
export interface PageProbes {
    revealed: string[];
    /** Links that only showed once a menu or tab was opened (followed by the crawl like any other link). */
    revealedLinks: Array<{ text: string; href: string }>;
    interactions: NonNullable<PageModel["interactions"]>;
    dialogs: string[];
    menus: NonNullable<PageModel["menus"]>;
    tables: NonNullable<PageModel["tables"]>;
    /** Per form (by position): the fields that appear after a choice. */
    conditional: Array<FormModel["conditional"] | null>;
    /** Per form and field (by position): the message an invalid value showed. */
    validation: Array<Array<FormFieldModel["validation"] | null>>;
}

export interface KnownPage {
    url: string;
    path: string;
    type: PageModel["type"];
    depth: number;
    fp: string;
    ufp: string;
    /** When the probes of this page last really ran (ISO). */
    probedAt: string;
    /** How many runs in a row took these results without probing. */
    reuses: number;
    probes: PageProbes;
    /** API endpoints the page's probes made it call (they are found by the probes, so a reused page brings them along). */
    apis: ApiEndpointModel[];
    /** How the crawl reached the page last time (the navigation edge), so starting from it keeps the same map. */
    via?: { from: string; label: string };
}

/** What the crawl may start from: the project's latest application model, as the host hands it over (GenerationRequest.knownPages). */
export interface KnownPages {
    origin: string;
    pages: KnownPage[];
}

export function probesOf(p: PageModel): PageProbes {
    return {
        revealed: [...(p.revealed ?? [])],
        revealedLinks: [...(p.revealedLinks ?? [])],
        interactions: [...(p.interactions ?? [])],
        dialogs: [...(p.dialogs ?? [])],
        menus: [...(p.menus ?? [])],
        tables: [...(p.tables ?? [])],
        conditional: p.forms.map((f) => f.conditional ?? null),
        validation: p.forms.map((f) => f.fields.map((x) => x.validation ?? null)),
    };
}

/** Put earlier probe results on a page read now (same fingerprints, so its forms and fields are the same ones in the same order). */
export function applyProbes(p: PageModel, probes: PageProbes): void {
    p.revealed = [...probes.revealed];
    p.revealedLinks = [...probes.revealedLinks];
    p.interactions = [...probes.interactions];
    const union = <T>(now: T[] | undefined, then: T[]) => {
        const out = [...(now ?? [])];
        for (const x of then) if (!out.some((y) => JSON.stringify(y) === JSON.stringify(x))) out.push(x);
        return out;
    };
    p.dialogs = union(p.dialogs, probes.dialogs);
    p.menus = union(p.menus, probes.menus);
    p.tables = union(p.tables, probes.tables);
    p.forms.forEach((f, i) => {
        const c = probes.conditional[i];
        if (c) f.conditional = c;
        else delete f.conditional;
        f.fields.forEach((x, j) => {
            const v = probes.validation[i]?.[j];
            if (v) x.validation = v;
            else delete x.validation;
        });
    });
}

/** Remove what probes add, before probing a page again. */
export function clearProbes(p: PageModel): void {
    p.revealed = [];
    p.revealedLinks = [];
    p.interactions = [];
    for (const f of p.forms) {
        delete f.conditional;
        for (const x of f.fields) delete x.validation;
    }
}

const blur = (s: string) => s.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
const set = (xs: string[]) => [...new Set(xs.map(blur))].sort();

/** Whether two probe results say the same about a page (numbers and spacing blurred, order ignored). */
export function sameProbes(a: PageProbes, b: PageProbes): boolean {
    const norm = (p: PageProbes) =>
        JSON.stringify({
            r: set(p.revealed),
            l: set(p.revealedLinks.map((l) => l.href)),
            i: set(p.interactions.map((x) => `${x.method} ${x.path}`)),
            d: set(p.dialogs),
            m: set(p.menus.map((x) => JSON.stringify(x))),
            t: set(p.tables.map((x) => JSON.stringify(x))),
            c: p.conditional.map((c) => (c ? set(c.map((x) => `${x.when} -> ${set(x.shows).join(",")}`)) : null)),
            v: p.validation.map((f) => f.map((x) => (x ? `${x.check}: ${blur(x.message)}` : null))),
        });
    return norm(a) === norm(b);
}

/** The API calls earlier explorations captured on a site (traffic, the site's own API list): what an API-only run, which crawls no pages, tests too. */
export interface KnownApis {
    origin: string;
    apis: ApiEndpointModel[];
}

/** The captured calls of an application model (not its OpenAPI operations: a run reads the document itself), or undefined when there are none. */
export function knownApisOf(model: AppModel | null | undefined): KnownApis | undefined {
    const apis = (model?.apis ?? []).filter((a) => a.source !== "openapi");
    return model && apis.length ? { origin: model.origin, apis } : undefined;
}

/** The known pages of an application model (pages whose probes ran in a crawl that records when), for the next exploration. */
export function knownPagesOf(model: AppModel | null | undefined): KnownPages | undefined {
    if (!model?.pages?.length) return undefined;
    const pages: KnownPage[] = [];
    for (const p of model.pages) {
        if (!p.probedAt || p.discovery !== 2 || p.type === "error" || p.status >= 400) continue;
        const caused = new Set((p.interactions ?? []).map((x) => `${x.method} ${x.path}`));
        const via = model.navigation.find((n) => n.to === p.path);
        pages.push({
            url: p.url,
            path: p.path,
            type: p.type,
            depth: p.depth,
            fp: pageFingerprint(p),
            ufp: understandingFingerprint(p),
            probedAt: p.probedAt,
            reuses: p.reuses ?? 0,
            probes: probesOf(p),
            apis: caused.size ? model.apis.filter((a) => caused.has(`${a.method} ${a.path}`)) : [],
            ...(via ? { via: { from: via.from, label: via.label } } : {}),
        });
        if (pages.length >= MAX_KNOWN_PAGES) break;
    }
    return pages.length ? { origin: model.origin, pages } : undefined;
}

export type ProbeDecision = { kind: "probe" } | { kind: "reuse"; known: KnownPage } | { kind: "spot"; known: KnownPage };

/** One crawl's use of the known pages: which page's probes to skip, the spot checks, and when reuse is off for the rest of the run. */
export class ProbeReuse {
    private readonly byKey = new Map<string, KnownPage>();
    private changed = 0;
    private reusable = 0;
    /** Why reuse was switched off for the rest of this run (undefined while it is on). */
    off?: string;
    /** Pages whose probe results were taken this run (emptied when reuse is switched off and they are probed again). */
    readonly reused: PageModel[] = [];
    readonly changedPaths: string[] = [];
    spotChecked = 0;
    expired = 0;

    constructor(
        readonly known: KnownPages,
        private readonly key: (url: string) => string | null,
        private readonly now: () => Date = () => new Date(),
    ) {
        for (const p of known.pages) {
            const k = key(p.url);
            if (k && !this.byKey.has(k)) this.byKey.set(k, p);
        }
    }

    /**
     * Where the crawl can start: every known page, shallowest first. Sign-in and sign-up pages are left out: they are read by the sign-in
     * and the signed-out pass, and opened in a signed-in crawl they would show another page than the one known.
     */
    seeds(): Array<{ url: string; depth: number; via?: { from: string; label: string } }> {
        return [...this.known.pages].filter((p) => p.type !== "login" && p.type !== "register").sort((a, b) => a.depth - b.depth || a.url.localeCompare(b.url)).map((p) => ({ url: p.url, depth: p.depth, ...(p.via ? { via: p.via } : {}) }));
    }

    /** For a page as read now, before its probes: probe it, take the known results, or probe it as a spot check. */
    decide(page: PageModel): ProbeDecision {
        if (this.off) return { kind: "probe" };
        const k = this.key(page.url);
        const known = k ? this.byKey.get(k) : undefined;
        if (!known) return { kind: "probe" };
        if (known.fp !== pageFingerprint(page) || known.ufp !== understandingFingerprint(page)) {
            this.changed++;
            if (this.changedPaths.length < 50) this.changedPaths.push(page.path);
            if (this.changed > this.known.pages.length * CHANGED_SHARE_OFF) {
                this.off = `more than half of the ${this.known.pages.length} known pages changed since the last exploration (likely a new release)`;
            }
            return { kind: "probe" };
        }
        const age = this.now().getTime() - Date.parse(known.probedAt);
        if (!Number.isFinite(age) || age > PROBE_TTL_DAYS * 86_400_000 || known.reuses >= MAX_REUSES) {
            this.expired++;
            return { kind: "probe" };
        }
        this.reusable++;
        return this.reusable % SPOT_CHECK_EVERY === 1 ? { kind: "spot", known } : { kind: "reuse", known };
    }

    /** Take the known results for a page. Returns the links its menus revealed (for the crawl to follow). */
    take(page: PageModel, known: KnownPage): Array<{ text: string; href: string }> {
        applyProbes(page, known.probes);
        page.probedAt = known.probedAt;
        page.reuses = known.reuses + 1;
        page.reusedFrom = { at: known.probedAt };
        this.reused.push(page);
        return known.probes.revealedLinks;
    }

    /** After a spot check probed the page: whether it found what was known. A difference turns reuse off for the rest of the run. */
    check(page: PageModel, known: KnownPage): boolean {
        this.spotChecked++;
        if (sameProbes(probesOf(page), known.probes)) return true;
        this.off = `a spot check of ${page.path} found it behaves differently from the last exploration (its menus, conditional fields or validation messages changed)`;
        return false;
    }

    /** The endpoints the reused pages' probes found last time. */
    reusedApis(): ApiEndpointModel[] {
        const paths = new Set(this.reused.map((p) => this.key(p.url)));
        return this.known.pages.filter((k) => paths.has(this.key(k.url))).flatMap((k) => k.apis);
    }

    /** The earliest date the reused results were found on. */
    since(): string | undefined {
        return this.reused.map((p) => p.reusedFrom?.at ?? "").filter(Boolean).sort()[0];
    }
}
