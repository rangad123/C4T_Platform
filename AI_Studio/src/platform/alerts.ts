/**
 * Alert channels (generic webhook, Slack-compatible incoming webhook), message building and delivery.
 *
 * Channel URLs are secrets (a Slack webhook URL lets anyone post to the channel): stored encrypted, only the
 * host is ever shown. Delivery never fails a job: every outcome is written to `alert_log`.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import type { ApiChange } from "../engine/contracts/diff.js";
import { ignoredNote } from "../engine/quarantine/rules.js";
import type { Severity } from "../engine/validation/severity.js";
import type { Db, Row } from "./db.js";
import { buildEmail, mergeSmtp, publicSmtp, sendEmail, type EmailDeliveryOptions, type MessageContent, type SmtpPatchT, type SmtpSettings } from "./alert-email.js";
import { HttpError } from "./http-error.js";
import { assertAllowedTarget } from "./net-guard.js";
import type { SecretBox } from "./secrets.js";
import { isFailing, severityAtLeast, type Change, type RunSummary } from "./trends.js";

export const ALERT_EVENTS = ["run_failed", "regression", "recovered", "flaky", "api_breaking_change"] as const;
export type AlertEvent = (typeof ALERT_EVENTS)[number];
/** Not derived from a run's test results: sent by `notifyApiDrift` when the live API changed shape between two runs. */
export const API_DRIFT_EVENT: AlertEvent = "api_breaking_change";
export const CHANNEL_KINDS = ["webhook", "slack", "teams", "email"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export interface AlertChannel {
    id: string;
    projectId: string;
    kind: ChannelKind;
    name: string;
    /** Host of the destination; the full URL is never returned. For an email channel: the recipients. */
    host: string;
    /** Email channels only. */
    recipients?: string[];
    /** Email channels only: the mail server in use (never the user name or password), or null when none is set up. */
    smtp?: ({ source: "server" | "channel" } & ReturnType<typeof publicSmtp>) | null;
    events: AlertEvent[];
    minSeverity: Severity | null;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface AlertLogEntry {
    id: number;
    projectId: string;
    channelId: string | null;
    channelName: string;
    channelKind: string;
    /** Comma-separated events the message carried, or "test". */
    event: string;
    jobId: string | null;
    status: "sent" | "failed";
    httpStatus: number | null;
    attempts: number;
    error: string | null;
    summary: string | null;
    createdAt: string;
}

const baseChannel = (r: Row): AlertChannel => ({
    id: r.id,
    projectId: r.project_id,
    kind: r.kind,
    name: r.name,
    host: r.url_host,
    events: JSON.parse(r.events_json),
    minSeverity: r.min_severity ?? null,
    enabled: Boolean(r.enabled),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
});

const nowIso = () => new Date().toISOString();

export class AlertStore {
    constructor(
        private readonly db: Db,
        private readonly secrets: SecretBox,
        /** The server-wide mail settings (from the environment), used by email channels without settings of their own. */
        private readonly serverMail: () => SmtpSettings | undefined = () => undefined,
    ) {}

    /** The public shape: an email channel also shows its recipients and which mail server it uses, never the login. */
    private toChannel(r: Row): AlertChannel {
        const ch = baseChannel(r);
        if (ch.kind !== "email") return ch;
        const e = this.secrets.decrypt<{ email: { to: string[]; smtp?: SmtpSettings } }>(r.url_enc).email;
        const server = this.serverMail();
        const smtp = e.smtp ? { source: "channel" as const, ...publicSmtp(e.smtp) } : server ? { source: "server" as const, ...publicSmtp(server) } : null;
        return { ...ch, recipients: e.to, smtp };
    }

    createEmail(input: { projectId: string; name: string; recipients: string[]; smtp?: SmtpSettings; events: AlertEvent[]; minSeverity?: Severity | null; enabled?: boolean }): AlertChannel {
        const id = randomUUID();
        const t = nowIso();
        this.db.run(
            "INSERT INTO alert_channels (id, project_id, kind, name, url_enc, url_host, events_json, min_severity, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            id,
            input.projectId,
            "email",
            input.name,
            this.secrets.encrypt({ email: { to: input.recipients, ...(input.smtp ? { smtp: input.smtp } : {}) } }),
            input.recipients.join(", "),
            JSON.stringify(input.events),
            input.minSeverity ?? null,
            input.enabled === false ? 0 : 1,
            t,
            t,
        );
        return this.get(id)!;
    }

    /** Change an email channel's recipients and/or own mail settings (`null` goes back to the server's). */
    updateEmail(id: string, patch: { recipients?: string[]; smtp?: SmtpPatchT | null }): void {
        const cur = this.emailOf(id);
        const to = patch.recipients ?? cur.to;
        const smtp = patch.smtp === undefined ? cur.smtp : patch.smtp === null ? undefined : mergeSmtp(cur.smtp, patch.smtp);
        this.db.run("UPDATE alert_channels SET url_enc = ?, url_host = ? WHERE id = ?", this.secrets.encrypt({ email: { to, ...(smtp ? { smtp } : {}) } }), to.join(", "), id);
    }

    /** Recipients and the channel's own mail settings, decrypted. Only the sender uses this. */
    emailOf(id: string): { to: string[]; smtp?: SmtpSettings } {
        const r = this.db.get<{ url_enc: string }>("SELECT url_enc FROM alert_channels WHERE id = ?", id);
        if (!r) throw new Error("Channel not found");
        return this.secrets.decrypt<{ email: { to: string[]; smtp?: SmtpSettings } }>(r.url_enc).email;
    }

    /** The mail server an email channel sends through: its own settings, else the server's. */
    smtpFor(id: string): SmtpSettings | undefined {
        return this.emailOf(id).smtp ?? this.serverMail();
    }

    create(input: { projectId: string; kind: ChannelKind; name: string; url: string; events: AlertEvent[]; minSeverity?: Severity | null; enabled?: boolean }): AlertChannel {
        const id = randomUUID();
        const t = nowIso();
        this.db.run(
            "INSERT INTO alert_channels (id, project_id, kind, name, url_enc, url_host, events_json, min_severity, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            id,
            input.projectId,
            input.kind,
            input.name,
            this.secrets.encrypt({ url: input.url }),
            new URL(input.url).host,
            JSON.stringify(input.events),
            input.minSeverity ?? null,
            input.enabled === false ? 0 : 1,
            t,
            t,
        );
        return this.get(id)!;
    }

    get(id: string): AlertChannel | undefined {
        const r = this.db.get("SELECT * FROM alert_channels WHERE id = ?", id);
        return r ? this.toChannel(r) : undefined;
    }

    list(projectId: string): AlertChannel[] {
        return this.db.all("SELECT * FROM alert_channels WHERE project_id = ? ORDER BY created_at", projectId).map((r) => this.toChannel(r));
    }

    update(id: string, patch: { name?: string; url?: string; events?: AlertEvent[]; minSeverity?: Severity | null; enabled?: boolean }): AlertChannel | undefined {
        const cur = this.get(id);
        if (!cur) return undefined;
        this.db.run(
            "UPDATE alert_channels SET name = ?, events_json = ?, min_severity = ?, enabled = ?, updated_at = ? WHERE id = ?",
            patch.name ?? cur.name,
            JSON.stringify(patch.events ?? cur.events),
            patch.minSeverity === undefined ? cur.minSeverity : patch.minSeverity,
            (patch.enabled ?? cur.enabled) ? 1 : 0,
            nowIso(),
            id,
        );
        if (patch.url) this.db.run("UPDATE alert_channels SET url_enc = ?, url_host = ? WHERE id = ?", this.secrets.encrypt({ url: patch.url }), new URL(patch.url).host, id);
        return this.get(id);
    }

    delete(id: string): boolean {
        return Number(this.db.run("DELETE FROM alert_channels WHERE id = ?", id).changes) > 0;
    }

    /** The destination URL. Only the sender uses this; it never goes into an API response. */
    urlOf(id: string): string {
        const r = this.db.get<{ url_enc: string }>("SELECT url_enc FROM alert_channels WHERE id = ?", id);
        if (!r) throw new Error("Channel not found");
        return this.secrets.decrypt<{ url: string }>(r.url_enc).url;
    }

    // ── what each channel was last told ──
    state(channelId: string, event: AlertEvent): string | undefined {
        return this.db.get<{ fingerprint: string }>("SELECT fingerprint FROM alert_state WHERE channel_id = ? AND event = ?", channelId, event)?.fingerprint;
    }
    setState(channelId: string, event: AlertEvent, fingerprint: string): void {
        this.db.run("INSERT INTO alert_state (channel_id, event, fingerprint) VALUES (?,?,?) ON CONFLICT(channel_id, event) DO UPDATE SET fingerprint = excluded.fingerprint", channelId, event, fingerprint);
    }
    clearState(channelId: string, events: AlertEvent[]): void {
        for (const e of events) this.db.run("DELETE FROM alert_state WHERE channel_id = ? AND event = ?", channelId, e);
    }

    // ── log ──
    log(e: Omit<AlertLogEntry, "id" | "createdAt">): void {
        this.db.run(
            "INSERT INTO alert_log (project_id, channel_id, channel_name, channel_kind, event, job_id, status, http_status, attempts, error, summary, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            e.projectId,
            e.channelId,
            e.channelName,
            e.channelKind,
            e.event,
            e.jobId,
            e.status,
            e.httpStatus,
            e.attempts,
            e.error?.slice(0, 500) ?? null,
            e.summary?.slice(0, 500) ?? null,
            nowIso(),
        );
        // The log is for the last few weeks of activity, not an archive.
        this.db.run("DELETE FROM alert_log WHERE project_id = ? AND id NOT IN (SELECT id FROM alert_log WHERE project_id = ? ORDER BY id DESC LIMIT 500)", e.projectId, e.projectId);
    }

    listLog(projectId: string, limit = 50): AlertLogEntry[] {
        return this.db.all("SELECT * FROM alert_log WHERE project_id = ? ORDER BY id DESC LIMIT ?", projectId, limit).map((r) => ({
            id: r.id,
            projectId: r.project_id,
            channelId: r.channel_id,
            channelName: r.channel_name,
            channelKind: r.channel_kind,
            event: r.event,
            jobId: r.job_id,
            status: r.status,
            httpStatus: r.http_status,
            attempts: r.attempts,
            error: r.error,
            summary: r.summary,
            createdAt: r.created_at,
        }));
    }
}

// ── delivery ────────────────────────────────────────────────────────────────

export interface DeliveryOptions {
    /** Per attempt. */
    timeoutMs?: number;
    /** Waits before each retry; the number of entries is the number of retries. */
    backoffMs?: number[];
}
export interface DeliveryResult {
    ok: boolean;
    status?: number;
    attempts: number;
    error?: string;
}

const DEFAULT_BACKOFF = [500, 2_000];
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const retryable = (status: number) => status >= 500 || status === 429 || status === 408;

/**
 * POST JSON to a channel URL. The target is re-checked before every attempt (a hostname can start resolving
 * to a private address after the channel was saved), redirects are not followed (they could lead inside the
 * network), and 5xx / 429 / network failures are retried with backoff. Other 4xx answers are final.
 */
export async function deliver(url: string, body: unknown, opts: DeliveryOptions = {}): Promise<DeliveryResult> {
    const backoff = opts.backoffMs ?? DEFAULT_BACKOFF;
    let last: DeliveryResult = { ok: false, attempts: 0, error: "not sent" };
    for (let attempt = 1; attempt <= backoff.length + 1; attempt++) {
        if (attempt > 1) await wait(backoff[attempt - 2]!);
        try {
            await assertAllowedTarget(url);
        } catch (e) {
            return { ok: false, attempts: attempt, error: e instanceof HttpError ? e.message : "The address is not allowed" };
        }
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json", "user-agent": "ai-testing-platform-alerts/1" },
                body: JSON.stringify(body),
                redirect: "manual",
                signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000),
            });
            await res.arrayBuffer().catch(() => undefined); // drain so the connection can be reused
            if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, attempts: attempt };
            if (res.status >= 300 && res.status < 400) return { ok: false, status: res.status, attempts: attempt, error: `The address redirects (HTTP ${res.status}); use the final URL` };
            last = { ok: false, status: res.status, attempts: attempt, error: `The receiver answered HTTP ${res.status}` };
            if (!retryable(res.status)) return last;
        } catch (e) {
            const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
            const code = (e as { cause?: { code?: string } }).cause?.code;
            last = { ok: false, attempts: attempt, error: timedOut ? "The receiver did not answer in time" : `Could not reach the receiver${code ? ` (${code})` : ""}` };
        }
    }
    return last;
}

