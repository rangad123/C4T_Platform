/**
 * Messages when a security assessment ends: through the project's existing alert channels (webhook, Slack, Microsoft Teams, email; see
 * src/platform/alerts.ts), with a per-project setting.
 *
 * Stable API (UI2 builds the switch on the routes in ./routes/notifications.ts):
 *   notificationSettings(db, projectId)            the setting (defaults when never saved)
 *   saveNotificationSettings(db, projectId, patch) change it (what is left out stays)
 *   notifyAssessmentFinished(p, assessment, app)    called once when an assessment ends (RUN's loop, routes/assessments.ts `loopDeps`)
 *
 * When a message goes out (each switch is per project):
 *   newCriticalHigh  (default ON)   the assessment found critical or high findings that were not known before (new in this assessment),
 *                                   or (round 21) critical or high findings marked fixed that it saw again ("came back", reopened-critical-high)
 *   failed          (default ON)   the assessment failed
 *   everyFinish      (default OFF)  every end: completed, completed with gaps, failed, cancelled
 * At most one message per assessment and channel (the reasons are combined). `channelIds` null = every enabled alert channel of the
 * project; a list = only those (channels that no longer exist are skipped). Every delivery is written to the project's alert log.
 *
 * What a message carries: the project and application names, the state in plain words, counts by severity of the findings seen in the
 * assessment and of the new critical/high ones, and the link to the assessment. Never evidence, finding titles or locations, the target
 * address, the approver, an error text (it can name addresses) or any secret.
 *
 * Storage: the key/value table `ai_settings` (as llm-health does; no migration of its own), key `security-notify:<projectId>`, value the
 * JSON of the four fields. It travels with a project backup (security.json) and is removed with the project's security data.
 */
import { z } from "zod";
import type { Config } from "../config.js";
import { buildEmail, sendEmail, serverSmtp, type MessageContent } from "../platform/alert-email.js";
import { AlertStore, deliver, teamsPayload, type AlertChannel, type DeliveryOptions, type DeliveryResult } from "../platform/alerts.js";
import type { Db } from "../platform/db.js";
import { SecretBox } from "../platform/secrets.js";
import { EVERYONE_OPTED_OUT } from "../platform/project-folders.js";
import { SEVERITIES, type SecurityApplication, type SecurityAssessment, type Severity } from "./contract.js";

export interface SecurityNotificationSettings {
    /** New critical or high findings in an assessment (default true). */
    newCriticalHigh: boolean;
    /** The assessment failed (default true). */
    failed: boolean;
    /** Every end of an assessment, whatever its result (default false). */
    everyFinish: boolean;
    /** The alert channels to use: null = every enabled channel of the project. */
    channelIds: string[] | null;
}

export const NOTIFY_DEFAULTS: SecurityNotificationSettings = { newCriticalHigh: true, failed: true, everyFinish: false, channelIds: null };
export const MAX_NOTIFY_CHANNELS = 50;

/** The body of PUT /api/v1/security/projects/:id/notifications: every field optional; what is left out stays. */
export const NotificationSettingsPatch = z
    .object({
        newCriticalHigh: z.boolean(),
        failed: z.boolean(),
        everyFinish: z.boolean(),
        channelIds: z.array(z.string().min(1).max(100)).max(MAX_NOTIFY_CHANNELS).nullable(),
    })
    .partial()
    .strict();
export type NotificationSettingsPatchT = z.infer<typeof NotificationSettingsPatch>;

const keyOf = (projectId: string) => `security-notify:${projectId}`;

/** The project's setting, with `saved: false` when it was never changed (the defaults apply). */
export function notificationSettings(db: Db, projectId: string): SecurityNotificationSettings & { saved: boolean } {
    let raw: string | null | undefined;
    try {
        raw = db.get<{ value: string | null }>("SELECT value FROM ai_settings WHERE key = ?", keyOf(projectId))?.value;
    } catch {
        raw = undefined;
    }
    if (!raw) return { ...NOTIFY_DEFAULTS, saved: false };
    const parsed = NotificationSettingsPatch.safeParse((() => {
        try {
            return JSON.parse(raw);
        } catch {
            return {};
        }
    })());
    return { ...NOTIFY_DEFAULTS, ...(parsed.success ? parsed.data : {}), saved: true };
}

