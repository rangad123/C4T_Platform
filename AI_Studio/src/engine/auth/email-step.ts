/**
 * The email step in a generated web script: "Wait for an email to <address> and type its code into <field>" / "... and open its link".
 *
 * The script never talks to a mailbox and holds no mailbox password. It asks the computer that runs it: it writes a small request file
 * into the folder named by AITP_MAIL_DIR and waits for the answer file (src/engine/auth/mail-rpc.ts answers it from the project's test
 * mailbox and does the extraction). Without that folder (no test mailbox set up, or a run on a runner, which cannot read the platform's
 * mailbox) the step fails with a plain sentence. The helper is pasted only into scripts that have an email step, so every other script
 * stays byte-for-byte as it was. Tests compile it from this same text.
 */
import type { Step, TestSpec } from "../spec/schema.js";

/** How long a step waits for the email (the platform answers within this; the script allows a little more for the answer to arrive). */
export const MAIL_WAIT_MS = 90_000;

export const usesEmail = (spec: Pick<TestSpec, "steps">): boolean => spec.steps.some((s) => s.action === "email");

/** Same words as the step's own check in the generator, kept here so the plain-language message is in one place. */
export const NO_MAILBOX_MESSAGE =
    "This test waits for an email, but no test mailbox is available to it. Set one up under Test accounts (Test mailbox), and run the test on the platform: runners cannot read the test mailbox.";

export const EMAIL_HELPER_SOURCE = `/** When this test file started: an email only counts if it arrived after this (see the platform's test mailbox). */
const EMAIL_SINCE = Date.now();

/** Emailed codes and magic links: asks the computer running this test for the newest email to an address, then its code or its link. */
async function waitForEmail(to: string, use: "code" | "link", after: string, baseUrl: string): Promise<string> {
    const dir = process.env.AITP_MAIL_DIR;
    if (!dir) throw new Error(${JSON.stringify(NO_MAILBOX_MESSAGE)});
    const fs = await import("node:fs");
    const path = await import("node:path");
    const id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    const request = JSON.stringify({ v: 1, to, use, after: after || undefined, since: EMAIL_SINCE, origin: new URL(baseUrl).origin });
    fs.writeFileSync(path.join(dir, id + ".tmp"), request);
    fs.renameSync(path.join(dir, id + ".tmp"), path.join(dir, id + ".req.json"));
    const answer = path.join(dir, id + ".res.json");
    const deadline = Date.now() + ${MAIL_WAIT_MS} + 20_000;
    while (Date.now() < deadline) {
        if (fs.existsSync(answer)) {
            const r = JSON.parse(fs.readFileSync(answer, "utf8")) as { ok: boolean; value?: string; error?: string };
            if (r.ok && typeof r.value === "string") return r.value;
            throw new Error(r.error || "The test mailbox could not answer.");
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("No email to " + to + " arrived in time.");
}
`;

/**
 * The body of an email step. `L` renders a locator the way the generator does. The wait is long, so the test's own time limit is raised
 * for this test (the same way the access and input checks do).
 */
export function renderEmailStep(step: Extract<Step, { action: "email" }>, L: (l: NonNullable<Extract<Step, { action: "email" }>["locator"]>) => string, expr: (s: string) => string, lit: (s: string) => string): string {
    const call = `await waitForEmail(${expr(step.to)}, ${lit(step.use)}, ${lit(step.after ?? "")}, BASE_URL)`;
    if (!step.to.trim()) throw new Error("An email step needs the address the email is sent to");
    const raise = `test.setTimeout(${MAIL_WAIT_MS + 120_000});\n        `;
    if (step.use === "code") {
        if (!step.locator) throw new Error("An email step that types a code needs the field to type it into");
        return `${raise}await ${L(step.locator)}.fill(${call});`;
    }
    if (step.locator) throw new Error("An email step that opens a link takes no field");
    return `${raise}await page.goto(await allowedAddress(${call}, BASE_URL));`;
}
