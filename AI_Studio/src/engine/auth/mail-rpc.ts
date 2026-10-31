/**
 * The host side of the email step: answers the requests a running script writes into its run folder (see ./email-step.ts).
 *
 * The script writes `<id>.req.json` ({ to, use, after, since, origin }); this loop reads it, asks the mail source for the newest email to
 * that address received since the test started (every couple of seconds, up to MAIL_WAIT_MS), takes the code or the link out of it
 * (./mail.ts) and writes `<id>.res.json`. The mail source belongs to the project the run belongs to; the script never sees the mailbox,
 * its password or any other message. Requests are capped (count, size) and validated: the folder is written by generated code.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { MAIL_WAIT_MS } from "./email-step.js";
import { answerFrom, type MailSource } from "./mail.js";

const Request = z.object({
    v: z.literal(1),
    to: z.string().min(3).max(254),
    use: z.enum(["code", "link"]),
    after: z.string().max(200).optional(),
    since: z.number().finite(),
    origin: z.string().max(300).regex(/^https?:\/\/[^/]+$/),
});

export const MAX_MAIL_REQUESTS = 30;

export interface MailRpcOptions {
    /** How long one request waits for its email (default MAIL_WAIT_MS). */
    waitMs?: number;
    /** Pause between looks at the mailbox (default 2 s). */
    pollMs?: number;
    /** How often the folder is looked at for new requests (default 250 ms). */
    scanMs?: number;
}

export interface MailRpc {
    readonly dir: string;
    /** Stops answering; requests still waiting get a plain "the run ended" answer. */
    stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A plain sentence for a source that failed (a mailbox that refuses the login, an unreachable server). */
const sourceProblem = (e: unknown) => `The test mailbox could not be read: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 200)}`;

export async function startMailRpc(dir: string, source: MailSource, opts: MailRpcOptions = {}): Promise<MailRpc> {
    await fs.mkdir(dir, { recursive: true });
    const waitMs = opts.waitMs ?? MAIL_WAIT_MS;
    const pollMs = opts.pollMs ?? 2_000;
    let stopped = false;
    const seen = new Set<string>();
    const pending = new Set<Promise<void>>();

    const answer = async (id: string, body: { ok: true; value: string } | { ok: false; error: string }) => {
        const tmp = path.join(dir, `${id}.ans.tmp`);
        await fs.writeFile(tmp, JSON.stringify(body));
        await fs.rename(tmp, path.join(dir, `${id}.res.json`));
    };

    const serve = async (id: string, file: string) => {
        let req: z.infer<typeof Request>;
        try {
            req = Request.parse(JSON.parse(await fs.readFile(file, "utf8")));
        } catch {
            return answer(id, { ok: false, error: "The email step sent a request the platform could not read." });
        }
        const deadline = Date.now() + waitMs;
        let failures = 0;
        while (!stopped && Date.now() < deadline) {
            try {
                const msg = await source({ to: req.to, since: req.since });
                failures = 0;
                if (msg) {
                    const r = answerFrom(msg, { use: req.use, after: req.after, origin: req.origin });
                    return answer(id, "value" in r ? { ok: true, value: r.value } : { ok: false, error: r.error });
                }
            } catch (e) {
                // One failed look can be a network hiccup; three in a row is a problem the person must fix.
                if (++failures >= 3) return answer(id, { ok: false, error: sourceProblem(e) });
            }
            await sleep(pollMs);
        }
        return answer(id, { ok: false, error: stopped ? "The run ended before the email arrived." : `No email to ${req.to} arrived within ${Math.round(waitMs / 1000)} seconds.` });
    };

    const scan = async () => {
        const names = await fs.readdir(dir).catch(() => [] as string[]);
        for (const n of names) {
            const m = /^([a-z0-9-]{1,40})\.req\.json$/.exec(n);
            if (!m || seen.has(m[1]!)) continue;
            seen.add(m[1]!);
            if (seen.size > MAX_MAIL_REQUESTS) {
                await answer(m[1]!, { ok: false, error: `A run may wait for at most ${MAX_MAIL_REQUESTS} emails.` }).catch(() => undefined);
                continue;
            }
            const p = serve(m[1]!, path.join(dir, n)).catch(() => undefined);
            pending.add(p);
            void p.finally(() => pending.delete(p));
        }
    };

    const timer = setInterval(() => void scan(), opts.scanMs ?? 250);
    return {
        dir,
        async stop() {
            stopped = true;
            clearInterval(timer);
            await Promise.all([...pending]);
        },
    };
}
