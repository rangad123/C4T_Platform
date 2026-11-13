/**
 * Time and conditions in web tests: the `clock` and `condition` steps, and a test's pinned date (TestSpec.pinnedTime).
 *
 * One reading of each step, used twice: `renderClock` / `renderCondition` write the Playwright line of a generated script, and
 * `applyClock` / `applyCondition` do the same thing live while a test is written (../web/interpreter.ts). A value that does not fit is
 * refused in plain words by both, before anything runs.
 */
import type { Page } from "playwright";
import { CONDITION_SETS, MAX_CLOCK_MINUTES, type Step } from "../spec/schema.js";

type ClockStep = Extract<Step, { action: "clock" }>;
type ConditionStep = Extract<Step, { action: "condition" }>;

const DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** A date or date and time as the ISO text both the script and the live run use; a plain date means noon UTC that day. */
export function clockTime(text: string | undefined, what: string): string {
    const t = (text ?? "").trim();
    if (!DATE.test(t) || Number.isNaN(Date.parse(t))) throw new Error(`${what} needs a date like 2025-01-15 or 2025-01-15T09:30:00Z (got "${t.slice(0, 40)}")`);
    return new Date(/T/.test(t) ? t : `${t}T12:00:00Z`).toISOString();
}

/** The day a check is pinned to when it is made: noon UTC of today, so a page's date text reads the same on every later run. */
export const pinToday = (now = new Date()): string => `${now.toISOString().slice(0, 10)}T12:00:00.000Z`;

function clockMinutes(step: ClockStep): number {
    const m = step.minutes;
    if (typeof m !== "number" || !Number.isFinite(m) || m <= 0 || m > MAX_CLOCK_MINUTES) throw new Error(`Moving the clock ahead needs a number of minutes between 1 and ${MAX_CLOCK_MINUTES}`);
    return Math.round(m * 60_000);
}

export function renderClock(step: ClockStep): string {
    switch (step.op) {
        case "install":
            return step.time ? `await page.clock.install({ time: new Date(${JSON.stringify(clockTime(step.time, "Taking over the clock"))}) });` : "await page.clock.install();";
        case "fastForward":
            return `await page.clock.fastForward(${clockMinutes(step)});`;
        case "pauseAt":
            return `await page.clock.pauseAt(new Date(${JSON.stringify(clockTime(step.time, "Stopping the clock"))}));`;
        case "resume":
            return "await page.clock.resume();";
    }
}

export async function applyClock(page: Page, step: ClockStep): Promise<void> {
    switch (step.op) {
        case "install":
            return step.time ? page.clock.install({ time: new Date(clockTime(step.time, "Taking over the clock")) }) : page.clock.install();
        case "fastForward":
            return page.clock.fastForward(clockMinutes(step));
        case "pauseAt":
            return page.clock.pauseAt(new Date(clockTime(step.time, "Stopping the clock")));
        case "resume":
            return page.clock.resume();
    }
}

/** The pinned date line at the top of a test (before the first page opens). */
export const renderPinnedTime = (pinned: string): string => `    await page.clock.setFixedTime(new Date(${JSON.stringify(clockTime(pinned, "Pinning the date"))}));\n`;

// ── conditions ──────────────────────────────────────────────────────────────

/** Permissions a test may grant (Playwright's list, the ones pages ask people for). */
export const PERMISSIONS = ["geolocation", "notifications", "camera", "microphone", "clipboard-read", "clipboard-write", "midi", "background-sync", "ambient-light-sensor", "accelerometer", "gyroscope", "magnetometer", "payment-handler", "storage-access"] as const;

const MEDIA_VALUES: Record<"colorScheme" | "reducedMotion" | "forcedColors" | "media", readonly string[]> = {
    colorScheme: ["light", "dark", "no-preference"],
    reducedMotion: ["reduce", "no-preference"],
    forcedColors: ["active", "none"],
    media: ["print", "screen"],
};

/** What one condition step does, checked: the same plan feeds the script line and the live call. */
type ConditionPlan =
    | { kind: "offline"; on: boolean }
    | { kind: "media"; key: keyof typeof MEDIA_VALUES; value: string }
    | { kind: "viewport"; width: number; height: number }
    | { kind: "grant"; permissions: string[] }
    | { kind: "deny" }
    | { kind: "geolocation"; latitude: number; longitude: number };

