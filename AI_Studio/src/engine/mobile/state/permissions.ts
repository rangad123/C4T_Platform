/**
 * The runtime permissions an Android app asks for, read from `dumpsys package <package>` (the configured package only).
 *
 * Runtime ("dangerous") permissions are the ones a person is asked about and the only ones `pm grant` can give; install-time permissions (internet,
 * vibrate...) are granted when the app is installed. The output is read as untrusted text: only lines that are a well-formed permission name count, and
 * the list is capped.
 */
import { MAX_GRANTED, PERMISSION_NAME } from "../target.js";

export interface RequestedPermission {
    name: string;
    /** Granted right now on this phone (when the phone says). */
    granted?: boolean;
    /** A short plain name ("Camera"). */
    label: string;
}

/** Most permissions listed for a person to choose from. */
export const MAX_LISTED_PERMISSIONS = 60;
const MAX_DUMP = 2 * 1024 * 1024;

/** Runtime permissions of the platform, for apps whose dump has no "runtime permissions" section (old Android versions). */
const KNOWN_RUNTIME = new Set(
    [
        "ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION", "ACCESS_BACKGROUND_LOCATION", "CAMERA", "RECORD_AUDIO", "READ_CONTACTS", "WRITE_CONTACTS", "GET_ACCOUNTS",
        "READ_CALENDAR", "WRITE_CALENDAR", "READ_PHONE_STATE", "READ_PHONE_NUMBERS", "CALL_PHONE", "READ_CALL_LOG", "WRITE_CALL_LOG", "SEND_SMS", "RECEIVE_SMS",
        "READ_SMS", "BODY_SENSORS", "ACTIVITY_RECOGNITION", "READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE", "READ_MEDIA_IMAGES", "READ_MEDIA_VIDEO",
        "READ_MEDIA_AUDIO", "POST_NOTIFICATIONS", "NEARBY_WIFI_DEVICES", "BLUETOOTH_CONNECT", "BLUETOOTH_SCAN", "BLUETOOTH_ADVERTISE", "UWB_RANGING",
    ].map((n) => `android.permission.${n}`),
);

/** "android.permission.ACCESS_FINE_LOCATION" reads as "Access fine location". */
export function permissionLabel(name: string): string {
    const last = name.split(".").pop() ?? name;
    const words = last.toLowerCase().replace(/_/g, " ").trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

export function parseRequestedPermissions(dump: string): RequestedPermission[] {
    const text = dump.length > MAX_DUMP ? dump.slice(0, MAX_DUMP) : dump;
    const requested: string[] = [];
    const runtime = new Map<string, boolean>();
    let section: "requested" | "runtime" | "other" = "other";
    let sectionIndent = -1;
    for (const raw of text.split(/\r?\n/)) {
        const indent = raw.length - raw.trimStart().length;
        const line = raw.trim();
        if (!line) continue;
        if (/^requested permissions:$/i.test(line)) {
            section = "requested";
            sectionIndent = indent;
            continue;
        }
        if (/^runtime permissions:$/i.test(line)) {
            section = "runtime";
            sectionIndent = indent;
            continue;
        }
        // A heading at the same or a smaller indent ends the section.
        if (section !== "other" && indent <= sectionIndent) section = "other";
        if (section === "other") continue;
        const m = /^([A-Za-z0-9_.]+?)(?::\s*granted=(true|false))?(?:[,:\s].*)?$/.exec(line);
        const name = m?.[1];
        if (!name || !PERMISSION_NAME.test(name)) continue;
        if (section === "requested" && !requested.includes(name)) requested.push(name);
        if (section === "runtime") runtime.set(name, m?.[2] === "true");
    }
    const names = runtime.size ? [...runtime.keys()] : requested.filter((n) => KNOWN_RUNTIME.has(n));
    return names.slice(0, MAX_LISTED_PERMISSIONS).map((name) => ({ name, label: permissionLabel(name), ...(runtime.has(name) ? { granted: runtime.get(name)! } : {}) }));
}

/** The permissions a project asks to grant, checked and without repeats (the schema already refuses malformed names). */
export function cleanGrantList(list: readonly string[] | undefined): string[] {
    return [...new Set((list ?? []).filter((n) => PERMISSION_NAME.test(n)))].slice(0, MAX_GRANTED);
}
