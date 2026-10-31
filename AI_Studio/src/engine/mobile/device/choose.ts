/**
 * Which device a phone test run uses (validation right after creating tests, Run, schedules, runners: wherever mobile-runner.ts runs).
 *
 * In this order:
 *   1. the device the project chose (Settings, Mobile app, "Where phone tests run"): the phone the AI explored on, a named phone, an emulator
 *      (a device farm is chosen before this, by the job: the farm's phones decide);
 *   2. else a connected, ready real phone that has the app installed for its current user;
 *   3. else an emulator (one already running, or the project's AVD, which the runner starts).
 * A chosen phone that is not connected falls through to the next rule, and the run says so. An emulator is never started when a ready real phone
 * with the app is connected and chosen (or found by rule 2).
 *
 * `chooseDevice` is the pure rule (a table in the tests); `pickRunDevice` asks adb for the facts it needs.
 */
import { Adb, type AdbDevice } from "./adb.js";
import { installedFrom, currentUserFrom, type LauncherCall } from "./launcher.js";
import { deviceWords, effectiveRunsOn, type ExploredOn, type PhoneRunsOn } from "../phone-settings.js";
import { mobileAvailability } from "../toolchain.js";

export interface DeviceFacts extends AdbDevice {
    /** The app is installed for the phone's current user (undefined: not known, for example an APK-only project). */
    hasApp?: boolean | undefined;
}

export type RunDevice =
    | { kind: "phone"; serial: string; model?: string | undefined; why: string }
    | { kind: "emulator"; /** A running emulator to use as it is. */ serial?: string | undefined; avd?: string | undefined; why: string }
    | { kind: "none"; problem: string };

export interface ChoiceInput {
    /** The project's setting and the device the last exploration used (mobile/phone-settings.ts). */
    runsOn?: PhoneRunsOn | undefined;
    exploredOn?: ExploredOn | undefined;
    devices: DeviceFacts[];
    /** The emulator (AVD) the runner would start; "" or undefined when this computer has none. */
    avd?: string | undefined;
    /** False where no emulator may be started (a stand-in runner, a runner told to use a phone). */
    canStartEmulator?: boolean | undefined;
    /** Where the run happens, for the sentence: "this computer" (default) or the runner's name. */
    where?: string | undefined;
}

export const CHOICE_WORDS = {
    noDevice: "No phone with the app is connected and no emulator is set up on this computer. Plug in a phone with USB debugging on and the app installed, or create an emulator.",
    notConnected: (d: { serial: string; model?: string | undefined }, reason: string) => `The phone chosen for this project, ${deviceWords(d)}, ${reason}, so`,
} as const;

const words = (d: { serial: string; model?: string | undefined }) => deviceWords({ serial: d.serial, model: d.model });

/** "Ran on CPH2467 (R58N20ABCDE), a phone on this computer." */
export function ranOnSentence(d: Extract<RunDevice, { kind: "phone" | "emulator" }>, where = "this computer", started = false): string {
    if (d.kind === "phone") return `Ran on ${words(d)}, a phone on ${where}.`;
    const name = d.serial ? `${d.serial}${d.avd ? ` (${d.avd})` : ""}` : (d.avd ?? "");
    return `Ran on the emulator ${name} on ${where}${started ? ", started for this run" : ""}.`.replace("emulator  on", "emulator on");
}

