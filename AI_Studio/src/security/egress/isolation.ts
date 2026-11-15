/**
 * OS-level egress isolation for scanner runs above passive: the request guard (guard.ts) only helps if a scanner cannot simply go
 * round it. Before a profile above passive may run a scanner, the platform PROVES, from the very context the scanner would run in,
 * that a direct connection to the target fails and a request through the guard arrives.
 *
 * The mechanism (Linux, no root): the scanner is started inside a new user, network and mount namespace (`unshare -rn -m`). That
 * namespace has only its own loopback interface, so nothing in it can reach any other address. The guard does not listen on this
 * machine's network at all for such a run: it listens on a Unix socket in an owner-only per-run directory, and a small relay inside
 * the namespace listens on 127.0.0.1:<port> there and passes each connection to that socket. The scanner is given
 * http://127.0.0.1:<port> as its proxy, exactly as before; the only way out of the namespace is the guard.
 *
 * A network namespace does not isolate Unix sockets that live in files, so the relay also hides /run (and /var/run), /tmp, /var/tmp
 * and /dev/shm behind empty private tmpfs mounts before the scanner starts: this machine's own sockets (the name resolver, docker,
 * D-Bus, avahi), its temporary files and every other run's guard socket are then out of reach. Only the folders this run needs are
 * bound back in at their own paths: the run's own guard directory, the scanner's folder, Node's folder, the working directory and
 * folders named on the command line; never a folder that holds other runs' guard directories, and never anything under /run.
 *
 * The masking is made by the relay, which needs its capabilities in the namespace to mount. The scanner must not keep them, or it could
 * simply unmount the masking again: the relay starts it through `setpriv` with the capability bounding and inheritable sets emptied and
 * no_new_privs set, so the tool (still uid 0 inside the namespace, but with no capability at all) cannot mount or unmount anything. The
 * environment check tries exactly that (`umount -l` on each masked folder) and refuses when it works.
 *
 * Needs on the machine that runs the scanners: Linux, `unshare`, `mount`, `umount` and `setpriv` (util-linux) and `ip` (iproute2), and unprivileged user
 * namespaces allowed (kernel.unprivileged_userns_clone, and an AppArmor policy that lets `unshare` create them). If any is missing the
 * check fails and every scan above passive is refused with a sentence naming what is missing. Passive keeps the proxy and the
 * zero-traffic check.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net, { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { runProcess } from "../scanners/process.js";
import { systemResolver, type Resolver } from "../scope.js";
import { egressEnv, startEgressGuard, type EgressGuard, type EgressOptions } from "./guard.js";

/** How a command is started inside the isolated network: the relay's Unix socket and its port in there are fixed per run. */
export type IsolationWrap = (file: string, args: readonly string[], relay: { socketPath: string; port: number }) => { file: string; args: string[] };

export type IsolationSupport = { ok: true; mechanism: string; wrap: IsolationWrap; /** The umount command the environment check tries. */ umount?: string } | { ok: false; missing: string };

/** The folders hidden from a scanner, and the ones of those a run's own folders may be bound back into (never /run). */
export const MASKED_PATHS = ["/run", "/tmp", "/var/tmp", "/dev/shm"] as const;
const KEEPABLE: readonly string[] = ["/tmp", "/var/tmp", "/dev/shm"];

/**
 * The relay, run with `node -e` inside the namespace: brings the namespace's loopback up, hides this machine's /run, /var/run, /tmp,
 * /var/tmp and /dev/shm behind empty private tmpfs mounts (binding back only this run's own folders), listens on 127.0.0.1:<port>,
 * passes every connection to the guard's Unix socket, then starts the scanner and exits with its exit code.
 * The scanner is started without any capability (setpriv), so it cannot undo the masking.
 * argv: ip, mount, setpriv, socket, port, file, args...
 */
