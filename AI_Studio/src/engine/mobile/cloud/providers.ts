/**
 * The device farms the platform can run phone tests on, as data: where each one's WebDriver hub and REST API live, how an app is uploaded, which
 * capabilities a session asks for, how a result is reported back, and the page that shows a session's video and logs.
 *
 * All of them speak the standard Appium remote (W3C WebDriver) protocol, so one client (webdriver.ts) drives every one. The addresses are fixed per
 * provider (Sauce Labs: per region): a person picks a provider and gives an account, never an address, so stored credentials can only ever go to that
 * provider's own servers. "Any Appium server" is the exception: its address is given, and credentials are only sent to it over https (or to this computer).
 *
 * Contributor seam: AITP_FARM_BASE (for example http://127.0.0.1:6771) replaces every provider address by `<base>/<provider>/hub|api|web`, so the tests
 * reach a local fake server. Unset (always, in production), nothing changes. It is an operator setting like AITP_ADB_PATH, never taken from a request.
 */
import type { FarmConnection, FarmDevice, ProviderId } from "./types.js";

export interface ProviderInfo {
    id: ProviderId;
    label: string;
    /** Plain words shown when connecting. */
    hint: string;
    /** Name of the first credential field ("User name"), or undefined when the provider takes none. */
    userLabel?: string;
    keyLabel?: string;
    /** The provider installs the app from an upload (true), or the app must already be on the phone (Any Appium server). */
    uploadsApp: boolean;
    /** The provider has a page per session with its video and logs. */
    sessionLinks: boolean;
    /** Sauce Labs only. */
    regions?: readonly string[];
    /** Any Appium server only: the person gives the server's address. */
    needsHubUrl?: boolean;
    /** Where the person finds the device names and their credentials. */
    docsHint: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
    browserstack: {
        id: "browserstack",
        label: "BrowserStack App Automate",
        hint: "Real Android phones in BrowserStack's cloud. The platform uploads your app's .apk for each run.",
        userLabel: "User name",
        keyLabel: "Access key",
        uploadsApp: true,
        sessionLinks: true,
        docsHint: "Your user name and access key are under Account, Settings in BrowserStack. Device names are as BrowserStack lists them, for example Google Pixel 8.",
    },
    saucelabs: {
        id: "saucelabs",
        label: "Sauce Labs",
        hint: "Real phones and emulators in Sauce Labs' cloud. The platform uploads your app's .apk to Sauce Labs storage for each run.",
        userLabel: "User name",
        keyLabel: "Access key",
        uploadsApp: true,
        sessionLinks: true,
        regions: ["us-west-1", "eu-central-1", "us-east-4"],
        docsHint: "Your user name and access key are under User settings in Sauce Labs. Pick the data centre your account uses.",
    },
    lambdatest: {
        id: "lambdatest",
        label: "LambdaTest",
        hint: "Real Android phones in LambdaTest's cloud. The platform uploads your app's .apk for each run.",
        userLabel: "User name",
        keyLabel: "Access key",
        uploadsApp: true,
        sessionLinks: true,
        docsHint: "Your user name and access key are in LambdaTest under Account settings, Password and security.",
    },
    appium: {
        id: "appium",
        label: "Any Appium server",
        hint: "An Appium 2 server you run, with the UiAutomator2 driver and a phone attached. The app must already be installed on that phone.",
        userLabel: "User name (optional)",
        keyLabel: "Password or key (optional)",
        uploadsApp: false,
        sessionLinks: false,
        needsHubUrl: true,
        docsHint: "Give the server's address, for example https://appium.example.com/wd/hub. Sign-in details are only sent over https.",
    },
};

/** Addresses of one provider for one connection. */
export interface ProviderEndpoints {
    hub: string;
    api: string;
    web: string;
}

const testBase = (): string | undefined => {
    const b = process.env.AITP_FARM_BASE?.trim();
    return b ? b.replace(/\/+$/, "") : undefined;
};

