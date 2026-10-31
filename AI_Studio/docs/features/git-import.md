# Git import

Bring Playwright test files you already have in a Git repository into a project as **custom tests** (hand-written, see `custom-scripts.md`), keep the link to where they came from, and update them when the repository moves.

## What a person does

1. Give the repository address (`https://...`), optionally a branch, tag or full commit id, a folder inside the repository, and an access token for a private repository.
2. **Preview** shows every test file found: its title, how many `test(...)` calls it has, how big it is, and any problem that stops it being imported. It also lists files that were skipped and why. A preview stores nothing.
3. **Import** stores each clean file as one custom test (version kind `git`), records where it came from, and starts the normal validation run for the new and changed tests.
4. Later, **Check for updates** says whether the branch moved and which imported files differ; **Refresh** brings them in as new versions and creates tests for new files.
5. **Remove the link** drops the repository entry only. The tests stay as custom tests with their history; importing the same repository again picks them up instead of creating copies.

## Which files are imported

- Files named `*.spec.ts`, `*.spec.js`, `*.test.ts` or `*.test.js` under the chosen folder. `node_modules`, `.git` and other dot-folders are left out (the preview says how many files that was).
- One file is one test. The title is the first `test.describe("...")` title, else the first `test("...")` title, else the file name. Titles and paths come from the repository, so they are cut to 160 and 300 characters, stripped of control characters, and shown escaped.
- Files over 200 KB, files that are not UTF-8 text, symbolic links and submodules are skipped with a reason. More than 200 test files at once is refused with a request to choose a narrower folder.
- Each file goes through the static guard of the custom-script feature. A file with guard **errors** is shown under `problems` in the preview and is **skipped** on import with the reason; it is never stored. Warnings are stored. Imports are explained in plain words: `./helpers/<name>` is fine only if the project already has a helper of that name ("These files use a helper named X that doesn't exist yet"); any other relative import (`../lib/util`) or package import (`@app/...`) is refused, because an imported test is a single file. Helpers are not created automatically.
- Files are imported as they are. Nothing is rewritten.

## Refresh, check and idempotence

- Tests are matched by (repository link, file path). Importing again updates the matching test and adds a new version only when the text changed; unchanged files report `created: false, changed: false` and start no job.
- **A hand edit is never overwritten.** When a test's current script differs from the newest version a Git import stored, the file was edited here. **Check** lists it with `editedHere: true` (only when the repository changed it too: compared with what the last import stored, a hand edit alone is not "the repository changed"), and **refresh** skips it, leaves the script and its history untouched, and reports it in `skipped` with `editedHere: true` and the reason "Edited here since the last import, so it was left as it is." To take the repository's version, restore the Git version in the test's history or delete the test and import again. Limit: a test whose link was dropped and then imported again is matched by its file, but its edits are not detected until it is linked.
- Files that disappeared from the repository are reported by **check** (`changed` with `removed: true`) and are never deleted automatically. New files are reported in `added`.
- **Check** first asks the server for the branch head (`git ls-remote`, no download). If it equals the stored commit, nothing else happens. A commit id is immutable, so such a link is always up to date.
- The link stores the address (never with credentials), host, `owner/repo`, branch/tag/commit, the commit imported, the time, and the folder. Each test's provenance (`custom.git`: host, path, ref, commit, importedAt, plus the link id and file path) lives in the custom-test record.

## How the repository is read (safety)

The platform runs the system `git` program. It must be installed on the computer that runs the platform; otherwise the answer is a plain 422.

