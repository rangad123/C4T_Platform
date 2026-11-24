/**
 * What differs between the project's test accounts, from each account's own crawl (./access.ts surveyAccess): screens one
 * account reaches and another does not, and buttons one sees on a screen they share. Plain lines for the planner, which plans
 * role scenarios from them ("a teacher can open /grades, a student cannot", "the admin sees Delete"). No LLM.
 */
import { urlPattern } from "../discovery/crawler.js";
import type { Credentials } from "../discovery/auth.js";
import type { Reach, RoleLogin } from "./access.js";

const patternOf = (path: string) => {
    try {
        return urlPattern(new URL(path, "http://app.invalid").toString());
    } catch {
        return path;
    }
};

export function roleDifferences(reach: Reach[], max = 24): string[] {
    const accounts = reach.filter((r) => r.who !== "anonymous");
    if (accounts.length < 2) return [];
    const screens = new Map(accounts.map((r) => [r.who, new Map(r.pages.map((p) => [patternOf(p.path), p]))]));
    const controls = new Map(accounts.map((r) => [r.who, new Map((r.controls ?? []).map((c) => [patternOf(c.path), new Set(c.names)]))]));
    const reachLines: string[] = [];
    const controlLines: string[] = [];
    for (const a of accounts) {
        for (const b of accounts) {
            if (a === b) continue;
            const mine = screens.get(a.who)!;
            const theirs = screens.get(b.who)!;
            // A crawl cut short by a browser crash says nothing about what that account cannot reach.
            for (const [pat, p] of b.incomplete ? [] : mine) {
                if (pat === "/" || theirs.has(pat)) continue;
                reachLines.push(`“${a.who}” can open ${p.path}${p.heading ? ` (“${p.heading}”)` : ""}; “${b.who}” did not reach it.`);
            }
            const aCtl = controls.get(a.who)!;
            const bCtl = controls.get(b.who)!;
            for (const [pat, names] of aCtl) {
                const other = bCtl.get(pat);
                if (!other) continue;
                const only = [...names].filter((n) => !other.has(n)).slice(0, 4);
                if (only.length) controlLines.push(`On ${pat}, “${a.who}” sees ${only.map((n) => `“${n}”`).join(", ")}; “${b.who}” does not.`);
            }
        }
    }
    // Both kinds get room: control differences are the ones access checks cannot cover.
    const half = Math.ceil(max / 2);
    const c = controlLines.slice(0, Math.max(half, max - reachLines.length));
    return [...reachLines.slice(0, max - c.length), ...c];
}

// ── authoring a role scenario ───────────────────────────────────────────────

const ROLE_KEY = /^[a-z][a-z0-9_-]*$/;

type RoleScenario = { role?: string; title?: string; description?: string; preconditions?: string[]; requiredData?: string[]; expectedResults?: string[] };

/**
 * The one test account a scenario without a role says it signs in as, or undefined when it says none or more than one: "Signed in as the
 * admin test account ada", "admin test account ada" in its data, or a description that starts with the account ("Mia opens a note").
 * An account named as data ("colleague test account email (ben)", "share it with ben") is not who signs in. Paid trial rbac-2 WEB-038,
 * WEB-044, WEB-045 and WEB-047 named their account this way and ran as the project's.
 */
function namedRole(scenario: RoleScenario, roles: RoleLogin[]): string | undefined {
    const text = [scenario.title, scenario.description, ...(scenario.preconditions ?? []), ...(scenario.requiredData ?? [])].join("\n").toLowerCase();
    const opening = (scenario.description ?? "").toLowerCase();
    const named = roles.filter((r) => {
        const n = r.name.toLowerCase();
        if (!ROLE_KEY.test(n)) return false;
        const end = "(?![a-z0-9_-])";
        return (
            new RegExp(`\\b(?:signed|signs|sign|logged|logs|log) in as (?:the |an? )?(?:[a-z]+ ){0,3}${n}${end}`).test(text) ||
            new RegExp(`\\btest (?:account|user) ${n}${end}|(?<![a-z0-9_-])${n} test account\\b`).test(text) ||
            new RegExp(`^(?:[a-z]+ )?${n}${end}`).test(opening)
        );
    });
    return named.length === 1 ? named[0]!.name : undefined;
}

/**
 * The sign-in details a role scenario is written with: its account's, or undefined (then the project's own account is used). A scenario
 * the planner gave no role is a role scenario when its words say it signs in as exactly one of the project's accounts other than
 * `mainUsername`'s.
 */
export function roleCredentials(scenario: RoleScenario, roles: RoleLogin[] | undefined, mainUsername?: string): { name: string; credentials: Credentials } | undefined {
    // The project's own account named in the words stays the project's account (its fresh-account and lane handling stay as they are).
    const role = scenario.role ?? (roles?.length ? namedRole(scenario, roles.filter((r) => r.username !== mainUsername)) : undefined);
    const r = role ? roles?.find((x) => x.name === role) : undefined;
    if (!r || !ROLE_KEY.test(r.name.toLowerCase())) return undefined;
    return { name: r.name, credentials: { username: r.username, password: r.password, ...(r.totpSecret ? { totpSecret: r.totpSecret } : {}) } };
}

/**
 * A spec written while signed in as a named account: its {{credentials.*}} placeholders become that account's
 * ({{credentials.teacher.username}} -> TEST_TEACHER_USERNAME when it runs, ../generators/render-utils.ts), so it runs as that account.
 */
export function asRole<T extends { steps: unknown[]; testData: Record<string, string>; tags: string[] }>(spec: T, role: string): T {
    const key = role.toLowerCase();
    const swap = (v: unknown): unknown => (typeof v === "string" ? v.replace(/\{\{\s*credentials\.(username|password|totp)\s*\}\}/g, `{{credentials.${key}.$1}}`) : v);
    return {
        ...spec,
        steps: spec.steps.map((st) => Object.fromEntries(Object.entries(st as Record<string, unknown>).map(([k, v]) => [k, swap(v)]))),
        testData: Object.fromEntries(Object.entries(spec.testData).map(([k, v]) => [k, swap(v) as string])),
        tags: [...new Set([...spec.tags, `role:${key}`])],
    };
}