export function saveNotificationSettings(db: Db, projectId: string, patch: NotificationSettingsPatchT): SecurityNotificationSettings & { saved: boolean } {
    const { saved: _saved, ...cur } = notificationSettings(db, projectId);
    const next: SecurityNotificationSettings = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    if (next.channelIds) next.channelIds = [...new Set(next.channelIds)];
    db.run("INSERT INTO ai_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", keyOf(projectId), JSON.stringify(next));
    return { ...next, saved: true };
}

/** Removes the setting (a project's security data going away, or a restore that is undone). */
export function forgetNotificationSettings(db: Db, projectId: string): void {
    db.run("DELETE FROM ai_settings WHERE key = ?", keyOf(projectId));
}

// ── the message ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `reopened-critical-high` (round 21): a critical or high finding marked fixed was seen again ("came back"); sent under `newCriticalHigh`. */
export type NoticeReason = "new-critical-high" | "reopened-critical-high" | "failed" | "finished";
type Counts = Record<Severity, number>;

const STATE_WORDS: Record<SecurityAssessment["state"], string> = {
    QUEUED: "is waiting",
    DISCOVERING: "is running",
    SCANNING: "is running",
    VALIDATING: "is running",
    GENERATING_REPORT: "is running",
    COMPLETED: "finished",
    PARTIALLY_COMPLETED: "finished with gaps",
    FAILED: "failed",
    CANCELLED: "was cancelled",
};
const RESULT_WORDS: Partial<Record<SecurityAssessment["state"], string>> = { COMPLETED: "Finished", PARTIALLY_COMPLETED: "Finished with gaps", FAILED: "Failed", CANCELLED: "Cancelled" };
const SEVERITY_WORDS: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Informational" };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const zero = (): Counts => ({ critical: 0, high: 0, medium: 0, low: 0, info: 0 });

/** Findings seen in the assessment, the ones it found first, and (round 21) the ones it reopened (marked fixed, seen again), by severity. */
export function assessmentCounts(db: Db, assessmentId: string): { seen: Counts; newFindings: Counts; reopened: Counts } {
    const seen = zero();
    const newFindings = zero();
    const reopened = zero();
    // FIND's ingest writes this history line when a finding marked fixed is seen again (fixed → needs review, by this assessment).
    for (const r of db.all<{ severity: Severity; n: number }>(
        "SELECT f.severity AS severity, COUNT(DISTINCT f.id) AS n FROM security_finding_history h JOIN security_findings f ON f.id = h.finding_id WHERE h.assessment_id = ? AND h.from_validation = 'fixed' AND h.to_validation = 'needs-review' GROUP BY f.severity",
        assessmentId,
    ))
        if (r.severity in reopened) reopened[r.severity] = r.n;
    for (const r of db.all<{ severity: Severity; n: number }>(
        "SELECT f.severity AS severity, COUNT(*) AS n FROM security_finding_sightings s JOIN security_findings f ON f.id = s.finding_id WHERE s.assessment_id = ? GROUP BY f.severity",
        assessmentId,
    ))
        if (r.severity in seen) seen[r.severity] = r.n;
    for (const r of db.all<{ severity: Severity; n: number }>("SELECT severity, COUNT(*) AS n FROM security_findings WHERE first_assessment_id = ? GROUP BY severity", assessmentId)) if (r.severity in newFindings) newFindings[r.severity] = r.n;
    return { seen, newFindings, reopened };
}

export interface AssessmentNotice {
    reasons: NoticeReason[];
    content: MessageContent;
    webhook: Record<string, unknown>;
    slack: Record<string, unknown>;
}

/** Slack mrkdwn needs only these three characters escaped. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The message for an assessment that ended, or undefined when the setting says nothing is sent for it. Pure apart from reading the
 * counts. `base` is the platform's address for the link (PUBLIC_URL, else where it listens).
 */
