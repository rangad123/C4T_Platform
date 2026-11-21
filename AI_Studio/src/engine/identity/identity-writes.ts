/**
 * C3e writes as a second or lesser identity (no LLM). A write endpoint that documents a refusal for "not the owner" or "not an admin" is
 * sent as an account the survey evidence says lacks the right, and the documented refusal is expected:
 *  - owner: an account that reads another account's record through sharing (it lists that record, but not every record of that owner)
 *    sends the record's own values back with PUT/PATCH, so an accepted write changes nothing;
 *  - role: an account the vertical survey refused gives itself the role value of the account that was allowed; an accepted change is
 *    changed back at once;
 *  - revoke: the record's owner stops sharing it with the reader, then the reader reads it again and expects the documented 404.
 * Writes, so only behind the gate (identityWritesAllowed) and at most MAX_IDENTITY_WRITES writes a run. Each check runs in the access
 * helper the generated scripts carry: fresh browser contexts signed in per account, the app's own API host only, no values stored.
 */
import type { DraftSpec } from "../api/test-specs.js";
import type { ApiEndpointModel } from "../understanding/app-model.js";
import type { ApiAccessRow, ApiListRow } from "./access.js";
import { WHO_AM_I } from "./session-end.js";

export const MAX_IDENTITY_WRITES = 8;