const RELAY = `
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const [ip, mount, setpriv, sock, port, file, ...args] = process.argv.slice(1);
const fail = (m) => { process.stderr.write("isolation: " + m + "\\n"); process.exit(125); };
try { execFileSync(ip, ["link", "set", "lo", "up"], { stdio: "ignore" }); } catch (e) { fail("the loopback interface could not be brought up"); }
const run = (what, argv) => { try { execFileSync(mount, ["-n", ...argv], { stdio: ["ignore", "ignore", "pipe"] }); } catch (e) { fail(what + " (" + String(e.stderr || e.message).split("\\n")[0].slice(0, 160) + ")"); } };
const real = (p) => { try { return fs.realpathSync(p); } catch { return undefined; } };
const inside = (p, root) => p !== root && p.startsWith(root + "/");
const MASKED = ${JSON.stringify(MASKED_PATHS)}, KEEPABLE = ${JSON.stringify(KEEPABLE)};
const roots = [];
for (const r of [...MASKED, "/var/run"]) {
  let st; try { st = fs.lstatSync(r); } catch { continue; }
  if (st.isSymbolicLink()) { if (!MASKED.includes(real(r))) fail("this machine's " + r + " is a link to a folder that cannot be hidden"); continue; }
  if (st.isDirectory()) roots.push(r);
}
const sockDir = real(path.dirname(sock));
if (!sockDir) fail("the request guard's folder is missing");
if (inside(sockDir, "/run")) fail("the request guard's folder is under /run, which is hidden from the scanners");
// Folders this run needs, bound back in at their own paths. Never one that holds the guard folders of other runs.
const dirOf = (p) => { const r = real(p); if (r) return fs.statSync(r).isDirectory() ? r : path.dirname(r); return real(path.dirname(p)); };
const cwd = process.cwd();
const parent = path.dirname(sockDir);
const keeps = [...new Set([sockDir, dirOf(file), dirOf(process.execPath), real(cwd), ...args.filter((a) => a.startsWith("/")).map(dirOf)])]
  .filter((k) => k && KEEPABLE.some((r) => inside(k, r)) && k !== parent && !inside(parent, k))
  .sort((a, b) => a.length - b.length)
  .filter((k, i, all) => !all.slice(0, i).some((o) => o === k || inside(k, o)));
const hold = fs.mkdtempSync(path.join(sockDir, ".mask-"));
const stages = roots.map((r, i) => {
  const stage = path.join(hold, String(i));
  fs.mkdirSync(stage);
  run("this machine's " + r + " could not be hidden from the scanners", ["-t", "tmpfs", "-o", (r === "/run" || r === "/var/run" ? "mode=0755" : "mode=1777") + ",nosuid,nodev", "tmpfs", stage]);
  for (const k of keeps.filter((k) => inside(k, r))) {
    const to = path.join(stage, path.relative(r, k));
    fs.mkdirSync(to, { recursive: true });
    run("the run's folder " + k + " could not be kept", ["--bind", k, to]);
  }
  return { r, stage };
});
// The root that holds the staging folder moves last, so the others are still reachable when they move.
stages.sort((a, b) => Number(inside(hold, a.r)) - Number(inside(hold, b.r)));
for (const { r, stage } of stages) run("this machine's " + r + " could not be hidden from the scanners", ["--move", stage, r]);
try { fs.rmSync(hold, { recursive: true, force: true }); } catch {}
// The working directory is looked up again, so the scanner never keeps a handle on a hidden folder.
try { process.chdir(cwd); } catch { process.chdir("/"); }
const server = net.createServer((c) => {
  const u = net.connect(sock);
  const end = () => { c.destroy(); u.destroy(); };
  c.on("error", end); u.on("error", end); c.on("close", end); u.on("close", end);
  c.pipe(u).pipe(c);
});
server.on("error", (e) => fail("the relay could not listen: " + e.code));
server.listen(Number(port), "127.0.0.1", () => {
  // No capability survives into the scanner: an empty bounding and inheritable set, and no way to gain any back (no_new_privs).
  const child = spawn(setpriv, ["--bounding-set", "-all", "--inh-caps", "-all", "--no-new-privs", "--", file, ...args], { stdio: "inherit" });
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => child.kill(s));
  child.on("error", (e) => { process.stderr.write("isolation: " + e.code + "\\n"); process.exit(127); });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
});
`;

const SYSTEM_DIRS = ["/usr/sbin", "/sbin", "/usr/bin", "/bin"];

/** The executable `name` on PATH or in the usual system folders, or undefined. */
function findTool(name: string, searchPath: string): string | undefined {
    for (const dir of [...searchPath.split(path.delimiter).filter(Boolean), ...SYSTEM_DIRS]) {
        const file = path.join(dir, name);
        try {
            fs.accessSync(file, fs.constants.X_OK);
            if (fs.statSync(file).isFile()) return file;
        } catch {
            /* not here */
        }
    }
    return undefined;
}

/**
 * What this machine offers. Never installs anything and never needs root: it looks for `unshare`, `mount` and `ip`, tries to create a
 * user and network namespace and bring its loopback up, then runs the environment check (`checkEnvironment`) inside a real isolated
 * environment. `searchPath` and `platform` are for tests.
 */
