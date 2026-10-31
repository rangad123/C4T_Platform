/**
 * Google's Android "platform-tools" (adb and a few companions, about 7 to 15 MB): everything a real phone on USB needs for the AI phone explorer, without
 * the Android SDK. See docs/features/phone-setup-simple.md.
 *
 * Where it comes from: Google's own SDK repository, the same list Android Studio's SDK manager reads (`repository2-3.xml` under
 * https://dl.google.com/android/repository/). That list names, for each system, the archive, its exact size and its SHA-1. Google publishes no
 * SHA-256 for platform-tools, so the check is: the list itself over https from dl.google.com, then the archive's size and SHA-1 against it. The
 * archive must come from the same address as the list (a list that points elsewhere is refused). Nothing is pinned here because Google keeps only
 * the newest platform-tools in that list and a pinned checksum would go stale; the version that was fetched is recorded next to the files.
 *
 * Where it goes: one folder chosen by the caller (the runner uses `<work folder>/phone-tools`), as `platform-tools/` inside it, never anywhere
 * system-wide and never on the PATH. Only entries under `platform-tools/` with plain relative names are unpacked.
 *
 * Tests point AITP_PHONE_TOOLS_REPO at a local stand-in for Google; plain http is accepted only for an address on the same computer.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";

export const GOOGLE_REPOSITORY = "https://dl.google.com/android/repository/";
export const REPOSITORY_MANIFEST = "repository2-3.xml";
/** Written next to the unpacked tools: which version, from where, its SHA-1, when. */
export const PHONE_TOOLS_MARKER = "aitp-phone-tools.json";

/** Caps on what comes from the network (the real list is about 1 MB, the real archives 7 to 15 MB). */
export const PHONE_TOOLS_LIMITS = { manifestBytes: 16 * 1024 * 1024, archiveBytes: 150 * 1024 * 1024, unpackedBytes: 400 * 1024 * 1024, entries: 3000, timeoutMs: 10 * 60_000 } as const;

/** What a person does on the phone so this computer may use it. Shown by the runner and in the doc. */
export const USB_DEBUGGING_STEPS = [
    "On the phone, open Settings, About phone, and tap Build number seven times (on some phones it is under Software information). The phone says you are now a developer.",
    "Go back to Settings, open System, Developer options (or search Settings for Developer options) and turn on USB debugging.",
    "Connect the phone to this computer with a USB cable, unlock it, and tap Allow on the question \"Allow USB debugging?\" (tick \"Always allow from this computer\" to be asked only once).",
    "On Windows, some phones also need their maker's USB driver (Google's for Pixel phones, Samsung's for Samsung phones).",
] as const;

export type HostOs = "windows" | "macosx" | "linux";

/** Which of Google's downloads fits this system, or why none does. */
export function phoneToolsHost(platform: NodeJS.Platform = process.platform, arch: string = process.arch): { ok: true; hostOs: HostOs; note?: string } | { ok: false; reason: string } {
    if (platform === "win32") return { ok: true, hostOs: "windows", ...(arch === "arm64" ? { note: "Google's Windows tools are made for Intel and AMD processors; Windows on ARM runs them through its own emulation." } : {}) };
    if (platform === "darwin") return { ok: true, hostOs: "macosx" };
    if (platform === "linux") {
        if (arch === "x64") return { ok: true, hostOs: "linux" };
        return { ok: false, reason: "Google publishes the phone tools for Linux only for Intel and AMD processors. Install adb from this computer's packages (for example `sudo apt install adb`) and start the runner again." };
    }
    return { ok: false, reason: "Google publishes the phone tools only for Windows, macOS and Linux." };
}

export interface PlatformToolsArchive {
    version: string;
    hostOs: HostOs;
    /** Absolute address of the archive (always under the list's own address). */
    url: string;
    size: number;
    sha1: string;
}

