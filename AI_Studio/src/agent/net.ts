/**
 * The runner on a company network: which proxy it uses, which certificates it trusts, and how it says what went wrong.
 *
 * The proxy, first match wins (a flag beats an environment variable, which beats the kit's file):
 *   1. --proxy <address> (or --proxy none: no proxy at all, whatever else is set)
 *   2. HTTPS_PROXY / HTTP_PROXY (either case; NO_PROXY for the exceptions)
 *   3. "proxy" in the kit's runner.json (index.ts passes it as AITP_KIT_PROXY)
 *   4. on Windows, the person's own proxy setting (Settings, Network, Proxy, "Use a proxy server"), read with `reg query` from
 *      HKCU\...\Internet Settings. That reads a setting, never a process. Automatic proxy scripts (PAC) are not supported.
 * It applies to every connection the runner itself makes (the platform, file downloads) and is written into the environment, so the
 * programs the runner starts (npm, Playwright's browser download, its own helpers) use it too. The browser and the API calls of the
 * tests go directly to the application unless --proxy-tests is set (then the run's Playwright config gets the proxy; see
 * src/engine/net/test-proxy.ts). This computer's own addresses (localhost, 127.0.0.1, ::1) are always reached directly.
 *
 * Certificates: Node's own list, plus the computer's certificate store (unless AITP_SYSTEM_CA=0), plus --ca-file; NODE_EXTRA_CA_CERTS
 * keeps working. Child processes get the same trust through NODE_USE_SYSTEM_CA and NODE_EXTRA_CA_CERTS.
 *
 * A proxy password is a secret: it is registered with the log (masked in every line, heartbeat and result), never printed, and
 * never sent to the platform (the runner reports the proxy as host:port only).
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Capabilities } from "../agent-protocol/schema.js";
import {
    applyGlobalProxy,
    applyTrust,
    bypassEntries,
    bypassMatches,
    exportProxyEnv,
    parseProxyAddress,
    proxyEnvOf,
    proxySecrets,
    readCertificateFile,
    redactCredentials,
    withLoopbackBypass,
    type ProxyAddress,
    type ProxyEnv,
} from "../engine/net/company-network.js";

export type ProxySource = "flag" | "env" | "file" | "windows";

export interface NetworkSettings {
    proxy?: { https?: ProxyAddress; http?: ProxyAddress; source: ProxySource };
    /** --proxy none: connect directly, ignore the variables, the file and the Windows setting. */
    proxyNone?: boolean;
    /** The exceptions as given (NO_PROXY form, commas), before this computer's own addresses are added. */
    bypass?: string;
    proxyTests: boolean;
    caFile?: { path: string; pems: string[] };
    /** Trust the computer's certificate store (default; AITP_SYSTEM_CA=0 turns it off). */
    systemCa: boolean;
    /** Plain sentences to print once at start (a Windows setting that could not be used, for example). */
    notes: string[];
}

export interface NetworkValues {
    proxy?: string;
    "proxy-bypass"?: string;
    "proxy-tests"?: boolean;
    "ca-file"?: string;
}

const truthy = (v: string | undefined): boolean => v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());
const falsy = (v: string | undefined): boolean => v !== undefined && /^(0|false|no|off)$/i.test(v.trim());

