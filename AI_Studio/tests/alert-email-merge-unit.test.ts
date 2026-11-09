/**
 * mergeSmtp (platform/alert-email.ts) keeps a channel's stored mail password only for the server it was entered for. The route refuses
 * the change first; this is the same rule where the settings are merged, so no other caller (AlertStore.updateEmail) can carry it over.
 */
import { describe, expect, it } from "vitest";
import { mergeSmtp, SMTP_NEW_PASSWORD_NEEDED, type SmtpSettings } from "../src/platform/alert-email.js";

const cur: SmtpSettings = { host: "smtp.example.test", port: 587, secure: false, from: "alerts@example.test", user: "mailer", password: "kept-secret" };

describe("mergeSmtp and the stored password", () => {
    it("is refused when the host, the port or TLS changes without the password", () => {
        expect(() => mergeSmtp(cur, { host: "evil.example.test" })).toThrow(SMTP_NEW_PASSWORD_NEEDED);
        expect(() => mergeSmtp(cur, { port: 2525 })).toThrow(SMTP_NEW_PASSWORD_NEEDED);
        expect(() => mergeSmtp({ ...cur, secure: true }, { secure: false })).toThrow(SMTP_NEW_PASSWORD_NEEDED);
        expect(() => mergeSmtp(cur, { host: "evil.example.test", username: "other" })).toThrow(SMTP_NEW_PASSWORD_NEEDED);
    });

    it("keeps it for the same server, takes a new one, and drops it with the user name", () => {
        expect(mergeSmtp(cur, { from: "other@example.test" })).toMatchObject({ host: cur.host, password: "kept-secret" });
        expect(mergeSmtp(cur, { host: cur.host, port: cur.port })).toMatchObject({ password: "kept-secret" });
        // The same server typed with other capitals is the same server.
        expect(mergeSmtp(cur, { host: "SMTP.Example.TEST" })).toMatchObject({ password: "kept-secret" });
        expect(mergeSmtp(cur, { host: "new.example.test", password: "typed-again" })).toMatchObject({ host: "new.example.test", password: "typed-again" });
        const noLogin = mergeSmtp(cur, { host: "new.example.test", username: null });
        expect(noLogin.host).toBe("new.example.test");
        expect(noLogin).not.toHaveProperty("password");
    });
});
