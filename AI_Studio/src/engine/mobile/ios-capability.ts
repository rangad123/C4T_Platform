/**
 * Can this computer run iOS tests? One rule, used twice: by the platform to decide which agent may be offered an iOS task (and to
 * refuse a run early with a plain sentence), and by the agent itself before it starts anything. Pure: it only reads what the agent
 * reported (see `Capabilities.ios` in src/agent-protocol/schema.ts).
 */

/** The part of the agent's reported capabilities this rule reads. */
export interface IosCapabilityInput {
    os: string;
    ios?: { xcode: boolean; simulators: readonly string[]; xcuitest?: boolean; iosSimulators?: number };
}

/** Why this computer cannot run iOS tests, in plain words that complete "it ...", or undefined when it can. */
export function iosCapabilityProblem(caps: IosCapabilityInput): string | undefined {
    const i = caps.ios;
    if (caps.os !== "darwin") return "it is not a Mac";
    if (!i?.xcode) return "Xcode is not installed on it (or its command line tools are not selected)";
    if ((i.iosSimulators ?? i.simulators.length) === 0) return "it has no iOS simulator (install an iOS runtime in Xcode, Settings, Platforms)";
    // An agent built before iOS support reports no `xcuitest` and is never chosen.
    if (i.xcuitest !== true) return "the Appium XCUITest driver is not installed on it (run `npx @taqwright/taqwright install` there, or `appium driver install xcuitest`)";
    return undefined;
}
