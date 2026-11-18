/**
 * One lane per account (queue rows 181a, 189): tests that sign in as the same account share its state on the server (cart, discount,
 * profile), so their runs never overlap; signed-out tests and other accounts' tests run beside them. Used by validation, the strength
 * check (../mutation/strength.ts, ../mutation/faults.ts) and the browser / condition checks (./variants.ts).
 */
import type { ScriptRun } from "./runner.js";

/** Placeholders and script variables that sign in: {{credentials.username}} / TEST_USERNAME (the project's account), {{credentials.bob.password}} / TEST_BOB_PASSWORD (a named one). */
const MAIN_SIGN_IN = /\{\{\s*credentials\.(?:username|password|totp)\s*\}\}|process\.env\.TEST_(?:USERNAME|PASSWORD|TOTP_SECRET)\b/;
const ROLE_SIGN_IN = /\{\{\s*credentials\.([a-z][a-z0-9_-]*)\.(?:username|password|totp)\s*\}\}|process\.env\.TEST_(?!ENV_)([A-Z][A-Z0-9_]*?)_(?:USERNAME|PASSWORD|TOTP_SECRET)\b/;

/** The lane key of a named account: "role:<name>", lower case, "-" and "_" alike (as TEST_<NAME>_* spells it). */
export const roleLane = (name: string): string => `role:${name.toLowerCase().replace(/-/g, "_")}`;

/** The account some text signs in as, as a lane key: "main", "role:<name>", or undefined when it never signs in. */
export function textAccountLane(text: string): string | undefined {
    const role = ROLE_SIGN_IN.exec(text);
    if (role) return roleLane(role[1] ?? role[2]!);
    return MAIN_SIGN_IN.test(text) ? "main" : undefined;
}

/** The account a test signs in as, as a lane key: "main", "role:<name>", or undefined for a test that never signs in. */
export function testAccountLane(t: { spec: { steps: unknown[] }; custom?: { filename?: string; content: string } }): string | undefined {
    return textAccountLane(t.custom ? t.custom.content : JSON.stringify(t.spec.steps));
}

/** How many items share their lane with another item (0: no lane needs keeping apart). */
export function sharedLaneCount(lanes: ReadonlyArray<string | undefined>): number {
    return lanes.filter((l) => l !== undefined && lanes.indexOf(l) !== lanes.lastIndexOf(l)).length;
}

/**
 * A laned batch in rounds: each round holds at most one item of each account (in order) and is filled with signed-out items up to
 * `width`; the signed-out items left over join the last round. Indexes into the batch.
 */
export function laneRounds(lanes: ReadonlyArray<string | undefined>, width: number): number[][] {
    const byLane = new Map<string, number[]>();
    const free: number[] = [];
    lanes.forEach((lane, i) => (lane === undefined ? free.push(i) : byLane.set(lane, [...(byLane.get(lane) ?? []), i])));
    const rounds: number[][] = [];
    for (let r = 0; [...byLane.values()].some((l) => r < l.length); r++) {
        const round = [...byLane.values()].flatMap((l) => (r < l.length ? [l[r]!] : []));
        while (round.length < width && free.length) round.push(free.shift()!);
        rounds.push(round);
    }
    if (free.length) rounds.length ? rounds[rounds.length - 1]!.push(...free) : rounds.push(free);
    return rounds;
}

/**
 * Runs a batch whose results come back one per item, in order: as one call when no two items share an account, else one call per
 * round (laneRounds). `onLaned` is told how many items share an account, once, when rounds are used.
 */
export async function runInLanes<T>(items: T[], lanes: ReadonlyArray<string | undefined>, width: number, run: (batch: T[]) => Promise<ScriptRun[]>, onLaned?: (shared: number) => void): Promise<ScriptRun[]> {
    const shared = sharedLaneCount(lanes);
    if (!shared) return await run(items);
    onLaned?.(shared);
    const out: ScriptRun[] = new Array(items.length);
    for (const round of laneRounds(lanes, Math.max(1, width))) {
        const runs = await run(round.map((i) => items[i]!));
        round.forEach((i, k) => (out[i] = runs[k]!));
    }
    return out;
}

/**
 * The account a planned scenario will sign in as, before it is written: its named account (`role`, already resolved to one the job
 * has), else "main" when the job signed in and the scenario needs it (requiresAuth) or its plan names the account's sign-in
 * ({{credentials.username}} in its data, preconditions, description or expected results, as sign-in and registration tests do).
 */
export function scenarioAccountLane(
    scenario: { requiresAuth: boolean; description: string; preconditions: string[]; requiredData: string[]; expectedResults: string[] },
    role: string | undefined,
    signedIn: boolean,
): string | undefined {
    if (role) return roleLane(role);
    if (!signedIn) return undefined;
    if (scenario.requiresAuth) return "main";
    return textAccountLane([scenario.description, ...scenario.preconditions, ...scenario.requiredData, ...scenario.expectedResults].join("\n")) === "main" ? "main" : undefined;
}
