/**
 * Runner kit support: a runner started from the zip that the platform generates (Settings, Runners, Add a runner) has no command line
 * to speak of. Next to `runner.mjs` it finds `runner.json` (the platform's address, the name the person typed, the kit version) and
 * `runner.token` (the project token). This file turns those into the same settings the flags and environment variables set, so the
 * rest of the agent does not know the difference.
 *
 * Order of precedence stays what the setup guide says: a flag beats an environment variable, and both beat the kit's files. A runner
 * started from a repository checkout has no `runner.json` beside it, so none of this applies there.
 */
import fs from "node:fs";
import path from "node:path";

export const KIT_CONFIG_FILE = "runner.json";
export const KIT_TOKEN_FILE = "runner.token";
/** The single-use enrollment code a download carries (round 39); deleted by the runner once traded for its credential. */
export const KIT_ENROLL_FILE = "runner.enroll";
const MAX_CONFIG_BYTES = 8 * 1024;

export interface KitFile {
    url: string;
    name: string;
    kitVersion?: string;
    /** Which browser web tests use (auto, bundled, chrome, msedge). Optional: a person may add it; the flag and AITP_BROWSER beat it. */
    browser?: string;
    /** Android phone tools (auto, now, off; see phone-tools.ts). Optional: the installers write it; AITP_PHONE_TOOLS beats it. */
    phoneTools?: string;
}

export type KitResult = { kit: false; env: NodeJS.ProcessEnv } | { kit: true; env: NodeJS.ProcessEnv; file: KitFile } | { kit: "broken"; message: string };

const printable = (s: string): boolean => !/[\u0000-\u001f\u007f]/.test(s);

/** The kit's runner.json, or a plain reason it cannot be used. Exported for the unit tests. */
export function parseKitFile(text: string): { ok: true; file: KitFile } | { ok: false; message: string } {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return { ok: false, message: `${KIT_CONFIG_FILE} is not valid. Download the runner kit again from the platform.` };
    }
    const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
    const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= max && printable(v) ? v : undefined);
    const url = str(o?.url, 300);
    const name = str(o?.name, 64);
    const kitVersion = o?.kitVersion === undefined ? undefined : str(o.kitVersion, 80);
    if (!url || !name || (o?.kitVersion !== undefined && !kitVersion)) return { ok: false, message: `${KIT_CONFIG_FILE} is missing the platform address or the runner name. Download the runner kit again from the platform.` };
    const browser = typeof o?.browser === "string" ? o.browser.trim().toLowerCase() : undefined;
    if (o?.browser !== undefined && !(browser && ["auto", "bundled", "chrome", "msedge"].includes(browser))) return { ok: false, message: `${KIT_CONFIG_FILE} has a "browser" the runner does not know. Use "auto", "bundled", "chrome" or "msedge", or remove the line.` };
    const phoneTools = typeof o?.phoneTools === "string" ? o.phoneTools.trim().toLowerCase() : undefined;
    if (o?.phoneTools !== undefined && !(phoneTools && ["auto", "now", "off"].includes(phoneTools))) return { ok: false, message: `${KIT_CONFIG_FILE} has a "phoneTools" the runner does not know. Use "auto", "now" or "off", or remove the line.` };
    return { ok: true, file: { url, name, ...(kitVersion ? { kitVersion } : {}), ...(browser ? { browser } : {}), ...(phoneTools ? { phoneTools } : {}) } };
}

/**
 * Read the kit files in `dir` (the folder of runner.mjs) and fill in what the person did not set. Returns the environment to give to
 * the agent. With no runner.json in `dir` nothing changes (`kit: false`).
 */
export function applyKitDefaults(env: NodeJS.ProcessEnv, dir: string): KitResult {
    const configPath = path.join(dir, KIT_CONFIG_FILE);
    let text: string;
    try {
        if (!fs.existsSync(configPath)) return { kit: false, env };
        if (fs.statSync(configPath).size > MAX_CONFIG_BYTES) return { kit: "broken", message: `${KIT_CONFIG_FILE} is too large to be a runner kit file. Download the runner kit again from the platform.` };
        text = fs.readFileSync(configPath, "utf8");
    } catch {
        return { kit: "broken", message: `${KIT_CONFIG_FILE} could not be read. Check that you unzipped the whole runner kit.` };
    }
    const parsed = parseKitFile(text.replace(/^﻿/, ""));
    if (!parsed.ok) return { kit: "broken", message: parsed.message };
    const { file } = parsed;
    const out: NodeJS.ProcessEnv = { ...env };
    const unset = (k: string) => !out[k]?.trim();
    if (unset("AITP_URL")) out.AITP_URL = file.url;
    if (unset("AITP_AGENT_NAME")) out.AITP_AGENT_NAME = file.name;
    // Runs and the file cache live inside the kit folder, so deleting the folder removes everything the runner left behind.
    if (unset("AITP_AGENT_WORK_DIR")) out.AITP_AGENT_WORK_DIR = path.join(dir, "work");
    if (unset("AITP_AGENT_TOKEN") && unset("AITP_AGENT_TOKEN_FILE") && fs.existsSync(path.join(dir, KIT_TOKEN_FILE))) out.AITP_AGENT_TOKEN_FILE = path.join(dir, KIT_TOKEN_FILE);
    // Round 39: a download carries a single-use enrollment code (runner.enroll) instead; the credential it is traded for is kept for this folder.
    if (unset("AITP_CREDENTIAL_DIR")) out.AITP_CREDENTIAL_DIR = dir;
    if (unset("AITP_AGENT_TOKEN") && unset("AITP_AGENT_TOKEN_FILE") && unset("AITP_AGENT_ENROLL_FILE") && unset("AITP_ENROLL_CODE") && fs.existsSync(path.join(dir, KIT_ENROLL_FILE))) out.AITP_AGENT_ENROLL_FILE = path.join(dir, KIT_ENROLL_FILE);
    if (file.kitVersion) out.AITP_KIT_VERSION = file.kitVersion;
    if (file.browser && unset("AITP_BROWSER")) out.AITP_BROWSER = file.browser;
    if (file.phoneTools && unset("AITP_PHONE_TOOLS")) out.AITP_PHONE_TOOLS = file.phoneTools;
    return { kit: true, env: out, file };
}
