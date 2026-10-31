/**
 * Device farms: the shapes shared by the engine (running on a farm) and the platform (storing connections). Pure types and small schemas.
 *
 * A "connection" is one provider account of a project (BrowserStack, Sauce Labs, LambdaTest, or any Appium server) plus the phones picked from it.
 * Its credentials are held encrypted by the platform and only ever reach the provider's own addresses (see providers.ts).
 */
import { z } from "zod";

export const PROVIDER_IDS = ["browserstack", "saucelabs", "lambdatest", "appium"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const SAUCE_REGIONS = ["us-west-1", "eu-central-1", "us-east-4"] as const;

/** Caps on what a person can store (everything that comes from users is bounded). */
export const FARM_LIMITS = { connectionsPerProject: 5, devicesPerConnection: 10, maxParallel: 10, labelMax: 60, deviceNameMax: 80, osVersionMax: 20, credentialMax: 200, hubUrlMax: 300 } as const;

const DEVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]*$/;
const OS_VERSION = /^[0-9]{1,2}(\.[0-9]{1,2}){0,2}$/;

export const FarmDeviceSchema = z
    .object({
        name: z.string().trim().min(1).max(FARM_LIMITS.deviceNameMax).regex(DEVICE_NAME, "Device names use letters, digits, spaces and . _ ( ) + - only"),
        osVersion: z.string().trim().max(FARM_LIMITS.osVersionMax).regex(OS_VERSION, "Write the Android version as a number, for example 14 or 13.0").optional(),
    })
    .strict();
export type FarmDevice = z.infer<typeof FarmDeviceSchema>;

/** What the engine needs to run on one connection. Contains secrets: built by the platform for a run, never stored or logged in this form. */
export interface FarmConnection {
    id: string;
    provider: ProviderId;
    label: string;
    /** Sauce Labs only. */
    region?: (typeof SAUCE_REGIONS)[number];
    /** "Any Appium server" only: the server's address (no credentials in it). */
    hubUrl?: string;
    devices: FarmDevice[];
    username?: string;
    accessKey?: string;
}

/** How a project runs its phone tests on a farm. */
export interface FarmRunPlan {
    connection: FarmConnection;
    /** How many tests run at the same time (1 to 10). */
    parallel: number;
    /** True: every test runs on every picked phone ("Run on several phones"); false: the tests are shared out among them. */
    matrix: boolean;
}

/** One session on a farm, as the platform keeps it (links never carry credentials). */
export interface FarmSessionRecord {
    testId: string;
    provider: ProviderId;
    device: string;
    sessionId: string;
    status: "passed" | "failed" | "error";
    /** The provider's page for the session (video, logs), when the provider has one. */
    link?: string;
}
