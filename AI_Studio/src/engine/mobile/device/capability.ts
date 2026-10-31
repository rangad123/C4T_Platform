/**
 * Can a computer be driven by the AI phone explorer? One rule, used by the runner agent (to report it), by the platform (to refuse early, in words) and by
 * the Runners page (to explain).
 */
import type { Capabilities } from "../../../agent-protocol/schema.js";

/** Why this computer cannot be driven by the AI phone explorer, in words for the person, or undefined when it can. */
export function deviceSessionProblem(c: Pick<Capabilities, "android"> & Partial<Pick<Capabilities, "phoneTools">>): string | undefined {
    const a = c.android;
    // No adb yet, but the runner fetches Google's phone tools itself when a session arrives (phone-setup-simple.md): whether a phone is plugged in
    // can only be seen once adb is there, so the session itself says so in words if none is.
    if ((!a || !a.adb) && (c.phoneTools?.state === "can-fetch" || c.phoneTools?.state === "fetching")) return undefined;
    if (!a || !a.adb) {
        if (c.phoneTools?.state === "failed" || c.phoneTools?.state === "unsupported") return c.phoneTools.note ?? "adb (the Android debug tool) was not found on this computer.";
        return "adb (the Android debug tool) was not found on this computer. Run `npx @taqwright/taqwright install --with-avd` or install the Android SDK platform-tools.";
    }
    const ready = a.devices.some((d) => d.state === "device");
    if (ready || a.avds.length > 0) return undefined;
    const blocked = a.devices.find((d) => d.state === "unauthorized");
    if (blocked) return "A phone is connected but has not allowed USB debugging from this computer. Unlock it and accept the prompt.";
    if (a.devices.some((d) => d.state === "offline")) return "A phone is connected but offline. Unplug it, plug it in again and unlock it.";
    return "No phone is connected and no emulator exists. Plug in a phone with USB debugging on, or create an emulator.";
}
