/**
 * Email alerts: the message, the mail-server settings and the delivery over SMTP (nodemailer, MIT-0).
 *
 * The mail server's user name and password are secrets like a Slack webhook URL: they live only in the encrypted blob of
 * a channel (or in the server's environment), are write-only through the API, and never appear in a message, a log line
 * or an error text. Errors shown to people are written here, in plain words, from the error *code*, never from the
 * server's raw reply.
 */
import net from "node:net";
import { createTransport } from "nodemailer";
import { z } from "zod";
import type { Config } from "../config.js";
import type { DeliveryResult } from "./alerts.js";
import { HttpError } from "./http-error.js";
import { assertAllowedTarget, isPrivateHost } from "./net-guard.js";

export const MAX_RECIPIENTS = 10;

/** One alert, in the plain words every channel shows (Slack, Teams and email render it their own way). */
export interface MessageContent {
    title: string;
    headline: string;
    /** Short status shown after the title in an email subject, e.g. "7 of 9 passed". */
    subjectDetail: string;
    facts: Array<[label: string, value: string]>;
    findingsHeading: string;
    findings: Array<{ title: string; severity?: string; reason?: string }>;
    link: string;
}

// ── mail-server settings ────────────────────────────────────────────────────

export interface SmtpSettings {
    host: string;
    port: number;
    /** TLS from the first byte (port 465). Otherwise the connection upgrades with STARTTLS when the server offers it. */
    secure: boolean;
    from: string;
    /** Secrets: never returned by the API. */
    user?: string;
    password?: string;
}

const HOST = z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$|^[0-9A-Fa-f:]{2,45}$/, "Use a host name or IP address, without http:// or a port");
const FROM = z.string().trim().email("Use a plain sender address such as alerts@example.com").max(254);

/** Mail-server settings typed into a channel. Without a user name the server is used without signing in. */
export const SmtpInput = z
    .object({
        host: HOST,
        port: z.number().int().min(1).max(65535).default(587),
        secure: z.boolean().optional(),
        from: FROM,
        username: z.string().max(200).optional(),
        password: z.string().max(500).optional(),
    })
    .strict();
export type SmtpInputT = z.infer<typeof SmtpInput>;

/** A change to a channel's own settings: what is left out stays; `null` for the login removes it. */
export const SmtpPatch = z
    .object({
        host: HOST,
        port: z.number().int().min(1).max(65535),
        secure: z.boolean(),
        from: FROM,
        username: z.string().max(200).nullable(),
        password: z.string().max(500).nullable(),
    })
    .partial()
    .strict();
export type SmtpPatchT = z.infer<typeof SmtpPatch>;

export const Recipients = z
    .array(z.string().trim().email("Use full email addresses such as name@example.com").max(254))
    .min(1, "Add at least one email address")
    .max(MAX_RECIPIENTS, `Use at most ${MAX_RECIPIENTS} email addresses`)
    .transform((list) => {
        const seen = new Set<string>();
        return list.filter((a) => (seen.has(a.toLowerCase()) ? false : (seen.add(a.toLowerCase()), true)));
    });

export const fromInput = (i: SmtpInputT): SmtpSettings => ({
    host: i.host,
    port: i.port,
    secure: i.secure ?? i.port === 465,
    from: i.from,
    ...(i.username ? { user: i.username, password: i.password ?? "" } : {}),
});

/** The server-wide mail settings from the environment, or undefined when not set (a host and a sender are the minimum). */
export function serverSmtp(config: Pick<Config, "SMTP_HOST" | "SMTP_PORT" | "SMTP_SECURE" | "SMTP_USER" | "SMTP_PASSWORD" | "SMTP_FROM">): SmtpSettings | undefined {
    const host = config.SMTP_HOST?.trim();
    const from = config.SMTP_FROM?.trim();
    if (!host || !from) return undefined;
    const port = Number(config.SMTP_PORT?.trim() || 587);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    const flag = config.SMTP_SECURE?.trim().toLowerCase();
    const user = config.SMTP_USER?.trim();
    return { host, port, secure: flag ? flag === "true" : port === 465, from, ...(user ? { user, password: config.SMTP_PASSWORD ?? "" } : {}) };
}