/** The Q4 gate: data changes on, and a current client authorization, or a bench or fixture app on a loopback address. */
export function identityWritesAllowed(req: { allowMutatingApiTests: boolean; riskyChecksGate?: "bench" | "fixture" | "authorization"; url: string }): boolean {
    if (req.allowMutatingApiTests !== true || !req.riskyChecksGate) return false;
    if (req.riskyChecksGate === "authorization") return true;
    let host = "";
    try {
        host = new URL(req.url).hostname;
    } catch {
        return false;
    }
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

/**
 * Script-side check, appended to the access helper (it uses ACCESS_PREFIX, accessSignIn and accessOwnApi from there).
 * cfg = {identityWrite: "owner" | "role" | "revoke", as, by?, method, path, read?, param?, whoAmI?, origin?, documented?, sev}.
 * Paths must be on the application's own API host; a check that cannot be judged throws a plain sentence, which is not a finding.
 */
export const IDENTITY_WRITES_HELPER_SOURCE = String.raw`
async function accessWriteAssert(page, base, cfg) {
    const browser = page.context().browser();
    const what = cfg.method + " " + cfg.path;
    const cannot = (why) => new Error(why + ", so it could not be judged whether " + what + " is refused to “" + cfg.as + "”.");
    if (!browser) throw cannot("A separate browser context could not be opened");
    const origin = cfg.origin || new URL(base).origin;
    if (!accessOwnApi(origin, base)) throw new Error("The API host " + origin + " in this check is not the application's own address, so nothing was called.");
    const own = (path) => {
        let u;
        try { u = new URL(String(path), origin); } catch { return null; }
        return /^\/(?![\/\\])/.test(String(path)) && !/\\/.test(String(path)) && u.origin === origin ? u.toString() : null;
    };
    // The settings can be edited: each kind sends only its own method.
    if (!(cfg.identityWrite === "revoke" ? cfg.method === "DELETE" : cfg.method === "PUT" || cfg.method === "PATCH")) throw new Error("The method " + cfg.method + " is not one this check sends, so nothing was called.");
    for (const p of [cfg.path, cfg.read, cfg.whoAmI]) if (p !== undefined && !own(String(p).replace("{" + cfg.param + "}", "x"))) throw new Error("The addresses in this check are not the application's own, so nothing was called.");
    const opts = { maxRedirects: 0, failOnStatusCode: false, timeout: 30000 };
    const call = async (ctx, method, path, data) => {
        const r = await ctx.request.fetch(own(path), { ...opts, method, ...(data !== undefined ? { data } : {}) }).catch(() => null);
        if (!r) return { status: 0, body: undefined };
        let body;
        try { body = JSON.parse(await r.text()); } catch {}
        return { status: r.status(), body };
    };
    const ok = (s) => s >= 200 && s < 300;
    const refused = (s) => s === 401 || s === 403 || s === 404;
    const opened = [];
    const as = async (who) => {
        const ctx = await browser.newContext({ ignoreHTTPSErrors: IGNORE_HTTPS_ERRORS, viewport: { width: 1280, height: 800 } });
        opened.push(ctx);
        const p = await ctx.newPage();
        await accessSignIn(p, base, who);
        await p.close().catch(() => undefined);
        return ctx;
    };
    const me = async (ctx, who) => {
        const r = await call(ctx, "GET", cfg.whoAmI);
        const id = r.body && typeof r.body === "object" ? ["id", "uuid", "_id"].map((k) => r.body[k]).find((v) => typeof v === "string" || typeof v === "number") : undefined;
        if (!ok(r.status) || id === undefined) throw cannot("GET " + cfg.whoAmI + " as “" + who + "” did not say who is signed in (HTTP " + r.status + ")");
        return { id: String(id), body: r.body };
    };
    const doc = cfg.documented ? " (documented: HTTP " + cfg.documented + ")" : "";
    try {
        if (cfg.identityWrite === "owner") {
            const ctx = await as(cfg.as);
            const read = await call(ctx, "GET", cfg.path);
            if (!ok(read.status) || !read.body || typeof read.body !== "object" || Array.isArray(read.body)) throw cannot("“" + cfg.as + "” could not read the record first (HTTP " + read.status + ")");
            // The record's own values: an accepted write puts back what was there.
            const body = Object.fromEntries(Object.entries(read.body).filter(([k, v]) => ["string", "number", "boolean"].includes(typeof v) && !/^(id|uuid|_id)$|^(owner|owner_?id|user_?id|user|created_?by|author|author_?id)$/i.test(k)));
            if (!Object.keys(body).length) throw cannot("The record has no plain fields to send back unchanged");
            const w = await call(ctx, cfg.method, cfg.path, body);
            if (refused(w.status)) return;
            if (!ok(w.status)) throw cannot(what + " answered HTTP " + w.status);
            throw new Error(ACCESS_PREFIX + " 1 write may be open to an account that is not the owner\n- [" + cfg.sev + "] A signed-in “" + cfg.as + "” user, who reads this record but does not own it, sent " + what + " and it was accepted (HTTP " + w.status + ")" + doc + ". The record's own values were sent, so nothing was changed. This is possible broken access control: check that only the owner can change the record");
        }
        if (cfg.identityWrite === "role") {
            const top = await me(await as(cfg.by), cfg.by);
            const ctx = await as(cfg.as);
            const mine = await me(ctx, cfg.as);
            const field = Object.keys(top.body).find((k) => /^(role|roles|user_?role|access_?level)$/i.test(k) && typeof top.body[k] === "string");
            if (!field || typeof mine.body[field] !== "string" || mine.body[field] === top.body[field]) throw cannot("GET " + cfg.whoAmI + " shows no role that differs between “" + cfg.by + "” and “" + cfg.as + "”");
            const path = cfg.path.replace("{" + cfg.param + "}", encodeURIComponent(mine.id));
            const w = await call(ctx, cfg.method, path, { [field]: top.body[field] });
            if (refused(w.status)) return;
            if (!ok(w.status)) throw cannot(what + " answered HTTP " + w.status);
            // An accepted change is a privilege the account must not keep: it is changed back before the finding is told.
            const back = await call(ctx, cfg.method, path, { [field]: mine.body[field] });
            throw new Error(ACCESS_PREFIX + " 1 write may be open to an account that is not allowed to make it\n- [" + cfg.sev + "] A signed-in “" + cfg.as + "” user gave its own account the " + field + " “" + top.body[field] + "” of “" + cfg.by + "” with " + cfg.method + " " + path + " and it was accepted (HTTP " + w.status + ")" + doc + "; it was " + (ok(back.status) ? "changed back" : "NOT changed back (HTTP " + back.status + "): change it back by hand") + ". This is possible broken access control: check that only the accounts allowed to change roles can do so");
        }
        if (cfg.identityWrite === "revoke") {
            const reader = await as(cfg.as);
            const before = await call(reader, "GET", cfg.read);
            if (!ok(before.status)) throw cannot("“" + cfg.as + "” could not read GET " + cfg.read + " before the share was stopped (HTTP " + before.status + ")");
            const mine = await me(reader, cfg.as);
            const path = cfg.path.replace("{" + cfg.param + "}", encodeURIComponent(mine.id));
            const w = await call(await as(cfg.by), cfg.method, path);
            if (!ok(w.status)) throw cannot("The owner “" + cfg.by + "” could not stop sharing (" + cfg.method + " " + path + " answered HTTP " + w.status + ")");
            const after = await call(reader, "GET", cfg.read);
            if (refused(after.status)) return;
            if (!ok(after.status)) throw cannot("GET " + cfg.read + " answered HTTP " + after.status + " after the share was stopped");
            throw new Error(ACCESS_PREFIX + " 1 record may stay open after sharing stopped\n- [" + cfg.sev + "] After the owner “" + cfg.by + "” stopped sharing with “" + cfg.as + "” (" + cfg.method + " " + path + ", HTTP " + w.status + "), “" + cfg.as + "” could still call GET " + cfg.read + " (HTTP " + after.status + ")" + doc + ". This is possible broken access control: check that stopping a share takes the record away");
        }
        throw new Error("This check names no kind of write, so nothing was called.");
    } finally {
        for (const c of opened) await c.close().catch(() => undefined);
    }
}
`;

const OWNER_WORD = /\bowner\b/i;
const ROLE_WORD = /\badmin|\brole|\bpermission/i;
const PERSON_PARAM = /user|member|person|people|account|collaborator|grantee/i;
const WRITES: Record<"owner" | "role" | "revoke", number> = { owner: 1, role: 2, revoke: 1 };

/** The write documents a 403/404 and says why in words that match (its refusal descriptions or summary). */
function documents(ep: ApiEndpointModel, words: RegExp): number[] | undefined {
    const refusals = (ep.spec?.responses ?? []).filter((r) => r.status === "403" || r.status === "404");
    if (!refusals.length || !(refusals.some((r) => words.test(r.description ?? "")) || words.test(ep.summary ?? ""))) return undefined;
    return refusals.map((r) => Number(r.status));
}

/**
 * A record an account reads but does not own: it lists the record, but not another record with the same owner value that some other
 * account lists. The owner account lists every record of that owner value, but not every record (so it is not one who reads them all).
 */
function sharedPairs(row: ApiListRow): Array<{ as: string; id: string; owner?: string }> {
    const lists = Object.entries(row.items);
    const all = new Set(lists.flatMap(([, items]) => items.map((x) => x.id)));
    const ofOwner = (o: string) => new Set(lists.flatMap(([, items]) => items.filter((x) => x.owner === o).map((x) => x.id)));
    const out: Array<{ as: string; id: string; owner?: string }> = [];
    for (const [as, items] of lists) {
        const mine = new Set(items.map((x) => x.id));
        const pick = items.find((x) => x.owner !== undefined && [...ofOwner(x.owner)].some((id) => !mine.has(id)));
        if (!pick) continue;
        const theirs = ofOwner(pick.owner!);
        const owner = lists.find(([who, its]) => who !== as && [...theirs].every((id) => its.some((x) => x.id === id)) && its.length < all.size)?.[0];
        out.push({ as, id: pick.id, ...(owner ? { owner } : {}) });
    }
    return out;
}

function spec(title: string, description: string, accounts: string[], cfg: Record<string, unknown>, expected: string): DraftSpec {
    return {
        title,
        description: `${description} Data changes: at most ${WRITES[cfg.identityWrite as keyof typeof WRITES]} write${WRITES[cfg.identityWrite as keyof typeof WRITES] > 1 ? "s" : ""}.`,
        kind: "web",
        category: "Access control",
        type: "security",
        priority: "high",
        preconditions: [accounts.length > 1 ? `Test accounts named ${accounts.map((a) => `“${a}”`).join(" and ")} are set up for this project` : `A test account named “${accounts[0]}” is set up for this project`],
        steps: [
            { action: "navigate", url: "/", description: "Start at the home page" },
            { action: "assert", check: "accessDenied", expected: JSON.stringify(cfg), description: expected },
        ],
        expectedResults: [expected],
        testData: {},
        tags: ["security", "access-control", "api", "identity-write"],
        source: { origin: "access-check" },
    };
}

/**
 * C3e checks from the survey evidence: the documented list endpoints each account read (owner and revoke), the vertical survey (role),
 * and the API description. Generated only when the caller's gate allows writes (identityWritesAllowed); at most MAX_IDENTITY_WRITES writes.
 */
export function generateIdentityWriteSpecs(input: { apis: ApiEndpointModel[]; lists: ApiListRow[]; access: ApiAccessRow[]; origin?: string }): DraftSpec[] {
    const { apis } = input;
    const at = input.origin ? { origin: input.origin } : {};
    const whoAmI = apis.find((a) => a.method === "GET" && !a.path.includes("{") && a.statuses?.includes(401) && WHO_AM_I.test(a.path))?.path;
    const out: DraftSpec[] = [];
    let writes = 0;
    const add = (s: DraftSpec, kind: keyof typeof WRITES) => {
        if (writes + WRITES[kind] > MAX_IDENTITY_WRITES) return;
        writes += WRITES[kind];
        out.push(s);
    };
    const fill = (template: string, id: string) => template.replace(/\{[^/{}]+\}/, encodeURIComponent(id));

    // Owner writes first: the revoke below takes the record away from the reader.
    // shortcut: no DELETE as a non-owner, since a wrongly accepted delete cannot be put back; add it for bench-only runs if a seed needs it.
    for (const row of input.lists) {
        const pair = sharedPairs(row)[0];
        if (!pair) continue;
        for (const w of apis.filter((a) => (a.method === "PUT" || a.method === "PATCH") && a.path === row.detail)) {
            const documented = documents(w, OWNER_WORD);
            if (!documented) continue;
            const path = fill(row.detail, pair.id);
            add(
                spec(
                    `“${pair.as}” account: cannot change a record it does not own (${w.method} ${path})`,
                    `The “${pair.as}” account reads ${path}, a record it lists but does not own, and sends ${w.method} ${path} with the record's own values. Fails if the write is accepted (documented: HTTP ${documented.join(" or ")}).`,
                    [pair.as],
                    { identityWrite: "owner", as: pair.as, method: w.method, path, ...at, documented: documented.join(" or "), sev: "high" },
                    `${w.method} ${path} is refused to the “${pair.as}” account`,
                ),
                "owner",
            );
        }
    }

    // The owner stops sharing, then the reader is refused the record.
    if (whoAmI)
        for (const row of input.lists) {
            const pair = sharedPairs(row).find((p) => p.owner);
            const readRefusal = apis.find((a) => a.method === "GET" && a.path === row.detail)?.statuses?.filter((s) => s === 403 || s === 404);
            if (!pair || !readRefusal?.length) continue;
            for (const d of apis.filter((a) => a.method === "DELETE" && a.path.startsWith(`${row.detail}/`))) {
                const params = [...d.path.slice(row.detail.length).matchAll(/\{([^/{}]+)\}/g)];
                if (params.length !== 1 || !d.path.endsWith(`{${params[0]![1]}}`) || !PERSON_PARAM.test(params[0]![1]!)) continue;
                const read = fill(row.detail, pair.id);
                const path = fill(row.detail, pair.id) + d.path.slice(row.detail.length);
                add(
                    spec(
                        `“${pair.owner}” account stops sharing ${read} with “${pair.as}”: “${pair.as}” can no longer read it`,
                        `The “${pair.as}” account reads ${read}; its owner “${pair.owner}” then sends DELETE ${path} with “${pair.as}”'s own id, and “${pair.as}” reads it again. Fails if it is still answered (documented: HTTP ${readRefusal.join(" or ")}).`,
                        [pair.owner!, pair.as],
                        { identityWrite: "revoke", as: pair.as, by: pair.owner, method: "DELETE", path, param: params[0]![1], read, whoAmI, ...at, documented: readRefusal.join(" or "), sev: "high" },
                        `After sharing stops, GET ${read} is refused to the “${pair.as}” account`,
                    ),
                    "revoke",
                );
            }
        }

    // Each account the vertical survey refused gives itself the allowed account's role.
    if (whoAmI)
        for (const w of apis.filter((a) => a.method === "PATCH" || a.method === "PUT")) {
            const m = /^(.*)\/\{([^/{}]+)\}$/.exec(w.path);
            const row = m && input.access.find((r) => r.path === m[1]);
            const documented = row && documents(w, ROLE_WORD);
            if (!m || !row || !documented) continue;
            const named = Object.keys(row.status).filter((who) => who !== "anonymous");
            const allowed = named.filter((who) => row.status[who]! >= 200 && row.status[who]! < 300);
            const refused = named.filter((who) => !allowed.includes(who));
            if (!allowed.length) continue;
            const lesser = { by: allowed[0]!, viewers: refused };
            for (const as of lesser.viewers)
                add(
                    spec(
                        `“${as}” account: cannot change its own role (${w.method} ${w.path})`,
                        `The “${as}” account sends ${w.method} ${w.path} with its own id and the role value of “${lesser.by}”, read from GET ${whoAmI}. Fails if the change is accepted (documented: HTTP ${documented.join(" or ")}); an accepted change is changed back at once.`,
                        [lesser.by, as],
                        { identityWrite: "role", as, by: lesser.by, method: w.method, path: w.path, param: m[2], whoAmI, ...at, documented: documented.join(" or "), sev: "high" },
                        `${w.method} ${w.path} is refused to the “${as}” account`,
                    ),
                    "role",
                );
        }
    return out;
}
