/**
 * The scanner adapters' own safety fixes, checked without any real scanner: the command each adapter builds, the document it writes, and
 * the requests it asks ZAP for, through the adapters' fake-process and fake-API hooks. Nothing here enables a scanner or a profile.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
    AUTH_ENV,
    authConfigToml,
    checksForVersion,
    excludePathArgs,
    SchemathesisAdapter,
    versionAtLeast,
    withoutExcludedOperations,
} from "../src/security/scanners/schemathesis/adapter.js";
import { NucleiAdapter, templateDialsDirectly, templateIsReadOnly } from "../src/security/scanners/nuclei/adapter.js";
import { setIsolationFor, type IsolatedEgress } from "../src/security/egress/isolation.js";
import { PROFILE_TAGS, templateAllowed } from "../src/security/scanners/nuclei/policy.js";
import { removeSigninRules, signinRuleRemovable, signinRuleUrl, ZAP_DELETE_ROUNDS, ZAP_PROCESS_ID, ZAP_SIGNIN_REMOVE_ROUNDS, ZAP_SIGNIN_RULE, ZapAdapter, ZapApiError } from "../src/security/scanners/zap/adapter.js";
import { NO_AI_INTERFACE, PromptfooAdapter } from "../src/security/scanners/promptfoo/adapter.js";
import { ScannerError, type ScanApproval, type ScanTarget } from "../src/security/scanners/contract.js";
import { scannerSettings } from "../src/security/scanners/settings.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "aitp-scanner-fixes-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const SECRET = "Bearer sess-SECRET-77aa91";
const target = (over: Partial<ScanTarget> = {}): ScanTarget => ({
    applicationId: "app-1",
    origin: "http://127.0.0.1:9601",
    urls: ["http://127.0.0.1:9601/", "http://127.0.0.1:9601/api/books"],
    excludedPaths: ["/admin", "/v1/payments"],
    maxRequestsPerSecond: 2,
    requestBudget: 100,
    timeoutMs: 60_000,
    authHeader: { name: "Authorization", value: SECRET },
    spec: null,
    aiInterface: null,
    ...over,
});
const approval: ScanApproval = { profile: "advanced", approvedByUserId: "u1", approvedByName: "Ana", approvedAt: new Date().toISOString(), environment: "staging", statement: "ok" };
const outcome = (stdout = "") => ({ code: 0, signal: null, stopped: false, stopReason: null, stdout, stderr: "", truncated: false, tookMs: 1 }) as never;

describe("Schemathesis: check names, excluded operations, the sign-in", () => {
    it("chooses the checks the installed version knows: one unknown name would refuse the whole run", () => {
        expect(versionAtLeast("4.32.4", "4.25.0")).toBe(true);
        expect(versionAtLeast("4.24.9", "4.25.0")).toBe(false);
        const old = checksForVersion("passive", "4.24.0");
        expect(old.checks).not.toContain("allow_header_conformance");
        expect(old.leftOut).toEqual(["allow_header_conformance"]);
        expect(checksForVersion("passive", "4.32.4").leftOut).toEqual([]);
        expect(checksForVersion("passive", "4.32.4").checks).toContain("allow_header_conformance");
        const adv = checksForVersion("advanced", "4.30.0");
        expect(adv.leftOut).toEqual(["object_level_authorization"]);
        expect(adv.checks).not.toContain("object_level_authorization");
        // An unreadable version keeps only the checks every 4.x has.
        expect(checksForVersion("passive", undefined).checks).not.toContain("allow_header_conformance");
    });

    it("takes every operation under an excluded path out of the document, counting the document's own base path", () => {
        const doc = JSON.stringify({ openapi: "3.0.3", servers: [{ url: "https://api.example.com/v1" }], paths: { "/books": {}, "/payments/refund": {}, "/payments": {}, "/admin/users": {}, "/administer": {} } });
        const out = withoutExcludedOperations(doc, ["/admin", "/v1/payments"]);
        if ("refused" in out) throw new Error(out.refused);
        expect(Object.keys(JSON.parse(out.text).paths).sort()).toEqual(["/administer", "/books"]);
        expect(out.removed.sort()).toEqual(["/admin/users", "/payments", "/payments/refund"]);
        // YAML too; Swagger 2 basePath counts the same way.
        const yaml = "swagger: '2.0'\nbasePath: /v1\npaths:\n  /payments/x: {}\n  /ok: {}\n";
        const y = withoutExcludedOperations(yaml, ["/v1/payments"]);
        if ("refused" in y) throw new Error(y.refused);
        expect(Object.keys(JSON.parse(y.text).paths)).toEqual(["/ok"]);
        // Nothing excluded: the document is handed over unchanged. Unreadable while something must be excluded: refused.
        expect(withoutExcludedOperations(doc, [])).toEqual({ text: doc, removed: [] });
        expect("refused" in withoutExcludedOperations("{not a document", ["/admin"])).toBe(true);
        expect(excludePathArgs(["/admin/", "/a.b"])).toEqual(["--exclude-path-regex", "^/admin(/|$)", "--exclude-path-regex", "^/a\\.b(/|$)"]);
    });

    it("presents the saved sign-in through its config file and environment, never as an argument or in the file", async () => {
        expect(authConfigToml("Authorization")).toBe(`headers = { "Authorization" = "\${${AUTH_ENV}}" }\n`);
        const seen: { args: string[]; env: Record<string, string>; spec?: string; config?: string }[] = [];
        const adapter = new SchemathesisAdapter({
            settings: scannerSettings({ SECURITY_SCANNERS: "schemathesis" }),
            resolve: () => "/fake/schemathesis",
            run: (async (o: { args: string[]; env: Record<string, string> }) => {
                if (o.args.includes("--version")) return outcome("schemathesis, version 4.24.0");
                const at = (flag: string) => o.args[o.args.indexOf(flag) + 1]!;
                seen.push({ args: o.args, env: o.env, spec: readFileSync(o.args[o.args.indexOf("run") + 1]!, "utf8"), config: readFileSync(at("--config-file"), "utf8") });
                return outcome();
            }) as never,
            readFile: async () => "",
        });
        const spec = { fileName: "api.json", text: JSON.stringify({ openapi: "3.0.3", servers: [{ url: "http://127.0.0.1:9601" }], paths: { "/api/books": {}, "/admin/users": {} } }) };
        await adapter.start(target({ spec }), "passive", { signal: new AbortController().signal }).then((h) => h.cleanup()).catch((e) => {
            if (!(e instanceof ScannerError)) throw e;
        });
        expect(seen.length).toBe(1);
        const run = seen[0]!;
        expect(run.args.slice(0, 3)).toEqual(["--config-file", run.args[1], "run"]);
        expect(run.args.join(" ")).not.toContain(SECRET);
        expect(run.config).not.toContain(SECRET);
        expect(run.env[AUTH_ENV]).toBe(SECRET);
        expect(Object.keys(JSON.parse(run.spec!).paths)).toEqual(["/api/books"]);
        expect(run.args).toContain("--exclude-path-regex");
        expect(run.args[run.args.indexOf("--checks") + 1]).not.toContain("allow_header_conformance");
        expect(run.args).not.toContain("--generation-deterministic");
    });

    it("refuses a Schemathesis older than 4.0, whose report flags do not exist", async () => {
        const adapter = new SchemathesisAdapter({ settings: scannerSettings({ SECURITY_SCANNERS: "schemathesis" }), resolve: () => "/fake/st", run: (async () => outcome("schemathesis, version 3.39.5")) as never });
        const spec = { fileName: "a.json", text: '{"openapi":"3.0.3","paths":{}}' };
        await expect(adapter.start(target({ spec }), "passive", { signal: new AbortController().signal })).rejects.toThrow(/older than 4\.0\.0/);
    });
});

describe("Nuclei: no offline -passive, a read-only template set, the sign-in from a file", () => {
    const dir = path.join(tmp, "templates");
    const write = (name: string, body: string) => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, name), body);
    };
    write("get-headers.yaml", "id: get-headers\ninfo:\n  severity: info\n  tags: header\nhttp:\n  - method: GET\n    path: ['{{BaseURL}}/']\n");
    write("post-login.yaml", "id: post-login\ninfo:\n  severity: high\n  tags: header\nhttp:\n  - method: POST\n    path: ['{{BaseURL}}/login']\n    body: 'u=a&p=b'\n");
    write("raw-delete.yaml", "id: raw-delete\ninfo:\n  severity: high\n  tags: exposure\nhttp:\n  - raw:\n      - |\n        DELETE /x HTTP/1.1\n        Host: {{Hostname}}\n");
    write("payloads.yaml", "id: payloads\ninfo:\n  severity: low\n  tags: exposure\nhttp:\n  - method: GET\n    path: ['{{BaseURL}}/?q={{p}}']\n    payloads:\n      p: ['a']\n");
    write("dns.yaml", "id: dns\ninfo:\n  severity: info\n  tags: tech\ndns:\n  - name: '{{FQDN}}'\n");

    it("calls a template read-only only when every request is GET or HEAD with no payloads, and the passive profile needs that", () => {
        expect(templateIsReadOnly({ id: "a", http: [{ method: "GET", path: ["x"] }] })).toBe(true);
        expect(templateIsReadOnly({ id: "a", requests: [{ path: ["x"] }] })).toBe(true);
        expect(templateIsReadOnly({ id: "a", ssl: [{ address: "x" }] })).toBe(true);
        expect(templateIsReadOnly({ id: "a", http: [{ method: "POST" }] })).toBe(false);
        expect(templateIsReadOnly({ id: "a", http: [{ raw: ["PUT /x HTTP/1.1"] }] })).toBe(false);
        expect(templateIsReadOnly({ id: "a", http: [{ method: "GET", fuzzing: [{}] }] })).toBe(false);
        expect(templateIsReadOnly({ id: "a", dns: [{}] })).toBe(false);
        expect(templateIsReadOnly({ id: "a" })).toBe(false);
        for (const t of ["default-login", "cve", "headless"]) expect(PROFILE_TAGS.passive).not.toContain(t);
        expect(templateAllowed({ id: "x", severity: "info", tags: ["header"], readOnly: false }, "passive").ok).toBe(false);
        expect(templateAllowed({ id: "x", severity: "info", tags: ["header"] }, "passive").ok).toBe(false);
        expect(templateAllowed({ id: "x", severity: "info", tags: ["header"], readOnly: true }, "passive").ok).toBe(true);
    });

    it("runs only the read-only templates at the passive profile, without -passive, with the blocked tags again and the header from a file", async () => {
        let args: string[] = [];
        let templates = "";
        let headers = "";
        const adapter = new NucleiAdapter({
            settings: scannerSettings({ SECURITY_SCANNERS: "nuclei", SECURITY_NUCLEI_TEMPLATES: dir }),
            resolve: () => "/fake/nuclei",
            run: (async (o: { args: string[] }) => {
                args = o.args;
                templates = readFileSync(o.args[o.args.indexOf("-t") + 1]!, "utf8");
                headers = readFileSync(o.args[o.args.indexOf("-H") + 1]!, "utf8");
                return outcome("");
            }) as never,
        });
        const h = await adapter.start(target(), "passive", { signal: new AbortController().signal });
        await h.cleanup();
        expect(args).not.toContain("-passive");
        expect(args[args.indexOf("-etags") + 1]).toContain("bruteforce");
        expect(args.join(" ")).not.toContain(SECRET);
        expect(headers.trim()).toBe(`Authorization: ${SECRET}`);
        const used = templates.trim().split("\n").map((f) => path.basename(f));
        expect(used).toEqual(["get-headers.yaml"]);
    });

    it("refuses a template that dials the target itself (an ssl section bypasses the HTTP proxy) unless the run is isolated", () => {
        expect(templateDialsDirectly({ id: "a", ssl: [{ address: "{{Host}}:{{Port}}" }] })).toBe(true);
        expect(templateDialsDirectly({ id: "a", http: [{ method: "GET" }], ssl: [{}] })).toBe(true);
        expect(templateDialsDirectly({ id: "a", network: [{}] })).toBe(true);
        expect(templateDialsDirectly({ id: "a", info: {}, variables: {}, http: [{ method: "GET" }], requests: [{}] })).toBe(false);
        // Raw-socket requests (unsafe, pipelined) are not shown to go through nuclei's -proxy: refused unless the run is isolated.
        const unsafeRaw = { id: "a", http: [{ raw: ["GET / HTTP/1.1\nHost: {{Hostname}}\n\n"], unsafe: true }] };
        expect(templateIsReadOnly(unsafeRaw)).toBe(true);
        expect(templateDialsDirectly(unsafeRaw)).toBe(true);
        expect(templateDialsDirectly({ id: "a", requests: [{ raw: ["GET / HTTP/1.1"], unsafe: "true" }] })).toBe(true);
        expect(templateDialsDirectly({ id: "a", http: [{ raw: ["GET / HTTP/1.1"], pipeline: true }] })).toBe(true);
        expect(templateDialsDirectly({ id: "a", http: [{ raw: ["GET / HTTP/1.1"], unsafe: false }] })).toBe(false);
        const facts = { id: "a", severity: "info", tags: ["misconfig"], path: "a.yaml", readOnly: true, safeMethodsOnly: true, dialsDirectly: templateDialsDirectly(unsafeRaw) };
        expect(templateAllowed(facts, "passive").ok).toBe(false);
        const tls = { id: "tls", severity: "info", tags: ["ssl"], readOnly: true, safeMethodsOnly: true, dialsDirectly: true };
        for (const level of ["passive", "conservative-active", "advanced"] as const) {
            const no = templateAllowed(tls, level);
            expect(no.ok, level).toBe(false);
            expect(no.reason).toMatch(/request guard.*not isolated/);
            expect(templateAllowed(tls, level, { isolated: false }).ok, level).toBe(false);
            expect(templateAllowed(tls, level, { isolated: true }).ok, level).toBe(true);
        }
    });

    it("leaves ssl templates out of a run that is not isolated, and keeps them in an isolated one", async () => {
        write("tls-version.yaml", "id: tls-version\ninfo:\n  severity: info\n  tags: ssl\nssl:\n  - address: '{{Host}}:443'\n");
        const used = async (isolated: boolean) => {
            let templates = "";
            const adapter = new NucleiAdapter({
                settings: scannerSettings({ SECURITY_SCANNERS: "nuclei", SECURITY_NUCLEI_TEMPLATES: dir }),
                resolve: () => "/fake/nuclei",
                run: (async (o: { args: string[] }) => {
                    const at = o.args.indexOf("-t");
                    templates = readFileSync(o.args[at + 1]!, "utf8");
                    return outcome("");
                }) as never,
            });
            const t = target();
            if (isolated) {
                const iso = { mechanism: "test", wrap: (file: string, args: readonly string[]) => ({ file, args: [...args], cwd: tmp }), close: async () => undefined } as unknown as IsolatedEgress;
                setIsolationFor(t, iso);
            }
            const h = await adapter.start(t, "passive", { signal: new AbortController().signal });
            await h.cleanup();
            return templates.trim().split("\n").map((f) => path.basename(f));
        };
        expect(await used(false)).toEqual(["get-headers.yaml"]);
        expect(await used(true)).toEqual(["get-headers.yaml", "tls-version.yaml"]);
    });
});

/** ZAP's Replacer as the adapter uses it: rules by description, each with the address pattern it was given. */
const replacerFake = (rules: Array<Record<string, string>> = [], over: { keepsUrl?: boolean; removes?: (description: string) => boolean; reads?: () => boolean } = {}) => {
    const answer = (n: string, q: Record<string, unknown>): Record<string, unknown> => {
        if (n === "rules") {
            if (over.reads && !over.reads()) throw new Error("ZAP did not answer replacer/view/rules in time.");
            return { rules: rules.map((r) => ({ ...r })) };
        }
        if (n === "addRule") rules.push({ description: String(q.description), enabled: "true", matchType: String(q.matchType), matchString: String(q.matchString), replacement: String(q.replacement), url: over.keepsUrl === false ? "" : String(q.url ?? "") });
        if (n === "removeRule") {
            if (over.removes && !over.removes(String(q.description))) throw new Error("ZAP did not answer replacer/action/removeRule in time.");
            const i = rules.findIndex((r) => r.description === q.description);
            if (i < 0) throw new Error("does_not_exist");
            rules.splice(i, 1);
        }
        return { Result: "OK" };
    };
    return Object.assign(answer, { rules });
};