- `execFile`-style process start with an **argument array**, no shell. The address and ref come after `--` and are validated (ref: no leading `-`, no `..`, no spaces or control characters).
- **https only.** `ssh://`, `scp`-style, `git://`, `file://`, `http://` and addresses with a user name or password are refused with a plain message. The host goes through the same address guard as tested applications (`assertAllowedTarget`; private and loopback addresses are refused when `BLOCK_PRIVATE_TARGETS=true`). **Redirects.** With an access token git follows **no** redirect (`http.followRedirects=false`): a repository address that redirects is refused with "The repository address redirects somewhere else...", and a test with two local servers on different ports shows that the token goes to the repository's own host only and the redirect target is never contacted. Without a token git follows the redirect of the first request (`initial`), because many hosts present a repository that way; that redirect target is **not** run through the address guard. **What remains open:** the address guard looks at the host once before the download, so a hostname that resolves differently at connect time (DNS rebinding), or a redirect without a token, can reach a private address. The response is never returned, but the different plain messages for "not found", "needs a sign-in" and "could not be reached" tell a caller something about what answered (a blind probe). Where that matters, use an access token (which also closes the redirect path) and keep the platform on a network that cannot reach internal services.
- A shallow, single-branch clone (`--depth 1 --single-branch --no-tags --no-checkout`). **Nothing is checked out**: files are read straight from git's object store with `cat-file`. So no working tree exists in which a hook, a symlink, a smudge filter or a submodule could act. In addition: `core.hooksPath` points at an empty folder, `core.symlinks=false`, `submodule.recurse=false`, `protocol.file/ext/git/ssh.allow=never`, `credential.helper=` empty, `GIT_ALLOW_PROTOCOL=https`, `GIT_LFS_SKIP_SMUDGE=1`, `GIT_TERMINAL_PROMPT=0`, user and system git configuration switched off (`GIT_CONFIG_GLOBAL` is an empty file, `GIT_CONFIG_NOSYSTEM=1`, `HOME` points to the work folder). git receives only a small environment (PATH and the like), not the platform's own settings.
- A commit id is fetched by id (`git fetch --depth 1 <url> <sha>`); if the server refuses that, the message says to use a branch or tag.
- Limits: 60 seconds for any git command; a repository over 50 MB or 5000 files is refused (disk use is watched during the download and the process is ended when it grows past twice the limit). On a timeout or limit the process **started by the import** is ended by its process id (with its children, by id, on Windows); nothing is ever stopped by name.
- The work folder (under `.validation/git-import/run-<id>`, inside the platform's scratch area) is removed in every outcome, success or failure; folders older than an hour left by a crash are swept at start.
- **Nothing from the repository is executed**: no install, no hooks, no scripts, no test run during import. The tests run later, only where hand-written scripts are allowed (`ALLOW_CUSTOM_SCRIPTS=true` on the platform, or a runner agent started with `--allow-custom-scripts`). When they may not run, the import still stores the tests and the answer has `jobId: null` and a `note` naming what to switch on; the tests stay "Not validated".
- One import (preview, import, check or refresh) at a time per project (a second gets 409) and at most two at a time on the whole platform (a third gets 429, "Other Git imports are running right now"). A git process that cannot be ended is given up on after a bounded wait (on Windows the end of the process tree is waited for, up to 4 seconds, before the work folder is removed), so the per-project lock is always released.

## The access token

Optional, write-only, used for this one download and then forgotten. It is passed to git through the process **environment** as a header limited to the repository's own origin (`GIT_CONFIG_COUNT/KEY/VALUE`, `http.<origin>/.extraHeader` with `Authorization: Bearer ...`), never as an argument, so it does not appear in a process list. It is never stored, logged, put in an event or an error, or returned. Git's own error text is scrubbed (the token and its URL-encoded and base64 forms, and any `user:password@` in an address) and mapped to a plain sentence ("The repository refused the access token", "No repository was found at that address", "took too long", "too large"); raw git output is not returned. Some hosts expect a different header style (for example GitHub accepts a token as a bearer header for Git over HTTPS; others want a basic sign-in); if a host refuses the token, the message says so.

## API

As in `.scratch/briefs/CODE-API-SHAPES.md`, all behind the API key:

- `POST /api/projects/:id/git-imports` `{ url, ref?, path?, token?, dryRun? }`: 200 preview `{ commit, files: [{ path, title, bytes, tests, problems, warnings }], skipped: [{ path, reason }] }`, or 201 `{ commit, imported: [{ testId, path, created, changed }], skipped, jobId, note? }`.
- `GET /api/projects/:id/git-imports`: `[{ id, host, path, ref, commit, importedAt, tests }]`.
- `POST /api/projects/:id/git-imports/:gid/check` (optional `{ token }`): `{ upToDate, newCommit?, changed: [{ testId, path, removed?, editedHere? }], added: [path] }`.
- `POST /api/projects/:id/git-imports/:gid/refresh` (optional `{ token }`): like the import answer; a skipped file that was edited here has `editedHere: true` in `skipped`.
- `DELETE /api/projects/:id/git-imports/:gid`: 204; the tests stay.

Additions to the shared contract: `warnings` per file in the preview, `changed` per imported file, `note` on the import answer, `removed` on a changed entry and `added` in the check answer.

## Limits worth knowing

- Only the system `git` and https; no SSH keys, no submodules, no Git LFS content (LFS pointer files import as the small text files they are).
- An imported file must be self-contained apart from `@playwright/test`, `@axe-core/playwright` and `./helpers/<name>`; test suites that share code across files need that code turned into helpers first.
- The guard is an accident guard, not a security boundary; the boundary is where custom scripts may run.