export function detectIsolation(options: { searchPath?: string; platform?: NodeJS.Platform } = {}): IsolationSupport {
    const tools = isolationTools(options);
    if (!tools.ok) return tools;
    return judgeNamespace(spawnSync(tools.unshare, ["-rn", "--", tools.ip, "link", "set", "lo", "up"], { timeout: 10_000, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] })) ?? withEnvironment(tools.support, checkEnvironment(tools.support));
}

/**
 * detectIsolation without blocking the event loop (both checks run as child processes the loop waits on). Run once at startup
 * (`warmIsolation`), so neither a request nor the assessment loop's first claim waits on up to 50 seconds of synchronous checks.
 */
export async function detectIsolationAsync(options: { searchPath?: string; platform?: NodeJS.Platform } = {}): Promise<IsolationSupport> {
    const tools = isolationTools(options);
    if (!tools.ok) return tools;
    return judgeNamespace(await spawnAsync(tools.unshare, ["-rn", "--", tools.ip, "link", "set", "lo", "up"], 10_000)) ?? withEnvironment(tools.support, await checkEnvironmentAsync(tools.support));
}

type Spawned = { status: number | null; stdout: string; stderr: string; error?: Error };
/** spawnSync's answer, without blocking: stdin closed, output collected, killed at the time limit. */
function spawnAsync(file: string, args: readonly string[], timeoutMs: number): Promise<Spawned> {
    return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
        } catch (e) {
            return resolve({ status: null, stdout, stderr, error: e as Error });
        }
        const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
        child.stdout!.on("data", (d) => (stdout += d));
        child.stderr!.on("data", (d) => (stderr += d));
        child.on("error", (error) => {
            clearTimeout(timer);
            resolve({ status: null, stdout, stderr, error });
        });
        child.on("close", (status) => {
            clearTimeout(timer);
            resolve({ status, stdout, stderr });
        });
    });
}

function judgeNamespace(tried: { error?: Error; status: number | null; stderr?: string | null }): IsolationSupport | undefined {
    if (!tried.error && tried.status === 0) return undefined;
    const why = (tried.error?.message ?? tried.stderr ?? "").split("\n")[0]!.trim().slice(0, 160);
    return { ok: false, missing: `permission for this user to create a network namespace (unshare -rn failed${why ? `: ${why}` : ""}; unprivileged user namespaces are switched off or blocked by AppArmor)` };
}

const withEnvironment = (support: IsolationSupport, problem: string | undefined): IsolationSupport => (problem ? { ok: false, missing: `a private environment for the scanners (${problem})` } : support);

/** The commands the isolation needs, and the support they would give (not yet checked). */
function isolationTools(options: { searchPath?: string; platform?: NodeJS.Platform }): { ok: false; missing: string } | { ok: true; unshare: string; ip: string; support: Extract<IsolationSupport, { ok: true }> } {
    const platform = options.platform ?? process.platform;
    if (platform !== "linux")
        return { ok: false, missing: `network namespaces, which this ${platform} machine does not have (the isolation needs Linux)` };
    const searchPath = options.searchPath ?? process.env.PATH ?? "";
    const unshare = findTool("unshare", searchPath);
    const mount = findTool("mount", searchPath);
    const ip = findTool("ip", searchPath);
    const setpriv = findTool("setpriv", searchPath);
    const umount = findTool("umount", searchPath);
    const absent = [
        !unshare && "the unshare command (util-linux)",
        !mount && "the mount command (util-linux)",
        !umount && "the umount command (util-linux)",
        !setpriv && "the setpriv command (util-linux)",
        !ip && "the ip command (iproute2)",
    ].filter(Boolean);
    if (absent.length) return { ok: false, missing: absent.join(" and ") };
    const support: Extract<IsolationSupport, { ok: true }> = {
        ok: true,
        mechanism:
            "a user, network and mount namespace (unshare -rn -m) whose only way out is the request guard's Unix socket, with this machine's /run, /tmp, /var/tmp and /dev/shm hidden and the scanner started without any capability",
        wrap: (file, args, relay) => ({ file: unshare!, args: ["-rn", "-m", "--", process.execPath, "-e", RELAY, ip!, mount!, setpriv!, relay.socketPath, String(relay.port), file, ...args] }),
        umount: umount!,
    };
    return { ok: true, unshare: unshare!, ip: ip!, support };
}

