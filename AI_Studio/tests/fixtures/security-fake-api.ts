/**
 * A fake platform API for the Security Assessment screens (round 18, UI): a small HTTP server that serves the built web UI (web/dist) and
 * answers the /api routes those screens use from state a test controls. It runs no assessment and judges nothing; the real module is CORE,
 * RUN and FIND's work (src/security), exercised end to end by tests/security-ui-real.test.ts. The answer shapes are the real routes' ones
 * (read from src/security/routes/core.ts, assessments.ts and findings.ts): lists wrapped in an object ({ applications }, { assessments },
 * { findings, total }), one object wrapped too ({ application, authorization, statement }, { assessment }, { finding, history, application }).
 *
 * Every request is recorded in `requests`; anything not handled goes to `unhandled` (a test fails on a route the screens use that this
 * fake lacks).
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { REPO_ROOT } from "../../src/config.js";

type Json = Record<string, any>;

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".ico": "image/x-icon" };
const RUNNING = ["QUEUED", "DISCOVERING", "SCANNING", "VALIDATING", "GENERATING_REPORT"];
const OPEN = ["needs-review", "probable", "confirmed"];
const SEVERITIES = ["critical", "high", "medium", "low", "info"];

export const RISK_RULES = [
    "High risk: at least one open critical or high finding.",
    "Medium risk: no open critical or high finding, at least one open medium finding.",
    "Low risk: only low or informational findings are open.",
    "Open means needs review, probable or confirmed; fixed, accepted risk and false positive are not open.",
];

export class SecurityFake {
    enabled = true;
    role: "owner" | "editor" | "viewer" = "owner";
    /** When false, the testing-type route answers 404 (a platform without it). */
    testingTypeRoute = true;
    readonly projects = new Map<string, Json>();
    readonly types = new Map<string, string>();
    readonly apps = new Map<string, Json>();
    readonly auths = new Map<string, Json>();
    readonly assessments = new Map<string, Json>();
    readonly findings = new Map<string, Json>();
    readonly history = new Map<string, Json[]>();
    readonly requests: Array<{ method: string; path: string; body: any }> = [];
    readonly unhandled: string[] = [];
    // Round 20 (UI2): the security trail, the notification setting (OPS), saved sign-ins and API documents (SIGN).
    readonly events: Json[] = [];
    readonly notify = new Map<string, Json>();
    readonly channels = new Map<string, Json[]>();
    readonly recent = new Map<string, Json[]>();
    /** Per project: SIGN's judged saved sign-ins (src/security/signin.ts SignInStatus), as GET /projects/:id/sign-ins answers them. */
    readonly signIns = new Map<string, Json[]>();
    readonly apiDocs = new Map<string, { summary: Json; text: string }>();
    private eventSeq = 0;
    delayMs = 0;
    private seq = 0;
    private server?: http.Server;

    constructor(readonly port: number) {}

    get base(): string {
        return `http://127.0.0.1:${this.port}`;
    }
    private id(prefix: string): string {
        return `${prefix}${++this.seq}`;
    }
    called(method: string, pattern: RegExp) {
        return this.requests.filter((r) => r.method === method && pattern.test(r.path));
    }

    // ── state ────────────────────────────────────────────────────────────────

    addProject(name: string, type: "functional" | "security" | "both" = "functional"): Json {
        const p = { id: this.id("p"), name, created_at: new Date().toISOString() };
        this.projects.set(p.id, p);
        this.types.set(p.id, type);
        return p;
    }

    private fingerprint(a: Json): string {
        // As the real one (src/security/authorization.ts): the saved sign-in and the sensitive workflows count only when set.
        const extra = [...(a.signInAccount ? [a.signInAccount] : []), ...(a.sensitiveWorkflows?.length ? [JSON.stringify(a.sensitiveWorkflows.map((w: Json) => [w.name, [...w.pathPrefixes].sort()]))] : [])];
        return JSON.stringify([a.targetUrl, [...a.scope].sort(), [...a.excludedPaths].sort(), a.maxRequestsPerSecond, ...extra]);
    }

    /** One event of the project's security trail (newest last here; the route answers newest first). */
    addEvent(projectId: string, over: Json = {}): Json {
        const e = { id: ++this.eventSeq, at: new Date(Date.now() - 60_000 * (1000 - this.eventSeq)).toISOString(), projectId, applicationId: null, actor: { kind: "open", id: null, name: "Anyone (open access)" }, action: "application.created", objectType: "application", objectId: null, summary: "Added an application.", ...over };
        this.events.push(e);
        return e;
    }

    addApp(projectId: string, over: Json = {}): Json {
        const now = new Date().toISOString();
        const a = { id: this.id("app"), projectId, name: "Customer portal", targetUrl: "https://staging.example.com/", environment: "staging", scope: [], excludedPaths: ["/admin/billing"], maxRequestsPerSecond: 2, apiSpecUrl: null, notes: null, signInAccount: null, sensitiveWorkflows: [], apiDocument: null, createdAt: now, updatedAt: now, ...over };
        this.apps.set(a.id, a);
        return a;
    }

    authorize(appId: string, over: Json = {}): Json {
        const app = this.apps.get(appId)!;
        const r = { id: this.id("auth"), applicationId: appId, basis: "client-permission", approverName: "Dana Client", approverEmail: null, documentReference: "Engagement letter 114", restrictions: null, confirmedByUserId: null, confirmedByName: "Anyone (open access)", confirmedAt: new Date(Date.now() - 1000 * this.seq).toISOString(), scopeFingerprint: this.fingerprint(app), revokedAt: null, ...over };
        this.auths.set(r.id, r);
        return r;
    }

    addAssessment(appId: string, over: Json = {}): Json {
        const app = this.apps.get(appId)!;
        const now = new Date().toISOString();
        const a = { id: this.id("as"), applicationId: appId, projectId: app.projectId, authorizationId: "", kind: "passive", state: "COMPLETED", progress: 100, progressText: "Finished.", coverage: { pagesSeen: 4, formsSeen: 1, apiCallsSeen: 2, notInspected: ["Signed-in areas: no account was given."] }, error: null, startedBy: "Anyone (open access)", createdAt: now, startedAt: now, finishedAt: now, retestOf: null, ...over };
        this.assessments.set(a.id, a);
        return a;
    }

    addFinding(appId: string, over: Json = {}): Json {
        const app = this.apps.get(appId)!;
        const now = new Date().toISOString();
        const f = {
            id: this.id("f"),
            projectId: app.projectId,
            applicationId: appId,
            firstAssessmentId: null,
            lastAssessmentId: null,
            fingerprint: `fp${this.seq}`,
            title: "Content Security Policy is missing",
            category: "headers",
            severity: "medium",
            confidence: "high",
            location: `${app.targetUrl}`,
            description: "The page is served without a Content-Security-Policy header.",
            impact: "A policy limits what an injected script could do.",
            remediation: "Send a Content-Security-Policy header from the web server.",
            reproduction: "1. Open the page in a browser\n2. Open the developer tools, Network\n3. Look at the answer's headers: there is no Content-Security-Policy",
            evidence: [{ kind: "response-header", label: "Headers received", value: "server: nginx\ncontent-type: text/html", observedAt: now }],
            source: "built-in",
            aiNote: null,
            validation: "needs-review",
            firstSeenAt: now,
            lastSeenAt: now,
            ...over,
        };
        this.findings.set(f.id, f);
        this.history.set(f.id, []);
        return f;
    }

    /** Move an assessment along (the test plays the job loop). */
    advance(aid: string, patch: Json): Json {
        const a = this.assessments.get(aid)!;
        Object.assign(a, patch);
        return a;
    }

    authState(app: Json): Json {
        const latest = [...this.auths.values()].filter((x) => x.applicationId === app.id).sort((x, y) => y.confirmedAt.localeCompare(x.confirmedAt))[0];
        if (!latest) return { state: "none", message: "No authorization is recorded for this application yet. Record one before assessing it.", authorizationId: null };
        if (latest.revokedAt) return { state: "revoked", message: "The authorization was withdrawn. Record a new one before the next assessment.", authorizationId: latest.id };
        if (latest.scopeFingerprint !== this.fingerprint(app)) return { state: "stale", message: "The target, scope, exclusions or request limit changed after the authorization was recorded. Confirm it again before the next assessment.", authorizationId: latest.id };
        return { state: "current", message: "A current authorization covers this application.", authorizationId: latest.id };
    }

    private statement(app: Json): string {
        const p = this.projects.get(app.projectId);
        return `I confirm that ${p?.name ?? "the client"} owns ${app.targetUrl} or that its owner has given documented permission to assess it, within the scope listed.${app.excludedPaths.length ? ` Never requested: ${app.excludedPaths.join(", ")}.` : ""} The assessment is passive: it only sends the ordinary requests a visitor's browser makes.`;
    }
    private active(appId: string) {
        return [...this.assessments.values()].find((a) => a.applicationId === appId && RUNNING.includes(a.state));
    }
    private appView(a: Json) {
        return { ...a, authorization: this.authState(a), activeAssessmentId: this.active(a.id)?.id ?? null };
    }
    private asView(a: Json) {
        return { ...a, cancelRequested: false, applicationName: this.apps.get(a.applicationId)?.name ?? null };
    }

    overview(projectId: string): Json {
        const apps = [...this.apps.values()].filter((a) => a.projectId === projectId);
        const list = [...this.assessments.values()].filter((a) => a.projectId === projectId);
        const fs_ = [...this.findings.values()].filter((f) => f.projectId === projectId);
        const open = fs_.filter((f) => OPEN.includes(f.validation));
        const bySev = Object.fromEntries(SEVERITIES.map((s) => [s, open.filter((f) => f.severity === s).length]));
        const completed = list.filter((a) => a.state === "COMPLETED" || a.state === "PARTIALLY_COMPLETED");
        const critHigh = bySev.critical + bySev.high;
        const fixed = fs_.filter((f) => f.validation === "fixed" && f.fixedByRetest);
        return {
            risk: { level: critHigh ? "high" : open.length ? "medium" : "no-open-findings", label: critHigh ? "High risk" : open.length ? "Medium risk" : "No open findings", reason: `There are ${bySev.critical} critical and ${bySev.high} high open findings.`, openBySeverity: bySev, rules: RISK_RULES },
            counts: {
                applications: apps.length,
                applicationsAssessed: new Set(completed.map((a) => a.applicationId)).size,
                assessmentsCompleted: completed.length,
                openCriticalHigh: critHigh,
                awaitingReview: open.filter((f) => f.validation !== "confirmed").length,
                fixedAfterRetest: fixed.length,
                remediationRemaining: open.length,
                falsePositives: fs_.filter((f) => f.validation === "false-positive").length,
                acceptedRisks: fs_.filter((f) => f.validation === "accepted-risk").length,
            },
            applications: apps.map((a) => {
                const last = list.filter((x) => x.applicationId === a.id).sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0];
                return { id: a.id, name: a.name, targetUrl: a.targetUrl, environment: a.environment, lastAssessment: last ? { id: last.id, state: last.state, finishedAt: last.finishedAt, createdAt: last.createdAt } : null, openFindings: open.filter((f) => f.applicationId === a.id).length };
            }),
            needsAttention: open
                .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity))
                .slice(0, 10)
                .map(({ id, title, severity, validation, location, applicationId, lastSeenAt }) => ({ id, title, severity, validation, location, applicationId, lastSeenAt })),
            fixedRecently: fixed.map(({ id, title, severity, location, applicationId, lastSeenAt }) => ({ id, title, severity, location, applicationId, fixedAt: lastSeenAt, retestId: null })),
        };
    }

    // ── the server ───────────────────────────────────────────────────────────

    async start(): Promise<void> {
        this.server = http.createServer((req, res) => void this.handle(req, res));
        await new Promise<void>((r) => this.server!.listen(this.port, "127.0.0.1", r));
    }
    async stop(): Promise<void> {
        this.server?.closeAllConnections?.();
        await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const url = new URL(req.url ?? "/", this.base);
        if (!url.pathname.startsWith("/api/")) return this.serveStatic(url.pathname, res);
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");
        let body: any;
        try {
            body = raw ? JSON.parse(raw) : undefined;
        } catch {
            body = raw;
        }
        const method = req.method ?? "GET";
        const p = url.pathname.slice(4);
        this.requests.push({ method, path: p + url.search, body });
        if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
        try {
            const r = this.route(method, p, url, body);
            if (!r) {
                this.unhandled.push(`${method} ${p}`);
                res.writeHead(404, { "content-type": "application/json" });
                return void res.end(JSON.stringify({ error: "Not found" }));
            }
            const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
            res.writeHead(r.status ?? 200, { "content-type": r.type ?? (typeof r.body === "string" ? "text/plain" : "application/json"), ...(r.headers ?? {}) });
            res.end(text);
        } catch (e) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: String((e as Error).message) }));
        }
    }

    private serveStatic(pathname: string, res: http.ServerResponse): void {
        const dist = path.join(REPO_ROOT, "web", "dist");
        let file = path.join(dist, pathname === "/" ? "index.html" : decodeURIComponent(pathname));
        if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, "index.html");
        res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
        fs.createReadStream(file).pipe(res);
    }

    private publicProject(p: Json): Json {
        return { id: p.id, name: p.name, created_at: p.created_at, test_count: 0, validated_count: 0, url: null, last_job_status: null, application: null, latestJob: null, suites: [], mobile: null };
    }

    private refuse(status: number, error: string) {
        return { status, body: { error } };
    }
    private needs(role: "editor" | "owner") {
        const rank = { viewer: 0, editor: 1, owner: 2 };
        return rank[this.role] >= rank[role] ? null : this.refuse(403, role === "owner" ? "Only an owner of this project can do this." : "Your role can look but not change anything here.");
    }

    private route(method: string, p: string, url: URL, body: any): { status?: number; body: any; type?: string; headers?: Record<string, string> } | undefined {
        let m: RegExpMatchArray | null;
        if (method === "GET" && p === "/auth/state") return { body: { mode: "open", accessKeyConfigured: false, hasPeople: false, sso: { enabled: false, label: "" }, me: { kind: "open", name: "Anyone (open access)", role: this.role } } };
        if (method === "GET" && p === "/config") return { body: { llm: { provider: "anthropic", model: "scripted", configured: true }, authRequired: false, browsers: { chromium: true, firefox: false, webkit: false }, variants: [], frameworks: [], adapters: [] } };
        if (method === "GET" && p === "/projects") return { body: [...this.projects.values()].map((x) => this.publicProject(x)) };
        if (method === "POST" && p === "/projects") {
            const proj = this.addProject(String(body?.name ?? "Untitled"));
            return { status: 201, body: { id: proj.id, name: proj.name } };
        }
        if ((m = p.match(/^\/projects\/([^/]+)(?:\/(.*))?$/))) {
            const proj = this.projects.get(m[1]!);
            if (!proj) return this.refuse(404, "Project not found");
            const rest = m[2] ?? "";
            if (method === "GET" && rest === "") return { body: this.publicProject(proj) };
            if (method === "GET" && (rest === "tests" || rest === "jobs")) return { body: [] };
            if (method === "GET" && rest === "schedules") return { body: { serverTime: new Date().toISOString(), timezone: { name: "UTC", utcOffsetMinutes: 0 }, schedulerEnabled: false, schedules: [] } };
            if (method === "GET" && rest === "storage") return { body: { project: { id: proj.id, name: proj.name }, generatedAt: new Date().toISOString(), truncated: false, usage: { bytes: 0, text: "0 B" }, removed: { files: 0, bytes: 0, text: "" }, retention: { enabled: false, source: "default" }, needsSecrets: [] } };
            return undefined;
        }

        if (!p.startsWith("/v1/security/")) return undefined;
        const s = p.slice("/v1/security".length);
        if (method === "GET" && s === "/status") return { body: { enabled: this.enabled, limits: { maxRequestsPerAssessment: 2000, assessmentMinutes: 30, maxRequestsPerSecond: { min: 1, max: 10, default: 2 }, privateTargetsAllowed: false } } };
        if (!this.enabled) return this.refuse(404, "Security assessment is turned off on this platform.");

        if ((m = s.match(/^\/projects\/([^/]+)\/(testing-type|applications|assessments|findings|overview|report|stop-all|activity|notifications|sign-ins)$/))) {
            const pid = m[1]!;
            if (!this.projects.has(pid)) return this.refuse(404, "Project not found");
            const what = m[2];
            if (what === "testing-type") {
                if (!this.testingTypeRoute) return undefined;
                if (method === "GET") return { body: { testingType: this.types.get(pid) ?? "functional" } };
                if (method === "PUT") {
                    const no = this.needs("editor");
                    if (no) return no;
                    if (!["functional", "security", "both"].includes(body?.testingType)) return this.refuse(400, "Choose functional, security or both.");
                    this.types.set(pid, body.testingType);
                    return { body: { testingType: body.testingType } };
                }
            }
            if (what === "sign-ins" && method === "GET") {
                // As SIGN's route: "main" and the test accounts, each judged (never a value).
                const list = this.signIns.get(pid) ?? [{ account: "main", label: "the project's own account", state: "missing", message: "No sign-in is saved for the project's own account. Save one in Settings (Test accounts, Saved sign-ins) or upload one here; until then the assessment visits signed out.", savedAt: null, expiresAt: null, site: null }];
                return { body: { signIns: list } };
            }
            if (what === "activity" && method === "GET") {
                // As CORE's route: newest first, `limit` (at most 200), `before` (an event id), `applicationId`.
                const q = url.searchParams;
                const limit = Math.min(200, Number(q.get("limit") ?? 50));
                const before = Number(q.get("before") ?? 0);
                const list = this.events.filter((e) => e.projectId === pid && (!before || e.id < before) && (!q.get("applicationId") || e.applicationId === q.get("applicationId"))).sort((a, b) => b.id - a.id);
                return { body: { events: list.slice(0, limit) } };
            }
            if (what === "notifications") {
                // As OPS's route (src/security/routes/notifications.ts).
                const defaults = { newCriticalHigh: true, failed: true, everyFinish: false, channelIds: null };
                if (method === "PUT") {
                    const no = this.needs("editor");
                    if (no) return no;
                    const extra = Object.keys(body ?? {}).filter((k) => !(k in defaults));
                    if (extra.length) return this.refuse(400, `Unrecognized key(s): ${extra.join(", ")}`);
                    this.notify.set(pid, { ...defaults, ...(this.notify.get(pid) ?? {}), ...body });
                }
                if (method === "GET" || method === "PUT") {
                    const settings = { ...defaults, ...(this.notify.get(pid) ?? {}) };
                    const chosen = settings.channelIds ? new Set(settings.channelIds) : undefined;
                    const channels = (this.channels.get(pid) ?? []).map((c) => ({ ...c, selected: c.enabled && (!chosen || chosen.has(c.id)) }));
                    return { body: { settings, saved: this.notify.has(pid), defaults, channels, recent: this.recent.get(pid) ?? [] } };
                }
            }
            if (what === "applications" && method === "GET") return { body: { applications: [...this.apps.values()].filter((a) => a.projectId === pid).map((a) => this.appView(a)), limits: {} } };
            if (what === "applications" && method === "POST") {
                const no = this.needs("editor");
                if (no) return no;
                const allowed = ["name", "targetUrl", "environment", "scope", "excludedPaths", "maxRequestsPerSecond", "apiSpecUrl", "notes", "signInAccount", "sensitiveWorkflows"];
                const extra = Object.keys(body ?? {}).filter((k) => !allowed.includes(k));
                if (extra.length) return this.refuse(400, `Unrecognized key(s): ${extra.join(", ")}`);
                const a = this.addApp(pid, body);
                return { status: 201, body: { application: this.appView(a), authorization: this.authState(a), statement: this.statement(a) } };
            }
            if (what === "assessments" && method === "GET") return { body: { assessments: [...this.assessments.values()].filter((a) => a.projectId === pid).sort((x, y) => y.createdAt.localeCompare(x.createdAt)).map((a) => this.asView(a)) } };
            if (what === "findings" && method === "GET") {
                const q = url.searchParams;
                let list = [...this.findings.values()].filter((f) => f.projectId === pid);
                if (q.get("application")) list = list.filter((f) => f.applicationId === q.get("application"));
                for (const k of ["severity", "category", "validation"]) if (q.get(k)) list = list.filter((f) => q.get(k)!.split(",").includes(f[k]));
                if (q.get("location")) list = list.filter((f) => f.location.toLowerCase().includes(q.get("location")!.toLowerCase()));
                if (q.get("q")) list = list.filter((f) => `${f.title} ${f.description}`.toLowerCase().includes(q.get("q")!.toLowerCase()));
                return { body: { findings: list, total: list.length, limit: 200, offset: 0 } };
            }
            if (what === "overview" && method === "GET") return { body: this.overview(pid) };
            if (what === "report" && method === "GET") return this.report(`project ${this.projects.get(pid)!.name}`, url);
            if (what === "stop-all" && method === "POST") {
                const no = this.needs("editor");
                if (no) return no;
                const stopped = [...this.assessments.values()].filter((a) => a.projectId === pid && RUNNING.includes(a.state));
                for (const a of stopped) Object.assign(a, { state: "CANCELLED", finishedAt: new Date().toISOString(), progressText: "Stopped by the emergency stop." });
                return { status: 202, body: { stopped: stopped.length, assessments: stopped.map((a) => this.asView(a)) } };
            }
            return undefined;
        }

        if ((m = s.match(/^\/applications\/([^/]+)(?:\/(authorizations|assessments|findings|api-document|saved-sign-in))?$/))) {
            const app = this.apps.get(m[1]!);
            if (!app) return this.refuse(404, "Application not found");
            const sub = m[2];
            if (!sub && method === "GET") return { body: { application: this.appView(app), authorization: this.authState(app), currentAuthorization: null, statement: this.statement(app), activeAssessmentId: this.active(app.id)?.id ?? null } };
            if (!sub && method === "PATCH") {
                const no = this.needs("editor");
                if (no) return no;
                Object.assign(app, body, { updatedAt: new Date().toISOString() });
                return { body: { application: this.appView(app), authorization: this.authState(app), changed: Object.keys(body ?? {}) } };
            }
            if (!sub && method === "DELETE") {
                const no = this.needs("owner");
                if (no) return no;
                this.apps.delete(app.id);
                return { body: { deleted: true } };
            }
            if (sub === "authorizations" && method === "GET") return { body: { authorizations: [...this.auths.values()].filter((x) => x.applicationId === app.id), authorization: this.authState(app), statement: this.statement(app) } };
            if (sub === "authorizations" && method === "POST") {
                const no = this.needs("owner");
                if (no) return no;
                if (body?.confirm !== true) return this.refuse(400, "Tick the box to confirm the statement.");
                if (!body?.approverName) return this.refuse(400, "Give the name of the person who approved the assessment.");
                const r = this.authorize(app.id, { basis: body.basis, approverName: body.approverName, approverEmail: body.approverEmail ?? null, documentReference: body.documentReference ?? null, restrictions: body.restrictions ?? null, confirmedAt: new Date().toISOString() });
                return { status: 201, body: { authorization: r, state: this.authState(app) } };
            }
            if (sub === "assessments" && method === "POST") {
                const no = this.needs("editor");
                if (no) return no;
                const st = this.authState(app);
                if (st.state !== "current") return this.refuse(409, st.message);
                if (this.active(app.id)) return this.refuse(409, "An assessment of this application is already running. Wait for it to finish or stop it.");
                const a = this.addAssessment(app.id, { state: "QUEUED", progress: 0, progressText: "Waiting to start.", coverage: null, startedAt: null, finishedAt: null, retestOf: body?.retestOf ?? null, authorizationId: st.authorizationId });
                return { status: 201, body: { assessment: this.asView(a) } };
            }
            if (sub === "saved-sign-in" && method === "PUT") {
                // As SIGN's route: a storage state file for an account; the answer is its judged state, never a value.
                const no = this.needs("editor");
                if (no) return no;
                let state: any;
                try {
                    state = typeof body?.storageState === "string" ? JSON.parse(body.storageState) : body?.storageState;
                } catch {
                    return this.refuse(400, "The saved sign-in is not valid JSON.");
                }
                if (!Array.isArray(state?.cookies)) return this.refuse(400, "This is not a saved browser sign-in: it has no cookies list.");
                const status = { account: body.account, label: body.account, state: "not-checked", message: `The assessment loads the saved sign-in for ${body.account === "main" ? "the project's own account" : `the test account “${body.account}”`}. It has not been checked yet and its cookies give no end date.`, savedAt: new Date().toISOString(), expiresAt: null, site: new URL(app.targetUrl).origin };
                const list = (this.signIns.get(app.projectId) ?? []).filter((x) => x.account !== body.account);
                this.signIns.set(app.projectId, [...list, status]);
                return { body: { signIn: status } };
            }
            if (sub === "api-document") {
                // As SIGN's route: the text is never answered, only what was read from it.
                if (method === "GET") {
                    const d = this.apiDocs.get(app.id);
                    if (!d) return { body: { document: null, operations: [], baseUrl: null } };
                    const { ops, ...document } = d.summary;
                    return { body: { document, operations: ops, baseUrl: app.targetUrl } };
                }
                const no = this.needs("editor");
                if (no) return no;
                if (method === "DELETE") {
                    const had = this.apiDocs.delete(app.id);
                    app.apiDocument = null;
                    return { body: { deleted: had } };
                }
                if (method === "PUT") {
                    let doc: any;
                    try {
                        doc = JSON.parse(String(body?.content ?? ""));
                    } catch {
                        return this.refuse(400, "The API document is not valid JSON.");
                    }
                    if (!doc?.paths || typeof doc.paths !== "object") return this.refuse(400, "This is not an OpenAPI or Swagger document: it has no paths.");
                    const ops: Json[] = [];
                    for (const [p, item] of Object.entries<any>(doc.paths)) for (const mth of Object.keys(item)) ops.push(mth === "get" && !p.includes("{") ? { method: mth, path: p, url: new URL(p, app.targetUrl).href, request: true, reason: null, kind: "request" } : { method: mth, path: p, url: null, request: false, reason: mth === "get" ? "It needs values (a path parameter), and none are ever made up." : `It is a ${mth.toUpperCase()} operation, which could change data, so it is never called.`, kind: mth === "get" ? "needs-values" : "not-get" });
                    const summary = { fileName: body.fileName, format: "json", sizeBytes: String(body.content).length, sha256: "0".repeat(64), title: doc.info?.title ?? null, version: doc.info?.version ?? null, operations: ops.length, requestable: ops.filter((o) => o.request).length, uploadedAt: new Date().toISOString(), uploadedBy: "Anyone (open access)" };
                    this.apiDocs.set(app.id, { summary: { ...summary, ops }, text: String(body.content) });
                    app.apiDocument = summary;
                    return { body: { document: summary, operations: ops, baseUrl: app.targetUrl } };
                }
            }
            if (sub === "findings" && method === "POST") {
                const no = this.needs("editor");
                if (no) return no;
                for (const k of ["title", "location", "description", "impact", "remediation"]) if (!String(body?.[k] ?? "").trim()) return this.refuse(400, `${k}: Too small: expected string to have >=1 characters`);
                const f = this.addFinding(app.id, { ...body, source: "manual", validation: "needs-review", evidence: (body.evidence ?? []).map((e: Json) => ({ ...e, value: String(e.value).replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email hidden]") })) });
                return { status: 201, body: { finding: f } };
            }
            return undefined;
        }

        if ((m = s.match(/^\/authorizations\/([^/]+)$/)) && method === "DELETE") {
            const no = this.needs("owner");
            if (no) return no;
            const r = this.auths.get(m[1]!);
            if (!r) return this.refuse(404, "Authorization not found");
            r.revokedAt = new Date().toISOString();
            return { body: { authorization: r, state: this.authState(this.apps.get(r.applicationId)!), stoppedAssessmentId: null } };
        }

        if ((m = s.match(/^\/assessments\/([^/]+)(?:\/(cancel|report))?$/))) {
            const a = this.assessments.get(m[1]!);
            if (!a) return this.refuse(404, "Assessment not found");
            if (!m[2] && method === "GET") return { body: { assessment: this.asView(a) } };
            if (m[2] === "cancel" && method === "POST") {
                const no = this.needs("editor");
                if (no) return no;
                Object.assign(a, { state: "CANCELLED", finishedAt: new Date().toISOString(), progressText: "Stopped." });
                return { status: 202, body: { assessment: this.asView(a) } };
            }
            if (m[2] === "report" && method === "GET") return this.report(`assessment ${a.id}`, url);
            return undefined;
        }

        if ((m = s.match(/^\/findings\/([^/]+)$/))) {
            const f = this.findings.get(m[1]!);
            if (!f) return this.refuse(404, "Finding not found");
            const app = this.apps.get(f.applicationId);
            if (method === "GET") return { body: { finding: f, history: this.history.get(f.id) ?? [], application: app ? { id: app.id, name: app.name, targetUrl: app.targetUrl } : null, sightings: [] } };
            if (method === "PATCH") {
                const no = this.needs("editor");
                if (no) return no;
                const h = { id: (this.history.get(f.id)?.length ?? 0) + 1, at: new Date().toISOString(), actor: "Anyone (open access)", actorId: null, from: body.validation === f.validation ? null : f.validation, to: body.validation === f.validation ? null : body.validation, comment: body.comment ?? null, assessmentId: null };
                this.history.get(f.id)!.push(h);
                f.validation = body.validation;
                return { body: { finding: f, history: this.history.get(f.id) } };
            }
        }
        return undefined;
    }

    private report(what: string, url: URL) {
        const format = url.searchParams.get("format") ?? "html";
        if (format === "csv") return { body: "title,severity\r\nContent Security Policy is missing,medium\r\n", type: "text/csv; charset=utf-8", headers: { "content-disposition": 'attachment; filename="security-report.csv"' } };
        if (format === "xlsx") return { body: "PK fake workbook", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers: { "content-disposition": 'attachment; filename="security-report.xlsx"' } };
        if (format === "pdf") return { body: "%PDF-1.4\n% fake\n", type: "application/pdf", headers: { "content-disposition": 'attachment; filename="security-report.pdf"' } };
        return { body: `<!doctype html><html lang="en"><head><title>Security report</title></head><body><h1>Security assessment report</h1><p>Report of the ${what}.</p><h2>Executive summary</h2><p>Passive, read-only.</p></body></html>`, type: "text/html; charset=utf-8" };
    }
}

export async function startSecurityFake(port: number): Promise<SecurityFake> {
    const f = new SecurityFake(port);
    await f.start();
    return f;
}
