/**
 * The Taqwright configuration for an iOS run, and the environment the Taqwright process gets. Both are built from fixed text and a
 * few validated values (simulator name and id, bundle id, a port, a time limit): nothing a spec says is ever put into the config,
 * no path leaves the machine, and no secret is involved (the test process gets no credentials and no platform variables).
 */

/**
 * The config file written next to the scripts. It mirrors the Android one (validation/mobile-runner.ts) with Platform.IOS. The
 * agent boots the simulator itself and pins it by id, so Taqwright/Appium never boots or picks another one.
 */
export const IOS_CONFIG = `import { defineConfig, Platform } from "@taqwright/taqwright";
const bundle = process.env.MOBILE_APP_PACKAGE;
const udid = process.env.MOBILE_UDID;
const version = process.env.MOBILE_IOS_VERSION;
export default defineConfig({
    testDir: ".",
    testMatch: /.*\\.spec\\.ts$/,
    timeout: Number(process.env.MOBILE_TEST_TIMEOUT_MS ?? 180000),
    workers: 1,
    retries: 0,
    reporter: [["json", { outputFile: "report.json" }]],
    outputDir: "artifacts",
    projects: [
        {
            name: "ios",
            use: {
                platform: Platform.IOS,
                // The agent boots the simulator itself and tells Taqwright which one (see mobile/ios-runner.ts).
                device: { provider: "emulator", name: process.env.MOBILE_SIMULATOR as string, ...(udid ? { udid } : {}), ...(version ? { osVersion: version } : {}) },
                ...(bundle ? { appBundleId: bundle } : {}),
                // Each run has its own Appium port: the previous run's server may still be shutting down on the usual one.
                appium: { autoStart: true, autoStartDevice: false, connectionTimeout: 300000, ...(process.env.MOBILE_APPIUM_PORT ? { port: Number(process.env.MOBILE_APPIUM_PORT) } : {}) },
                video: "on-failure",
                trace: "on-failure",
                expectTimeout: 15000,
            },
        },
    ],
});
`;

/** What the iOS runner passes besides the allowed variables of the machine. */
export interface IosChildEnvInput {
    simulatorName: string;
    udid?: string;
    version?: string;
    bundleId?: string;
    port: number;
    testTimeoutMs: number;
}

/** The variables the Taqwright process reads for an iOS run. Empty credentials are set on purpose so none can be inherited. */
export function iosChildEnv(i: IosChildEnvInput): Record<string, string> {
    return {
        FORCE_COLOR: "0",
        MOBILE_SIMULATOR: i.simulatorName,
        MOBILE_UDID: i.udid ?? "",
        MOBILE_IOS_VERSION: i.version ?? "",
        MOBILE_APPIUM_PORT: String(i.port),
        // The generated script reads this name for both platforms (it holds the Android package or the iOS bundle id).
        MOBILE_APP_PACKAGE: i.bundleId ?? "",
        MOBILE_TEST_TIMEOUT_MS: String(Math.round(i.testTimeoutMs)),
        TEST_USERNAME: "",
        TEST_PASSWORD: "",
    };
}

/** Variables of the Mac that the iOS toolchain reads and the browser runner has no reason to pass. */
export const IOS_ENV_ALLOW = new Set(["TAQWRIGHT_HOME", "APPIUM_HOME", "DEVELOPER_DIR", "NUMBER_OF_PROCESSORS"]);