export function planCondition(step: ConditionStep): ConditionPlan {
    const v = (step.value ?? "").trim();
    switch (step.set) {
        case "offline":
        case "online":
            return { kind: "offline", on: step.set === "offline" };
        case "colorScheme":
        case "reducedMotion":
        case "forcedColors":
        case "media": {
            const allowed = MEDIA_VALUES[step.set];
            const value = v || allowed[0]!;
            if (!allowed.includes(value)) throw new Error(`"${step.set}" is one of ${allowed.join(", ")} (got "${v.slice(0, 40)}")`);
            return { kind: "media", key: step.set, value };
        }
        case "viewport": {
            const m = /^(\d{3,4})\s*[x×]\s*(\d{3,4})$/.exec(v);
            const w = Number(m?.[1]);
            const h = Number(m?.[2]);
            if (!m || w < 200 || h < 200 || w > 3840 || h > 2160) throw new Error(`Resizing the window needs a size like 390x844, between 200x200 and 3840x2160 (got "${v.slice(0, 40)}")`);
            return { kind: "viewport", width: w, height: h };
        }
        case "grantPermissions": {
            const list = v.split(",").map((p) => p.trim()).filter(Boolean);
            const bad = list.filter((p) => !(PERMISSIONS as readonly string[]).includes(p));
            if (!list.length || bad.length) throw new Error(`Allowing permissions needs a list from: ${PERMISSIONS.join(", ")}${bad.length ? ` (not one: ${bad.join(", ").slice(0, 80)})` : ""}`);
            return { kind: "grant", permissions: list };
        }
        case "denyPermissions":
            return { kind: "deny" };
        case "geolocation": {
            const [lat, lng] = v.split(",").map((x) => Number(x.trim()));
            if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat!) > 90 || Math.abs(lng!) > 180 || v.split(",").length !== 2) throw new Error(`A location is "latitude,longitude", e.g. 52.52,13.40 (got "${v.slice(0, 40)}")`);
            return { kind: "geolocation", latitude: lat!, longitude: lng! };
        }
    }
}

/** The script line(s); `BASE_URL` is the script's own constant (permissions are granted to the application's site only). */
export function renderCondition(step: ConditionStep): string {
    const p = planCondition(step);
    switch (p.kind) {
        case "offline":
            return `await page.context().setOffline(${p.on});`;
        case "media":
            return `await page.emulateMedia({ ${p.key}: ${JSON.stringify(p.value)} });`;
        case "viewport":
            return `await page.setViewportSize({ width: ${p.width}, height: ${p.height} });`;
        case "grant":
            return `await page.context().grantPermissions(${JSON.stringify(p.permissions)}, { origin: new URL(BASE_URL).origin });`;
        case "deny":
            return "await page.context().clearPermissions();";
        case "geolocation":
            return `await page.context().setGeolocation({ latitude: ${p.latitude}, longitude: ${p.longitude} });\n        await page.context().grantPermissions(["geolocation"], { origin: new URL(BASE_URL).origin });`;
    }
}

export async function applyCondition(page: Page, step: ConditionStep, baseUrl: string): Promise<void> {
    const p = planCondition(step);
    const origin = new URL(baseUrl).origin;
    switch (p.kind) {
        case "offline":
            return page.context().setOffline(p.on);
        case "media":
            return page.emulateMedia({ [p.key]: p.value });
        case "viewport":
            return page.setViewportSize({ width: p.width, height: p.height });
        case "grant":
            return page.context().grantPermissions(p.permissions, { origin });
        case "deny":
            return page.context().clearPermissions();
        case "geolocation":
            await page.context().setGeolocation({ latitude: p.latitude, longitude: p.longitude });
            return page.context().grantPermissions(["geolocation"], { origin });
    }
}

/** The kinds a condition step accepts, for tool and editor descriptions. */
export const CONDITION_HELP = `set: ${CONDITION_SETS.join("|")}. value: colorScheme light|dark; reducedMotion reduce|no-preference; forcedColors active|none; media print|screen; viewport "390x844"; grantPermissions a comma list (${PERMISSIONS.slice(0, 4).join(", ")}...); geolocation "lat,lng"; offline, online and denyPermissions take none.`;