/** The proxy and certificate settings from the command line and the environment (the Windows setting is added later, by `addWindowsProxy`). */
export function resolveNetwork(values: NetworkValues, env: NodeJS.ProcessEnv): { ok: true; settings: NetworkSettings } | { ok: false; message: string } {
    const notes: string[] = [];
    let proxy: NetworkSettings["proxy"];
    let proxyNone = false;
    const one = (raw: string, what: string): ProxyAddress | string => {
        const p = parseProxyAddress(raw);
        return p.ok ? p.proxy : `${what}: ${p.message}`;
    };
    const flag = values.proxy?.trim();
    if (flag !== undefined && /^(none|direct|off)$/i.test(flag)) proxyNone = true;
    else if (flag !== undefined) {
        const p = one(flag, "--proxy");
        if (typeof p === "string") return { ok: false, message: p };
        proxy = { https: p, http: p, source: "flag" };
    } else {
        const pe = proxyEnvOf(env);
        if (pe.https || pe.http) {
            const https = pe.https ? one(pe.https, "HTTPS_PROXY") : undefined;
            const http = pe.http ? one(pe.http, "HTTP_PROXY") : undefined;
            if (typeof https === "string") return { ok: false, message: https };
            if (typeof http === "string") return { ok: false, message: http };
            proxy = { ...(https ? { https } : {}), ...(http ? { http } : {}), source: "env" };
        } else if (env.AITP_KIT_PROXY?.trim()) {
            const p = one(env.AITP_KIT_PROXY, '"proxy" in runner.json');
            if (typeof p === "string") return { ok: false, message: p };
            proxy = { https: p, http: p, source: "file" };
        }
    }
    const bypassRaw = values["proxy-bypass"] ?? proxyEnvOf(env).noProxy ?? env.AITP_KIT_NO_PROXY;
    const bypass = bypassRaw?.trim() ? bypassEntries(bypassRaw).join(",") : undefined;

    let caFile: NetworkSettings["caFile"];
    const caPath = (values["ca-file"] ?? env.AITP_CA_FILE)?.trim();
    if (caPath) {
        const read = readCertificateFile(caPath);
        if (!read.ok) return { ok: false, message: `${values["ca-file"] !== undefined ? "--ca-file" : 'AITP_CA_FILE (or "caFile" in runner.json)'}: ${read.message}` };
        caFile = { path: path.resolve(caPath), pems: read.pems };
    }
    const proxyTests = values["proxy-tests"] === true || truthy(env.AITP_PROXY_TESTS);
    return { ok: true, settings: { ...(proxy ? { proxy } : {}), ...(proxyNone ? { proxyNone } : {}), ...(bypass ? { bypass } : {}), proxyTests, ...(caFile ? { caFile } : {}), systemCa: !falsy(env.AITP_SYSTEM_CA), notes } };
}

/**
 * The network lines a person may add to the kit's runner.json: `proxy`, `noProxy`, `caFile` (relative to the kit folder) and
 * `proxyTests`. They fill in only what the environment leaves unset (AITP_KIT_PROXY and AITP_KIT_NO_PROXY are read after the
 * HTTPS_PROXY family, see resolveNetwork). With no runner.json, or none of these lines, nothing changes.
 */
export function kitNetworkDefaults(env: NodeJS.ProcessEnv, dir: string): { ok: true; env: NodeJS.ProcessEnv } | { ok: false; message: string } {
    const file = path.join(dir, "runner.json");
    let o: Record<string, unknown>;
    try {
        if (!fs.existsSync(file) || fs.statSync(file).size > 8 * 1024) return { ok: true, env };
        const v: unknown = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
        if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: true, env };
        o = v as Record<string, unknown>;
    } catch {
        // kit.ts already says plainly when runner.json cannot be read.
        return { ok: true, env };
    }
    const bad = (key: string) => ({ ok: false as const, message: `runner.json has a "${key}" the runner cannot use: it must be ${key === "proxyTests" ? "true or false" : "text"}. Fix the line or remove it.` });
    for (const key of ["proxy", "noProxy", "caFile"]) if (o[key] !== undefined && (typeof o[key] !== "string" || (o[key] as string).length > 4000)) return bad(key);
    if (o.proxyTests !== undefined && typeof o.proxyTests !== "boolean") return bad("proxyTests");
    const out: NodeJS.ProcessEnv = { ...env };
    const unset = (k: string) => !out[k]?.trim();
    if (typeof o.proxy === "string" && o.proxy.trim() && unset("AITP_KIT_PROXY")) out.AITP_KIT_PROXY = o.proxy.trim();
    if (typeof o.noProxy === "string" && o.noProxy.trim() && unset("AITP_KIT_NO_PROXY")) out.AITP_KIT_NO_PROXY = o.noProxy.trim();
    if (typeof o.caFile === "string" && o.caFile.trim() && unset("AITP_CA_FILE")) out.AITP_CA_FILE = path.resolve(dir, o.caFile.trim());
    if (o.proxyTests === true && unset("AITP_PROXY_TESTS")) out.AITP_PROXY_TESTS = "1";
    return { ok: true, env: out };
}