describe("ZAP: a saved sign-in never reaches another application through the shared daemon", () => {
    const settings = scannerSettings({ SECURITY_SCANNERS: "zap", SECURITY_ZAP_URL: "http://127.0.0.1:9602", SECURITY_ZAP_API_KEY: "k" });
    const OTHER = "session=OTHER-APPLICATION-9f2c";
    const stale = () => ({ description: "freit-20261101090000-signin", enabled: "true", matchType: "REQ_HEADER", matchString: "Cookie", replacement: OTHER, url: "" });
    const daemon = (replacer: ReturnType<typeof replacerFake>, over: { access?: () => void } = {}) => {
        const calls: Array<{ c: string; n: string; q: Record<string, unknown>; rules: string[] }> = [];
        const logs: string[] = [];
        const fetchJson = (async (_base: string, c: string, _op: string, n: string, o: { query?: Record<string, unknown> } = {}) => {
            calls.push({ c, n, q: o.query ?? {}, rules: replacer.rules.map((r) => r.description) });
            if (c === "replacer") return replacer(n, o.query ?? {});
            if (c === "core" && n === "accessUrl") over.access?.();
            if (c === "pscan" && n === "recordsToScan") return { recordsToScan: "0" };
            if (c === "alert" && n === "alerts") return { alerts: [] };
            return { Result: "OK" };
        }) as never;
        const start = (t: ScanTarget, signal = new AbortController().signal) => new ZapAdapter({ settings, fetchJson, sleep: async () => undefined }).start(t, "passive", { signal, log: (event, data) => logs.push(`${event} ${JSON.stringify(data)}`) });
        return { calls, logs, start, replacer };
    };

    it("limits the sign-in rule to the target's own origin, and the pattern does not cover a longer host that starts the same", async () => {
        const d = daemon(replacerFake());
        await (await d.start(target())).cleanup();
        const add = d.calls.find((x) => x.c === "replacer" && x.n === "addRule")!;
        expect(add.q.url).toBe(signinRuleUrl("http://127.0.0.1:9601"));
        const pattern = new RegExp(String(add.q.url));
        for (const yes of ["http://127.0.0.1:9601", "http://127.0.0.1:9601/", "http://127.0.0.1:9601/api/books?x=1"]) expect(pattern.test(yes), yes).toBe(true);
        for (const no of ["http://127.0.0.1:96010/", "http://127.0.0.1:9601.other.example/", "http://other.example/", "https://127.0.0.1:9601/", "http://other.example/?next=http://127.0.0.1:9601/"]) expect(pattern.test(no), no).toBe(false);
        expect(new RegExp(signinRuleUrl("https://shop.example")).test("https://shopxexample/")).toBe(false);
        // Gone again at the end, and confirmed by reading the rules after the removal.
        expect(d.replacer.rules).toEqual([]);
        expect(d.calls.at(-1 - d.calls.slice().reverse().findIndex((x) => x.c === "replacer"))).toMatchObject({ n: "rules" });
    });

    it("refuses the run when ZAP does not confirm the address limit, before any request, and leaves no rule behind", async () => {
        const d = daemon(replacerFake([], { keepsUrl: false }));
        await expect(d.start(target())).rejects.toThrow(/did not confirm that the saved sign-in is limited to this application's own address/);
        expect(d.calls.some((x) => x.c === "core" && x.n === "accessUrl")).toBe(false);
        expect(d.replacer.rules).toEqual([]);
    });

    it("removes a sign-in rule an earlier run left behind before the first request, also for a run without a sign-in", async () => {
        for (const withSignin of [true, false]) {
            const d = daemon(replacerFake([stale(), { description: "someone-elses-rule", url: "" }]));
            await (await d.start(target(withSignin ? {} : { authHeader: null }))).cleanup();
            const requests = d.calls.filter((x) => x.c === "core" && x.n === "accessUrl");
            expect(requests.length).toBe(2);
            for (const r of requests) expect(r.rules.filter((name) => name === "freit-20261101090000-signin"), String(withSignin)).toEqual([]);
            // Only the platform's own sign-in rules are touched.
            expect(d.replacer.rules.map((r) => r.description)).toEqual(["someone-elses-rule"]);
            expect(JSON.stringify(d.logs)).not.toContain(OTHER);
        }
    });

    it("refuses to request anything while an earlier sign-in rule cannot be removed, or the rules cannot be read", async () => {
        const stuck = daemon(replacerFake([stale()], { removes: () => false }));
        const e = await stuck.start(target({ authHeader: null })).catch((x) => x);
        expect(e).toBeInstanceOf(ScannerError);
        expect((e as ScannerError).message).toMatch(/could not confirm that no saved sign-in is left switched on/);
        expect(`${(e as ScannerError).message} ${(e as ScannerError).detail}`).not.toContain(OTHER);
        expect(stuck.calls.some((x) => x.c === "core" && x.n === "accessUrl")).toBe(false);
        expect(stuck.calls.some((x) => x.c === "replacer" && x.n === "addRule")).toBe(false);

        const unread = daemon(replacerFake([stale()], { reads: () => false }));
        await expect(unread.start(target())).rejects.toThrow(/could not confirm that no saved sign-in is left switched on/);
        expect(unread.calls.some((x) => x.c === "core" && x.n === "accessUrl")).toBe(false);
        expect(unread.calls.some((x) => x.c === "replacer" && x.n === "addRule")).toBe(false);
    });

    it("fails the run when its own sign-in rule cannot be confirmed removed at the end, and tries more than once", async () => {
        let requested = false;
        let removals = 0;
        const replacer = replacerFake([], { removes: () => (requested ? (removals++, false) : true) });
        const d = daemon(replacer, { access: () => (requested = true) });
        await expect(d.start(target())).rejects.toThrow(/could not confirm that no saved sign-in is left switched on/);
        expect(removals).toBe(ZAP_SIGNIN_REMOVE_ROUNDS);
        expect(d.logs.join("\n")).toMatch(/signin-rule-left/);
        expect(d.logs.join("\n")).not.toContain(SECRET);

        // One removal that times out is tried again and the run still succeeds.
        let failed = false;
        const flaky = daemon(replacerFake([], { removes: () => (failed ? true : ((failed = true), false)) }));
        await (await flaky.start(target())).cleanup();
        expect(flaky.replacer.rules).toEqual([]);
    });

    it("still removes the sign-in rule when the run is cancelled part-way", async () => {
        const abort = new AbortController();
        const d = daemon(replacerFake(), { access: () => abort.abort() });
        await expect(d.start(target(), abort.signal)).rejects.toThrow(/cancelled/);
        expect(d.replacer.rules).toEqual([]);
        expect(d.calls.filter((x) => x.c === "replacer" && x.n === "removeRule").length).toBe(1);
    });

    it("removeSigninRules reads a daemon without the Replacer add-on as having no rules", async () => {
        await expect(removeSigninRules(async () => { throw new ZapApiError(400, "http_error", "ZAP answered 400 for replacer/view/rules.", '{"code":"no_implementor","message":"No Implementor"}'); })).resolves.toBeUndefined();
        await expect(removeSigninRules(async () => { throw new ZapApiError(500, "http_error", "ZAP answered 500 for replacer/view/rules."); })).rejects.toThrow(/could not confirm/);
        expect(ZAP_SIGNIN_RULE.test("freit-20261114101500-signin")).toBe(true);
        expect(ZAP_SIGNIN_RULE.test("freit-app-1-2rps")).toBe(false);
    });
});

describe("ZAP: alerts ZAP keeps hidden behind a listed one do not hide this run's findings", () => {
    const settings = scannerSettings({ SECURITY_SCANNERS: "zap", SECURITY_ZAP_URL: "http://127.0.0.1:9602", SECURITY_ZAP_API_KEY: "k" });
    const URL1 = "http://127.0.0.1:9601/";
    const alertAt = (id: number) => ({ id: String(id), pluginId: "10021", alert: "X-Content-Type-Options Header Missing", risk: "Low", confidence: "Medium", url: URL1, method: "GET", evidence: "" });
    /** ZAP lists one alert per rule and page; repeats wait behind it and one layer comes up with each delete. A new repeat is hidden while any row is held. */
    const daemon = (layers: number, endless = false) => {
        let held = Array.from({ length: layers }, (_, i) => alertAt(i + 1));
        let deletes = 0;
        let next = 1000;
        const calls: string[] = [];
        const fetchJson = (async (_base: string, c: string, _op: string, n: string, o: { query?: Record<string, unknown> } = {}) => {
            calls.push(`${c}/${n}`);
            if (c === "alert" && n === "deleteAlerts") {
                deletes++;
                if (!endless) held = held.slice(1);
                return { Result: "OK" };
            }
            if (c === "core" && n === "accessUrl") {
                if (o.query?.url === URL1) held.push(alertAt(next++));
                return { Result: "OK" };
            }
            if (c === "alert" && n === "alerts") return { alerts: held.slice(0, 1) };
            if (c === "pscan" && n === "recordsToScan") return { recordsToScan: "0" };
            if (c === "replacer" && n === "rules") return { rules: [] };
            return { Result: "OK" };
        }) as never;
        return { calls, deletes: () => deletes, start: () => new ZapAdapter({ settings, fetchJson, sleep: async () => undefined }).start(target({ authHeader: null }), "passive", { signal: new AbortController().signal }) };
    };

    it("deletes until nothing is listed, so a repeat run still reports its finding", async () => {
        const d = daemon(4);
        const h = await d.start();
        const r = await h.results();
        expect(d.deletes()).toBe(4);
        expect(r.findings.map((f) => f.url)).toEqual([URL1]);
        expect(r.coverage.notInspected.join(" ")).not.toMatch(/before this run started/);
    });

    it("fails with a plain sentence, and requests nothing, when alerts are still there after the bounded number of deletions", async () => {
        const d = daemon(1, true);
        const e = await d.start().catch((x) => x);
        expect(e).toBeInstanceOf(ScannerError);
        expect((e as ScannerError).message).toMatch(/still held alerts for this application after they were deleted/);
        expect(d.deletes()).toBe(ZAP_DELETE_ROUNDS);
        expect(d.calls).not.toContain("core/accessUrl");
    });
});

describe("ZAP: the alert cap is set with the action the daemon has, and a daemon that takes neither is named in the coverage", () => {
    const settings = scannerSettings({ SECURITY_SCANNERS: "zap", SECURITY_ZAP_URL: "http://127.0.0.1:9602", SECURITY_ZAP_API_KEY: "k" });
    const run = async (has: string[]) => {
        const calls: Array<{ name: string; q: Record<string, unknown> }> = [];
        const fetchJson = (async (_base: string, c: string, _op: string, n: string, o: { query?: Record<string, unknown> } = {}) => {
            calls.push({ name: `${c}/${n}`, q: o.query ?? {} });
            if (/MaxAlertsPerRule/.test(n) && !has.includes(`${c}/${n}`)) throw new ZapApiError(400, "http_error", `ZAP answered 400 for ${c}/action/${n}.`, '{"code":"bad_action"}');
            if (c === "alert" && n === "alerts") return { alerts: [] };
            if (c === "pscan" && n === "recordsToScan") return { recordsToScan: "0" };
            if (c === "replacer" && n === "rules") return { rules: [] };
            return { Result: "OK" };
        }) as never;
        const h = await new ZapAdapter({ settings, fetchJson, sleep: async () => undefined }).start(target({ authHeader: null }), "passive", { signal: new AbortController().signal });
        return { calls: calls.filter((x) => /MaxAlertsPerRule/.test(x.name)), coverage: (await h.results()).coverage };
    };

    it("uses pscan/setMaxAlertsPerRule (ZAP 2.17), falls back to the old core option, and says so when neither is taken", async () => {
        const current = await run(["pscan/setMaxAlertsPerRule"]);
        expect(current.calls).toEqual([{ name: "pscan/setMaxAlertsPerRule", q: { maxAlerts: 50 } }]);
        expect(current.coverage.notInspected.join(" ")).not.toMatch(/did not accept the limit/);

        const older = await run(["core/setOptionMaxAlertsPerRule"]);
        expect(older.calls.map((x) => x.name)).toEqual(["pscan/setMaxAlertsPerRule", "core/setOptionMaxAlertsPerRule"]);
        expect(older.coverage.notInspected.join(" ")).not.toMatch(/did not accept the limit/);

        const neither = await run([]);
        expect(neither.coverage.notInspected.join(" ")).toMatch(/ZAP did not accept the limit of 50 alerts for each rule, so it kept its own setting/);
    });
});

describe("ZAP: only the alerts this run produced are reported", () => {
    const settings = scannerSettings({ SECURITY_SCANNERS: "zap", SECURITY_ZAP_URL: "http://127.0.0.1:9602", SECURITY_ZAP_API_KEY: "k" });
    const alertAt = (id: number, url: string) => ({ id: String(id), pluginId: "10021", alert: "X-Content-Type-Options Header Missing", risk: "Low", confidence: "Medium", url, method: "GET", evidence: "" });
    const old = [alertAt(1, "http://127.0.0.1:9601/"), alertAt(2, "http://127.0.0.1:9601/api/books"), alertAt(3, "http://127.0.0.1:9601/api/books")];
    /** A fake daemon that already holds alerts from an earlier run at the same addresses. `canDelete`: it has alert/action/deleteAlerts. `raises`: what this run's requests add. */
    const daemon = (canDelete: boolean, raises: ReturnType<typeof alertAt>[]) => {
        let table = [...old];
        const calls: string[] = [];
        const fetchJson = (async (_base: string, c: string, _op: string, n: string, o: { query?: Record<string, unknown> } = {}) => {
            calls.push(`${c}/${n}`);
            if (c === "alert" && n === "deleteAlerts") {
                if (!canDelete) throw new Error("bad_action");
                expect(o.query?.baseurl).toBe("http://127.0.0.1:9601");
                table = [];
                return { Result: "OK" };
            }
            if (c === "core" && n === "accessUrl") {
                table.push(...raises.filter((a) => a.url === o.query?.url));
                return { Result: "OK" };
            }
            if (c === "alert" && n === "alerts") return { alerts: table.slice(Number(o.query?.start ?? 0), Number(o.query?.start ?? 0) + Number(o.query?.count ?? 500)) };
            if (c === "pscan" && n === "recordsToScan") return { recordsToScan: "0" };
            return { Result: "OK" };
        }) as never;
        return { calls, adapter: new ZapAdapter({ settings, fetchJson, sleep: async () => undefined }) };
    };
    const run = async (canDelete: boolean, raises: ReturnType<typeof alertAt>[]) => {
        const d = daemon(canDelete, raises);
        const h = await d.adapter.start(target({ authHeader: null }), "passive", { signal: new AbortController().signal });
        const r = await h.results();
        await h.cleanup();
        return { ...r, calls: d.calls };
    };

    it("a run that raised nothing reports nothing, though the daemon held earlier alerts for the same addresses", async () => {
        for (const canDelete of [true, false]) {
            const r = await run(canDelete, []);
            expect(r.findings, String(canDelete)).toEqual([]);
            expect(r.coverage.inspected.join(" ")).toMatch(/ZAP reported 0 alerts for this origin in this run; 0 became findings/);
        }
    });

    it("clears the target's old alerts before the first request, and reports only what was raised afterwards", async () => {
        const r = await run(true, [alertAt(7, "http://127.0.0.1:9601/")]);
        expect(r.calls.indexOf("alert/deleteAlerts")).toBeGreaterThan(-1);
        expect(r.calls.indexOf("alert/deleteAlerts")).toBeLessThan(r.calls.indexOf("core/accessUrl"));
        expect(r.findings.map((f) => f.url)).toEqual(["http://127.0.0.1:9601/"]);
        expect(r.coverage.notInspected.join(" ")).not.toMatch(/before this run started/);
    });

    it("on a daemon that cannot delete, leaves out the alerts that were there before the run and says so", async () => {
        const r = await run(false, [alertAt(7, "http://127.0.0.1:9601/"), alertAt(8, "http://127.0.0.1:9601/api/books")]);
        expect(r.findings.map((f) => f.url)).toEqual(["http://127.0.0.1:9601/", "http://127.0.0.1:9601/api/books"]);
        expect(r.coverage.inspected.join(" ")).toMatch(/ZAP reported 2 alerts for this origin in this run; 2 became findings/);
        expect(r.coverage.notInspected.join(" ")).toMatch(/3 alerts ZAP already held for this origin before this run started were left out/);
    });
});

describe("ZAP: no active scan without an approved advanced profile, never recursive from the origin", () => {
    const settings = scannerSettings({ SECURITY_SCANNERS: "zap", SECURITY_ZAP_URL: "http://127.0.0.1:9602", SECURITY_ZAP_API_KEY: "k" });
    const fake = () => {
        const calls: Array<{ c: string; n: string; q: Record<string, unknown> }> = [];
        let scans = 0;
        const fetchJson = (async (_base: string, c: string, _op: string, n: string, o: { query?: Record<string, unknown> } = {}) => {
            calls.push({ c, n, q: o.query ?? {} });
            if (c === "ascan" && n === "scan") return { scan: String(++scans) };
            if (c === "ascan" && n === "scans") return { scan: [] };
            if (c === "ascan" && n === "status") return { status: "100" };
            if (c === "pscan" && n === "recordsToScan") return { recordsToScan: "0" };
            if (c === "alert" && n === "alerts") return { alerts: [] };
            if (c === "core" && n === "mode") return { mode: "standard" };
            if (c === "replacer") return replacer(n, o.query ?? {});
            return { Result: "OK" };
        }) as never;
        const replacer = replacerFake();
        return { calls, adapter: new ZapAdapter({ settings, fetchJson, sleep: async () => undefined }) };
    };

    it("drives conservative-active like passive: only a visitor's requests, no active scanner", async () => {
        const { calls, adapter } = fake();
        const h = await adapter.start(target({ authHeader: null }), "conservative-active", { signal: new AbortController().signal });
        await h.cleanup();
        expect(calls.some((x) => x.c === "ascan" && x.n === "scan")).toBe(false);
        expect(calls.filter((x) => x.c === "core" && x.n === "accessUrl").length).toBe(2);
    });

    it("refuses the advanced profile without an approval, and with one scans each in-scope address without recursion", async () => {
        await expect(fake().adapter.start(target(), "advanced", { signal: new AbortController().signal })).rejects.toThrow(/approval/);
        const { calls, adapter } = fake();
        const h = await adapter.start(target(), "advanced", { signal: new AbortController().signal, approval });
        await h.cleanup();
        const scans = calls.filter((x) => x.c === "ascan" && x.n === "scan");
        expect(scans.map((x) => x.q.url)).toEqual(target().urls);
        for (const s of scans) expect(s.q.recurse).toBe(false);
        // Only each address's GET message is the starting point of the active scan.
        for (const s of scans) expect(s.q.method).toBe("GET");
        // The sign-in goes in as this run's Replacer rule, which is removed again at the end.
        const add = calls.find((x) => x.c === "replacer" && x.n === "addRule")!;
        expect(add.q).toMatchObject({ matchType: "REQ_HEADER", matchString: "Authorization", replacement: SECRET });
        expect(calls.some((x) => x.c === "replacer" && x.n === "removeRule" && x.q.description === add.q.description)).toBe(true);
    });
});

describe("Promptfoo: a plain refusal when there is no AI interface to evaluate", () => {
    it("says why before looking for the tool, because that reason holds whatever is installed", async () => {
        const adapter = new PromptfooAdapter({ settings: scannerSettings({ SECURITY_SCANNERS: "promptfoo" }), resolve: () => undefined });
        const e = await adapter.start(target(), "passive", { signal: new AbortController().signal }).catch((x) => x);
        expect(e).toBeInstanceOf(ScannerError);
        expect((e as ScannerError).message).toBe(NO_AI_INTERFACE);
        expect(String((e as ScannerError).detail ?? "")).toMatch(/no setting/);
    });
});

describe("ZAP: only a daemon without the delete action falls back to leaving earlier alerts out", () => {
    const settings = scannerSettings({ SECURITY_SCANNERS: "zap", SECURITY_ZAP_URL: "http://127.0.0.1:9602", SECURITY_ZAP_API_KEY: "k" });
    const URL1 = "http://127.0.0.1:9601/";
    const alertAt = (id: number) => ({ id: String(id), pluginId: "10021", alert: "X-Content-Type-Options Header Missing", risk: "Low", confidence: "Medium", url: URL1, method: "GET", evidence: "" });
    /** Three hidden layers of earlier alerts; `fail(round)` is what deleteAlerts throws in that round (0-based), or undefined to work. */
    const daemon = (fail: (round: number) => Error | undefined) => {
        let held = [alertAt(1), alertAt(2), alertAt(3)];
        let round = 0;
        const calls: string[] = [];
        const fetchJson = (async (_base: string, c: string, _op: string, n: string, o: { query?: Record<string, unknown> } = {}) => {
            calls.push(`${c}/${n}`);
            if (c === "alert" && n === "deleteAlerts") {
                const e = fail(round++);
                if (e) throw e;
                held = held.slice(1);
                return { Result: "OK" };
            }
            if (c === "core" && n === "accessUrl") {
                if (o.query?.url === URL1) held.push(alertAt(100 + calls.length));
                return { Result: "OK" };
            }
            if (c === "alert" && n === "alerts") return { alerts: held.slice(0, 1) };
            if (c === "pscan" && n === "recordsToScan") return { recordsToScan: "0" };
            if (c === "replacer" && n === "rules") return { rules: [] };
            return { Result: "OK" };
        }) as never;
        return { calls, start: () => new ZapAdapter({ settings, fetchJson, sleep: async () => undefined }).start(target({ authHeader: null }), "passive", { signal: new AbortController().signal }) };
    };
    const missing = (code: string) => new ZapApiError(400, "http_error", "ZAP answered 400 for alert/action/deleteAlerts.", JSON.stringify({ code, message: "No such action" }));

    it("falls back (and says so) when the first call answers that the action does not exist", async () => {
        for (const code of ["bad_action", "bad_view", "no_implementor"]) {
            const d = daemon((r) => (r === 0 ? missing(code) : undefined));
            const r = await (await d.start()).results();
            expect(r.coverage.notInspected.join(" "), code).toMatch(/already held for this origin before this run started (was|were) left out/);
            expect(d.calls.filter((c) => c === "alert/deleteAlerts"), code).toHaveLength(1);
        }
    });

    it("fails the run with a plain sentence, before any request, on any other error or on an error after the first round", async () => {
        const cases: Array<[string, (round: number) => Error | undefined]> = [
            ["a 500 in the first round", (r) => (r === 0 ? new ZapApiError(500, "http_error", "ZAP answered 500 for alert/action/deleteAlerts.") : undefined)],
            ["a timeout in the first round", (r) => (r === 0 ? new Error("ZAP did not answer alert/action/deleteAlerts in time.") : undefined)],
            ["a busy daemon in a later round", (r) => (r === 1 ? new ZapApiError(503, "http_error", "ZAP answered 503 for alert/action/deleteAlerts.") : undefined)],
            ["'no such action' in a later round", (r) => (r === 2 ? missing("bad_action") : undefined)],
        ];
        for (const [name, fail] of cases) {
            const d = daemon(fail);
            const e = await d.start().catch((x) => x);
            expect(e, name).toBeInstanceOf(ScannerError);
            expect((e as ScannerError).message, name).toBe("ZAP could not delete the alerts an earlier run left for this application, so this run's findings could not be told apart from an earlier run's. Nothing was requested.");
            expect(d.calls, name).not.toContain("core/accessUrl");
        }
    });
});

describe("ZAP: the sign-in clean-up never removes another platform process's live rule", () => {
    const settings = scannerSettings({ SECURITY_SCANNERS: "zap", SECURITY_ZAP_URL: "http://127.0.0.1:9602", SECURITY_ZAP_API_KEY: "k" });
    const stamp = (at: Date) => at.toISOString().replace(/[^0-9]/g, "").slice(0, 14);
    const other = ZAP_PROCESS_ID === "0badf00d" ? "1badf00d" : "0badf00d";
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60_000);

    it("judges a rule by its process id and age", () => {
        const at = { now: Date.now(), maxAgeMs: settings.runTimeoutMs + 10 * 60_000 };
        expect(signinRuleRemovable(`freit-${stamp(new Date())}-${ZAP_PROCESS_ID}-signin`, at)).toBe(true);
        expect(signinRuleRemovable(`freit-${stamp(new Date())}-${other}-signin`, at)).toBe(false);
        expect(signinRuleRemovable(`freit-${stamp(dayAgo)}-${other}-signin`, at)).toBe(true);
        expect(signinRuleRemovable(`freit-${stamp(new Date())}-signin`, at)).toBe(false);
        expect(signinRuleRemovable("freit-20261101090000-signin", { ...at, now: Date.UTC(2026, 10, 15) })).toBe(true);
        expect(signinRuleRemovable("freit-whatever-signin", at)).toBe(true);
        expect(signinRuleRemovable("someone-elses-rule", at)).toBe(false);
    });

    it("a run removes its own process's rules and rules older than the longest run, keeps another process's live rule, and names its own rule with its process id", async () => {
        const live = { description: `freit-${stamp(new Date())}-${other}-signin`, url: "^http://other\\.example(?:[/?#].*)?$", replacement: "session=LIVE-OTHER-RUN" };
        const mineStale = { description: `freit-${stamp(hourAgo)}-${ZAP_PROCESS_ID}-signin`, url: "", replacement: "x" };
        const oldOther = { description: `freit-${stamp(dayAgo)}-${other}-signin`, url: "", replacement: "y" };
        const replacer = replacerFake([live, mineStale, oldOther]);
        const added: string[] = [];
        const fetchJson = (async (_base: string, c: string, _op: string, n: string, o: { query?: Record<string, unknown> } = {}) => {
            if (c === "replacer") {
                if (n === "addRule") added.push(String(o.query?.description));
                return replacer(n, o.query ?? {});
            }
            if (c === "pscan" && n === "recordsToScan") return { recordsToScan: "0" };
            if (c === "alert" && n === "alerts") return { alerts: [] };
            return { Result: "OK" };
        }) as never;
        await (await new ZapAdapter({ settings, fetchJson, sleep: async () => undefined }).start(target(), "passive", { signal: new AbortController().signal })).cleanup();
        expect(added).toHaveLength(1);
        expect(added[0]).toMatch(new RegExp(`^freit-\\d{14}-${ZAP_PROCESS_ID}-signin$`));
        expect(replacer.rules.map((r) => r.description)).toEqual([live.description]);
    });
});