// ── messages ────────────────────────────────────────────────────────────────

export interface AlertSubject {
    project: { id: string; name: string; url: string | null };
    /** Link back to the project in the UI. */
    link: string;
}

const PRIORITY: AlertEvent[] = ["regression", "run_failed", "flaky", "recovered"];
const TITLE: Record<AlertEvent, string> = { regression: "Regression found", run_failed: "Test run failed", flaky: "Flaky tests detected", recovered: "Tests recovered", api_breaking_change: "API change that can break clients" };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const primaryEvent = (events: AlertEvent[]): AlertEvent => PRIORITY.find((e) => events.includes(e)) ?? events[0]!;

const short = (c: Change) => ({ testKey: c.key, title: c.title, ...(c.severity ? { severity: c.severity } : {}), ...(c.reason ? { reason: c.reason } : {}) });

/** The slice of a run one message talks about, filtered to what the channel cares about. */
export interface RunView {
    summary: RunSummary;
    events: AlertEvent[];
    newlyFailing: Change[];
    recovered: Change[];
    flaky: Change[];
    /** Currently failing tests (all of them, worst first). */
    failing: Change[];
}

const SEV_ORDER = ["critical", "high", "medium", "low"];
const worstFirst = (a: Change, b: Change) => (a.severity ? SEV_ORDER.indexOf(a.severity) : 9) - (b.severity ? SEV_ORDER.indexOf(b.severity) : 9);