export function endpointsFor(conn: Pick<FarmConnection, "provider" | "region" | "hubUrl">): ProviderEndpoints {
    const base = testBase();
    if (base && conn.provider !== "appium") return { hub: `${base}/${conn.provider}/hub`, api: `${base}/${conn.provider}/api`, web: `${base}/${conn.provider}/web` };
    switch (conn.provider) {
        case "browserstack":
            return { hub: "https://hub-cloud.browserstack.com/wd/hub", api: "https://api-cloud.browserstack.com", web: "https://app-automate.browserstack.com" };
        case "saucelabs": {
            const region = conn.region ?? "us-west-1";
            return { hub: `https://ondemand.${region}.saucelabs.com/wd/hub`, api: `https://api.${region}.saucelabs.com`, web: "https://app.saucelabs.com" };
        }
        case "lambdatest":
            return { hub: "https://mobile-hub.lambdatest.com/wd/hub", api: "https://mobile-api.lambdatest.com", web: "https://appautomation.lambdatest.com" };
        case "appium": {
            const hub = (conn.hubUrl ?? "").replace(/\/+$/, "");
            return { hub, api: hub, web: "" };
        }
    }
}

/** The app upload request of a provider (multipart), and where the app's reference is in the answer. Undefined: the provider takes no upload. */
export function uploadRequest(conn: FarmConnection, ep: ProviderEndpoints, file: Blob, fileName: string): { url: string; form: FormData; ref: (body: unknown) => string | undefined } | undefined {
    const form = new FormData();
    const pick = (body: unknown, ...path: string[]): unknown => path.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), body);
    const str = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length < 300 ? v : undefined);
    switch (conn.provider) {
        case "browserstack":
            form.append("file", file, fileName);
            return { url: `${ep.api}/app-automate/upload`, form, ref: (b) => str(pick(b, "app_url")) };
        case "saucelabs":
            form.append("payload", file, fileName);
            form.append("name", fileName);
            return { url: `${ep.api}/v1/storage/upload`, form, ref: (b) => (str(pick(b, "item", "id")) ? `storage:${str(pick(b, "item", "id"))}` : undefined) };
        case "lambdatest":
            form.append("appFile", file, fileName);
            form.append("name", fileName);
            return { url: `${ep.api.replace("mobile-api.", "manual-api.")}/app/upload/realDevice`, form, ref: (b) => str(pick(b, "app_url")) };
        case "appium":
            return undefined;
    }
}

/** A cheap, read-only request that proves the account works ("Check connection"). */
export function checkRequest(conn: FarmConnection, ep: ProviderEndpoints): { url: string; method: "GET" } {
    switch (conn.provider) {
        case "browserstack":
            return { url: `${ep.api}/app-automate/plan.json`, method: "GET" };
        case "saucelabs":
            return { url: `${ep.api}/rest/v1/users/${encodeURIComponent(conn.username ?? "")}`, method: "GET" };
        case "lambdatest":
            return { url: `${ep.api}/mobile-automation/api/v1/builds?limit=1`, method: "GET" };
        case "appium":
            return { url: `${ep.hub}/status`, method: "GET" };
    }
}

/** Session capabilities in the provider's own dialect. `appRef` is the uploaded app (cloud providers); `appPackage` the app to open. */
export function capabilitiesFor(conn: FarmConnection, device: FarmDevice, o: { appRef?: string; appPackage?: string; name: string; build: string }): Record<string, unknown> {
    const base = { platformName: "Android", "appium:automationName": "UiAutomator2" };
    const name = o.name.slice(0, 120);
    const build = o.build.slice(0, 120);
    switch (conn.provider) {
        case "browserstack":
            return { ...base, ...(o.appRef ? { "appium:app": o.appRef } : {}), "bstack:options": { deviceName: device.name, ...(device.osVersion ? { osVersion: device.osVersion } : {}), projectName: "AI Testing Platform", buildName: build, sessionName: name } };
        case "saucelabs":
            return { ...base, "appium:deviceName": device.name, ...(device.osVersion ? { "appium:platformVersion": device.osVersion } : {}), ...(o.appRef ? { "appium:app": o.appRef } : {}), "sauce:options": { name, build } };
        case "lambdatest":
            return { ...base, "lt:options": { deviceName: device.name, ...(device.osVersion ? { platformVersion: device.osVersion } : {}), ...(o.appRef ? { app: o.appRef } : {}), isRealMobile: true, w3c: true, build, name } };
        case "appium":
            return { ...base, "appium:deviceName": device.name, ...(device.osVersion ? { "appium:platformVersion": device.osVersion } : {}), ...(o.appPackage ? { "appium:appPackage": o.appPackage, "appium:noReset": true } : {}), "appium:newCommandTimeout": 240 };
    }
}

