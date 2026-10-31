/**
 * OPS routes: the project's setting for messages when an assessment ends (../notify.ts). UI2 builds the switch on these.
 *
 *   GET /api/v1/security/projects/:id/notifications   viewer   { settings, saved, defaults, channels, recent }
 *   PUT /api/v1/security/projects/:id/notifications   editor   body { newCriticalHigh?, failed?, everyFinish?, channelIds? }  -> same answer
 *
 * `settings` = { newCriticalHigh, failed, everyFinish, channelIds } (channelIds null = every enabled alert channel of the project).
 * `channels` = the project's alert channels as [{ id, name, kind, enabled, selected }] (never an address or a sign-in: channels are set up,
 * by owners, under Schedule, Alerts). `recent` = the last 20 deliveries of assessment messages from the alert log
 * [{ at, channelName, channelKind, status, reasons, error, summary }]. A change is recorded in the security trail and Activity.
 */
import { HttpError } from "../../platform/http-error.js";
import { NOTIFY_DEFAULTS, NotificationSettingsPatch, notificationSettings, saveNotificationSettings, type SecurityNotificationSettings } from "../notify.js";
import { SECURITY_API, type SecurityRouteCtx } from "./context.js";

const onOff = (b: boolean) => (b ? "on" : "off");

export function registerSecurityNotificationRoutes(ctx: SecurityRouteCtx): void {
    const { app, p } = ctx;
    const params = (req: { params: unknown }) => req.params as Record<string, string>;

    const channelsOf = (projectId: string) =>
        p.db.all<{ id: string; name: string; kind: string; enabled: number }>("SELECT id, name, kind, enabled FROM alert_channels WHERE project_id = ? ORDER BY created_at, id", projectId);

    const answer = (projectId: string) => {
        const { saved, ...settings } = notificationSettings(p.db, projectId);
        const chosen = settings.channelIds ? new Set(settings.channelIds) : undefined;
        const channels = channelsOf(projectId).map((c) => ({ id: c.id, name: c.name, kind: c.kind, enabled: c.enabled === 1, selected: c.enabled === 1 && (!chosen || chosen.has(c.id)) }));
        const recent = p.db
            .all<{ created_at: string; channel_name: string; channel_kind: string; status: string; event: string; error: string | null; summary: string | null }>(
                "SELECT created_at, channel_name, channel_kind, status, event, error, summary FROM alert_log WHERE project_id = ? AND event LIKE 'security:%' ORDER BY id DESC LIMIT 20",
                projectId,
            )
            .map((r) => ({ at: r.created_at, channelName: r.channel_name, channelKind: r.channel_kind, status: r.status, reasons: r.event.slice("security:".length).split(",").filter(Boolean), error: r.error, summary: r.summary }));
        return { settings, saved, defaults: NOTIFY_DEFAULTS, channels, recent };
    };

    app.get(`${SECURITY_API}/projects/:id/notifications`, async (req) => {
        const { id } = params(req);
        ctx.project(id!);
        return answer(id!);
    });

    app.put(`${SECURITY_API}/projects/:id/notifications`, async (req) => {
        const { id } = params(req);
        const project = ctx.project(id!);
        const patch = ctx.body(NotificationSettingsPatch, req.body);
        if (patch.channelIds) {
            const known = new Set(channelsOf(id!).map((c) => c.id));
            const unknown = patch.channelIds.find((c) => !known.has(c));
            if (unknown) throw new HttpError(400, "One of the chosen alert channels does not belong to this project. Reload the page and choose again.");
        }
        const { saved: _saved, ...before } = notificationSettings(p.db, id!);
        const next: SecurityNotificationSettings = saveNotificationSettings(p.db, id!, patch);
        const changed = (Object.keys(NOTIFY_DEFAULTS) as Array<keyof SecurityNotificationSettings>).some((k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]));
        if (changed) {
            const where = next.channelIds === null ? "every alert channel of the project" : next.channelIds.length ? `${next.channelIds.length} chosen alert channel${next.channelIds.length === 1 ? "" : "s"}` : "no alert channel";
            ctx.audit({
                projectId: id!,
                action: "notifications.changed",
                objectType: "project",
                objectId: id!,
                summary: `Changed the assessment messages of “${project.name}”: new critical or high findings ${onOff(next.newCriticalHigh)}, failures ${onOff(next.failed)}, every finish ${onOff(next.everyFinish)}; sent to ${where}.`,
            });
        }
        return answer(id!);
    });
}
