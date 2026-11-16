/**
 * The exploration as a source of application knowledge: the stored understanding model (../understanding/app-model.ts) and the access
 * survey converted into a fragment, without AI. Pages keep their purpose, elements, forms with the constraints and messages the page
 * showed, dialogs, menus and tables, the requests each control caused, and their screen in the screen map; the crawl's navigation;
 * endpoints seen in traffic ("observed") and, only where the model took them from an OpenAPI document, "documented"; workflows from the
 * analysed journeys ("inferred"); roles from what each test account reached and how the accounts differ.
 *
 * What the application did is never an expectation: this source produces no rules. A model from an older runner (pages without the
 * discovery marker) converts the same way, with one missing-context sentence saying what it could not capture.
 */
import { urlPattern } from "../discovery/crawler.js";
import type { Reach } from "../identity/access.js";
import type { AppModel as UnderstandingModel, FormFieldModel, PageModel } from "../understanding/app-model.js";
import { ModelFragmentSchema, type ModelFragment } from "./fragment.js";
import { missingContext } from "./missing-context.js";
import type { AppModel, Endpoint, Evidence } from "./model.js";
import { fingerprintJson } from "./sources/fingerprint.js";
import { hideSecrets } from "./sources/hide-secrets.js";

export interface ExplorationSource {
    /** The exploration's stored understanding model. */
    model: UnderstandingModel;
    /** What the source record is known by (the application address or the exploration). */
    ref: string;
    /** When it was processed (ISO time). */
    now: string;
    /** The access survey: what each viewer reached (../identity/access.ts surveyAccess). */
    reach?: Reach[];
    /** How the accounts differ (../identity/role-differences.ts roleDifferences over the same survey). */
    roleDifferences?: string[];
}

const cut = (s: unknown, n: number) => String(s ?? "").slice(0, n);
const seg = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
const patternOf = (path: string) => {
    try {
        return urlPattern(new URL(path, "http://app.invalid").toString());
    } catch {
        return path;
    }
};

const ELEMENT_KIND: Record<string, "link" | "button" | "input" | "select" | "other"> = {
    link: "link",
    button: "button",
    textbox: "input",
    searchbox: "input",
    checkbox: "input",
    radio: "input",
    combobox: "select",
    listbox: "select",
};

function field(f: FormFieldModel) {
    return {
        name: cut(f.name || f.label || f.type, 200),
        ...(f.label ? { label: cut(f.label, 200) } : {}),
        type: cut(f.type || "text", 50),
        required: f.required,
        ...(f.min ? { min: cut(f.min, 100) } : {}),
        ...(f.max ? { max: cut(f.max, 100) } : {}),
        ...(f.minLength !== undefined ? { minLength: f.minLength } : {}),
        ...(f.maxLength !== undefined ? { maxLength: f.maxLength } : {}),
        ...(f.pattern ? { pattern: cut(f.pattern, 500) } : {}),
        ...(f.options ? { options: f.options.slice(0, 200).map((o) => cut(o, 200)) } : {}),
        ...(f.validation?.message ? { message: cut(f.validation.message, 500) } : {}),
    };
}

function structures(p: PageModel): AppModel["pages"][number]["structures"] {
    return [
        ...(p.dialogs ?? []).map((name) => ({ kind: "dialog" as const, name: cut(name, 200) })),
        ...(p.menus ?? []).map((m) => ({ kind: "menu" as const, name: cut(m.name, 200) })),
        ...(p.tables ?? []).map((t) => ({ kind: "table" as const, name: cut(t.name, 200), headers: t.headers.slice(0, 50).map((h) => cut(h, 200)) })),
    ].slice(0, 100);
}

/** Content words of a text, compared by their first four letters (product ~ products); path parameters and "api" are not words. */
const wordsOf = (s: string) => new Set((s.toLowerCase().replace(/\{[^}]*\}|:[a-z_]+/g, " ").match(/[a-z]{4,}/g) ?? []).map((w) => w.slice(0, 4)));
const shares = (a: Set<string>, b: Set<string>) => [...a].some((w) => b.has(w));

/**
 * The page each journey step happens on and, where the crawl saw it, the request it sends. The journey's pages are in order: a step is on
 * the first page from the current one that the step names (a control of that page, or a word of its path), otherwise on the page as far
 * along the journey as the step is. Its request is the one a control the step names caused there, otherwise a write seen on that page
 * whose path shares a word with the step. Nothing is guessed beyond what the crawl recorded.
 */