const tag = (block: string, name: string): string | undefined => new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`).exec(block)?.[1]?.trim();
const versionKey = (v: string): number[] => v.split(".").map((x) => Number(x) || 0);
function newer(a: string, b: string): boolean {
    const x = versionKey(a);
    const y = versionKey(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
    return false;
}

/**
 * The stable platform-tools archives a repository list offers. Google's format (repository2-1 and 2-3): `<channel id="channel-0">stable</channel>`, and
 * `<remotePackage path="platform-tools">` with `<revision><major/><minor/><micro/></revision>`, `<channelRef ref="channel-0"/>` and `<archive>` entries of
 * `<complete><size/><checksum type="sha1"/><url/></complete><host-os/>`. Anything that does not fit is skipped, never guessed.
 */
export function parseRepositoryManifest(xml: string, listUrl: string): PlatformToolsArchive[] {
    if (xml.length > PHONE_TOOLS_LIMITS.manifestBytes) return [];
    const stable = new Set<string>();
    for (const m of xml.matchAll(/<channel\s+id="([^"]{1,40})"\s*>\s*stable\s*<\/channel>/g)) stable.add(m[1]!);
    if (stable.size === 0) stable.add("channel-0");
    const base = new URL(listUrl);
    const out: PlatformToolsArchive[] = [];
    for (const m of xml.matchAll(/<remotePackage\s+([^>]*)>([\s\S]*?)<\/remotePackage>/g)) {
        const attrs = m[1]!;
        const body = m[2]!;
        if (!/\bpath="platform-tools"/.test(attrs) || /\bobsolete="true"/.test(attrs)) continue;
        const channel = /<channelRef\s+ref="([^"]{1,40})"/.exec(body)?.[1] ?? "channel-0";
        if (!stable.has(channel)) continue;
        const rev = /<revision>([\s\S]*?)<\/revision>/.exec(body)?.[1] ?? "";
        const parts = [tag(rev, "major"), tag(rev, "minor"), tag(rev, "micro")].filter((p): p is string => p !== undefined && /^\d{1,5}$/.test(p));
        if (parts.length === 0 || /<preview>/.test(rev)) continue;
        const version = parts.join(".");
        for (const a of body.matchAll(/<archive>([\s\S]*?)<\/archive>/g)) {
            const block = a[1]!;
            const complete = /<complete>([\s\S]*?)<\/complete>/.exec(block)?.[1] ?? "";
            const hostOs = tag(block, "host-os");
            const size = Number(tag(complete, "size"));
            const sumMatch = /<checksum(?:\s+type="([^"]*)")?\s*>([^<]*)<\/checksum>/.exec(complete);
            const sha1 = sumMatch && (sumMatch[1] === undefined || sumMatch[1] === "sha1") ? sumMatch[2]!.trim().toLowerCase() : "";
            const rel = tag(complete, "url") ?? "";
            if (hostOs !== "windows" && hostOs !== "macosx" && hostOs !== "linux") continue;
            if (!Number.isInteger(size) || size <= 0 || size > PHONE_TOOLS_LIMITS.archiveBytes || !/^[0-9a-f]{40}$/.test(sha1)) continue;
            let url: URL;
            try {
                url = new URL(rel, base);
            } catch {
                continue;
            }
            // The archive must come from where the list came from: a list that sends the download elsewhere is not followed.
            if (url.origin !== base.origin || !/\.zip$/i.test(url.pathname)) continue;
            out.push({ version, hostOs, url: url.href, size, sha1 });
        }
    }
    return out;
}

/** The newest stable archive for this system. */
export function chooseArchive(list: readonly PlatformToolsArchive[], hostOs: HostOs): PlatformToolsArchive | undefined {
    let best: PlatformToolsArchive | undefined;
    for (const a of list) if (a.hostOs === hostOs && (!best || newer(a.version, best.version))) best = a;
    return best;
}

/** Where the list is read from: Google, or AITP_PHONE_TOOLS_REPO (a mirror, or the tests' stand-in). https only, except http on this computer. */
export function repositoryBase(env: NodeJS.ProcessEnv = process.env): { ok: true; url: string } | { ok: false; reason: string } {
    const raw = env.AITP_PHONE_TOOLS_REPO?.trim() || GOOGLE_REPOSITORY;
    let u: URL;
    try {
        u = new URL(raw.endsWith("/") ? raw : `${raw}/`);
    } catch {
        return { ok: false, reason: "AITP_PHONE_TOOLS_REPO is not a web address." };
    }
    const local = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return { ok: false, reason: "The phone tools are downloaded over https only." };
    if (u.username || u.password) return { ok: false, reason: "AITP_PHONE_TOOLS_REPO must not contain a user name or password." };
    return { ok: true, url: u.href };
}

const exe = (name: string, platform: NodeJS.Platform) => (platform === "win32" ? `${name}.exe` : name);

export interface InstalledPhoneTools {
    /** The folder to use as ANDROID_HOME (it holds platform-tools/). */
    home: string;
    adb: string;
    version: string;
}

/** The phone tools a previous fetch put into `dir`, when they are complete. */
export function installedPhoneTools(dir: string, platform: NodeJS.Platform = process.platform): InstalledPhoneTools | undefined {
    const tools = path.join(dir, "platform-tools");
    const adb = path.join(tools, exe("adb", platform));
    try {
        const marker = JSON.parse(fs.readFileSync(path.join(tools, PHONE_TOOLS_MARKER), "utf8")) as { version?: unknown };
        if (typeof marker.version !== "string" || !fs.existsSync(adb)) return undefined;
        return { home: dir, adb, version: marker.version.slice(0, 40) };
    } catch {
        return undefined;
    }
}

export class PhoneToolsError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PhoneToolsError";
    }
}

export interface FetchPhoneToolsOptions {
    /** The folder the tools go into (as platform-tools/ inside it). */
    dir: string;
    platform?: NodeJS.Platform;
    arch?: string;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    /** One plain line per step. */
    onLine?: (line: string) => void;
    timeoutMs?: number;
}

/** A plain name inside platform-tools/: no absolute paths, no "..", no drive letters, no control characters. */
function safeEntry(name: string): boolean {
    if (!name.startsWith("platform-tools/") || name.length > 300 || /[\u0000-\u001f\\:*?"<>|]/.test(name)) return false;
    return name.split("/").every((p, i, all) => (p === "" ? i === all.length - 1 : p !== "." && p !== ".."));
}

async function readCapped(res: Response, cap: number, onChunk?: (b: Uint8Array) => void): Promise<Buffer> {
    if (!res.body) return Buffer.alloc(0);
    const chunks: Uint8Array[] = [];
    let n = 0;
    const reader = res.body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.length;
        if (n > cap) {
            await reader.cancel().catch(() => undefined);
            throw new PhoneToolsError("The download was larger than expected, so it was stopped and nothing was kept.");
        }
        onChunk?.(value);
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}

/**
 * Fetches, checks and unpacks the newest stable platform-tools into `dir/platform-tools`. A failure leaves whatever was there before untouched and
 * throws PhoneToolsError with a plain sentence.
 */
export async function fetchPlatformTools(o: FetchPhoneToolsOptions): Promise<InstalledPhoneTools> {
    const platform = o.platform ?? process.platform;
    const say = o.onLine ?? (() => undefined);
    const host = phoneToolsHost(platform, o.arch ?? process.arch);
    if (!host.ok) throw new PhoneToolsError(host.reason);
    const base = repositoryBase(o.env ?? process.env);
    if (!base.ok) throw new PhoneToolsError(base.reason);
    const doFetch = o.fetchImpl ?? fetch;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), o.timeoutMs ?? PHONE_TOOLS_LIMITS.timeoutMs);
    const signal = o.signal ? AbortSignal.any([o.signal, timeout.signal]) : timeout.signal;
    const get = async (url: string, what: string): Promise<Response> => {
        let res: Response;
        try {
            // Redirects are followed (a mirror of dl.google.com); what arrives is checked against the list's size and SHA-1 either way.
            res = await doFetch(url, { signal, redirect: "follow" });
        } catch {
            if (o.signal?.aborted) throw new PhoneToolsError("The download of the phone tools was stopped.");
            if (timeout.signal.aborted) throw new PhoneToolsError("The download of the phone tools took too long and was stopped.");
            throw new PhoneToolsError(`${what} could not be reached (${new URL(url).host}). Check this computer's internet connection or proxy.`);
        }
        if (!res.ok) throw new PhoneToolsError(`${what} answered with an error (${res.status}).`);
        return res;
    };
    try {
        const listUrl = new URL(REPOSITORY_MANIFEST, base.url).href;
        say(`Looking up Google's Android phone tools (${new URL(listUrl).host})`);
        const xml = (await readCapped(await get(listUrl, "Google's list of Android tools"), PHONE_TOOLS_LIMITS.manifestBytes)).toString("utf8");
        const archive = chooseArchive(parseRepositoryManifest(xml, listUrl), host.hostOs);
        if (!archive) throw new PhoneToolsError("Google's list of Android tools has no phone tools for this system, so nothing was downloaded.");

        say(`Downloading the Android phone tools ${archive.version} (${(archive.size / 1048576).toFixed(1)} MB)`);
        const sha1 = createHash("sha1");
        const zip = await readCapped(await get(archive.url, "Google's download server"), archive.size, (b) => sha1.update(b));
        if (zip.length !== archive.size) throw new PhoneToolsError(`The downloaded phone tools are ${zip.length} bytes, but Google lists ${archive.size}. Nothing was kept.`);
        if (sha1.digest("hex") !== archive.sha1) throw new PhoneToolsError("The downloaded phone tools do not match Google's checksum (SHA-1). Nothing was kept.");
        say("Checked the download against Google's size and checksum");

        let total = 0;
        let count = 0;
        let refused = 0;
        let files: Record<string, Uint8Array>;
        try {
            files = unzipSync(zip, {
                filter: (f) => {
                    if (f.name.endsWith("/")) return false;
                    if (!safeEntry(f.name)) {
                        refused++;
                        return false;
                    }
                    count++;
                    total += f.originalSize;
                    if (count > PHONE_TOOLS_LIMITS.entries || total > PHONE_TOOLS_LIMITS.unpackedBytes) throw new PhoneToolsError("The phone tools archive is larger than expected when unpacked. Nothing was kept.");
                    return true;
                },
            });
        } catch (e) {
            if (e instanceof PhoneToolsError) throw e;
            throw new PhoneToolsError("The phone tools archive could not be unpacked. Nothing was kept.");
        }
        if (refused > 0) throw new PhoneToolsError("The phone tools archive holds files outside its own folder, so it was not used.");
        const adbName = `platform-tools/${exe("adb", platform)}`;
        if (!files[adbName]) throw new PhoneToolsError("The phone tools archive has no adb for this system. Nothing was kept.");

        // Unpack beside the current copy, then swap: a half-written folder never replaces a working one.
        fs.mkdirSync(o.dir, { recursive: true });
        const stage = path.join(o.dir, `platform-tools.new-${process.pid}`);
        fs.rmSync(stage, { recursive: true, force: true });
        try {
            for (const [name, data] of Object.entries(files)) {
                const dest = path.join(stage, name.slice("platform-tools/".length));
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.writeFileSync(dest, data);
                // The archive's own Unix modes are not read here: every program (a name without an extension) is made runnable on a Mac or Linux.
                if (platform !== "win32" && !path.basename(dest).includes(".")) fs.chmodSync(dest, 0o755);
            }
            fs.writeFileSync(path.join(stage, PHONE_TOOLS_MARKER), JSON.stringify({ version: archive.version, hostOs: archive.hostOs, url: archive.url, size: archive.size, sha1: archive.sha1, fetchedAt: new Date().toISOString() }, null, 2));
        } catch {
            fs.rmSync(stage, { recursive: true, force: true });
            throw new PhoneToolsError("The phone tools could not be written into the runner's folder (is the disk full?). Nothing was kept.");
        }
        const final = path.join(o.dir, "platform-tools");
        const old = path.join(o.dir, `platform-tools.old-${process.pid}`);
        if (fs.existsSync(final)) fs.renameSync(final, old);
        fs.renameSync(stage, final);
        fs.rmSync(old, { recursive: true, force: true });
        const got = installedPhoneTools(o.dir, platform);
        if (!got) throw new PhoneToolsError("The phone tools were unpacked but adb is missing. Nothing usable was kept.");
        say(`The Android phone tools ${got.version} are ready (in the runner's own folder)`);
        return got;
    } finally {
        clearTimeout(timer);
    }
}