/** What counts toward a run's numbers: quarantined tests are left out because they decide nothing. */
export function counted(s: RunSummary): { total: number; passed: number; failing: number; note: string } {
    const q = s.quarantined;
    return { total: s.total - (q?.tests ?? 0), passed: s.validated - (q?.passed ?? 0), failing: s.failed + s.needsReview - (q ? q.failed + q.needsReview : 0), note: q ? ignoredNote(q.tests) : "" };
}

/** One sentence, in plain words, on what changed. */
export function headline(subject: AlertSubject, v: RunView): string {
    const s = v.summary;
    const name = subject.project.name;
    if (s.jobError) return `${name}: the run could not complete. ${s.jobError}`;
    const parts: string[] = [];
    if (v.newlyFailing.length) parts.push(`${plural(v.newlyFailing.length, "test")} newly failing`);
    const still = v.failing.length - v.newlyFailing.length;
    if (still > 0 && !v.newlyFailing.length) parts.push(`${plural(v.failing.length, "test")} failing`);
    else if (still > 0) parts.push(`${still} still failing`);
    if (v.flaky.length) parts.push(`${plural(v.flaky.length, "flaky test")}`);
    if (v.recovered.length) parts.push(`${v.recovered.length} recovered`);
    const c = counted(s);
    const stats = c.total ? ` ${c.passed} of ${plural(c.total, "test")} passed (${s.passRate}%)${c.note ? ` ${c.note}` : ""}.` : c.note ? ` ${c.note}.` : "";
    return `${name}: ${parts.join(", ") || "run finished"}.${stats}`;
}