// ── the Windows proxy setting ──────────────────────────────────────────────

export const INTERNET_SETTINGS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

/** The values of one key in `reg query` output, by lower-case name (value names may contain spaces: fields are separated by 4 spaces). */
export function parseRegQuery(out: string): Map<string, string> {
    const values = new Map<string, string>();
    let inKey = false;
    for (const line of out.split(/\r?\n/)) {
        if (/^HKEY_/i.test(line)) {
            // Only the key itself, not the sub-keys `reg query` lists after it.
            inKey = !inKey && values.size === 0;
            continue;
        }
        if (!inKey) continue;
        const m = /^\s+(.+?)\s{2,}(REG_[A-Z_]+)(?:\s{2,}(.*?))?\s*$/.exec(line);
        if (m) values.set(m[1]!.trim().toLowerCase(), (m[3] ?? "").trim());
    }
    return values;
}

export interface WindowsProxy {
    https?: string;
    http?: string;
    bypass?: string;
    notes: string[];
}

/** What the Windows proxy setting means for the runner. */
export function windowsProxyFrom(values: Map<string, string>): WindowsProxy {
    const notes: string[] = [];
    const enabled = /^(0x0*1|1)$/i.test(values.get("proxyenable") ?? "");
    const pac = values.get("autoconfigurl");
    if (!enabled) {
        if (pac) notes.push("Windows is set to find the proxy with an automatic setup script (PAC). The runner cannot read those scripts, so it connects directly. If it cannot reach the platform, ask IT for the proxy address and start the runner with --proxy http://host:port.");
        return { notes };
    }
    const server = (values.get("proxyserver") ?? "").trim();
    if (!server) {
        notes.push("The Windows proxy setting is on but has no address, so the runner connects directly.");
        return { notes };
    }
    if (pac) notes.push("Windows also names an automatic proxy setup script (PAC). The runner cannot read it and uses the fixed proxy address instead.");
    let https: string | undefined;
    let http: string | undefined;
    if (server.includes("=")) {
        const parts = new Map<string, string>();
        for (const part of server.split(";")) {
            const [k, ...v] = part.split("=");
            if (k && v.length) parts.set(k.trim().toLowerCase(), v.join("=").trim());
        }
        https = parts.get("https") ?? parts.get("http");
        http = parts.get("http") ?? parts.get("https");
        if (!https && !http) {
            notes.push(parts.has("socks") ? "The Windows proxy setting names only a SOCKS proxy, which the runner does not support, so it connects directly." : "The Windows proxy setting could not be read, so the runner connects directly.");
            return { notes };
        }
    } else {
        https = server;
        http = server;
    }
    const kept: string[] = [];
    let dropped = 0;
    for (const raw of (values.get("proxyoverride") ?? "").split(";")) {
        const entry = raw.trim();
        if (!entry) continue;
        if (entry.toLowerCase() === "<local>") {
            notes.push('The Windows proxy setting says "Don\'t use the proxy server for local addresses". The runner cannot tell which names are local: add them to NO_PROXY (or --proxy-bypass) if they must be reached directly.');
            continue;
        }
        // NO_PROXY understands "*.example.com" and whole names, not a * in the middle or at the end (10.*).
        if (entry.replace(/^\*\./, "").includes("*")) dropped++;
        else kept.push(entry);
    }
    if (dropped) notes.push(`${dropped} Windows proxy exception${dropped === 1 ? "" : "s"} with a * in the middle or at the end (like 10.*) cannot be used; those addresses go through the proxy. Name them in full in NO_PROXY (or --proxy-bypass) if they must be reached directly.`);
    return { ...(https ? { https } : {}), ...(http ? { http } : {}), ...(kept.length ? { bypass: kept.join(",") } : {}), notes };
}

