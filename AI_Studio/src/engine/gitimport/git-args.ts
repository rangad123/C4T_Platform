/**
 * The exact command lines and environment the import gives the system `git`, built as plain data so a test can read them.
 * Rules: argument arrays only (never a shell string), nothing from the repository is executed (no hooks, no checkout, no
 * submodules, no LFS), and the access token travels in the environment, never in an argument.
 */
import { GitInputError } from "./url.js";

export const GIT_TIMEOUT_MS = 60_000;

/** Settings placed on every git command with `-c`: none of them is secret. */
/**
 * `hasToken`: with an access token no redirect is followed at all. The token is limited to the repository's origin by git's own URL matching, but a redirect is
 * decided by the server we are about to hand a credential to, and it is resolved again by the network stack (DNS) where the platform's address guard does not
 * look. Without a token, `initial` is kept (only the first request may redirect, which is how many hosts present a repository), and that gap is documented.
 */
export function safetyConfig(opts: { hooksDir: string; allowLocal: boolean; hasToken?: boolean }): string[] {
    const cfg = [
        "core.symlinks=false",
        // An empty folder of our own: even a hook that arrived with the clone has nowhere to be found.
        `core.hooksPath=${opts.hooksDir}`,
        "core.fsmonitor=false",
        "core.autocrlf=false",
        "credential.helper=",
        `http.followRedirects=${opts.hasToken ? "false" : "initial"}`,
        "submodule.recurse=false",
        "fetch.recurseSubmodules=false",
        "transfer.fsckObjects=false",
        "advice.detachedHead=false",
        `protocol.file.allow=${opts.allowLocal ? "always" : "never"}`,
        "protocol.ext.allow=never",
        "protocol.git.allow=never",
        "protocol.ssh.allow=never",
    ];
    if (!opts.allowLocal) cfg.push("protocol.http.allow=never");
    return cfg.flatMap((c) => ["-c", c]);
}

/** `git clone` of the tip of a branch or tag (or the default branch), history cut to one commit, nothing checked out. */
export function cloneArgs(cfg: string[], o: { url: string; dir: string; ref: string; allowLocal: boolean }): string[] {
    const a = [...cfg, "clone", "--depth", "1", "--single-branch", "--no-tags", "--no-checkout", "--no-recurse-submodules"];
    if (o.ref) a.push("--branch", o.ref);
    // A local path is cloned by copying unless it is addressed as a file:// URL, which honours --depth like a remote.
    a.push("--", o.url, o.dir);
    return a;
}

export const initArgs = (cfg: string[], dir: string): string[] => [...cfg, "init", "--quiet", "--", dir];
export const fetchCommitArgs = (cfg: string[], url: string, sha: string): string[] => [...cfg, "fetch", "--depth", "1", "--no-tags", "--no-recurse-submodules", "--", url, sha];
export const lsRemoteArgs = (cfg: string[], url: string, ref: string): string[] => [...cfg, "ls-remote", "--", url, ...(ref ? [ref, `${ref}^{}`] : ["HEAD"])];
export const listTreeArgs = (cfg: string[]): string[] => [...cfg, "ls-tree", "-r", "-l", "-z", "--full-tree", "HEAD"];
export const headArgs = (cfg: string[]): string[] => [...cfg, "rev-parse", "HEAD"];
export const catFileBatchArgs = (cfg: string[]): string[] => [...cfg, "cat-file", "--batch"];

/** A token goes into one HTTP header; reject anything that could add a second header or break the line. */
export function validateToken(token: string | undefined): string | undefined {
    if (token === undefined || token === "") return undefined;
    // eslint-disable-next-line no-control-regex
    if (token.length > 500 || /[\u0000-\u001f\u007f\s]/.test(token)) throw new GitInputError("The access token has characters that cannot be sent. Copy it again without spaces or line breaks.");
    return token;
}

/**
 * The environment for one git process. Only what git needs is passed on (the platform's own settings, such as its secret key, are
 * not), the user's and the system's git settings are switched off, and the token (if any) is an HTTP header limited to the
 * repository's own origin, so a redirect elsewhere never receives it.
 */
