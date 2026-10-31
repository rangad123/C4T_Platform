/**
 * The closed lists of adb commands of "Is this phone ready?" (mobile/device/ready.ts), checked on the final argument list like adb.ts does for
 * the explorer's own commands. Two lists:
 *
 *   READ   (an Adb made with `forReadiness()`): Android version, maker and model, screen and lock state, battery, the three animation scales,
 *          "stay awake while charging", the current user and the list of users, the packages installed for one user. Nothing changes.
 *   CHANGE (an Adb made with `forPhoneSetup()`, used only when a person presses "Turn animations off for tests", "Keep the screen on while
 *          charging" or their undo): `settings put global` of exactly those four settings, to a number. Every change is put back on request.
 *
 * Neither list is ever given to the AI explorer's session.
 */

const SAFE_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** The phone's properties the ready check reads. */
export const READY_PROPS = ["ro.build.version.release", "ro.build.version.sdk", "ro.product.manufacturer", "ro.product.brand", "ro.product.model", "ro.build.display.id"] as const;
export type ReadyProp = (typeof READY_PROPS)[number];

export const ANIMATION_KEYS = ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"] as const;
export type AnimationKey = (typeof ANIMATION_KEYS)[number];
export const STAY_ON_KEY = "stay_on_while_plugged_in";

const GLOBAL_KEYS = new Set<string>([...ANIMATION_KEYS, STAY_ON_KEY]);
/** An animation scale ("0", "1", "0.5", "1.0") or a stay-awake bit mask ("0".."15"). */
const SCALE_VALUE = /^\d{1,2}(\.\d{1,2})?$/;
const USER_ID = /^\d{1,6}$/;

/** Is this one of the read-only calls of the ready check? (After `-s <serial>` has been taken off.) */
export function allowedReadCommand(a: readonly string[]): boolean {
    if (a[0] !== "shell") return false;
    const rest = a.slice(1);
    const [s0, s1, s2] = rest;
    if (s0 === "getprop") return rest.length === 2 && (READY_PROPS as readonly string[]).includes(s1 ?? "");
    if (s0 === "dumpsys") return rest.length === 2 && (s1 === "power" || s1 === "battery" || s1 === "window");
    if (s0 === "settings") return rest.length === 4 && s1 === "get" && s2 === "global" && GLOBAL_KEYS.has(rest[3] ?? "");
    if (s0 === "am") return rest.length === 2 && s1 === "get-current-user";
    // Free storage on the data partition (read-only), so pre-flight can refuse plainly before an install fails for lack of space.
    if (s0 === "df") return rest.length === 3 && s1 === "-k" && s2 === "/data";
    if (s0 === "pm" && s1 === "list" && s2 === "users") return rest.length === 3;
    // `pm list packages --user <id>`: the list is searched here, never filtered by a name sent as an argument.
    if (s0 === "pm" && s1 === "list" && s2 === "packages") return rest.length === 5 && rest[3] === "--user" && USER_ID.test(rest[4] ?? "");
    // The launcher activity for one user (the ready check's own fallback when the shared resolver is not there).
    if (s0 === "cmd") return rest.length === 9 && s1 === "package" && s2 === "resolve-activity" && rest[3] === "--brief" && rest[4] === "--user" && USER_ID.test(rest[5] ?? "") && rest[6] === "-c" && rest[7] === "android.intent.category.LAUNCHER" && SAFE_PACKAGE.test(rest[8] ?? "");
    return false;
}

/** Is this one of the reversible changes a person can ask for? */
export function allowedChangeCommand(a: readonly string[]): boolean {
    if (a[0] !== "shell") return false;
    const rest = a.slice(1);
    return rest.length === 5 && rest[0] === "settings" && rest[1] === "put" && rest[2] === "global" && GLOBAL_KEYS.has(rest[3] ?? "") && SCALE_VALUE.test(rest[4] ?? "") && (rest[3] !== STAY_ON_KEY || /^\d{1,2}$/.test(rest[4] ?? ""));
}