let cached: IsolationSupport | undefined;
let warming: Promise<IsolationSupport> | undefined;
/** While the startup check runs, the answer: not yet available (fail closed, and never block on a second, synchronous check). */
export const ISOLATION_STILL_CHECKING = "a finished check of this machine's isolation (it is still running after the platform started; try again in a minute)";

/**
 * detectIsolation, worked out once per process in the background. Until it has an answer, isolation is not available (fail closed):
 * the first caller starts the background check and is told it is still running. Never the synchronous check: this is asked inside
 * requests and the assessment loop, and the check takes seconds.
 */
export function isolationSupport(): IsolationSupport {
    if (cached) return cached;
    void warmIsolation();
    return { ok: false, missing: ISOLATION_STILL_CHECKING };
}

/** Work out isolationSupport in the background (at startup, before the assessment loop starts), without blocking the event loop. */
export function warmIsolation(detect: () => Promise<IsolationSupport> = () => detectIsolationAsync()): Promise<IsolationSupport> {
    if (cached) return Promise.resolve(cached);
    warming ??= detect()
        .catch((e: unknown): IsolationSupport => ({ ok: false, missing: `a working isolation check (${(e as Error).message.split("\n")[0]!.slice(0, 120)})` }))
        .then((support) => (cached = support))
        .finally(() => (warming = undefined));
    return warming;
}

/**
 * The background check's answer once it has finished, without starting one: undefined when none was started. Awaited when the
 * platform closes, so a shutdown during the startup check lets it remove its temporary folders, and by anything that must not
 * act before the check has an answer.
 */
export function isolationReady(): Promise<IsolationSupport | undefined> {
    return warming ?? Promise.resolve(cached);
}

/** For tests: forget the worked-out answer. */
export function resetIsolationSupport(): void {
    cached = undefined;
    warming = undefined;
}

/** The plain sentence for a machine that cannot isolate a scanner, used at assessment start and before any scanner runs. */
export const isolationMissing = (missing: string) =>
    `Profiles above passive need the scanners to run in an isolated network whose only way out is the platform's request guard, and this machine cannot provide one: it is missing ${missing}. Only passive assessments can start.`;

/** Why no profile above passive may start on this machine, or undefined when isolation is available. */
export function egressIsolationProblem(support: IsolationSupport = isolationSupport()): string | undefined {
    return support.ok ? undefined : isolationMissing(support.missing);
}

/** One isolated run: the guard on a Unix socket, and how to start a command inside the network whose only way out it is. */
export interface IsolatedEgress {
    guard: EgressGuard;
    mechanism: string;
    /** The run's own owner-only directory holding the guard's socket: the only one of its kind a scanner of this run can see. */
    socketDir: string;
    /** The command to start instead of `file args`, plus the working directory the tool would have had (its own folder). */
    wrap(file: string, args: readonly string[]): { file: string; args: string[]; cwd: string };
    close(): Promise<void>;
}

const GUARD_DIR_PREFIX = "c4t-egress-";

/** Start the guard for an isolated run. `port` is the relay's port inside the namespace (any free number there; random by default). */
export async function startIsolatedEgress(support: Extract<IsolationSupport, { ok: true }>, options: Omit<EgressOptions, "socketPath">): Promise<IsolatedEgress> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), GUARD_DIR_PREFIX));
    await fsp.chmod(dir, 0o700).catch(() => undefined);
    const socketPath = path.join(dir, "guard.sock");
    const port = options.port || 20_000 + Math.floor(Math.random() * 40_000);
    let guard: EgressGuard;
    try {
        guard = await startEgressGuard({ ...options, port, socketPath });
    } catch (e) {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        throw e;
    }
    return {
        guard,
        mechanism: support.mechanism,
        socketDir: dir,
        wrap: (file, args) => ({ ...support.wrap(file, args, { socketPath, port }), cwd: path.dirname(file) }),
        close: async () => {
            await guard.close().catch(() => undefined);
            await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        },
    };
}

/**
 * The probe, run with `node -e` in the isolated context. argv: one JSON object { origin?, addresses, roots, sockets, names, resolver }.
 * Lists the hidden folders, tries to open every given Unix socket, asks the machine's resolver for a name, tries every target address
 * directly and (with an origin) sends one HEAD through the guard. Prints one JSON line.
 */
