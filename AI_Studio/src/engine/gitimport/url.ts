/**
 * Which repository addresses the Git import accepts, and the small pieces of input (branch/tag/commit, subfolder) that end up
 * on a command line. Everything here is a pure function so the policy is a table in a test.
 */

export class GitInputError extends Error {}

export interface RepoAddress {
    /** The address git is given: https only, never with credentials. */
    cloneUrl: string;
    /** `host` or `host:port`, for display and the address guard. */
    host: string;
    /** `owner/repo` without a trailing `.git`. */
    path: string;
    /** "https" for real addresses, "local" only for the test seam. */
    transport: "https" | "local";
}

export const MAX_URL_LENGTH = 500;

/** Parse a repository address. `allowLocal` is the test seam (local paths, file:// and http://); the HTTP API never sets it. */
export function parseRepoUrl(raw: string, opts: { allowLocal?: boolean } = {}): RepoAddress {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) throw new GitInputError("Enter the address of the repository, for example https://github.com/your-team/tests.");
    if (text.length > MAX_URL_LENGTH) throw new GitInputError("That address is too long.");
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f\s]/.test(text)) throw new GitInputError("The address must not contain spaces or control characters.");
    if (text.startsWith("-")) throw new GitInputError("That does not look like a repository address.");

    if (opts.allowLocal && (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith("/") || /^file:\/\//i.test(text) || /^http:\/\//i.test(text))) {
        const localPath = text.replace(/^file:\/\/\/?/i, "").replace(/\\/g, "/");
        const name = localPath.replace(/\/+$/, "").split("/").pop()?.replace(/\.git$/, "") || "repository";
        if (/^http:\/\//i.test(text)) {
            const u = new URL(text);
            return { cloneUrl: text, host: u.host, path: u.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "") || name, transport: "local" };
        }
        return { cloneUrl: text, host: "local", path: name, transport: "local" };
    }

    // `git@host:owner/repo` (scp style) is ssh in disguise.
    if (/^[\w.-]+@[\w.-]+:/.test(text) && !text.includes("://")) throw new GitInputError("SSH addresses are not supported. Use the https:// address of the repository.");
    let u: URL;
    try {
        u = new URL(text);
    } catch {
        throw new GitInputError("That does not look like a repository address. Use the https:// address, for example https://github.com/your-team/tests.");
    }
    switch (u.protocol) {
        case "https:":
            break;
        case "http:":
            throw new GitInputError("Only https:// addresses are supported. Use the https:// address of the repository.");
        case "ssh:":
        case "git+ssh:":
            throw new GitInputError("SSH addresses are not supported. Use the https:// address of the repository.");
        case "git:":
            throw new GitInputError("git:// addresses are not supported. Use the https:// address of the repository.");
        case "file:":
            throw new GitInputError("Local files cannot be imported. Use the https:// address of the repository.");
        default:
            throw new GitInputError("Only https:// addresses are supported.");
    }
    if (u.username || u.password) throw new GitInputError("Leave the user name and password out of the address. Put an access token in the token field instead.");
    if (!u.hostname) throw new GitInputError("The address has no host name.");
    if (u.search || u.hash) throw new GitInputError("The address must not have a query or a fragment.");
    const repoPath = u.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
    if (!repoPath) throw new GitInputError("The address must name a repository, for example https://github.com/your-team/tests.");
    if (repoPath.split("/").some((seg) => seg === ".." || seg === "." || seg === "")) throw new GitInputError("The repository path in the address is not valid.");
    const host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
    return { cloneUrl: `https://${host}/${repoPath}${u.pathname.replace(/\/+$/, "").endsWith(".git") ? ".git" : ""}`, host, path: repoPath, transport: "https" };
}

/** A branch or tag name safe to put after `--branch`; or a full 40-character commit id. */
export function parseRef(raw: string | undefined): { ref: string; isCommit: boolean } {
    const ref = (raw ?? "").trim();
    if (!ref) return { ref: "", isCommit: false };
    if (ref.length > 200) throw new GitInputError("The branch, tag or commit name is too long.");
    if (/^[0-9a-f]{40}$/i.test(ref)) return { ref: ref.toLowerCase(), isCommit: true };
    const ok = /^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/.test(ref) && !ref.includes("..") && !ref.includes("//") && !ref.endsWith("/") && !ref.endsWith(".lock") && !ref.includes("@{");
    if (!ok) throw new GitInputError("That branch, tag or commit name is not valid.");
    return { ref, isCommit: false };
}

/** The subfolder to import from: relative, forward slashes, no `..`. Empty string means the repository root. */
export function normalizeSubpath(raw: string | undefined): string {
    const text = (raw ?? "").trim().replace(/\\/g, "/");
    if (!text || text === "." || text === "/") return "";
    if (text.length > 300) throw new GitInputError("The folder path is too long.");
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(text)) throw new GitInputError("The folder path contains invalid characters.");
    if (text.startsWith("/") || /^[A-Za-z]:/.test(text)) throw new GitInputError("Give the folder as a path inside the repository, for example tests/e2e.");
    const parts = text.split("/").filter((p) => p !== "" && p !== ".");
    if (parts.some((p) => p === "..")) throw new GitInputError("The folder path must stay inside the repository.");
    if (parts.some((p) => p === ".git")) throw new GitInputError("That folder cannot be imported.");
    return parts.join("/");
}
