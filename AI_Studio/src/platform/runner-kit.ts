/**
 * The runner kit, platform side: a zip the platform builds per download so a tester can start a runner on their own computer without a
 * checkout of the repository (see docs/features/runner-kit.md).
 *
 * The program inside (runner.mjs and its helper processes) is prebuilt by `npm run build:runner` into dist/runner/ and only read here.
 * What is generated per download is small: runner.json (the address), runner.enroll (the person's one-time code), the start scripts and a
 * README. Nothing is ever read from the server's environment, `.env`, database or data folder: the only inputs are the prebuilt bundle,
 * the address and the code made for this download. Since round 45 this is the Linux download (and the fallback when a server has no
 * installer built); Windows and Mac get the installer (runner-installer.ts).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { zipSync, type Zippable } from "fflate";
import { z } from "zod";
import { isPrivateHost } from "../agent/config.js";
import { REPO_ROOT } from "../config.js";
import { NODE_MIN_MAJOR, readme, START_CMD, START_COMMAND, START_SH, withLineEnding, type KitPlatform } from "./runner-kit-scripts.js";
import { CHECK_FILES } from "./runner-check-scripts.js";

export { NODE_MIN_MAJOR, type KitPlatform };

export const BUILD_HINT = "The runner kit has not been built on this server. Run `npm run build:runner`.";

/** Where the prebuilt bundle lives: dist/runner next to the code, or RUNNER_KIT_DIR (tests and unusual installs). */
export const kitDir = (env: NodeJS.ProcessEnv = process.env): string => (env.RUNNER_KIT_DIR?.trim() ? path.resolve(env.RUNNER_KIT_DIR.trim()) : path.join(REPO_ROOT, "dist", "runner"));

// ── the prebuilt bundle ─────────────────────────────────────────────────────

