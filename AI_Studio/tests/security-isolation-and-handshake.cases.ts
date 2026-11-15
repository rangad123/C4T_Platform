/**
 * Security fixes: the isolation check never runs synchronously inside a request and the server switch is
 * judged before it; the umount probe counts only a permission refusal as "refused"; the certificate handshake is the one narrow
 * exception to the request guard. Ports 9861-9862. Not a test file of its own: imported by security-core-unit.test.ts (the fast tier).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkEnvironment, detectIsolation, ISOLATION_STILL_CHECKING, isolationSupport, resetIsolationSupport, unmountOutcome, warmIsolation, type IsolationSupport } from "../src/security/egress/isolation.js";
import { GuardDownError, guardFor } from "../src/security/assessment/guard.js";
import { observeTls, TLS_ONLY_TARGET } from "../src/security/assessment/scan.js";
import { RefusedError } from "../src/security/assessment/types.js";
import type { SecurityApplication } from "../src/security/contract.js";
import type { Resolver } from "../src/security/scope.js";
import { securitySettings } from "../src/security/settings.js";
import { SecurityStore } from "../src/security/store.js";
import { createRun, listRuns, requestLogOfAssessment, runsOfAssessment, supersedeScannerRuns, updateRun } from "../src/security/scanners/store.js";
import { Db } from "../src/platform/db.js";
import { Repo } from "../src/platform/repo.js";
import { SecretBox } from "../src/platform/secrets.js";
import { companyTls, removeMintedTls, TLS_SKIP_REASON } from "./fixtures/tls-files.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sec-isolation-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("the isolation check never runs synchronously inside a request", () => {
    it("with nothing worked out yet, the first ask starts the background check and answers 'still running' at once", async () => {
        resetIsolationSupport();
        const started = Date.now();
        const first = isolationSupport();
        expect(Date.now() - started).toBeLessThan(200);
        expect(first).toEqual({ ok: false, missing: ISOLATION_STILL_CHECKING });
        // The check it started is the one in flight; once it ends, its answer is used.
        const answer = await warmIsolation(() => Promise.reject(new Error("a second check must not start")));
        expect(answer.ok || !/a second check must not start/.test(answer.missing)).toBe(true);
        expect(isolationSupport()).toBe(answer);
        resetIsolationSupport();
    }, 120_000);

    it("the start gate does not ask for the isolation when the server switch is off (nor when anything else refuses)", () => {
        const dir = fs.mkdtempSync(path.join(tmp, "db-"));
        const db = new Db(path.join(dir, "t.db"));
        const repo = new Repo(db, new SecretBox(dir));
        const store = new SecurityStore(db);
        const projectId = repo.createProject({ name: "Client" }).id;
        const app = store.createApplication(projectId, { name: "Shop", targetUrl: "https://shop.example/", environment: "staging" });
        store.addAuthorization(app.id, { basis: "owner", approverName: "Client Person", approverRole: "Head of Engineering", approverEmail: "person@client.example", documentReference: "SOW-1", authority: "Signed SOW-1.", statement: "I confirm.", confirmedByName: "Owner", maxProfile: "advanced" });
        let asked = 0;
        const isolationProblem = () => (asked++, "it would block the event loop");
        for (const [activeProfilesOn, crowd4testOn] of [[false, true], [false, false], [true, false], [true, true]] as const) {
            const { refused } = store.gateCheck(app, { kind: "conservative-active", authorizationId: null }, { activeProfilesOn, crowd4testOn, isolationProblem });
            expect(refused, `${activeProfilesOn} ${crowd4testOn}`).toBeTruthy();
        }
        // Refused for other reasons every time (switch off, no Crowd4Test sign-in, no approval): the isolation was never asked.
        expect(asked).toBe(0);
        db.close?.();
    });
});

describe("the umount probe counts only a permission refusal as refused", () => {
    it("judges umount's outcome", () => {
        expect(unmountOutcome({ status: 0, stderr: "" })).toBe("unmounted");
        expect(unmountOutcome({ status: 32, stderr: "umount: /run: must be superuser to unmount." })).toBe("refused");
        expect(unmountOutcome({ status: 32, stderr: "umount: /tmp: umount failed: Operation not permitted." })).toBe("refused");
        expect(unmountOutcome({ status: 1, stderr: "umount: /tmp: Permission denied" })).toBe("refused");
        // A missing command, a timeout, a signal or another error proves nothing.
        expect(unmountOutcome({ status: null, error: "ENOENT" })).toBe("unchecked");
        expect(unmountOutcome({ status: null, error: "ETIMEDOUT", signal: "SIGTERM" })).toBe("unchecked");
        expect(unmountOutcome({ status: 32, stderr: "umount: /tmp: target is busy." })).toBe("unchecked");
        expect(unmountOutcome({ status: 32, stderr: "umount: /tmp: not mounted." })).toBe("unchecked");
        expect(unmountOutcome(undefined)).toBe("unchecked");
    });

    const machine = detectIsolation();
    it.skipIf(!machine.ok)("in a real isolated environment: an umount that is missing or fails for another reason fails the check (closed)", () => {
        if (!machine.ok) return;
        // Outside the masked folders, so it is reachable from in there.
        const dir = fs.mkdtempSync(path.join(process.cwd(), ".test-umount-"));
        try {
            const other = path.join(dir, "umount-other");
            fs.writeFileSync(other, "#!/bin/sh\necho \"umount: $2: target is busy.\" >&2\nexit 32\n", { mode: 0o755 });
            const failed = checkEnvironment({ ...machine, umount: other } as Extract<IsolationSupport, { ok: true }>);
            expect(failed).toBe("whether /run can be unmounted from the scanners' environment could not be checked");
            const absent = checkEnvironment({ ...machine, umount: path.join(dir, "no-such-umount") } as Extract<IsolationSupport, { ok: true }>);
            expect(absent).toBe("whether /run can be unmounted from the scanners' environment could not be checked");
            // The real umount is refused for lack of permission: the check passes.
            expect(checkEnvironment(machine)).toBeUndefined();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 120_000);
});

const COMPANY = companyTls();
if (!COMPANY) console.warn(TLS_SKIP_REASON);
const TARGET_PORT = 9861;
const OTHER_PORT = 9862;
type Seen = { connections: number; appBytes: number; closed: number };
const seen: Record<number, Seen> = {};
const servers: tls.Server[] = [];

describe.skipIf(!COMPANY)("the certificate handshake: one narrow exception to the request guard (approved policy)", () => {
    beforeAll(async () => {
        for (const port of [TARGET_PORT, OTHER_PORT]) {
            const s: Seen = (seen[port] = { connections: 0, appBytes: 0, closed: 0 });
            const server = tls.createServer({ cert: fs.readFileSync(COMPANY!.cert, "utf8"), key: fs.readFileSync(COMPANY!.key, "utf8") }, (socket) => {
                s.connections++;
                socket.on("data", (d: Buffer) => (s.appBytes += d.length));
                socket.on("error", () => undefined);
                socket.on("close", () => s.closed++);
                socket.on("end", () => socket.end());
            });
            await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
            servers.push(server);
        }
    });
    afterAll(async () => {
        await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
        removeMintedTls();
    });

    const resolver: Resolver = async (host) => {
        if (host === "secure.test" || host === "other.test") return [{ address: "127.0.0.1", family: 4 }];
        throw new Error("ENOTFOUND");
    };
    const app: SecurityApplication = {
        id: "a1",
        projectId: "p1",
        name: "Shop",
        targetUrl: `https://secure.test:${TARGET_PORT}/`,
        environment: "staging",
        // Both other addresses are in the assessment's scope: the request guard would send HTTP requests to them.
        scope: [`https://other.test:${OTHER_PORT}`, `https://secure.test:${OTHER_PORT}`],
        excludedPaths: [],
        maxRequestsPerSecond: 10,
        apiSpecUrl: null,
        notes: null,
        createdAt: "",
        updatedAt: "",
    } as SecurityApplication;
    const settings = securitySettings({ SECURITY_ALLOW_PRIVATE_TARGETS: "true" });
    const waitFor = async (ok: () => boolean) => {
        for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
    };

    it("refuses any host or port but the assessment's own, though they are in scope, and connects to nothing", async () => {
        const ctl = new AbortController();
        const guard = guardFor(app, settings, ctl.signal, { resolver });
        try {
            for (const url of [`https://other.test:${OTHER_PORT}/`, `https://secure.test:${OTHER_PORT}/`, `http://secure.test:${TARGET_PORT}/`]) {
                if (url.startsWith("https:")) expect(await guard.refusal(url), url).toBeUndefined();
                const e = await observeTls(guard, url, ctl.signal).catch((x) => x);
                expect(e, url).toBeInstanceOf(RefusedError);
                expect((e as RefusedError).reason, url).toBe(TLS_ONLY_TARGET);
            }
            expect(seen[OTHER_PORT]!.connections).toBe(0);
            expect(seen[TARGET_PORT]!.connections).toBe(0);
            const refused = guard.requestLog().stored().entries.filter((e) => e.source === "platform:tls");
            expect(refused.map((e) => e.verdict)).toEqual(["refused", "refused", "refused"]);
        } finally {
            ctl.abort();
            await guard.close();
        }
    });

    it("to the assessment's own host and port: only the TLS handshake, no application data, closed right after, logged as platform:tls", async () => {
        const ctl = new AbortController();
        const guard = guardFor(app, settings, ctl.signal, { resolver });
        try {
            const before = { ...seen[TARGET_PORT]! };
            const obs = await observeTls(guard, `https://secure.test:${TARGET_PORT}/`, ctl.signal);
            expect(obs.cert).toBeTruthy();
            await waitFor(() => seen[TARGET_PORT]!.closed > before.closed);
            expect(seen[TARGET_PORT]!.connections - before.connections).toBe(1);
            expect(seen[TARGET_PORT]!.closed - before.closed).toBe(1);
            expect(seen[TARGET_PORT]!.appBytes).toBe(0);
            const entries = guard.requestLog().stored().entries.filter((e) => e.source === "platform:tls");
            expect(entries.map((e) => `${e.method} ${e.verdict}`)).toEqual(["TLS allowed"]);
        } finally {
            ctl.abort();
            await guard.close();
        }
    });

    it("with the request guard down, nothing is sent: HTTP requests and the handshake are both refused (GuardDownError)", async () => {
        const ctl = new AbortController();
        const down = { ready: async () => Promise.reject(new Error("the company proxy did not answer")) };
        const guard = guardFor(app, settings, ctl.signal, { resolver, proxy: down as never });
        try {
            const before = seen[TARGET_PORT]!.connections;
            await expect(guard.fetch(`https://secure.test:${TARGET_PORT}/`)).rejects.toBeInstanceOf(GuardDownError);
            await expect(observeTls(guard, `https://secure.test:${TARGET_PORT}/`, ctl.signal)).rejects.toBeInstanceOf(GuardDownError);
            expect(seen[TARGET_PORT]!.connections).toBe(before);
            expect(guard.requestLog().stored().entries.filter((e) => e.source === "platform:tls").map((e) => e.verdict)).toEqual(["refused"]);
        } finally {
            ctl.abort();
            await guard.close();
        }
    });
});

describe("a scanner stage run again after a lost lease lists each scanner once", () => {
    it("the interrupted attempt's runs are superseded: gone from the run lists, their requests still in the request log", () => {
        const dir = fs.mkdtempSync(path.join(tmp, "db-"));
        const db = new Db(path.join(dir, "t.db"));
        const repo = new Repo(db, new SecretBox(dir));
        const store = new SecurityStore(db);
        const projectId = repo.createProject({ name: "Client" }).id;
        const app = store.createApplication(projectId, { name: "Shop", targetUrl: "https://shop.example/", environment: "staging" });
        const authz = store.addAuthorization(app.id, { basis: "owner", approverName: "Owner", documentReference: null, restrictions: null, statement: "I confirm.", confirmedByName: "Tester" });
        const a = store.createAssessment({ applicationId: app.id, authorizationId: authz.id, startedBy: "Tester" });
        const entry = { at: new Date().toISOString(), method: "GET", host: "shop.example", path: "/", verdict: "allowed" as const, status: 200 };
        const run = (state: "FAILED" | "COMPLETED") => {
            const r = createRun(db, { assessmentId: a.id, projectId, applicationId: app.id, scanner: "nuclei", profile: "passive" });
            updateRun(db, r.id, { state, coverage: { inspected: [], notInspected: [], requestLog: [entry] } as never });
            return r;
        };
        run("FAILED"); // the attempt that lost its lease part-way
        supersedeScannerRuns(db, a.id); // the next owner starts the stage again
        const redo = run("COMPLETED");
        expect(runsOfAssessment(db, a.id).map((r) => r.id)).toEqual([redo.id]);
        expect(listRuns(db, projectId).map((r) => r.id)).toEqual([redo.id]);
        expect(requestLogOfAssessment(db, a.id).entries).toHaveLength(2);
        db.close();
    });
});