export function gitEnv(o: { base: NodeJS.ProcessEnv; scratch: string; emptyConfig: string; origin?: string; token?: string; allowLocal: boolean }): Record<string, string> {
    const env: Record<string, string> = {};
    for (const k of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "TEMP", "TMP", "TMPDIR", "LANG"]) {
        const v = o.base[k];
        if (v !== undefined) env[k] = v;
    }
    Object.assign(env, {
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
        GIT_ASKPASS: "",
        SSH_ASKPASS: "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: o.emptyConfig,
        HOME: o.scratch,
        USERPROFILE: o.scratch,
        XDG_CONFIG_HOME: o.scratch,
        GIT_LFS_SKIP_SMUDGE: "1",
        GIT_ALLOW_PROTOCOL: o.allowLocal ? "https:http:file" : "https",
        GIT_OPTIONAL_LOCKS: "0",
        LC_ALL: "C",
    });
    if (o.token && o.origin) {
        env.GIT_CONFIG_COUNT = "1";
        env.GIT_CONFIG_KEY_0 = `http.${o.origin}/.extraHeader`;
        env.GIT_CONFIG_VALUE_0 = `Authorization: Bearer ${o.token}`;
    }
    return env;
}

/** Remove every secret (and its common encodings) from text that may be shown or stored. */
export function scrub(text: string, secrets: ReadonlyArray<string | undefined>): string {
    let out = text;
    for (const s of secrets) {
        if (!s) continue;
        const variants = new Set([s, encodeURIComponent(s), Buffer.from(s).toString("base64"), Buffer.from(`x-access-token:${s}`).toString("base64"), Buffer.from(`oauth2:${s}`).toString("base64")]);
        for (const v of variants) if (v) out = out.split(v).join("***");
    }
    // Any other credentials that ended up in an address.
    return out.replace(/(https?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, "$1***@").replace(/(Authorization:\s*(?:Bearer|Basic|token)\s+)\S+/gi, "$1***");
}

/** Turn what git printed into a sentence a person can act on. The raw text is kept out of the answer (it may name server paths). */
export function friendlyGitError(stderr: string, ctx: { timedOut?: boolean; tooLarge?: boolean; hasToken?: boolean }): string {
    if (ctx.timedOut) return "The repository took too long to download (over a minute). Try a smaller repository, or a branch with less history.";
    if (ctx.tooLarge) return "That repository is too large to import (the limit is 50 MB). Point to a smaller repository.";
    const s = stderr.toLowerCase();
    // A redirect is refused while an access token is in use (see safetyConfig); say what to do rather than the transport detail.
    if (ctx.hasToken && /redirect|returned error: 30[1-8]/.test(s)) return "The repository address redirects somewhere else, and redirects are not followed when an access token is used. Use the final address of the repository (open it in a browser to see where it ends up).";
    if (/authentication failed|could not read username|could not read password|invalid username or password|http (401|403)|returned error: (401|403)|403 forbidden|401 unauthorized|terminal prompts disabled/.test(s))
        return ctx.hasToken ? "The repository refused the access token. Check that the token is valid and allowed to read this repository." : "The repository needs a sign-in. Add an access token that can read it and try again.";
    if (/repository .* not found|not found|http 404|returned error: 404|does not appear to be a git repository|404/.test(s) && !/remote branch/.test(s)) return "No repository was found at that address. Check the spelling, and add an access token if it is private.";
    if (/remote branch .* not found|couldn't find remote ref|not our ref|reference is not a tree|unknown revision|invalid reference/.test(s)) return "That branch, tag or commit does not exist in the repository.";
    if (/could not resolve host|name or service not known|unable to access|failed to connect|connection (refused|timed out|reset)|ssl|certificate|network is unreachable|timed out/.test(s)) return "The repository could not be reached. Check the address and that the platform computer can reach it.";
    if (/no space left/.test(s)) return "There is not enough free disk space on the platform computer to download the repository.";
    if (/allow-reachable-sha1|allowanysha1|filtering not recognized|unadvertised object|not allowed|server does not allow/.test(s)) return "The server does not allow fetching a single commit. Use a branch or tag name instead.";
    if (/protocol .* not allowed|transport .* not allowed/.test(s)) return "That kind of address is not allowed. Use the https:// address of the repository.";
    return "The repository could not be downloaded. Check the address, the branch name and the access token.";
}