export function buildNotice(
    db: Db,
    a: Pick<SecurityAssessment, "id" | "projectId" | "applicationId" | "state" | "finishedAt" | "retestOf">,
    app: Pick<SecurityApplication, "name"> | undefined,
    project: { id: string; name: string },
    settings: SecurityNotificationSettings,
    base: string,
    sentAt = new Date().toISOString(),
): AssessmentNotice | undefined {
    const { seen, newFindings, reopened } = assessmentCounts(db, a.id);
    const newSerious = newFindings.critical + newFindings.high;
    // Round 21: a critical or high finding that was marked fixed and is seen again "came back": it counts like a new one.
    const backSerious = reopened.critical + reopened.high;
    const reasons: NoticeReason[] = [];
    if (settings.newCriticalHigh && newSerious > 0) reasons.push("new-critical-high");
    if (settings.newCriticalHigh && backSerious > 0) reasons.push("reopened-critical-high");
    if (settings.failed && a.state === "FAILED") reasons.push("failed");
    if (settings.everyFinish) reasons.push("finished");
    if (!reasons.length) return undefined;

    const appName = (app?.name ?? "a deleted application").slice(0, 120);
    const kind = a.retestOf ? "retest" : "passive assessment";
    const seenTotal = SEVERITIES.reduce((s, k) => s + seen[k], 0);
    const seenText = seenTotal ? `Findings seen: ${SEVERITIES.filter((k) => seen[k] > 0).map((k) => `${seen[k]} ${SEVERITY_WORDS[k].toLowerCase()}`).join(", ")}.` : "No findings were seen.";
    const newText = newSerious ? ` ${plural(newSerious, "new critical or high finding")} (${newFindings.critical} critical, ${newFindings.high} high).` : "";
    const backText = backSerious ? ` ${plural(backSerious, "critical or high finding")} came back: marked fixed, then seen again (${reopened.critical} critical, ${reopened.high} high).` : "";
    const headline = `The ${kind} of “${appName}” in ${project.name} ${STATE_WORDS[a.state]}.${newText}${backText} ${seenText}`;
    const title = reasons.includes("new-critical-high")
        ? `New critical or high findings: ${appName}`
        : reasons.includes("reopened-critical-high")
          ? `Critical or high findings came back: ${appName}`
          : reasons.includes("failed") ? `Security assessment failed: ${appName}` : `Security assessment ${STATE_WORDS[a.state]}: ${appName}`;
    const link = `${base.replace(/\/+$/, "")}/#/projects/${encodeURIComponent(a.projectId)}/security/assessments/${encodeURIComponent(a.id)}`;
    const facts: Array<[string, string]> = [
        ["Project", project.name],
        ["Application", appName],
        ["Result", RESULT_WORDS[a.state] ?? STATE_WORDS[a.state]],
        ["New critical or high", String(newSerious)],
        ...(backSerious ? [["Came back (critical or high)", String(backSerious)] as [string, string]] : []),
        ...SEVERITIES.map((k): [string, string] => [SEVERITY_WORDS[k], String(seen[k])]),
    ];
    const content: MessageContent = { title, headline, subjectDetail: RESULT_WORDS[a.state]?.toLowerCase() ?? "", facts, findingsHeading: "", findings: [], link };
    const webhook = {
        event: "security_assessment",
        events: reasons,
        test: false,
        sentAt,
        project: { id: project.id, name: project.name },
        link,
        summary: headline,
        assessment: {
            id: a.id,
            applicationId: a.applicationId,
            applicationName: appName,
            state: a.state,
            retest: Boolean(a.retestOf),
            finishedAt: a.finishedAt,
            findingsSeen: seen,
            newFindings: { critical: newFindings.critical, high: newFindings.high },
            // Round 21: critical or high findings marked fixed and seen again by this assessment.
            reopenedFindings: { critical: reopened.critical, high: reopened.high },
        },
    };
    const slack = {
        text: headline,
        blocks: [
            { type: "header", text: { type: "plain_text", text: title.slice(0, 150) } },
            { type: "section", text: { type: "mrkdwn", text: esc(headline) } },
            { type: "section", fields: facts.slice(0, 10).map(([k, v]) => ({ type: "mrkdwn", text: `*${esc(k)}*\n${esc(v)}` })) },
            { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open assessment" }, url: link }] },
        ],
    };
    return { reasons, content, webhook, slack };
}

// ── delivery ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SentNotice {
    channelId: string;
    reasons: NoticeReason[];
    ok: boolean;
}