/** The `reg` program: Windows' own (an absolute path, never looked up on the PATH), or the stand-in a test names with AITP_REG_PATH. */
export function regProgram(env: NodeJS.ProcessEnv): { file: string; args: string[] } {
    const seam = env.AITP_REG_PATH?.trim();
    const args = ["query", INTERNET_SETTINGS_KEY];
    if (seam) return /\.(mjs|cjs|js)$/i.test(seam) ? { file: process.execPath, args: [seam, ...args] } : { file: seam, args };
    const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? "C:\\Windows";
    return { file: path.join(root, "System32", "reg.exe"), args };
}

/** Read the person's Windows proxy setting (5 s limit). No address in the answer when there is nothing to use; `notes` say why in words. */
export async function readWindowsProxy(env: NodeJS.ProcessEnv): Promise<WindowsProxy> {
    const { file, args } = regProgram(env);
    const out = await new Promise<string | undefined>((resolve) => {
        execFile(file, args, { env, timeout: 5000, windowsHide: true, maxBuffer: 256 * 1024, encoding: "utf8" }, (err, stdout) => resolve(err ? undefined : stdout));
    });
    if (out === undefined) return { notes: ["The Windows proxy setting could not be read, so the runner connects directly unless a proxy is given with --proxy or HTTPS_PROXY."] };
    return windowsProxyFrom(parseRegQuery(out));
}

/** On Windows, when nothing else names a proxy, use the person's own proxy setting. */
export async function addWindowsProxy(s: NetworkSettings, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Promise<NetworkSettings> {
    if (platform !== "win32" || s.proxy || s.proxyNone) return s;
    const w = await readWindowsProxy(env);
    const notes = [...s.notes, ...w.notes];
    if (!w.https && !w.http) return { ...s, notes };
    const https = w.https ? parseProxyAddress(w.https) : undefined;
    const http = w.http ? parseProxyAddress(w.http) : undefined;
    if ((https && !https.ok) || (http && !http.ok)) return { ...s, notes: [...notes, "The Windows proxy setting has an address the runner cannot read, so it connects directly. Give the proxy with --proxy http://host:port."] };
    return {
        ...s,
        proxy: { ...(https?.ok ? { https: https.proxy } : {}), ...(http?.ok ? { http: http.proxy } : {}), source: "windows" },
        // The Windows exceptions count only when the person set no NO_PROXY or --proxy-bypass of their own.
        ...(s.bypass === undefined && w.bypass ? { bypass: w.bypass } : {}),
        notes,
    };
}

// ── applying it ────────────────────────────────────────────────────────────

const SOURCE_WORDS: Record<ProxySource, string> = { flag: "--proxy", env: "HTTPS_PROXY / HTTP_PROXY", file: "runner.json", windows: "the Windows proxy setting" };

interface Active {
    env: ProxyEnv;
    https?: ProxyAddress;
    http?: ProxyAddress;
    source: ProxySource;
}

/** The proxy this process's own connections use (set by `applyRunnerNetwork` with `global`), for error messages. */
let active: Active | undefined;
let report: NonNullable<Capabilities["network"]> | undefined;
let lastProblem: { text: string; at: number } | undefined;
/** A problem older than this is no longer reported on the runner's row. */
const PROBLEM_MAX_AGE_MS = 60 * 60_000;

/** The proxy a connection to `url` goes through, or undefined for "directly". */
export function proxyUsedFor(url: string): { proxy: ProxyAddress; source: ProxySource } | undefined {
    if (!active) return undefined;
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return undefined;
    }
    const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    if (bypassMatches(u.hostname, port, active.env.noProxy)) return undefined;
    const p = u.protocol === "https:" ? (active.https ?? active.http) : active.http;
    return p ? { proxy: p, source: active.source } : undefined;
}

