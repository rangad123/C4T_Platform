/**
 * Driving a recording session step by step, the platform side: checks what a tool asks for, looks up the stored sign-in details for a `{{credentials.x}}`
 * stand-in, hands the action to whichever machine owns the browser (the platform, or a runner agent), keeps the audit count, and scrubs every credential
 * from what goes back. The browser work itself lives in the recorder core (src/engine/recorder/session.ts); this file never touches a page.
 */
import { totp } from "../engine/identity/totp.js";
import { credentialSlotOf, parseAction, type CredentialSlot, type LiveAction, type LiveSnapshot } from "../engine/recorder/act.js";
import type { RecStep } from "../engine/recorder/model.js";
import { scrubSecrets } from "./agent-routing.js";
import { expandSecrets, totpCodesNear } from "./secret-variants.js";
import { HttpError } from "./http-error.js";
import type { LiveAuditStore } from "./live-session-store.js";
import type { RecorderService, Recording } from "./recorder-service.js";

export interface LiveCredentials {
    username?: string;
    password?: string;
    totpSecret?: string;
}

export interface LiveSessionDeps {
    recorder: RecorderService;
    audit: LiveAuditStore;
    /** The sign-in details of the project's application and the origin they belong to; undefined when there are none. */
    credentialsFor(projectId: string): { origin: string; credentials: LiveCredentials } | undefined;
    /** Every secret the project knows, as exact strings (scrubbed from every answer). */
    secretsFor(projectId: string): string[];
}

export interface ActAnswer {
    recorded: boolean;
    step?: RecStep;
    note?: string;
    snapshot: LiveSnapshot;
}

const NO_DETAILS: Record<CredentialSlot, string> = {
    username: "user name",
    password: "password",
    totp: "one-time-code secret",
};

export class LiveSessionService {
    constructor(private readonly d: LiveSessionDeps) {}

    private who(rec: Recording) {
        return { recordingId: rec.id, projectId: rec.projectId, startUrl: rec.startUrl, runner: rec.runner?.kind === "agent" ? `agent:${rec.runner.name}` : "platform" };
    }

    private session(rid: string): Recording {
        const rec = this.d.recorder.get(rid);
        if (!rec || !rec.projectId) throw new HttpError(404, "Recording not found. It may have been discarded or the platform was restarted.");
        return rec;
    }

    /**
     * Everything that must not appear in an answer: the project's secrets in every listed encoding (URL, HTML, base64, case), the one-time codes the stored
     * authenticator secrets give now and in the neighbouring windows (so a later snapshot cannot show a code that was typed earlier), and the values just typed.
     */
    private scrubList(projectId: string, extra: readonly string[] = []): string[] {
        const base = [...this.d.secretsFor(projectId), ...extra];
        const codes = new Set<string>(totpCodesNear(this.d.credentialsFor(projectId)?.credentials.totpSecret));
        // Role secrets are only known as strings: anything shaped like an authenticator secret also gives codes (a wrong guess only hides three numbers).
        for (const b of base) if (/^[A-Za-z2-7 -]{16,}$/.test(b)) for (const c of totpCodesNear(b)) codes.add(c);
        return expandSecrets([...base, ...codes]);
    }

    /** Looks up the value behind a stand-in, and the origins it may be typed on. Only on the application's own site: a page anywhere else never receives the project's sign-in details. */
    private resolve(rec: Recording, slot: CredentialSlot): { value: string; origins: string[] } {
        const found = this.d.credentialsFor(rec.projectId);
        const value = !found ? undefined : slot === "username" ? found.credentials.username : slot === "password" ? found.credentials.password : found.credentials.totpSecret ? totp(found.credentials.totpSecret) : undefined;
        if (!found || !value) throw new HttpError(422, `This project has no stored ${NO_DETAILS[slot]}. Save the project's sign-in details in its settings, then try again.`);
        let here = "";
        try {
            here = new URL(rec.currentUrl ?? rec.startUrl).origin;
        } catch {
            /* checked below */
        }
        const allowed = new Set([found.origin]);
        // A named environment's site is the project's own too.
        if (rec.environment) {
            try {
                allowed.add(new URL(rec.startUrl).origin);
            } catch {
                /* ignore */
            }
        }
        if (!allowed.has(here)) throw new HttpError(422, `The stored sign-in details are only typed on the application's own site (${found.origin}). This page is on ${here || "another site"}.`);
        return { value, origins: [...allowed] };
    }

    async snapshot(rid: string, o: { image?: boolean } = {}): Promise<LiveSnapshot> {
        const rec = this.session(rid);
        const snap = await this.d.recorder.liveSnapshot(rid, o);
        this.d.audit.count(this.who(rec), "snapshots");
        return scrubSecrets(snap, this.scrubList(rec.projectId));
    }

    async act(rid: string, raw: unknown, o: { image?: boolean } = {}): Promise<ActAnswer> {
        const rec = this.session(rid);
        const parsed = parseAction(raw);
        if (!parsed.ok) {
            this.d.audit.count(this.who(rec), "refused");
            throw new HttpError(400, parsed.error);
        }
        const action: LiveAction = parsed.action;
        let secrets = this.scrubList(rec.projectId);
        let secret: string | undefined;
        let origins: string[] = [];
        try {
            const slot = action.action === "fill" ? credentialSlotOf(action.value) : undefined;
            if (slot) {
                const found = this.resolve(rec, slot);
                secret = found.value;
                origins = found.origins;
                secrets = this.scrubList(rec.projectId, [secret]);
            }
            const out = await this.d.recorder.act(rid, action, { ...(secret !== undefined ? { secret, origins } : {}), ...(o.image ? { image: true } : {}) });
            this.d.audit.count(this.who(rec), "actions");
            return scrubSecrets(out, secrets);
        } catch (e) {
            this.d.audit.count(this.who(rec), "refused");
            if (e instanceof HttpError) throw new HttpError(e.status, scrubSecrets(e.message, secrets), e.details);
            throw e;
        }
    }
}