export function webhookPayload(subject: AlertSubject, v: RunView, sentAt = nowIso()): Record<string, unknown> {
    const s = v.summary;
    return {
        event: primaryEvent(v.events),
        events: v.events,
        test: false,
        sentAt,
        project: subject.project,
        link: subject.link,
        summary: headline(subject, v),
        run: {
            jobId: s.jobId,
            status: s.jobStatus,
            mode: s.mode,
            trigger: s.trigger,
            finishedAt: s.finishedAt,
            total: s.total,
            passed: s.validated,
            failed: s.failed,
            needsReview: s.needsReview,
            flaky: s.flaky,
            passRate: s.passRate,
            durationMs: s.durationMs,
            ...(s.quarantined ? { quarantined: s.quarantined.tests } : {}),
        },
        newlyFailing: v.newlyFailing.map(short),
        recovered: v.recovered.map(short),
        flaky: v.flaky.map(short),
        findings: v.failing.slice(0, 5).map(short),
        error: s.jobError,
    };
}

export function testWebhookPayload(subject: AlertSubject, sentAt = nowIso()): Record<string, unknown> {
    return { event: "test", events: ["test"], test: true, sentAt, project: subject.project, link: subject.link, summary: `This is a test message from the AI Testing Platform for ${subject.project.name}. Alerts for this channel will look like this.`, run: null, newlyFailing: [], recovered: [], flaky: [], findings: [], error: null };
}