/** The pure rule. */
export function chooseDevice(i: ChoiceInput): RunDevice {
    const where = i.where ?? "this computer";
    const ready = i.devices.filter((d) => d.state === "device");
    const runsOn = effectiveRunsOn({ runsOn: i.runsOn, exploredOn: i.exploredOn });
    let lead = "";

    // 1. what the project chose
    const named = runsOn.kind === "phone" ? { serial: runsOn.serial, model: runsOn.model } : runsOn.kind === "explored" && i.exploredOn ? { serial: i.exploredOn.serial, model: i.exploredOn.model } : undefined;
    if (named) {
        const d = i.devices.find((x) => x.serial === named.serial);
        if (d && d.state === "device") {
            const how = runsOn.kind === "explored" ? "the phone the AI explored on" : "the phone chosen for this project";
            if (d.emulator) return { kind: "emulator", serial: d.serial, why: `Phone tests run on the emulator ${d.serial}, ${runsOn.kind === "explored" ? "the one the AI explored on" : "the device chosen for this project"}.` };
            return { kind: "phone", serial: d.serial, model: d.model ?? named.model, why: `Phone tests run on ${words({ serial: d.serial, model: d.model ?? named.model })}, ${how}, on ${where}.` };
        }
        const reason = !d ? `is not connected to ${where}` : d.state === "unauthorized" ? "has not allowed USB debugging from this computer" : `is ${d.state === "offline" ? "offline" : `not ready (${d.state})`}`;
        lead = `${CHOICE_WORDS.notConnected({ serial: named.serial, model: d?.model ?? named.model }, reason)} `;
    }

    /** A sentence after the lead ("The phone chosen ... is not connected, so phone tests run on ..."), or on its own with a capital. */
    const say = (s: string) => (lead ? `${lead}${s.charAt(0).toLowerCase()}${s.slice(1)}` : s);
    const emulatorChoice = (): RunDevice => {
        const running = ready.find((d) => d.emulator);
        if (i.avd && i.canStartEmulator !== false) return { kind: "emulator", avd: i.avd, why: say(`Phone tests run on the emulator ${i.avd}.`) };
        if (running) return { kind: "emulator", serial: running.serial, why: say(`Phone tests run on the emulator ${running.serial} that is already running.`) };
        if (i.avd) return { kind: "emulator", avd: i.avd, why: say(`Phone tests run on the emulator ${i.avd}.`) };
        return { kind: "none", problem: say(CHOICE_WORDS.noDevice) };
    };

    if (runsOn.kind === "emulator") return emulatorChoice();

    // 2. a ready real phone that has the app
    const phone = ready.find((d) => !d.emulator && d.hasApp === true);
    if (phone) return { kind: "phone", serial: phone.serial, model: phone.model, why: say(`Phone tests run on ${words(phone)}, a phone on ${where} that has the app.`) };

    // 3. an emulator
    return emulatorChoice();
}

/** Is `pkg` installed for the current user of the phone behind `call`? undefined when the phone does not say. */
export async function appInstalledFor(call: LauncherCall, pkg: string): Promise<boolean | undefined> {
    const user = currentUserFrom(await call(["shell", "am", "get-current-user"]).catch(() => ""));
    return installedFrom(await call(["shell", "pm", "list", "packages", "--user", String(user)]).catch(() => ""), pkg);
}

export interface PickInput extends Omit<ChoiceInput, "devices"> {
    adb: Adb;
    /** The app under test; unset (an APK-only project): no real phone is picked automatically. */
    appPackage?: string | undefined;
}

/** Lists the devices, asks the ready real phones whether they have the app (only when rule 2 can apply), and applies the rule. */
export async function pickRunDevice(i: PickInput): Promise<{ device: RunDevice; devices: DeviceFacts[] }> {
    let devices: DeviceFacts[];
    try {
        devices = await i.adb.devices();
    } catch {
        devices = [];
    }
    const runsOn = effectiveRunsOn({ runsOn: i.runsOn, exploredOn: i.exploredOn });
    const namedReady = (runsOn.kind === "phone" || runsOn.kind === "explored") && devices.some((d) => d.state === "device" && d.serial === (runsOn.kind === "phone" ? runsOn.serial : i.exploredOn?.serial));
    if (i.appPackage && runsOn.kind !== "emulator" && !namedReady) {
        for (const d of devices) {
            if (d.state !== "device" || d.emulator) continue;
            const a = i.adb.forSerial(d.serial).forReadiness();
            d.hasApp = await appInstalledFor((args) => a.setupCall(args, 15_000), i.appPackage).catch(() => undefined);
            if (d.hasApp) break; // the first phone that has it is the one; the others are not asked
        }
    }
    return { device: chooseDevice({ ...i, devices }), devices };
}

/**
 * Can phone tests run on THIS computer at all? An emulator is not needed when a phone is plugged in: the Android tools (adb) are enough, and the run
 * itself says in words when no phone with the app is connected and no emulator exists. Undefined reason when they can.
 */
export function localPhoneRunsProblem(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const avail = mobileAvailability(env);
    if (avail.available || avail.toolchain !== "none") return undefined;
    return avail.reason ?? "No Android tools were found on this computer.";
}

/**
 * The device an exploration used, from its session's name ("CPH2467 (R58N20ABCDE)", as the device session and the runner name it). Undefined when the
 * name does not end in an adb serial (a device farm names its phones differently).
 */
export function exploredOnFromName(deviceName: string, at: Date = new Date()): ExploredOn | undefined {
    const m = /^(.*?)\s*\(([A-Za-z0-9._:-]{1,80})\)\s*$/.exec(String(deviceName ?? "").replace(/[\r\n]/g, " "));
    if (!m) return undefined;
    const serial = m[2]!;
    const model = m[1]!.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 60);
    return { serial, ...(model && model !== "Android device" ? { model } : {}), emulator: serial.startsWith("emulator-"), at: at.toISOString() };
}