function stepLinks(steps: string[], journeyPages: string[], pages: AppModel["pages"], apis: UnderstandingModel["apis"], idOf: (path: string) => string | undefined): Array<{ page?: string; endpoint?: string }> {
    const route = journeyPages.map((p) => pages.find((x) => x.id === idOf(p))).filter((p): p is AppModel["pages"][number] => !!p).filter((p, i, xs) => i === 0 || xs[i - 1] !== p);
    if (!route.length) return steps.map(() => ({}));
    const named = (step: string, control: string) => control.trim().length > 1 && step.toLowerCase().includes(control.trim().toLowerCase());
    let at = 0;
    return steps.map((step, i) => {
        const words = wordsOf(step);
        const hit = route.findIndex((p, k) => k >= at && (p.elements.some((e) => named(step, e.name)) || p.interactions.some((x) => named(step, x.control)) || shares(words, wordsOf(p.path))));
        at = hit >= 0 ? hit : Math.max(at, Math.floor((i * route.length) / steps.length));
        const p = route[at]!;
        const caused = p.interactions.find((x) => named(step, x.control));
        const write = caused ? undefined : apis.find((a) => a.source === "network" && a.method.toUpperCase() !== "GET" && a.usedIn.includes(p.path) && shares(words, wordsOf(a.path)));
        const endpoint = caused ? `${caused.method.toUpperCase()} ${caused.path}` : write ? `${write.method.toUpperCase()} ${write.path}` : undefined;
        return { page: p.id, ...(endpoint ? { endpoint: cut(endpoint, 300) } : {}) };
    });
}