/** Remember a network problem (a plain sentence the runner already printed) for the runner's row on the platform. */
export function noteNetworkProblem(text: string, now = Date.now()): void {
    lastProblem = { text: redactCredentials(text).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 400), at: now };
}

/** What the runner tells the platform about its network (inside its capabilities). Undefined unless the network was set up by `applyRunnerNetwork`. */
export function networkCapabilities(now = Date.now()): Capabilities["network"] | undefined {
    if (!report) return undefined;
    const recent = lastProblem && now - lastProblem.at < PROBLEM_MAX_AGE_MS ? lastProblem : undefined;
    return { ...report, ...(recent ? { problem: recent.text, problemAt: new Date(recent.at).toISOString() } : {}) };
}

/** Tests: forget what an earlier setup in this process did. */
export function resetNetworkState(): void {
    active = undefined;
    report = undefined;
    lastProblem = undefined;
}

export interface NetworkSetup {
    /** Lines to print at start: `info` for what is used, `warn` for what could not be used. */
    info: string[];
    warn: string[];
    /** Values that must be masked wherever they might appear (the proxy password and the address that holds it). */
    secrets: string[];
}

/**
 * Put the settings to work. Every environment in `envs` gets the proxy variables and the certificate variables (the runner's own,
 * passed to the programs it starts, and process.env). With `global`, this process's own connections use the proxy and the
 * certificates too (the real runner; tests that only look at the environment leave the process alone).
 */
