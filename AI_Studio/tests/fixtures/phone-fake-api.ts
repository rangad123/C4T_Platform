/**
 * A fake platform API for the AI phone tests screens: a small HTTP server that serves the built web UI (web/dist) and answers the /api routes
 * the phone screens use from state a test controls. It runs nothing and decides nothing; the real platform behind these routes is MX-B's work
 * (tests/phone-ai-real.test.ts exercises that once it exists). The shapes are the ones the real routes answer (read from src/platform/routes/plans.ts,
 * routes/explorer.ts and the explorer's events): a job answer that does not say what it explored, a picture whose address is android-app://<package>,
 * events named mobile_*, and a plan with a `phone` part. See docs/features/ux-phone-ai.md.
 *
 * Every request is recorded in `requests`, so a test can say what the screens asked for and what they sent.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { REPO_ROOT } from "../../src/config.js";

type Json = Record<string, any>;

export interface FakeProject {
    id: string;
    name: string;
    mobile: Json | null;
    runner: { runOn: "platform" | "agent"; agentId: string | null };
    jobIds: string[];
    testIds: string[];
}

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".ico": "image/x-icon", ".jpg": "image/jpeg" };

export const DEFAULT_CONFIG = (): Json => ({
    llm: { provider: "anthropic", model: "scripted", configured: true },
    mobile: { available: true, avds: ["Pixel_6"], toolchain: "system" },
    authRequired: false,
    browsers: { chromium: true, firefox: false, webkit: false },
    variants: [],
    frameworks: [],
    adapters: [],
});

export class PhoneFake {
    config: Json = DEFAULT_CONFIG();
    agents: Json[] = [];
    readonly projects = new Map<string, FakeProject>();
    readonly jobs = new Map<string, Json>();
    readonly tests = new Map<string, Json>();
    readonly events = new Map<string, Json[]>();
    readonly plans = new Map<string, Json>();
    /** What the picture route answers for a job (the test sets it; the route adds nothing of its own). */
    readonly frames = new Map<string, Json>();
    /** The answer of GET /runs/:jobId for a job, when a test wants tests listed. */
    readonly runTests = new Map<string, Json[]>();
    readonly requests: Array<{ method: string; path: string; body: any }> = [];
    /** Make the next POST test-generation fail like the real route does (409 / 422 with a plain message). */
    startError: { status: number; error: string } | undefined;
    /** Make the next plan read fail. */
    planError: { status: number; error: string } | undefined;
    /** The delay (ms) applied to every /api answer, so loading states can be seen. */
    delayMs = 0;
    /** Anything not handled: recorded so a test can fail on a route the screens use that this fake lacks. */
    readonly unhandled: string[] = [];
    /** Routes a test adds (round 24: the phone settings and ready check), asked before the built-in ones; undefined passes on. */
    extraRoutes?: (method: string, path: string, body: any) => { status?: number; body: any; headers?: Record<string, string> } | undefined;
    private seq = 0;
    private server?: http.Server;
    private readonly streams = new Map<string, Set<http.ServerResponse>>();
    private eventSeq = 0;

    constructor(readonly port: number) {}

    // ── building state ───────────────────────────────────────────────────────

    addProject(name: string, mobile: Json | null = { appPackage: "com.example.shop", apk: null, avd: null }): FakeProject {
        const id = `p${++this.seq}`;
        const p: FakeProject = { id, name, mobile, runner: { runOn: "platform", agentId: null }, jobIds: [], testIds: [] };
        this.projects.set(id, p);
        return p;
    }

    addAgent(over: Json = {}): Json {
        const a = {
            id: `a${++this.seq}`,
            name: "Maya’s laptop",
            version: "1.0.0",
            tokenId: "t1",
            os: "win32",
            arch: "x64",
            node: "24.0.0",
            online: true,
            lastSeenAt: new Date().toISOString(),
            firstSeenAt: new Date(Date.now() - 86_400_000).toISOString(),
            activeTasks: 0,
            concurrency: 1,
            capabilities: { browsers: ["chromium"], deviceSession: true, android: { adb: true, devices: [{ serial: "emulator-5554", model: "Pixel_6", state: "device", emulator: true }], avds: ["Pixel_6"], state: "emulator", summary: "Android: 1 emulator ready" } },
            ...over,
        };
        this.agents.push(a);
        return a;
    }

    addJob(projectId: string, over: Json = {}): Json {
        const id = `j${++this.seq}`;
        const job = {
            jobId: id,
            projectId,
            status: "DISCOVERING",
            mode: "generate",
            planOnly: true,
            canWatch: true,
            progress: { discovery: "running", understanding: "pending", planning: "pending", generation: "pending", validation: "pending" },
            counters: { pagesDiscovered: 0, apisDiscovered: 0, journeysIdentified: 0, scenariosPlanned: 0, testsGenerated: 0, testsValidated: 0, testsFailedValidation: 0, testsNeedingReview: 0, scenariosSkipped: 0 },
            error: null,
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            finishedAt: null,
            ...over,
        };
        this.jobs.set(id, job);
        this.projects.get(projectId)?.jobIds.push(id);
        this.events.set(id, []);
        return job;
    }

    /** Change a job and tell anyone streaming it. */
    update(jobId: string, patch: Json): Json {
        const job = this.jobs.get(jobId)!;
        Object.assign(job, patch);
        if (patch.counters) job.counters = { ...job.counters, ...patch.counters };
        if (patch.progress) job.progress = { ...job.progress, ...patch.progress };
        this.push(jobId, "job", job);
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) this.end(jobId, job.status);
        return job;
    }

    log(jobId: string, message: string, kind = "info", stage = "discovery", level = "info"): void {
        const e = { id: ++this.eventSeq, stage, kind, level, message, createdAt: new Date().toISOString() };
        this.events.get(jobId)?.push(e);
        this.push(jobId, "log", { ...e, at: e.createdAt, jobId });
    }

    addTest(projectId: string, over: Json = {}): Json {
        const n = this.seq + 1;
        const t = {
            id: `t${++this.seq}`,
            projectId,
            testId: `MOB-${String(n).padStart(3, "0")}`,
            title: "Sign in with a test account",
            suite: "Phone",
            kind: "mobile",
            type: "functional",
            priority: "high",
            framework: "taqwright",
            validationStatus: "VALIDATED",
            validationReason: null,
            attempts: 1,
            severity: null,
            updatedAt: new Date().toISOString(),
            ...over,
        };
        this.tests.set(t.id, t);
        this.projects.get(projectId)?.testIds.push(t.id);
        return t;
    }

    setPlan(jobId: string, plan: Json): void {
        this.plans.set(jobId, plan);
    }

    // ── SSE ──────────────────────────────────────────────────────────────────

    private push(jobId: string, event: string, data: Json): void {
        for (const res of this.streams.get(jobId) ?? []) res.write(`event: ${event}\n${event === "log" ? `id: ${data.id}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
    }
    private end(jobId: string, status: string): void {
        for (const res of this.streams.get(jobId) ?? []) res.write(`event: end\ndata: ${JSON.stringify({ status })}\n\n`);
    }

    // ── the server ───────────────────────────────────────────────────────────

    async start(): Promise<void> {
        this.server = http.createServer((req, res) => void this.handle(req, res));
        await new Promise<void>((r) => this.server!.listen(this.port, "127.0.0.1", r));
    }
    async stop(): Promise<void> {
        for (const set of this.streams.values()) for (const res of set) res.end();
        this.server?.closeAllConnections?.();
        await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    }
    get base(): string {
        return `http://127.0.0.1:${this.port}`;
    }
    called(method: string, pattern: RegExp): Array<{ method: string; path: string; body: any }> {
        return this.requests.filter((r) => r.method === method && pattern.test(r.path));
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const url = new URL(req.url ?? "/", this.base);
        const pathname = url.pathname;
        if (!pathname.startsWith("/api/")) return this.serveStatic(pathname, res);
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks);
        let body: any;
        if (raw.length && (req.headers["content-type"] ?? "").includes("json")) {
            try {
                body = JSON.parse(raw.toString("utf8"));
            } catch {
                body = undefined;
            }
        } else if (raw.length) body = { bytes: raw.length };
        const method = req.method ?? "GET";
        const apiPath = pathname.slice(4);
        // Stream reads are not requests worth recording (they would drown the list).
        if (!apiPath.endsWith("/stream")) this.requests.push({ method, path: apiPath + url.search, body });
        if (this.delayMs && !apiPath.endsWith("/stream")) await new Promise((r) => setTimeout(r, this.delayMs));
        const send = (status: number, data: unknown, headers: Record<string, string> = {}) => {
            const text = typeof data === "string" ? data : JSON.stringify(data);
            res.writeHead(status, { "content-type": typeof data === "string" ? "text/plain" : "application/json", ...headers });
            res.end(text);
        };
        try {
            const r = this.extraRoutes?.(method, apiPath, body) ?? this.route(method, apiPath, url, body, res);
            if (r === "streamed") return;
            if (r === undefined) {
                this.unhandled.push(`${method} ${apiPath}`);
                return send(404, { error: "Not found" });
            }
            return send(r.status ?? 200, r.body, r.headers);
        } catch (e) {
            return send(500, { error: String((e as Error).message) });
        }
    }

    private serveStatic(pathname: string, res: http.ServerResponse): void {
        const dist = path.join(REPO_ROOT, "web", "dist");
        let file = path.join(dist, pathname === "/" ? "index.html" : decodeURIComponent(pathname));
        if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, "index.html");
        res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
        fs.createReadStream(file).pipe(res);
    }

    private publicProject(p: FakeProject): Json {
        const tests = p.testIds.map((i) => this.tests.get(i)!);
        const latest = p.jobIds.length ? this.jobs.get(p.jobIds[p.jobIds.length - 1]!) : null;
        return {
            id: p.id,
            name: p.name,
            created_at: new Date().toISOString(),
            test_count: tests.length,
            validated_count: tests.filter((t) => t.validationStatus === "VALIDATED").length,
            // The platform names the app of a phone exploration android-app://<package>; its job answers do not say what they explored (yet).
            application: p.jobIds.length ? { id: `app-${p.id}`, url: p.mobile?.appPackage ? `android-app://${p.mobile.appPackage}` : "https://example.com", config: {} } : null,
            latestJob: latest ?? null,
            suites: [],
            mobile: p.mobile,
        };
    }

    private runAnswer(job: Json): Json {
        const tests = this.runTests.get(job.jobId) ?? [];
        const count = (s: string) => tests.filter((t) => t.state === s).length;
        return {
            job,
            jobId: job.jobId,
            projectId: job.projectId,
            mode: job.mode ?? "generate",
            active: !["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status),
            counts: { planned: tests.length, ran: count("passed") + count("failed") + count("finding"), passed: count("passed"), failed: count("failed"), findings: count("finding"), running: count("running"), waiting: count("waiting"), notRun: count("not_run") },
            tests,
            startedBy: { kind: "person" },
            changes: null,
        };
    }

    /** One route. `undefined` means this fake does not know it. */
    private route(method: string, p: string, url: URL, body: any, res: http.ServerResponse): { status?: number; body: any; headers?: Record<string, string> } | "streamed" | undefined {
        let m: RegExpMatchArray | null;
        // The web app asks who is using it before anything else (people and access): an open platform, as on a fresh install.
        if (method === "GET" && p === "/auth/state") return { body: { mode: "open", accessKeyConfigured: false, hasPeople: false, sso: { enabled: false, label: "" }, me: { kind: "open", name: "Anyone (open access)", role: "owner" } } };
        if (method === "GET" && p === "/config") return { body: this.config };
        // The Security Assessment module (round 18): the shell asks whether it is on; these phone screens run with it off.
        if (method === "GET" && p === "/v1/security/status") return { body: { enabled: false } };
        if (method === "GET" && p === "/projects") return { body: [...this.projects.values()].map((x) => this.publicProject(x)) };
        // The Projects page (round 34): open access saves no preferences, and these screens use no folders.
        if (method === "GET" && p === "/me/preferences") return { body: { preferences: {}, saved: false } };
        if (method === "GET" && p === "/folders") return { body: { folders: [], canCreate: true, organizations: [] } };
        // The Projects page (round 38) asks for the testing agents once, for the rows' agent tiles and the legend; these screens use none.
        if (method === "GET" && p === "/testing-agents") return { body: { agents: [], canRun: { ok: true }, ai: { configured: true } } };
        if (method === "POST" && p === "/projects") {
            const proj = this.addProject(String(body?.name ?? "Untitled"), null);
            return { status: 201, body: { id: proj.id, name: proj.name } };
        }
        if (method === "POST" && p === "/stream-tickets") return { body: { ticket: `tk${++this.seq}` } };

        if ((m = p.match(/^\/projects\/([^/]+)(?:\/(.*))?$/))) {
            const proj = this.projects.get(m[1]!);
            if (!proj) return { status: 404, body: { error: "Project not found" } };
            const rest = m[2] ?? "";
            if (method === "GET" && rest === "") return { body: this.publicProject(proj) };
            if (method === "GET" && rest === "tests") return { body: proj.testIds.map((i) => this.tests.get(i)) };
            if (method === "GET" && rest === "jobs") return { body: proj.jobIds.map((i) => this.jobs.get(i)).reverse() };
            if (method === "GET" && rest === "schedules") return { body: { serverTime: new Date().toISOString(), timezone: { name: "UTC", utcOffsetMinutes: 0 }, schedulerEnabled: false, schedules: [] } };
            if (method === "GET" && rest === "storage") return { body: { project: { id: proj.id, name: proj.name }, generatedAt: new Date().toISOString(), truncated: false, usage: { bytes: 0, text: "0 B" }, removed: { files: 0, bytes: 0, text: "" }, retention: { enabled: false, source: "default" }, needsSecrets: [] } };
            // A quiet line on the Tests page; a server that does not answer shows nothing, which is all these tests need.
            // Cards on the Overview and lines on the Tests page that have nothing to say about a phone project: an answer that is not there shows nothing.
            if (method === "GET" && ["framework-settings", "api-changes", "memory", "performance", "cleanup", "application-model"].includes(rest)) return { status: 404, body: { error: "Not found" } };
            // Cards of the project's Dashboard (round 34), as a project with nothing to report answers them.
            if (method === "GET" && rest === "setup-check") return { body: { items: [] } };
            if (method === "GET" && rest === "requirements/coverage") return { body: { total: 0, notCovered: 0, covered: 0, passing: 0, failing: 0, retired: 0 } };
            if (method === "GET" && rest === "agent-tokens") return { body: [] };
            if (method === "GET" && rest === "agents") return { body: this.agents };
            // Round 24 (Settings, Mobile app): the ready check and the phone test settings, as a platform with no phone connected answers them.
            if (method === "GET" && rest === "phones") return { body: { available: true, reason: "No phone or emulator is connected to the computer that runs the platform.", phones: [] } };
            if (method === "GET" && rest === "phone-settings") {
                const depths = [["quick", "Quick", 40, 150, 10, 15], ["standard", "Standard", 150, 600, 30, 40], ["thorough", "Thorough", 300, 1200, 60, 80]].map(([id, label, screens, actions, minutes, ideas]) => ({ id, label, screens, actions, minutes, ideas, line: `About ${screens} screens.` }));
                return { body: { hasApp: Boolean(proj.mobile?.appPackage || proj.mobile?.apk), appPackage: proj.mobile?.appPackage ?? null, runsOn: null, effective: { kind: "auto" }, sentence: "Phone tests run on a connected phone that has the app, else on an emulator.", exploredOn: null, depth: "standard", depths, keepSignedIn: false, cleanStart: proj.mobile?.cleanStart === true, farm: { connections: [], chosen: null } } };
            }
            // What every project page may ask: can this project use AI (routes/ai-config.ts). Here it follows the server's word.
            if (method === "GET" && rest === "ai") return { body: { available: this.config.llm.configured, ready: this.config.llm.configured, runsHere: true } };
            if (method === "GET" && rest === "runner") {
                const a = proj.runner.agentId ? this.agents.find((x) => x.id === proj.runner.agentId) : undefined;
                const canMobile = proj.runner.runOn === "agent" ? Boolean(a?.online && a?.capabilities?.android) : this.config.mobile?.available === true;
                return { body: { runOn: proj.runner.runOn, agentId: proj.runner.agentId, status: proj.runner.runOn === "agent" ? `Runs on ${a?.name ?? "a runner"} (${a?.online ? "online" : "offline"}).` : "Runs on this server.", canRunWeb: true, canRunMobile: canMobile, phones: { canRun: canMobile, text: canMobile ? "Phone tests can run." : "Phone tests can’t run here." }, unavailableReason: null } };
            }
            if (method === "PUT" && rest === "runner") {
                proj.runner = { runOn: body?.runOn === "agent" ? "agent" : "platform", agentId: body?.runOn === "agent" ? (body.agentId ?? null) : null };
                return { body: { runOn: proj.runner.runOn, agentId: proj.runner.agentId, status: "Saved.", canRunWeb: true, canRunMobile: true, unavailableReason: null } };
            }
            if (method === "PUT" && rest === "mobile-app") {
                proj.mobile = { appPackage: body?.appPackage ?? null, apk: proj.mobile?.apk ?? null, avd: null, ...(body?.iosBundleId ? { iosBundleId: body.iosBundleId } : {}) };
                return { body: proj.mobile };
            }
            if (method === "POST" && rest === "mobile-app/apk") {
                proj.mobile = { appPackage: proj.mobile?.appPackage ?? null, apk: String(url.searchParams.get("filename") ?? "app.apk"), avd: null };
                return { body: proj.mobile };
            }
            if (method === "POST" && rest === "test-generation") {
                if (this.startError) {
                    const e = this.startError;
                    this.startError = undefined;
                    return { status: e.status, body: { error: e.error } };
                }
                const job = this.addJob(proj.id, { planOnly: body?.plan === true, status: "QUEUED", progress: { discovery: "pending", understanding: "pending", planning: "pending", generation: "pending", validation: "pending" } });
                return { status: 202, body: { jobId: job.jobId, status: job.status } };
            }
            if ((m = rest.match(/^jobs\/([^/]+)\/frame$/)) && method === "GET") {
                const f = this.frames.get(m[1]!);
                if (!f) return { body: { available: false, why: "waiting", reason: "Waiting for the first picture…", mime: "image/jpeg", watching: true } };
                const since = url.searchParams.get("since");
                if (since && f.at === since) return { body: { available: true, unchanged: true, mime: "image/jpeg", watching: true, ...f, imageBase64: undefined } };
                return { body: { available: true, mime: "image/jpeg", watching: true, ageMs: 100, ...f } };
            }
            if ((m = rest.match(/^plans\/([^/]+)$/))) {
                if (method === "GET") {
                    if (this.planError) {
                        const e = this.planError;
                        this.planError = undefined;
                        return { status: e.status, body: { error: e.error } };
                    }
                    const plan = this.plans.get(m[1]!);
                    return plan ? { body: plan } : { body: { ready: false, jobId: m[1], status: "DISCOVERING" } };
                }
                if (method === "DELETE") {
                    this.plans.delete(m[1]!);
                    return { status: 204, body: "" };
                }
            }
            if ((m = rest.match(/^plans\/([^/]+)\/create$/)) && method === "POST") {
                const job = this.addJob(proj.id, { planOnly: false, fromPlan: m[1], status: "GENERATING", progress: { discovery: "done", understanding: "done", planning: "done", generation: "running", validation: "pending" } });
                return { status: 202, body: { jobId: job.jobId, status: job.status } };
            }
            if ((m = rest.match(/^runs\/([^/]+)$/)) && method === "GET") {
                const job = this.jobs.get(m[1]!);
                return job ? { body: this.runAnswer(job) } : { status: 404, body: { error: "Run not found" } };
            }
            return undefined;
        }

        if ((m = p.match(/^\/test-generation\/([^/]+)(?:\/(events|stream))?$/))) {
            const job = this.jobs.get(m[1]!);
            if (!job) return { status: 404, body: { error: "Job not found" } };
            if (method === "GET" && !m[2]) return { body: job };
            if (method === "GET" && m[2] === "events") return { body: (this.events.get(job.jobId) ?? []).filter((e) => e.id > Number(url.searchParams.get("after") ?? 0)) };
            if (method === "DELETE" && !m[2]) {
                this.update(job.jobId, { status: "FAILED", error: "Cancelled", finishedAt: new Date().toISOString() });
                return { status: 202, body: { cancelRequested: true } };
            }
            if (method === "GET" && m[2] === "stream") {
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
                res.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
                for (const e of this.events.get(job.jobId) ?? []) res.write(`event: log\nid: ${e.id}\ndata: ${JSON.stringify({ ...e, at: e.createdAt, jobId: job.jobId })}\n\n`);
                if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) res.write(`event: end\ndata: ${JSON.stringify({ status: job.status })}\n\n`);
                const set = this.streams.get(job.jobId) ?? new Set();
                set.add(res);
                this.streams.set(job.jobId, set);
                res.on("close", () => set.delete(res));
                return "streamed";
            }
        }
        return undefined;
    }
}

export async function startPhoneFake(port: number): Promise<PhoneFake> {
    const f = new PhoneFake(port);
    await f.start();
    return f;
}