const PROBE = `
const net = require("node:net");
const http = require("node:http");
const fs = require("node:fs");
const dns = require("node:dns");
const c = JSON.parse(process.argv[1]);
const timed = (ms, s, resolve, v) => setTimeout(() => { s.destroy(); resolve(v); }, ms);
const direct = (address, port) => new Promise((resolve) => {
  const s = net.connect({ host: address, port, timeout: 3000 });
  s.on("connect", () => { s.destroy(); resolve("connected"); });
  s.on("timeout", () => { s.destroy(); resolve("timeout"); });
  s.on("error", (e) => resolve(e.code || "error"));
});
const unix = (p) => new Promise((resolve) => {
  const s = net.connect(p); const t = timed(3000, s, resolve, "timeout");
  s.on("connect", () => { clearTimeout(t); s.destroy(); resolve("connected"); });
  s.on("error", (e) => { clearTimeout(t); resolve(e.code || "error"); });
});
// systemd-resolved's own interface (varlink): it answers names even with no network, so it must not be reachable.
const resolver = (p, name) => new Promise((resolve) => {
  const s = net.connect(p); let b = ""; const t = timed(3000, s, resolve, "timeout");
  s.on("connect", () => s.write(JSON.stringify({ method: "io.systemd.Resolve.ResolveHostname", parameters: { name } }) + "\\0"));
  s.on("data", (d) => { b += d; if (b.includes("\\0")) { clearTimeout(t); s.destroy(); resolve(b.includes('"addresses"') ? "resolved" : "answered"); } });
  s.on("error", (e) => { clearTimeout(t); resolve(e.code || "error"); });
});
const lookup = (n) => new Promise((resolve) => dns.lookup(n, (e, a) => resolve(e ? (e.code || "error") : "resolved " + a)));
const viaGuard = (origin) => new Promise((resolve) => {
  const proxy = new URL(process.env.HTTP_PROXY);
  const r = http.request({ host: proxy.hostname, port: proxy.port, method: "HEAD", path: origin + "/", timeout: 10000 }, (x) => { x.resume(); resolve(x.statusCode); });
  r.on("timeout", () => { r.destroy(); resolve("timeout"); });
  r.on("error", (e) => resolve(e.code || "error"));
  r.end();
});
(async () => {
  const out = { roots: {}, sockets: {}, names: {} };
  for (const r of c.roots) { try { out.roots[r] = { dev: fs.statSync(r).dev, entries: fs.readdirSync(r) }; } catch (e) { out.roots[r] = { error: e.code || "error" }; } }
  for (const s of c.sockets) out.sockets[s] = await unix(s);
  for (const n of c.names) out.names[n] = await lookup(n);
  out.resolver = await resolver(c.resolver, "_localdnsstub");
  // Last, because it would show this machine's folders if it worked: the masking must not be removable from in here.
  if (c.umount) {
    const { spawnSync } = require("node:child_process");
    out.unmount = {};
    for (const r of c.roots) {
      if (!out.roots[r] || out.roots[r].error) continue;
      const u = spawnSync(c.umount, ["-l", r], { encoding: "utf8", timeout: 5000 });
      out.unmount[r] = { status: u.status, signal: u.signal, error: u.error ? (u.error.code || "error") : undefined, stderr: String(u.stderr || "").slice(0, 300) };
    }
  }
  if (c.origin) {
    const port = Number(new URL(c.origin).port || 80);
    out.direct = {};
    for (const a of c.addresses) out.direct[a] = await direct(a, port);
    out.viaGuard = await viaGuard(c.origin);
  }
  process.stdout.write(JSON.stringify(out) + "\\n");
})();
`;

const RESOLVER_SOCKET = "/run/systemd/resolve/io.systemd.Resolve";

/** Sockets on this machine that resolve names, relay traffic or control it: none may be reachable from a scanner. */
export function hostSockets(): string[] {
    const list = [RESOLVER_SOCKET, "/run/avahi-daemon/socket", "/var/run/nscd/socket", "/var/run/docker.sock", "/run/dbus/system_bus_socket"];
    if (process.env.XDG_RUNTIME_DIR) list.push(path.join(process.env.XDG_RUNTIME_DIR, "bus"));
    // The same resolver seen through the platform's own process: /proc must not be a way back to this machine's files.
    list.push(`/proc/${process.pid}/root${RESOLVER_SOCKET}`);
    return list;
}

type ProbeOut = {
    roots?: Record<string, { dev?: number; entries?: string[]; error?: string }>;
    sockets?: Record<string, string>;
    names?: Record<string, string>;
    resolver?: string;
    direct?: Record<string, string>;
    viaGuard?: number | string;
    /** Per masked folder: what `umount -l` did from the scanners' environment (judged by unmountOutcome). */
    unmount?: Record<string, UnmountRun>;
};