export function fragmentFromExploration(src: ExplorationSource): ModelFragment {
    const m = src.model;
    const accounts = (src.reach ?? []).filter((r) => r.who !== "anonymous");
    const anonymous = src.reach?.find((r) => r.who === "anonymous");
    const reachedBy = (pattern: string, r: Reach) => r.pages.some((p) => patternOf(p.path) === pattern);

    // Pages: the crawl's, then any page only a test account reached. Ids are the path, so every source names a page the same way.
    const ids = new Map<string, string>();
    const pageId = (path: string) => ids.get(path) ?? `page:${cut(path, 95)}`;
    const screenOf = (path: string) => m.screenMap?.screens.find((s) => s.paths.includes(path))?.key;
    const access = (path: string) => {
        if (!src.reach?.length) return {};
        const pattern = patternOf(path);
        const roles = accounts.filter((r) => reachedBy(pattern, r)).map((r) => cut(r.who, 100));
        const open = anonymous ? reachedBy(pattern, anonymous) : undefined;
        return {
            ...(roles.length ? { reachableBy: roles.slice(0, 20) } : {}),
            ...(open !== undefined && (open || roles.length) ? { requiresSignIn: !open } : {}),
        };
    };
    const pages: AppModel["pages"] = [];
    for (const p of m.pages.slice(0, 2000)) {
        if (ids.has(p.path)) continue;
        ids.set(p.path, `page:${cut(p.path, 95)}`);
        const screenId = screenOf(p.path);
        pages.push({
            id: pageId(p.path),
            path: cut(p.path, 500),
            purpose: cut(p.purpose, 500),
            elements: p.components.slice(0, 300).map((c) => ({ role: cut(c.role, 60), name: cut(c.name, 200), kind: ELEMENT_KIND[c.role] ?? "other" })),
            ...(screenId ? { screenId: cut(screenId, 100) } : {}),
            ...access(p.path),
            forms: p.forms.slice(0, 30).map((f) => ({ name: cut(f.id ?? f.purpose, 200), fields: f.fields.slice(0, 100).map(field) })),
            structures: structures(p),
            interactions: (p.interactions ?? []).slice(0, 200).map((i) => ({ control: cut(i.control, 200), method: cut(i.method, 10), path: cut(i.path, 500) })),
        });
    }
    for (const r of accounts)
        for (const rp of r.pages) {
            const known = [...ids.keys()].some((path) => patternOf(path) === patternOf(rp.path));
            if (known || pages.length >= 2000) continue;
            ids.set(rp.path, `page:${cut(rp.path, 95)}`);
            pages.push({ id: pageId(rp.path), path: cut(rp.path, 500), purpose: "", elements: [], ...access(rp.path), forms: [], structures: [], interactions: [] });
        }
    const idOfPattern = (path: string) => {
        const pattern = patternOf(path);
        const hit = pages.find((p) => patternOf(p.path) === pattern);
        return hit?.id;
    };

    const navigation: AppModel["navigation"] = m.navigation
        .filter((n) => ids.has(n.from) && ids.has(n.to))
        .slice(0, 5000)
        .map((n) => ({ from: pageId(n.from), to: pageId(n.to), control: cut(n.label, 200), evidence: [{ kind: "page", ref: cut(n.from, 500) }] }));

    // Endpoints: traffic is "observed"; an OpenAPI entry is "documented" with the document's path; one only named in site docs is neither.
    const endpoints: Endpoint[] = [];
    for (const a of m.apis) {
        if (endpoints.length >= 2000) break;
        const method = cut(a.method.toUpperCase(), 10);
        const parameters = [
            ...[...a.path.matchAll(/\{([^}]+)\}/g)].map((x) => ({ name: cut(x[1], 100), in: "path" as const, required: true, type: "" })),
            ...a.queryParams.map((q) => ({ name: cut(q, 100), in: "query" as const, required: false, type: "" })),
        ].slice(0, 100);
        const common = {
            method,
            path: cut(a.path, 500),
            parameters,
            ...(a.requiresAuth !== undefined ? { requiresAuth: a.requiresAuth } : {}),
            errors: a.statuses.filter((s) => s >= 400).slice(0, 30).map((s) => ({ status: String(s), description: "" })),
        };
        if (a.source === "network") {
            const evidence: Evidence[] = [{ kind: "request", ref: cut(`${method} ${a.examplePath ?? a.path}`, 500) }, ...a.usedIn.slice(0, 19).map((u) => ({ kind: "page" as const, ref: cut(u, 500) }))];
            endpoints.push({ ...common, origin: "observed", evidence });
        } else if (a.source === "openapi") {
            const doc = m.openApi?.url ?? "openapi";
            endpoints.push({ ...common, origin: "documented", evidence: [{ kind: "openapi", ref: cut(`${doc}#/paths/${seg(a.path)}/${a.method.toLowerCase()}`, 500) }] });
        }
    }

    const workflows: AppModel["workflows"] = m.journeys.slice(0, 500).map((j, n) => {
        const evidence: Evidence[] = j.pages.length ? j.pages.slice(0, 20).map((p) => ({ kind: "page", ref: cut(p, 500) })) : [{ kind: "page", ref: cut(m.url, 500) }];
        const where = stepLinks(j.steps.slice(0, 100), j.pages, pages, m.apis, idOfPattern);
        return {
            // Made from the name after secret hiding: the id is kept as it is when the fragment is redacted (platform/app-analysis.ts).
            id: cut(`journey-${n + 1}-${hideSecrets(j.name, { max: 200 }).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`, 100),
            name: cut(j.name, 200),
            steps: j.steps.slice(0, 100).map((action, order) => ({ order, action: cut(action, 500), ...where[order] })),
            preconditions: j.requiresAuth ? ["Signed in"] : [],
            postconditions: [],
            roles: [],
            sourceType: "inferred",
            evidence,
        };
    });

    const roles: AppModel["roles"] = accounts.slice(0, 50).map((r) => {
        const reaches = [...new Set(r.pages.map((p) => idOfPattern(p.path)).filter((x): x is string => !!x))].slice(0, 200);
        const name = cut(r.who, 100);
        return {
            name,
            reaches,
            differs: (src.roleDifferences ?? []).filter((d) => d.includes(`“${r.who}”`)).slice(0, 50).map((d) => cut(d, 500)),
            evidence: [{ kind: "page", ref: cut(r.pages[0]?.path ?? m.url, 500), excerpt: cut(`The ${r.who} account reached ${r.pages.length} ${r.pages.length === 1 ? "page" : "pages"}${r.incomplete ? " before its crawl ended early" : ""}.`, 1000) }],
        };
    });

    // Pages from a runner that did not read constraints, structures or requests per control: one sentence, from the shared wording.
    const old = m.pages.length > 0 && m.pages.some((p) => p.discovery !== 2);
    const missing = old ? missingContext({ endpoints: [] }, [], { oldRunner: true }).filter((x) => x.source === "exploration") : [];

    const model = {
        appType: cut(m.siteType, 100),
        contextSources: ["url", "crawl"],
        pages,
        navigation,
        endpoints,
        workflows,
        roles,
        missingContext: missing,
    };
    return ModelFragmentSchema.parse({
        source: { kind: "exploration", ref: cut(src.ref, 500), fingerprint: fingerprintJson(model), status: "processed", processedAt: src.now },
        model,
        rules: [],
        notes: [],
    });
}