/** Slack mrkdwn needs only these three characters escaped. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Slack incoming-webhook body: `text` is the notification fallback, `blocks` the layout. */
export function slackPayload(subject: AlertSubject, v: RunView): Record<string, unknown> {
    const s = v.summary;
    const c = counted(s);
    const text = headline(subject, v);
    const blocks: unknown[] = [
        { type: "header", text: { type: "plain_text", text: `${TITLE[primaryEvent(v.events)]}: ${subject.project.name}`.slice(0, 150) } },
        { type: "section", text: { type: "mrkdwn", text: esc(text) } },
    ];
    if (s.total) {
        blocks.push({
            type: "section",
            fields: [
                { type: "mrkdwn", text: `*Passed*\n${c.passed} of ${c.total} (${s.passRate}%)` },
                { type: "mrkdwn", text: `*Failing*\n${c.failing}` },
                { type: "mrkdwn", text: `*Flaky*\n${s.flaky}` },
                { type: "mrkdwn", text: `*Run*\n${s.trigger === "schedule" ? "Scheduled" : s.trigger === "deploy" ? "After a deploy" : "Manual"}` },
            ],
        });
    }
    const top = v.failing.slice(0, 5);
    if (top.length) blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Top findings*\n${top.map((c) => `• ${esc(c.title)}${c.severity ? ` _(${c.severity})_` : ""}${c.reason ? `: ${esc(c.reason.slice(0, 140))}` : ""}`).join("\n")}` } });
    blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open project" }, url: subject.link }] });
    return { text, blocks };
}

export function testSlackPayload(subject: AlertSubject): Record<string, unknown> {
    const text = `This is a test message from the AI Testing Platform for ${subject.project.name}.`;
    return {
        text,
        blocks: [
            { type: "section", text: { type: "mrkdwn", text: esc(text) } },
            { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open project" }, url: subject.link }] },
        ],
    };
}

// ── API drift messages ──────────────────────────────────────────────────────

export interface DriftView {
    from: { jobId: string; at: string };
    to: { jobId: string; at: string };
    breaking: ApiChange[];
    nonBreakingCount: number;
}

export function driftHeadline(subject: AlertSubject, v: DriftView): string {
    const top = v.breaking.slice(0, 3).map((c) => `${c.operation}: ${c.message}`).join("; ");
    return `${subject.project.name}: the API changed since the previous run in ${plural(v.breaking.length, "way")} that can break existing clients. ${top}${v.breaking.length > 3 ? `; and ${v.breaking.length - 3} more` : ""}.`;
}

export function driftWebhookPayload(subject: AlertSubject, v: DriftView, sentAt = nowIso()): Record<string, unknown> {
    return {
        event: API_DRIFT_EVENT,
        events: [API_DRIFT_EVENT],
        test: false,
        sentAt,
        project: subject.project,
        link: subject.link,
        summary: driftHeadline(subject, v),
        run: null,
        newlyFailing: [],
        recovered: [],
        flaky: [],
        findings: [],
        error: null,
        apiChanges: { from: v.from, to: v.to, breaking: v.breaking.slice(0, 20).map((c) => ({ operation: c.operation, message: c.message })), breakingCount: v.breaking.length, otherChanges: v.nonBreakingCount },
    };
}

export function driftSlackPayload(subject: AlertSubject, v: DriftView): Record<string, unknown> {
    const lines = v.breaking.slice(0, 8).map((c) => `• \`${esc(c.operation)}\`: ${esc(c.message)}`);
    if (v.breaking.length > 8) lines.push(`…and ${v.breaking.length - 8} more`);
    return {
        text: driftHeadline(subject, v),
        blocks: [
            { type: "header", text: { type: "plain_text", text: `${TITLE[API_DRIFT_EVENT]}: ${subject.project.name}`.slice(0, 150) } },
            { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
            { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open project" }, url: subject.link }] },
        ],
    };
}

// ── the same alerts for Microsoft Teams and email ───────────────────────────

const RUN_LABEL = { schedule: "Scheduled", deploy: "After a deploy", manual: "Manual" } as Record<string, string>;

/** The words of a run alert, shared by the Teams card and the email. */
export function runContent(subject: AlertSubject, v: RunView): MessageContent {
    const s = v.summary;
    const c = counted(s);
    return {
        title: `${TITLE[primaryEvent(v.events)]}: ${subject.project.name}`,
        headline: headline(subject, v),
        subjectDetail: s.jobError ? "the run could not complete" : c.total ? `${c.passed} of ${c.total} passed` : "",
        facts: c.total
            ? [
                  ["Passed", `${c.passed} of ${c.total} (${s.passRate}%)`],
                  ["Failing", String(c.failing)],
                  ["Flaky", String(s.flaky)],
                  ["Run", RUN_LABEL[s.trigger] ?? "Manual"],
              ]
            : [],
        findingsHeading: "Top findings",
        findings: v.failing.slice(0, 5).map((c) => ({ title: c.title, ...(c.severity ? { severity: c.severity } : {}), ...(c.reason ? { reason: c.reason.slice(0, 140) } : {}) })),
        link: subject.link,
    };
}

export function driftContent(subject: AlertSubject, v: DriftView): MessageContent {
    return {
        title: `${TITLE[API_DRIFT_EVENT]}: ${subject.project.name}`,
        headline: driftHeadline(subject, v),
        subjectDetail: `${plural(v.breaking.length, "breaking change")}`,
        facts: [],
        findingsHeading: "What changed",
        findings: v.breaking.slice(0, 8).map((c) => ({ title: c.operation, reason: c.message })),
        link: subject.link,
    };
}

export function testContent(subject: AlertSubject): MessageContent {
    return {
        title: `Test message: ${subject.project.name}`,
        headline: `This is a test message from the AI Testing Platform for ${subject.project.name}. Alerts for this channel will look like this.`,
        subjectDetail: "",
        facts: [],
        findingsHeading: "",
        findings: [],
        link: subject.link,
    };
}

/** Teams renders a small markdown subset in card text: keep the characters that would turn text into links or emphasis literal. */
const teamsEsc = (s: string) => s.replace(/\s+/g, " ").replace(/([\\`*_\[\]()<>~#|])/g, "\\$1");

/**
 * Adaptive Card message, the format Teams "Workflows" webhooks (and the older Office 365 connectors) accept:
 * `type: "message"` with the card as an attachment.
 */
export function teamsPayload(c: MessageContent): Record<string, unknown> {
    const body: unknown[] = [
        { type: "TextBlock", text: teamsEsc(c.title), weight: "Bolder", size: "Large", wrap: true },
        { type: "TextBlock", text: teamsEsc(c.headline), wrap: true },
    ];
    if (c.facts.length) body.push({ type: "FactSet", facts: c.facts.map(([title, value]) => ({ title, value })) });
    if (c.findings.length) {
        body.push({ type: "TextBlock", text: teamsEsc(c.findingsHeading), weight: "Bolder", wrap: true, spacing: "Medium" });
        for (const f of c.findings) body.push({ type: "TextBlock", text: teamsEsc(`${f.title}${f.severity ? ` (${f.severity})` : ""}${f.reason ? `: ${f.reason}` : ""}`), wrap: true, spacing: "Small" });
    }
    return {
        type: "message",
        attachments: [
            {
                contentType: "application/vnd.microsoft.card.adaptive",
                contentUrl: null,
                content: {
                    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
                    type: "AdaptiveCard",
                    version: "1.4",
                    body,
                    actions: [{ type: "Action.OpenUrl", title: "Open project", url: c.link }],
                    msteams: { width: "Full" },
                },
            },
        ],
    };
}

// ── choosing and sending alerts for a finished run ──────────────────────────

const fingerprint = (parts: string[]) => createHash("sha1").update([...parts].sort().join("\n")).digest("hex").slice(0, 16);

/** A re-run of a single test by hand is not worth a message; scheduled runs and fresh analyses always are. */
export function isAlertable(s: RunSummary): boolean {
    return s.trigger === "schedule" || s.trigger === "deploy" || s.mode === "generate" || s.total >= 2;
}

/** The events a run triggers for a channel that cares about findings from `min` severity up, with their fingerprints. */
export function triggeredEvents(s: RunSummary, min: Severity): Map<AlertEvent, string> {
    const out = new Map<AlertEvent, string>();
    const keep = (c: Change) => c.status === "f" || severityAtLeast(c.severity, min) || c.severity === undefined;
    const failingResults = s.results.filter((r) => isFailing(r, min));
    const newlyFailing = s.diff.newlyFailing.filter(keep);
    if (s.jobError) out.set("run_failed", fingerprint(["job", s.jobError.slice(0, 120)]));
    else if (failingResults.length) out.set("run_failed", fingerprint(failingResults.map((r) => `${r.k}:${r.s}`)));
    if (newlyFailing.length) out.set("regression", fingerprint(newlyFailing.map((c) => c.key)));
    if (s.diff.fixed.length) out.set("recovered", fingerprint(s.diff.fixed.map((c) => c.key)));
    if (s.diff.flakyPasses.length) out.set("flaky", fingerprint(s.diff.flakyPasses.map((c) => c.key)));
    return out;
}

function viewFor(s: RunSummary, events: AlertEvent[], min: Severity): RunView {
    const keep = (c: Change) => c.status === "f" || c.severity === undefined || severityAtLeast(c.severity, min);
    const failing: Change[] = s.results
        .filter((r) => isFailing(r, min))
        .map((r) => ({ key: r.key, title: r.title, id: r.id, status: r.s, ...(r.why ? { reason: r.why } : {}), ...(r.sev ? { severity: r.sev } : {}) }))
        .sort(worstFirst);
    return { summary: s, events, newlyFailing: s.diff.newlyFailing.filter(keep).sort(worstFirst), recovered: s.diff.fixed, flaky: s.diff.flakyPasses, failing };
}

export interface AlertServiceDeps {
    store: AlertStore;
    config: Config;
    delivery?: DeliveryOptions;
}

export interface SentAlert {
    channelId: string;
    events: AlertEvent[];
    ok: boolean;
}

export class AlertService {
    constructor(private readonly deps: AlertServiceDeps) {}

    /** Deliver one message the way the channel's kind wants it: JSON to a URL (webhook, Slack, Teams) or an email over SMTP. */
    private async send(ch: AlertChannel, out: { slack: () => unknown; webhook: () => unknown; content: () => MessageContent }, opts?: DeliveryOptions & EmailDeliveryOptions): Promise<DeliveryResult> {
        const { store } = this.deps;
        if (ch.kind === "email") {
            const smtp = store.smtpFor(ch.id);
            if (!smtp) return { ok: false, attempts: 0, error: "No mail server is set up for this channel any more. Set SMTP_HOST and SMTP_FROM on the server or give the channel its own." };
            return sendEmail(smtp, store.emailOf(ch.id).to, buildEmail(out.content()), opts);
        }
        const body = ch.kind === "slack" ? out.slack() : ch.kind === "teams" ? teamsPayload(out.content()) : out.webhook();
        return deliver(store.urlOf(ch.id), body, opts);
    }

    /** Base address for links back to the platform: PUBLIC_URL, else where the server itself listens. */
    baseUrl(fallback?: string): string {
        const c = this.deps.config;
        const host = c.HOST === "0.0.0.0" || c.HOST === "::" ? "localhost" : c.HOST;
        return (c.PUBLIC_URL || fallback || `http://${host}:${c.PORT}`).replace(/\/+$/, "");
    }

    subject(project: { id: string; name: string; url?: string | null }, fallbackBase?: string): AlertSubject {
        return { project: { id: project.id, name: project.name, url: project.url ?? null }, link: `${this.baseUrl(fallbackBase)}/#/projects/${project.id}` };
    }

    /**
     * Tell every interested channel about a finished run. An alert goes out once per distinct situation: a
     * failure that is still the same as the one the channel was last told about is not repeated, and the
     * memory is dropped when the situation clears, so the next failure is announced again.
     */
    async notifyRun(subject: AlertSubject, s: RunSummary): Promise<SentAlert[]> {
        const { store, config } = this.deps;
        const sent: SentAlert[] = [];
        for (const ch of store.list(s.projectId)) {
            if (!ch.enabled) continue;
            const min = ch.minSeverity ?? config.ALERT_MIN_SEVERITY;
            const triggered = triggeredEvents(s, min);
            // A job that ran no tests says nothing about the situations of the tests: leave their memory alone.
            if (s.total > 0) store.clearState(ch.id, ALERT_EVENTS.filter((e) => e !== API_DRIFT_EVENT && !triggered.has(e)));
            const fresh = PRIORITY.filter((e) => ch.events.includes(e) && triggered.has(e) && store.state(ch.id, e) !== triggered.get(e)!);
            if (fresh.length === 0) continue;

            const view = viewFor(s, fresh, min);
            const result = await this.send(ch, { slack: () => slackPayload(subject, view), webhook: () => webhookPayload(subject, view), content: () => runContent(subject, view) }, this.deps.delivery);
            store.log({ projectId: s.projectId, channelId: ch.id, channelName: ch.name, channelKind: ch.kind, event: fresh.join(","), jobId: s.jobId, status: result.ok ? "sent" : "failed", httpStatus: result.status ?? null, attempts: result.attempts, error: result.error ?? null, summary: headline(subject, view) });
            if (result.ok) for (const e of fresh) store.setState(ch.id, e, triggered.get(e)!);
            sent.push({ channelId: ch.id, events: fresh, ok: result.ok });
        }
        return sent;
    }

    /**
     * Tell channels subscribed to `api_breaking_change` that the live API changed shape in a way that can break clients.
     * Same de-duplication as run alerts: the same set of breaking changes is told once; the memory is dropped on the
     * next run without breaking changes, so a later break is announced again.
     */
    async notifyApiDrift(subject: AlertSubject, view: DriftView): Promise<SentAlert[]> {
        const { store } = this.deps;
        const sent: SentAlert[] = [];
        const print = fingerprint(view.breaking.map((c) => `${c.operation}:${c.message}`));
        for (const ch of store.list(subject.project.id)) {
            if (!ch.enabled || !ch.events.includes(API_DRIFT_EVENT)) continue;
            if (view.breaking.length === 0) {
                store.clearState(ch.id, [API_DRIFT_EVENT]);
                continue;
            }
            if (store.state(ch.id, API_DRIFT_EVENT) === print) continue;
            const result = await this.send(ch, { slack: () => driftSlackPayload(subject, view), webhook: () => driftWebhookPayload(subject, view), content: () => driftContent(subject, view) }, this.deps.delivery);
            store.log({ projectId: subject.project.id, channelId: ch.id, channelName: ch.name, channelKind: ch.kind, event: API_DRIFT_EVENT, jobId: view.to.jobId, status: result.ok ? "sent" : "failed", httpStatus: result.status ?? null, attempts: result.attempts, error: result.error ?? null, summary: driftHeadline(subject, view) });
            if (result.ok) store.setState(ch.id, API_DRIFT_EVENT, print);
            sent.push({ channelId: ch.id, events: [API_DRIFT_EVENT], ok: result.ok });
        }
        return sent;
    }

    /** Send a harmless message and report exactly what the receiver answered. One attempt, so the answer is the real one. */
    async sendTest(channel: AlertChannel, subject: AlertSubject): Promise<DeliveryResult> {
        const { store } = this.deps;
        const result = await this.send(channel, { slack: () => testSlackPayload(subject), webhook: () => testWebhookPayload(subject), content: () => testContent(subject) }, { ...this.deps.delivery, backoffMs: [] });
        store.log({ projectId: channel.projectId, channelId: channel.id, channelName: channel.name, channelKind: channel.kind, event: "test", jobId: null, status: result.ok ? "sent" : "failed", httpStatus: result.status ?? null, attempts: result.attempts, error: result.error ?? null, summary: "Test message" });
        return result;
    }

    /**
     * A message written by a runbook's notify step. The text is plain; each kind of channel escapes it its own way (Slack
     * markup, Teams markdown, HTML in email, JSON for a webhook). The outcome is written to the alert log like any other
     * delivery, and the caller decides what a failed delivery means (a runbook never fails because of it).
     */
    async sendRunbookMessage(channel: AlertChannel, subject: AlertSubject, msg: { runbookName: string; status: string; text: string; link: string; runId: string }): Promise<DeliveryResult> {
        const { store } = this.deps;
        const title = `Runbook ${msg.runbookName}: ${msg.status}`;
        const result = await this.send(
            channel,
            {
                slack: () => ({
                    text: msg.text,
                    blocks: [
                        { type: "header", text: { type: "plain_text", text: title.slice(0, 150) } },
                        { type: "section", text: { type: "mrkdwn", text: esc(msg.text) } },
                        { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open run" }, url: msg.link }] },
                    ],
                }),
                webhook: () => ({ event: "runbook", events: ["runbook"], test: false, sentAt: nowIso(), project: subject.project, link: msg.link, summary: msg.text, run: null, runbook: { name: msg.runbookName, status: msg.status, runId: msg.runId }, newlyFailing: [], recovered: [], flaky: [], findings: [], error: null }),
                content: () => ({ title, headline: msg.text, subjectDetail: msg.status, facts: [], findingsHeading: "", findings: [], link: msg.link }),
            },
            this.deps.delivery,
        );
        store.log({ projectId: channel.projectId, channelId: channel.id, channelName: channel.name, channelKind: channel.kind, event: "runbook", jobId: null, status: result.ok ? "sent" : "failed", httpStatus: result.status ?? null, attempts: result.attempts, error: result.error ?? null, summary: msg.text });
        return result;
    }
}