const Manifest = z.object({
    format: z.literal(1),
    platformVersion: z.string().max(40),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    kitVersion: z.string().max(80),
    nodeMin: z.number().int(),
    files: z.array(z.object({ name: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), bytes: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).min(1).max(20),
});
export type KitManifest = z.infer<typeof Manifest>;

/** The files the kit needs from the bundle. A manifest without them is not a usable build. */
const REQUIRED_FILES = ["runner.mjs", "task-child.mjs", "record-child.mjs", "package.json", "LICENSES.txt"];
/** A bundle larger than this is not what build:runner produces; refuse rather than hand out something odd. */
const MAX_BUNDLE_BYTES = 40 * 1024 * 1024;

export type Bundle = { ok: true; manifest: KitManifest; files: Map<string, Uint8Array> } | { ok: false; reason: string };

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** Reads dist/runner and checks every file against the manifest's checksums, so a half-written or edited build is never handed out. */
export function loadBundle(dir: string = kitDir()): Bundle {
    let manifest: KitManifest;
    try {
        manifest = Manifest.parse(JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")));
    } catch (e) {
        const missing = (e as NodeJS.ErrnoException)?.code === "ENOENT";
        return { ok: false, reason: missing ? BUILD_HINT : "The runner kit on this server is damaged. Run `npm run build:runner` again." };
    }
    const damaged = { ok: false as const, reason: "The runner kit on this server is damaged. Run `npm run build:runner` again." };
    const files = new Map<string, Uint8Array>();
    let total = 0;
    for (const f of manifest.files) {
        let bytes: Uint8Array;
        try {
            bytes = fs.readFileSync(path.join(dir, f.name));
        } catch {
            return damaged;
        }
        total += bytes.length;
        if (total > MAX_BUNDLE_BYTES || bytes.length !== f.bytes || sha256(bytes) !== f.sha256) return damaged;
        files.set(f.name, bytes);
    }
    if (!REQUIRED_FILES.every((n) => files.has(n))) return damaged;
    return { ok: true, manifest, files };
}

// ── the address the runner will connect to ──────────────────────────────────

export interface AddressDecision {
    platformUrl: string;
    urlOk: boolean;
    urlWarning?: string;
}

const REQUEST_NOTE = "This address is the one used to reach the platform right now. If runners reach it another way, set PUBLIC_URL.";
const HTTPS_NEEDED = "Runners need an https address when the platform is not on your own network. Set PUBLIC_URL to the https address people use.";

/**
 * What the runner kit will tell the runner to connect to, and whether the runner will accept it (the runner refuses plain http unless the
 * platform is on this computer or a private network, see src/agent/config.ts, which supplies the same rule).
 *
 * PUBLIC_URL wins. Without it the address is rebuilt from the request: this server then does not trust proxy headers (it has no trust-proxy
 * setting), so x-forwarded-* is never read and the Host header is used as it came, which is said in the warning.
 */
export function decideAddress(input: { publicUrl?: string | undefined; protocol: string; host?: string | undefined }): AddressDecision {
    const configured = input.publicUrl?.trim();
    let raw: string;
    let fromRequest = false;
    if (configured) raw = configured;
    else {
        const host = input.host?.trim() ?? "";
        // A Host header is `name` or `name:port` (or a bracketed IPv6 address). Anything else is not an address to hand out.
        if (!/^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/.test(host)) return { platformUrl: "", urlOk: false, urlWarning: "The platform could not tell which address it is reached at. Set PUBLIC_URL to the address people use." };
        raw = `${input.protocol === "https" ? "https" : "http"}://${host}`;
        fromRequest = true;
    }
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return { platformUrl: "", urlOk: false, urlWarning: "PUBLIC_URL is not a full address. Set it to something like https://tests.example.com." };
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return { platformUrl: "", urlOk: false, urlWarning: "PUBLIC_URL must start with https://." };
    if (u.username || u.password) return { platformUrl: "", urlOk: false, urlWarning: "PUBLIC_URL must not contain a user name or password." };
    const platformUrl = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
    if (u.protocol === "https:") return { platformUrl, urlOk: true, ...(fromRequest ? { urlWarning: REQUEST_NOTE } : {}) };
    if (!isPrivateHost(u.hostname)) return { platformUrl, urlOk: false, urlWarning: HTTPS_NEEDED };
    const loopback = /^(localhost|127\.|\[?::1\]?$)/i.test(u.hostname);
    if (loopback) return { platformUrl, urlOk: true, urlWarning: "This is an address on this computer. Only a runner on this computer can use it. For a runner elsewhere, set PUBLIC_URL to the address people use." };
    return { platformUrl, urlOk: true, ...(fromRequest ? { urlWarning: REQUEST_NOTE } : {}) };
}

// ── what the person may ask for ─────────────────────────────────────────────

/**
 * The one download a person asks for in Settings (round 45): their computer's system and processor. Windows gets the setup program, a
 * Mac the app, Linux the plain files; each carries its own Node.js when this server has built it for that system and processor.
 * Nothing else is a choice: the runner's name is the computer's own name unless the person renames it in Settings.
 */
export const DownloadRequest = z
    .object({
        os: z.enum(["windows", "mac", "linux"], { message: "Choose windows, mac or linux." }),
        arch: z.enum(["x64", "arm64"], { message: "Choose the processor: x64 or arm64." }),
    })
    .strict();
export type DownloadRequest = z.infer<typeof DownloadRequest>;

/** What one zip is for: the system its start scripts and README lead with, and (optionally) a name for the runner. */
export interface KitTarget {
    platform: KitPlatform;
    /** Left out: the runner uses the computer's own name. */
    name?: string;
}

// ── the zip ─────────────────────────────────────────────────────────────────

export interface BuildKitInput {
    bundle: Extract<Bundle, { ok: true }>;
    request: KitTarget;
    platformUrl: string;
    /**
     * The single-use enrollment code (aite_...) the runner trades for its own credential at first contact, written as runner.enroll (0600).
     * Every download the platform makes carries one, never a runner credential (round 39).
     */
    enrollCode?: string;
    /** The signed-update sequence of this server's runner files (runner-update.ts downloadSequence): a fresh download refuses older signed updates. */
    updateSequence?: number;
    /** @deprecated Test seam: a runner credential written as runner.token, for tests that start a kit against a stand-in platform. The platform's routes never pass one. */
    token?: string;
}

/** The kit's credential file: runner.enroll with the code, or (tests only) runner.token. Exactly one of them. */
export function kitCredentialFile(i: { enrollCode?: string; token?: string }): { name: "runner.enroll" | "runner.token"; text: string } {
    if (i.enrollCode) return { name: "runner.enroll", text: `${i.enrollCode}\n` };
    if (i.token) return { name: "runner.token", text: `${i.token}\n` };
    throw new Error("A runner kit needs an enrollment code.");
}

/** `rwxr-xr-x`, `rw-r--r--` and `rw-------` as ZIP external attributes (the permission bits live in the high 16 bits; `*` avoids a negative 32-bit shift). */
const mode = (m: number): number => (0o100000 | m) * 65536;

/** The word in every download's file and folder name (runner-my-computer-...): a download is for the person's own computer. */
export const KIT_SLUG = "my-computer";
export const kitFolder = (platform: KitPlatform): string => `runner-${KIT_SLUG}-${platform}`;
export const kitFileName = (platform: KitPlatform): string => `${kitFolder(platform)}.zip`;

export function buildKitZip(i: BuildKitInput): Uint8Array {
    const dir = kitFolder(i.request.platform);
    const text = (s: string): Uint8Array => new TextEncoder().encode(s);
    const kitVersion = i.bundle.manifest.kitVersion;
    const win = i.request.platform === "windows";
    const entries: Zippable = {};
    const add = (name: string, data: Uint8Array, perm = 0o644): void => {
        entries[`${dir}/${name}`] = [data, { os: 3, attrs: mode(perm), level: 6 }];
    };
    // The program: exactly the prebuilt bytes.
    for (const name of ["runner.mjs", "task-child.mjs", "record-child.mjs", "package.json", "LICENSES.txt"]) add(name, i.bundle.files.get(name)!);
    // The test tools' lock file (from round 39 on): the start scripts and installers install from it with npm ci.
    const lock = i.bundle.files.get("package-lock.json");
    if (lock) add("package-lock.json", lock);
    // What belongs to this download.
    add("runner.json", text(`${JSON.stringify({ url: i.platformUrl, ...(i.request.name ? { name: i.request.name } : {}), kitVersion, ...(i.updateSequence !== undefined ? { updateSequence: i.updateSequence } : {}) }, null, 2)}\n`));
    const credential = kitCredentialFile(i);
    add(credential.name, text(credential.text), 0o600);
    // All three start scripts are in every kit: someone who picked the wrong system (or downloaded on one computer and unzipped on another)
    // must not end up with nothing runnable. The chosen system only decides what the README leads with and the folder's name.
    add("start-runner.cmd", text(withLineEnding(START_CMD, "\r\n")), 0o755);
    add("start-runner.sh", text(withLineEnding(START_SH, "\n")), 0o755);
    add("start-runner.command", text(withLineEnding(START_COMMAND, "\n")), 0o755);
    // "Check this computer" (docs/features/runner-check.md): double-clickable, in every download.
    for (const f of CHECK_FILES) add(f.name, text(withLineEnding(f.text, f.eol)), 0o755);
    add("README.txt", text(withLineEnding(readme({ platform: i.request.platform, ...(i.request.name ? { runnerName: i.request.name } : {}), platformUrl: i.platformUrl, kitVersion }), win ? "\r\n" : "\n")));
    return zipSync(entries);
}