/** What may be shown about the settings in use: never the user name or the password. */
export const publicSmtp = (s: SmtpSettings) => ({ host: s.host, port: s.port, secure: s.secure, from: s.from, hasLogin: Boolean(s.user) });

export const NO_MAIL_SERVER_MESSAGE =
    "Email alerts need a mail server. Set SMTP_HOST and SMTP_FROM (and SMTP_USER and SMTP_PASSWORD if it needs a sign-in) on the server, or enter the mail server settings for this channel.";

/** The same outbound guard as webhooks: with BLOCK_PRIVATE_TARGETS the mail server may not be on a private network. */
export async function assertSmtpHostAllowed(host: string): Promise<void> {
    await assertAllowedTarget(`http://${net.isIPv6(host) ? `[${host}]` : host}/`);
}

// ── the message ─────────────────────────────────────────────────────────────

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
/** One line, no control characters: keeps a project name from adding mail headers. */
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();

export interface BuiltEmail {
    subject: string;
    text: string;
    html: string;
}

export function buildEmail(c: MessageContent): BuiltEmail {
    const subject = oneLine(`${c.title}${c.subjectDetail ? ` (${c.subjectDetail})` : ""}`).slice(0, 200);
    const finding = (f: MessageContent["findings"][number]) => `${oneLine(f.title)}${f.severity ? ` (${f.severity})` : ""}${f.reason ? `: ${oneLine(f.reason).slice(0, 200)}` : ""}`;
    const text = [
        oneLine(c.headline),
        "",
        ...c.facts.map(([k, v]) => `${k}: ${oneLine(v)}`),
        ...(c.facts.length ? [""] : []),
        ...(c.findings.length ? [c.findingsHeading, ...c.findings.map((f) => `- ${finding(f)}`), ""] : []),
        `Open the project: ${c.link}`,
        "",
        "Sent by the AI Testing Platform. You can change or stop these alerts in the project, on the Schedule tab, under Alerts.",
        "",
    ].join("\r\n");
    const html = `<!doctype html><html lang="en"><body style="margin:0;padding:16px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2933">
<h1 style="margin:0 0 8px;font-size:18px">${escapeHtml(oneLine(c.title))}</h1>
<p style="margin:0 0 12px">${escapeHtml(oneLine(c.headline))}</p>
${c.facts.length ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 12px">${c.facts.map(([k, v]) => `<tr><td style="padding:2px 16px 2px 0;color:#52606d">${escapeHtml(k)}</td><td style="padding:2px 0"><strong>${escapeHtml(oneLine(v))}</strong></td></tr>`).join("")}</table>` : ""}
${c.findings.length ? `<h2 style="margin:12px 0 4px;font-size:15px">${escapeHtml(c.findingsHeading)}</h2><ul style="margin:0 0 12px;padding-left:20px">${c.findings.map((f) => `<li>${escapeHtml(finding(f))}</li>`).join("")}</ul>` : ""}
<p style="margin:0 0 16px"><a href="${escapeHtml(c.link)}">Open the project</a></p>
<p style="margin:0;color:#52606d;font-size:13px">Sent by the AI Testing Platform. You can change or stop these alerts in the project, on the Schedule tab, under Alerts.</p>
</body></html>`;
    return { subject, text, html };
}

// ── delivery ────────────────────────────────────────────────────────────────

export interface EmailDeliveryOptions {
    /** Per attempt. */
    timeoutMs?: number;
    /** Waits before each retry; the number of entries is the number of retries. */
    backoffMs?: number[];
}

const DEFAULT_BACKOFF = [500, 2_000];
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Plain-words problem and whether trying again can help, from the error code only (the server's reply may be long or odd). */
export function describeSmtpError(e: unknown, s: Pick<SmtpSettings, "host" | "port">): { message: string; retry: boolean } {
    const err = e as { code?: string; responseCode?: number; message?: string };
    const code = err?.code ?? "";
    const reply = err?.responseCode;
    if (code === "EAUTH") return { message: "The mail server refused the sign-in. Check the user name and password.", retry: false };
    if (code === "EENVELOPE") return { message: "The mail server refused the sender or a recipient address.", retry: false };
    if (typeof reply === "number" && reply >= 500) return { message: `The mail server refused the message (SMTP ${reply}).`, retry: false };
    if (typeof reply === "number" && reply >= 400) return { message: `The mail server asked to try again later (SMTP ${reply}).`, retry: true };
    if (/ssl|tls|wrong version|certificate|handshake/i.test(err?.message ?? "")) return { message: "The secure connection to the mail server failed. Check the port and the secure-connection setting.", retry: false };
    if (code === "ETIMEDOUT" || code === "ECONNECTION" || code === "ESOCKET" || code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EDNS" || code === "ENOTFOUND") {
        return { message: `Could not reach the mail server ${s.host}:${s.port}${code ? ` (${code})` : ""}.`, retry: true };
    }
    return { message: "The email could not be sent.", retry: false };
}

/**
 * Send one email. The mail server is re-checked before every attempt (a name can start resolving to a private address after
 * the channel was saved), a temporary failure is retried with backoff, a refusal is final. Resolves, never throws.
 */
export async function sendEmail(smtp: SmtpSettings, to: string[], mail: BuiltEmail, opts: EmailDeliveryOptions = {}): Promise<DeliveryResult> {
    const backoff = opts.backoffMs ?? DEFAULT_BACKOFF;
    let last: DeliveryResult = { ok: false, attempts: 0, error: "not sent" };
    for (let attempt = 1; attempt <= backoff.length + 1; attempt++) {
        if (attempt > 1) await wait(backoff[attempt - 2]!);
        try {
            await assertSmtpHostAllowed(smtp.host);
        } catch (e) {
            return { ok: false, attempts: attempt, error: e instanceof HttpError ? e.message : "The mail server address is not allowed" };
        }
        const timeout = opts.timeoutMs ?? 10_000;
        const transport = createTransport({
            host: smtp.host,
            port: smtp.port,
            secure: smtp.secure,
            // A password must not cross the network in the clear, except to a server on the local network.
            requireTLS: Boolean(smtp.user) && !smtp.secure && !isPrivateHost(smtp.host),
            ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.password ?? "" } } : {}),
            connectionTimeout: timeout,
            greetingTimeout: timeout,
            socketTimeout: timeout * 2,
            disableFileAccess: true,
            disableUrlAccess: true,
        });
        try {
            await transport.sendMail({
                from: smtp.from,
                to,
                subject: mail.subject,
                text: mail.text,
                html: mail.html,
                headers: { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" },
            });
            return { ok: true, attempts: attempt };
        } catch (e) {
            const d = describeSmtpError(e, smtp);
            last = { ok: false, attempts: attempt, error: d.message };
            if (!d.retry) return last;
        } finally {
            transport.close();
        }
    }
    return last;
}

export const SMTP_NEW_PASSWORD_NEEDED = "Enter the password or access key again when you change the server: a stored one is only sent where it was entered for.";

/** A channel's own settings after a change. Needs a host and a sender once merged; a user name given without a password keeps the old one. */
export function mergeSmtp(cur: SmtpSettings | undefined, patch: SmtpPatchT): SmtpSettings {
    // The stored password is only ever sent to the server it was entered for, whoever calls this (the route says so first, in the same words).
    if (cur?.password && patch.password === undefined && patch.username !== null) {
        const moves = (patch.host !== undefined && patch.host.toLowerCase() !== (cur.host ?? "").toLowerCase()) || (patch.port !== undefined && patch.port !== cur.port) || (patch.secure === false && cur.secure);
        if (moves) throw new HttpError(400, SMTP_NEW_PASSWORD_NEEDED);
    }
    const host = patch.host ?? cur?.host;
    const from = patch.from ?? cur?.from;
    if (!host || !from) throw new HttpError(400, "Give the mail server's host and the sender address");
    const port = patch.port ?? cur?.port ?? 587;
    const login =
        patch.username === null
            ? undefined
            : patch.username !== undefined
              ? { user: patch.username, password: patch.password ?? cur?.password ?? "" }
              : cur?.user
                ? { user: cur.user, password: patch.password === null ? "" : (patch.password ?? cur.password ?? "") }
                : undefined;
    return { host, port, secure: patch.secure ?? cur?.secure ?? port === 465, from, ...(login?.user ? login : {}) };
}