/** How a result is reported back so the provider's dashboard shows it. Undefined: the provider has no such call. */
export function statusRequest(conn: FarmConnection, ep: ProviderEndpoints, sessionId: string, passed: boolean, reason: string): { url: string; method: string; body: string } | undefined {
    const id = encodeURIComponent(sessionId);
    const why = reason.slice(0, 250);
    switch (conn.provider) {
        case "browserstack":
            return { url: `${ep.api}/app-automate/sessions/${id}.json`, method: "PUT", body: JSON.stringify({ status: passed ? "passed" : "failed", reason: why }) };
        case "saucelabs":
            return { url: `${ep.api}/rest/v1/${encodeURIComponent(conn.username ?? "")}/jobs/${id}`, method: "PUT", body: JSON.stringify({ passed }) };
        case "lambdatest":
            return { url: `${ep.api}/mobile-automation/api/v1/sessions/${id}`, method: "PATCH", body: JSON.stringify({ status_ind: passed ? "passed" : "failed", reason: why }) };
        case "appium":
            return undefined;
    }
}

/** The provider's page for one session (video, logs). Built from the session id only: never carries credentials. */
export function sessionLink(conn: FarmConnection, ep: ProviderEndpoints, sessionId: string): string | undefined {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)) return undefined;
    switch (conn.provider) {
        case "browserstack":
            return `${ep.web}/dashboard/v2/sessions/${sessionId}`;
        case "saucelabs":
            return `${ep.web}/tests/${sessionId}`;
        case "lambdatest":
            return `${ep.web}/test?testID=${sessionId}`;
        case "appium":
            return undefined;
    }
}

/** The Authorization header for a connection, or undefined when it has no credentials. */
export function authHeader(conn: Pick<FarmConnection, "username" | "accessKey">): string | undefined {
    if (!conn.username && !conn.accessKey) return undefined;
    return `Basic ${Buffer.from(`${conn.username ?? ""}:${conn.accessKey ?? ""}`).toString("base64")}`;
}

/** Why a connection's settings cannot be used, in plain words, or undefined. */
export function connectionProblem(conn: FarmConnection): string | undefined {
    const info = PROVIDERS[conn.provider];
    if (!info) return "This device farm is not one the platform knows.";
    if (conn.provider !== "appium" && (!conn.username || !conn.accessKey)) return `${info.label} needs a user name and an access key.`;
    if (conn.provider === "appium") {
        let u: URL;
        try {
            u = new URL(conn.hubUrl ?? "");
        } catch {
            return "Give the Appium server's address, for example https://appium.example.com/wd/hub.";
        }
        if (!/^https?:$/.test(u.protocol)) return "The Appium server's address must start with http:// or https://.";
        if (u.username || u.password) return "Put sign-in details in their own fields, not in the address.";
        if (u.search || u.hash) return "The Appium server's address can't have a query or a fragment.";
        const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
        if ((conn.username || conn.accessKey) && u.protocol !== "https:" && !local) return "Sign-in details are only sent over https. Use an https address, or leave them out.";
    }
    if (conn.devices.length === 0) return "Pick at least one phone to run on.";
    return undefined;
}

/** Text from a provider can repeat what it was sent: the account's secrets never travel further in an error message. */
export function scrubSecrets(text: string, conn: Pick<FarmConnection, "username" | "accessKey">): string {
    let out = text;
    const auth = authHeader(conn);
    for (const s of [conn.accessKey, auth?.slice(6), conn.username && conn.username.length >= 4 ? conn.username : undefined]) {
        if (s && s.length >= 4) out = out.split(s).join("[hidden]");
    }
    return out;
}