type UnmountRun = { status?: number | null; signal?: string | null; error?: string; stderr?: string };

/**
 * What one `umount -l` from the scanners' environment shows: "unmounted" when it worked, "refused" only when it was refused for lack
 * of permission (EPERM/EACCES: "must be superuser", "Operation not permitted", "Permission denied"), and "unchecked" for anything
 * else (umount missing there, a timeout, a signal, another error): that proves nothing, so the check fails closed.
 */
export function unmountOutcome(run: UnmountRun | undefined): "unmounted" | "refused" | "unchecked" {
    if (!run || run.error || run.signal || run.status == null) return "unchecked";
    if (run.status === 0) return "unmounted";
    return /must be superuser|operation not permitted|permission denied|\bEPERM\b|\bEACCES\b/i.test(run.stderr ?? "") ? "refused" : "unchecked";
}

type ProbeContext = { sockets: string[]; otherRun: string; names: string[]; keeps: string[]; umount?: string };

const realOr = (p: string) => {
    try {
        return fs.realpathSync(p);
    } catch {
        return p;
    }
};
const inside = (p: string, root: string) => p !== root && p.startsWith(root + "/");

/** What the probe is asked and what its answers are judged against. `otherRun` is the guard socket of another (decoy) run. */
function probeContext(socketDir: string, otherRun: string, extraNames: string[], umount?: string): ProbeContext {
    return { sockets: [...hostSockets(), otherRun], otherRun, names: ["_localdnsstub", ...extraNames], keeps: [realOr(socketDir), path.dirname(realOr(process.execPath))], ...(umount ? { umount } : {}) };
}

const probeInput = (ctx: ProbeContext, origin?: string, addresses: string[] = []) =>
    JSON.stringify({ origin, addresses, roots: MASKED_PATHS, sockets: ctx.sockets, names: ctx.names, resolver: RESOLVER_SOCKET, umount: ctx.umount });

/** Which environment check failed, in plain words, or undefined when /run, /tmp, /var/tmp, /dev/shm and every socket are out of reach. */
function judgeEnvironment(out: ProbeOut, ctx: ProbeContext): string | undefined {
    if (!out.roots || !out.sockets || !out.names) return "the environment check gave no answer";
    for (const root of MASKED_PATHS) {
        let hostDev: number;
        try {
            hostDev = fs.statSync(root).dev;
        } catch {
            continue; // not on this machine: nothing to hide
        }
        const seen = out.roots[root];
        if (!seen || seen.error || seen.dev === undefined) return `${root} could not be checked from the scanners' environment (${seen?.error ?? "no answer"})`;
        if (seen.dev === hostDev) return `${root} in the scanners' environment is still this machine's own ${root}`;
        // Only the first folder of each of this run's own bound-in folders may show; /run shows nothing.
        const allowed = new Set(ctx.keeps.filter((k) => KEEPABLE.includes(root) && inside(k, root)).map((k) => path.relative(root, k).split("/")[0]!));
        const extra = (seen.entries ?? []).filter((e) => !allowed.has(e));
        if (extra.length) return `${root} in the scanners' environment is not empty (it shows ${extra.slice(0, 5).join(", ")})`;
        // The scanner must not be able to take the masking away again (it runs with no capability: see RELAY).
        const undo = unmountOutcome(out.unmount?.[root]);
        if (undo === "unmounted") return `${root} could be unmounted from the scanners' environment, which shows this machine's own ${root} again`;
        if (undo !== "refused") return `whether ${root} can be unmounted from the scanners' environment could not be checked`;
    }
    const opened = ctx.sockets.filter((s) => out.sockets![s] === "connected");
    if (opened.includes(ctx.otherRun)) return "another run's request guard socket could be opened from the scanners' environment";
    if (opened.length) return `a socket of this machine (${opened.slice(0, 3).join(", ")}) could be opened from the scanners' environment`;
    if (out.resolver === "resolved" || out.resolver === "answered") return "this machine's name resolver answered a lookup from the scanners' environment";
    const resolved = ctx.names.filter((n) => String(out.names![n] ?? "").startsWith("resolved"));
    if (resolved.length) return `a name (${resolved.join(", ")}) could be looked up from the scanners' environment`;
    return undefined;
}

