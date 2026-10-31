/**
 * "Check this computer" (computer-check.ts): one line per phone connected to this computer, from the same ready check Settings, Mobile app shows
 * (engine/mobile/device/ready.ts). Read-only: nothing on the phone changes. Phones are optional for a runner, so a phone that is not ready is
 * "optional", never "missing". The runner does not know a project's app, so the app checks are left out; the line says the rest.
 */
import { Adb } from "../engine/mobile/device/adb.js";
import { checkPhoneReady, type PhoneReadiness } from "../engine/mobile/device/ready.js";
import type { RunnerCheckItem } from "../agent-protocol/schema.js";

/** At most this many phones get a line (each check is a dozen short adb calls). */
export const MAX_PHONE_LINES = 4;
const IDS = ["phone-ready", "phone-ready-two", "phone-ready-three", "phone-ready-four"] as const;

export type PhoneLine = RunnerCheckItem & { notes?: string[] };

/** The line for one checked phone. */
export function phoneReadyLine(r: PhoneReadiness, n = 0): PhoneLine {
    const name = r.model ? `${r.model} (${r.serial})` : r.serial;
    const first = r.checks.find((c) => c.status === "problem") ?? r.checks.find((c) => c.status === "attention");
    const id = IDS[Math.min(n, IDS.length - 1)]!;
    if (r.state === "ready") return { id, status: "ok", title: `Phone ${name}${r.androidVersion ? `, Android ${r.androidVersion}` : ""}: ready for tests` };
    const fix = [first?.steps?.join(" ") ?? first?.detail ?? "", ...r.tips.slice(0, 1).map((t) => `Also for this phone: ${t.title}.`)].filter(Boolean).join(" ");
    return { id, status: "optional", title: `Phone ${name}: ${first ? first.title.charAt(0).toLowerCase() + first.title.slice(1) : "not ready"}`.slice(0, 300), ...(fix ? { fix: fix.slice(0, 400) } : {}) };
}

/** The lines for the phones adb sees on this computer (none when there is no adb or no phone: the phone tools line already says so). */
export async function phoneReadyLines(env: NodeJS.ProcessEnv): Promise<PhoneLine[]> {
    const adb = Adb.locate({ env, timeoutMs: 8000 });
    if (!adb) return [];
    let devices;
    try {
        devices = await adb.devices();
    } catch {
        return [];
    }
    const out: PhoneLine[] = [];
    for (const [n, d] of devices.slice(0, MAX_PHONE_LINES).entries()) {
        const dev = adb.forSerial(d.serial).forReadiness();
        try {
            out.push(phoneReadyLine(await checkPhoneReady((args) => dev.setupCall(args), { serial: d.serial, adbState: d.state, emulator: d.emulator, ...(d.model ? { model: d.model } : {}) }), n));
        } catch {
            /* a phone that stops answering mid-check gets no line */
        }
    }
    return out;
}
