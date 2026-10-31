/**
 * The project's test mailbox as one mail source for its runs: IMAP (read by the platform) or the inbound address (mail forwarded to the
 * platform and kept, encrypted, for a day). Only the project the run belongs to is ever read.
 */
import type { MailSource } from "../../engine/auth/mail.js";
import type { SessionStore } from "../session-store.js";
import { imapSource, type ImapOptions } from "./imap.js";

/** Forwarded mail is stamped with this platform's clock, the same clock the test uses: only a small allowance is needed. */
export const INBOUND_CLOCK_ALLOWANCE_MS = 5_000;

export function mailSourceFor(store: SessionStore, projectId: string, o: ImapOptions = {}): MailSource | undefined {
    const box = store.mailbox(projectId);
    if (!box) return undefined;
    if (box.kind === "imap") return imapSource(box.imap, o);
    return async ({ to, since }) => store.newestInbound(projectId, to, since - INBOUND_CLOCK_ALLOWANCE_MS);
}