/** A listening Unix socket in a folder exactly like another run's guard folder: a run must not be able to open it. */
async function otherRunSocket(): Promise<{ path: string; close(): Promise<void> }> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), GUARD_DIR_PREFIX));
    await fsp.chmod(dir, 0o700).catch(() => undefined);
    const file = path.join(dir, "guard.sock");
    const server = net.createServer((c) => c.destroy());
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(file, resolve);
        });
    } catch (e) {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        throw e;
    }
    return {
        path: file,
        close: async () => {
            await new Promise((r) => server.close(r));
            await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        },
    };
}

/** Run with `node -e` by checkEnvironment: holds the decoy socket open while the wrapped probe runs. argv: socket, file, args JSON, cwd. */
const DECOY_AND_RUN = `
const net = require("node:net");
const { spawnSync } = require("node:child_process");
const [sock, file, args, cwd] = process.argv.slice(1);
const s = net.createServer((c) => c.destroy());
s.listen(sock, () => {
  const r = spawnSync(file, JSON.parse(args), { encoding: "utf8", timeout: 30000, cwd });
  process.stdout.write(JSON.stringify({ status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", error: r.error && r.error.message }) + "\\n");
  s.close();
});
`;

/**
 * The environment check alone (no target, no guard request), run synchronously inside a real isolated environment: what failed, or
 * undefined. Used by detectIsolation, so the start gate refuses on a machine where /run, /tmp, /var/tmp or /dev/shm cannot be hidden.
 */
export function checkEnvironment(support: Extract<IsolationSupport, { ok: true }>): string | undefined {
    const env = environmentCheck(support);
    try {
        return env.judge(spawnSync(process.execPath, env.args, { encoding: "utf8", timeout: 40_000 }));
    } finally {
        env.done();
    }
}

/** checkEnvironment without blocking the event loop. */
export async function checkEnvironmentAsync(support: Extract<IsolationSupport, { ok: true }>): Promise<string | undefined> {
    const env = environmentCheck(support);
    try {
        return env.judge(await spawnAsync(process.execPath, env.args, 40_000));
    } finally {
        env.done();
    }
}

/** The environment check's command (node with the decoy socket, running the wrapped probe), how to judge its answer, and the clean-up. */
function environmentCheck(support: Extract<IsolationSupport, { ok: true }>): { args: string[]; judge(ran: { stdout?: string | null; stderr?: string | null; status: number | null }): string | undefined; done(): void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), GUARD_DIR_PREFIX));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), GUARD_DIR_PREFIX));
    const ctx = probeContext(dir, path.join(other, "guard.sock"), [], support.umount ?? findTool("umount", process.env.PATH ?? ""));
    const cmd = support.wrap(process.execPath, ["-e", PROBE, probeInput(ctx)], { socketPath: path.join(dir, "guard.sock"), port: 20_000 });
    const judge = (ran: { stdout?: string | null; stderr?: string | null; status: number | null }): string | undefined => {
        const last = (text: string | undefined) => {
            try {
                return JSON.parse((text ?? "").trim().split("\n").pop() || "{}") as Record<string, unknown>;
            } catch {
                return {};
            }
        };
        const res = last(ran.stdout ?? undefined) as { status?: number; stdout?: string; stderr?: string; error?: string };
        const out = last(res.stdout) as ProbeOut;
        if (!out.roots) return `the isolated environment could not be set up: ${(String(res.stderr ?? ran.stderr ?? "").trim().split("\n")[0] ?? "").slice(0, 160) || res.error || `exit code ${res.status ?? ran.status}`}`;
        return judgeEnvironment(out, ctx);
    };
    return {
        args: ["-e", DECOY_AND_RUN, ctx.otherRun, cmd.file, JSON.stringify(cmd.args), path.dirname(process.execPath)],
        judge,
        done: () => {
            fs.rmSync(dir, { recursive: true, force: true });
            fs.rmSync(other, { recursive: true, force: true });
        },
    };
}

export type IsolationProof = { ok: true; line: string } | { ok: false; reason: string };

/**
 * Prove, from the context a scanner would run in, that the target cannot be reached directly and that the guard can, and that the
 * environment hides this machine's sockets and temporary files: /run, /tmp, /var/tmp and /dev/shm are private and empty but for the
 * run's own folders, none of this machine's resolver/docker/D-Bus/avahi sockets and no other run's guard socket can be opened, and no
 * name can be looked up through this machine's resolver. The probe resolves nothing itself: the target's addresses are looked up here
 * and every one of them is tried directly (each must fail), then one HEAD of the target's origin is sent through the guard (it must
 * arrive at the guard). Uses its own guard, so the scanners' own request counts are not touched. Any failed check refuses, naming it.
 */