const EMAIL_FOOTER_FROM = "You can change or stop these alerts in the project, on the Schedule tab, under Alerts.";
const EMAIL_FOOTER_TO = "You can change or stop these messages in the project's security assessment, under Notifications.";

/** The platform's address for links (PUBLIC_URL, else where the server listens), as run alerts use. */
export function platformBase(config: Pick<Config, "PUBLIC_URL" | "HOST" | "PORT">): string {
    const host = config.HOST === "0.0.0.0" || config.HOST === "::" ? "localhost" : config.HOST;
    return (config.PUBLIC_URL || `http://${host}:${config.PORT}`).replace(/\/+$/, "");
}

/** The channels a project's setting points at: enabled ones, all or the chosen ones. */
export function noticeChannels(store: AlertStore, projectId: string, settings: SecurityNotificationSettings): AlertChannel[] {
    const all = store.list(projectId).filter((c) => c.enabled);
    if (!settings.channelIds) return all;
    const chosen = new Set(settings.channelIds);
    return all.filter((c) => chosen.has(c.id));
}

/**
 * Sends the message for an assessment that ended through the project's chosen channels. Never throws (a delivery problem is written to
 * the alert log; the assessment's result is already recorded). Returns what was sent, for tests.
 */
export async function notifyAssessmentFinished(
    p: { db: Db; config: Config },
    a: Pick<SecurityAssessment, "id" | "projectId" | "applicationId" | "state" | "finishedAt" | "retestOf">,
    app: Pick<SecurityApplication, "name"> | undefined,
    opts: { delivery?: DeliveryOptions & { timeoutMs?: number } } = {},
): Promise<SentNotice[]> {
    const sent: SentNotice[] = [];
    try {
        const project = p.db.get<{ id: string; name: string }>("SELECT id, name FROM projects WHERE id = ?", a.projectId);
        if (!project) return sent;
        const settings = notificationSettings(p.db, a.projectId);
        const notice = buildNotice(p.db, a, app, project, settings, platformBase(p.config));
        if (!notice) return sent;
        const store = new AlertStore(p.db, new SecretBox(p.config.dataDir, p.config.SECRET_KEY), () => serverSmtp(p.config));
        for (const ch of noticeChannels(store, a.projectId, settings)) {
            let result: DeliveryResult;
            try {
                if (ch.kind === "email") {
                    const smtp = store.smtpFor(ch.id);
                    if (!smtp) result = { ok: false, attempts: 0, error: "No mail server is set up for this channel any more. Set SMTP_HOST and SMTP_FROM on the server or give the channel its own." };
                    else {
                        const mail = buildEmail(notice.content);
                        const swap = (s: string) => s.split(EMAIL_FOOTER_FROM).join(EMAIL_FOOTER_TO);
                        // People who turned security emails off in their profile are left out (project-folders.ts).
                        const to = store.wantedRecipients(ch.id, "securityEmails");
                        result = to.length === 0 ? { ok: false, attempts: 0, error: EVERYONE_OPTED_OUT } : await sendEmail(smtp, to, { subject: mail.subject, text: swap(mail.text), html: swap(mail.html) }, opts.delivery);
                    }
                } else {
                    const body = ch.kind === "slack" ? notice.slack : ch.kind === "teams" ? teamsPayload(notice.content) : notice.webhook;
                    result = await deliver(store.urlOf(ch.id), body, opts.delivery);
                }
            } catch {
                result = { ok: false, attempts: 1, error: "The message could not be sent." };
            }
            store.log({
                projectId: a.projectId,
                channelId: ch.id,
                channelName: ch.name,
                channelKind: ch.kind,
                event: `security:${notice.reasons.join(",")}`,
                jobId: null,
                status: result.ok ? "sent" : "failed",
                httpStatus: result.status ?? null,
                attempts: result.attempts,
                error: result.error ?? null,
                summary: notice.content.headline,
            });
            sent.push({ channelId: ch.id, reasons: notice.reasons, ok: result.ok });
        }
    } catch {
        /* a message is best effort: the assessment's end is already recorded */
    }
    return sent;
}