export function applyRunnerNetwork(s: NetworkSettings, opts: { envs: NodeJS.ProcessEnv[]; global: boolean; workDir: string; platformUrl?: string; platform?: NodeJS.Platform }): NetworkSetup {
    const info: string[] = [];
    const warn: string[] = [...s.notes];
    const secrets = [...new Set([...proxySecrets(s.proxy?.https), ...proxySecrets(s.proxy?.http)])];
    const envs = [...new Set(opts.envs)];

    // Proxy.
    let pe: ProxyEnv | undefined;
    if (s.proxy) {
        pe = { ...(s.proxy.https ? { https: s.proxy.https.url } : {}), ...(s.proxy.http ? { http: s.proxy.http.url } : {}), noProxy: withLoopbackBypass(s.bypass) };
        for (const env of envs) exportProxyEnv(env, pe, opts.platform);
        let used = true;
        if (opts.global) {
            const applied = applyGlobalProxy(pe);
            if (!applied.ok) {
                used = false;
                warn.push(applied.note);
            } else active = { env: pe, ...(s.proxy.https ? { https: s.proxy.https } : {}), ...(s.proxy.http ? { http: s.proxy.http } : {}), source: s.proxy.source };
        }
        const shown = s.proxy.https ?? s.proxy.http!;
        const other = s.proxy.http && s.proxy.https && s.proxy.http.url !== s.proxy.https.url ? ` (plain http through ${s.proxy.http.display})` : "";
        const direct = bypassEntries(pe.noProxy).join(", ");
        if (used) info.push(`Network: connecting through the proxy ${shown.display}${other}, from ${SOURCE_WORDS[s.proxy.source]}. Reached directly: ${direct}.`);
        if (used && opts.platformUrl && !proxyUsedFor(opts.platformUrl) && opts.global) info.push("The platform's address is in the exceptions, so the runner reaches it directly.");
        if (s.proxyTests) {
            for (const env of envs) env.AITP_PROXY_TESTS = "1";
            info.push("Tests go through the proxy too (--proxy-tests): the browser and the tests' API calls reach the application through it.");
        } else info.push("Tests reach the application directly. Start the runner with --proxy-tests to send them through the proxy as well.");
    } else {
        info.push(s.proxyNone ? "Network: no proxy (--proxy none), connecting directly." : "Network: no proxy set, connecting directly.");
        if (s.proxyTests) warn.push("--proxy-tests has no effect: no proxy is set.");
        // A runner started with --proxy none must not hand a proxy from its own environment to the programs it starts.
        if (s.proxyNone) for (const env of envs) for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) if (env[k] !== undefined) delete env[k];
    }

    // Certificates.
    const certs: Array<"system" | "file" | "extra"> = [];
    const words: string[] = ["Node.js's own"];
    if (opts.global) {
        const t = applyTrust({ system: s.systemCa, pems: s.caFile?.pems ?? [] });
        warn.push(...t.notes);
        const cannot = t.notes.some((n) => /cannot add certificates/.test(n));
        if (s.systemCa && !cannot && !t.notes.some((n) => /could not be read/.test(n))) {
            certs.push("system");
            words.push(`this computer's certificate store (${t.system} more)`);
        }
        if (s.caFile && !cannot) {
            certs.push("file");
            words.push(`${path.basename(s.caFile.path)} (${s.caFile.pems.length} certificate${s.caFile.pems.length === 1 ? "" : "s"})`);
        }
    } else {
        if (s.systemCa) certs.push("system");
        if (s.caFile) certs.push("file");
    }
    const baseExtra = envs.map((e) => e.NODE_EXTRA_CA_CERTS).find((v) => v?.trim());
    if (baseExtra) {
        certs.push("extra");
        words.push("NODE_EXTRA_CA_CERTS");
    }
    for (const env of envs) {
        if (s.systemCa) env.NODE_USE_SYSTEM_CA = "1";
        if (s.caFile) env.NODE_EXTRA_CA_CERTS = childCertificateFile(s.caFile, env.NODE_EXTRA_CA_CERTS, opts.workDir);
    }
    info.push(`Certificates trusted: ${words.join(", ")}.`);

    report = {
        ...(s.proxy ? { proxy: (s.proxy.https ?? s.proxy.http)!.host, proxySource: s.proxy.source } : {}),
        ...(s.proxy && s.proxyTests ? { proxyTests: true } : {}),
        ...(certs.length ? { certificates: [...new Set(certs)] } : {}),
    };
    return { info, warn, secrets };
}

/** Start-up of the real runner (main.ts): add the Windows setting, register the secrets with the log, apply, print what is used. */
export async function setUpRunnerNetwork(s: NetworkSettings, opts: { env: NodeJS.ProcessEnv; global: boolean; workDir: string; platformUrl: string }, log: { addSecrets(v: Iterable<string | undefined>): unknown; info(m: string): void; warn(m: string): void }): Promise<void> {
    const full = await addWindowsProxy(s, opts.env);
    log.addSecrets([...proxySecrets(full.proxy?.https), ...proxySecrets(full.proxy?.http)]);
    const done = applyRunnerNetwork(full, { envs: opts.global ? [opts.env, process.env] : [opts.env], global: opts.global, workDir: opts.workDir, platformUrl: opts.platformUrl });
    for (const l of done.info) log.info(l);
    for (const l of done.warn) log.warn(l);
}

/**
 * The file child processes find in NODE_EXTRA_CA_CERTS: the company file itself, or, when NODE_EXTRA_CA_CERTS already named another
 * file, both in one file in the work folder (Node reads only one).
 */
function childCertificateFile(ca: { path: string; pems: string[] }, existing: string | undefined, workDir: string): string {
    if (!existing?.trim() || path.resolve(existing) === ca.path) return ca.path;
    try {
        const before = fs.readFileSync(existing, "utf8");
        const dir = path.join(workDir, "network");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, "trusted-certificates.pem");
        fs.writeFileSync(file, `${before.trim()}\n${ca.pems.join("\n")}\n`);
        return file;
    } catch {
        return ca.path;
    }
}