export async function proveIsolation(
    support: IsolationSupport,
    options: { app: EgressOptions["app"]; origin: string; allowPrivate?: boolean; resolver?: Resolver; signal?: AbortSignal; port?: number },
): Promise<IsolationProof> {
    if (!support.ok) return { ok: false, reason: isolationMissing(support.missing) };
    const refused = (what: string): IsolationProof => ({ ok: false, reason: `The external scanners were not run: ${what} Scans above passive are refused unless the scanners' direct network access is shown to be blocked.` });
    const host = new URL(options.origin).hostname.replace(/^\[|\]$/g, "");
    let addresses: string[];
    try {
        addresses = isIP(host) ? [host] : [...new Set((await (options.resolver ?? systemResolver)(host)).map((a) => a.address))];
    } catch (e) {
        return refused(`the target's address could not be looked up for the isolation check (${(e as Error).message.split("\n")[0]!.slice(0, 120)}).`);
    }
    if (!addresses.length) return refused("the target's address could not be looked up for the isolation check.");
    // The relay's port inside the namespace must not be the target's, or the direct test would reach the relay.
    const targetPort = Number(new URL(options.origin).port || 80);
    const port = options.port && options.port !== targetPort ? options.port : targetPort === 20_000 ? 20_001 : 20_000;
    let iso: IsolatedEgress;
    try {
        iso = await startIsolatedEgress(support, { app: options.app, allowPrivate: options.allowPrivate === true, maxRequests: 1, port, ...(options.signal ? { signal: options.signal } : {}), ...(options.resolver ? { resolver: options.resolver } : {}) });
    } catch (e) {
        return refused(`the request guard for the isolation check could not be started (${(e as Error).message.split("\n")[0]!.slice(0, 120)}).`);
    }
    let other: Awaited<ReturnType<typeof otherRunSocket>> | undefined;
    try {
        other = await otherRunSocket();
        const ctx = probeContext(iso.socketDir, other.path, [], support.umount ?? findTool("umount", process.env.PATH ?? ""));
        const cmd = iso.wrap(process.execPath, ["-e", PROBE, probeInput(ctx, options.origin, addresses.slice(0, 8))]);
        const run = await runProcess({ file: cmd.file, args: cmd.args, cwd: cmd.cwd, env: egressEnv(iso.guard.url), timeoutMs: 60_000, ...(options.signal ? { signal: options.signal } : {}) });
        let out: ProbeOut = {};
        try {
            out = JSON.parse(run.stdout.trim().split("\n").pop() ?? "{}");
        } catch {
            /* judged below */
        }
        if (!out.direct) return refused(`the isolation check could not run in the isolated network (${(run.stderr.trim().split("\n")[0] ?? "").slice(0, 160) || `exit code ${run.code}`}).`);
        const reached = Object.entries(out.direct).filter(([, r]) => r === "connected").map(([a]) => a);
        if (reached.length) return refused(`a test connection from the scanners' network reached the target directly (${reached.join(", ")}), so a scanner could go round the request guard.`);
        const leak = judgeEnvironment(out, ctx);
        if (leak) return refused(`${leak}, so a scanner could reach this machine's sockets or files and go round the request guard.`);
        if (typeof out.viaGuard !== "number" || iso.guard.counts().total === 0) return refused(`a test request from the scanners' isolated network did not arrive at the request guard (${String(out.viaGuard ?? "no answer")}).`);
        return {
            ok: true,
            line: `Network isolation: the scanners ran in ${iso.mechanism}; a direct connection to the target (${addresses.join(", ")}) failed from there, /run, /tmp, /var/tmp and /dev/shm were private and empty but for the run's own folders, none of this machine's sockets nor another run's request guard could be opened, no name could be looked up through this machine's resolver, and a test request through the request guard arrived.`,
        };
    } catch (e) {
        return refused(`the isolation check could not be carried out (${(e as Error).message.split("\n")[0]!.slice(0, 120)}).`);
    } finally {
        await other?.close();
        await iso.close();
    }
}

/** The isolated run a scanner target belongs to, for the adapter that starts the tool (it must start it with `wrap`). */
const isolated = new WeakMap<object, IsolatedEgress>();
export const isolationFor = (target: object): IsolatedEgress | undefined => isolated.get(target);
export const setIsolationFor = (target: object, iso: IsolatedEgress): void => void isolated.set(target, iso);
