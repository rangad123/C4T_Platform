# Runner updates: the runner keeps itself up to date

## What it does for you

Before, when the platform was updated, a runner downloaded earlier kept running its old program, and anything that changed in the runner (a fix, new test tool versions) only arrived with a new download. Now a runner started from a download **updates itself**:

1. The platform runs a newer runner version (it was updated and `npm run build:runner` was run).
2. The runner learns this the next time it connects or asks for work. It **takes no new tests**, lets the ones it is running finish, and meanwhile downloads the new version over its own connection.
3. It checks **every file** against the checksum the platform announced, tries the new program once (`--version`) with this computer's Node.js and test tools, and only then switches the files. The previous version is kept for one rollback.
4. It restarts by itself: the window says "The runner updated itself. Starting the new version.", and its row under **Setup, Runners** says "Updated itself from version 9.1.0 (…) a minute ago". **Activity** has a row for it.

A failed or damaged update changes nothing: the runner keeps running tests on its version and its row says **"Could not update: <reason>. Still on version X. It tries again in 5 minutes."**

## Signed updates (built in round 39)

A runner installs an update **only when it is signed** with the platform publisher's key, and checks that before it downloads or runs anything.

- **The key pair.** The private key lives only in the deploy workflow's secret `RUNNER_UPDATE_SIGNING_KEY`. The public key is built into the runner program (`src/agent/update-keys.ts`), so a runner never takes a key from the platform it updates from. To make the pair, run once on your own computer: `node scripts/sign-runner-update.mjs --new-key runner-update-signing-key.pem`. It writes the private key to that file (mode 0600, never over an existing file) and prints the line to paste into `PINNED_UPDATE_KEYS`. Store the file as the secret (`gh secret set RUNNER_UPDATE_SIGNING_KEY < runner-update-signing-key.pem`), then delete it. Until a key is pasted there, runners install no update by themselves.
- **What is signed.** `scripts/sign-runner-update.mjs` (Node's own modules only) hashes every file again and writes `update-manifest.json` next to the bundle: the version, a **sequence number** (the signing time in seconds), the signing time, every bundle file (`runner.mjs`, `task-child.mjs`, `record-child.mjs`, `package.json`, `package-lock.json`, `LICENSES.txt`) with its size and sha256, and for every complete download the **list file of each part** (`node_modules`, `node`) with its size and sha256 and the size of its pack. `update-manifest.sig` holds an Ed25519 signature over the manifest's exact bytes. The deploy signs in its own job (`sign-runner-update` in `ai-studio-deploy.yml`) that installs no npm package, so no package's install script runs next to the key.
- **What the platform does.** `src/platform/runner-update.ts` offers an update only when the bundle it serves is signed with a key the runners trust and every file it would offer matches the manifest. The offer carries the manifest and signature unchanged (`signed` in `RunnerUpdateOffer`; older runners ignore it). Without a valid signature it offers nothing, and the runner's update facts say `published: false` with the reason (`unpublished`), so the Runners page can say "download the new version"; "Update this runner" then answers 409 with the same sentence. The deploy log says whether the update was signed.
- **What the runner checks** (`src/agent/updater.ts`, `src/agent-protocol/update-manifest.ts`), in this order, before anything is downloaded: the signature (a known key id, Ed25519 over the exact bytes); that every file and part the offer names is in the manifest with the same size and sha256; that the manifest's sequence is larger than the one of the version it runs (`runner.json` `"updateSequence"`, written at every switch), so an old signed update sent again cannot move it back. Then every downloaded byte is checked against those sha256 values and every unpacked file against its signed list. The self-test (`runner.mjs --version`) runs only after all of this.
- **When a check fails** the runner installs nothing, keeps running tests on its version, reports `update.state = "needs-manual"` with the reason, writes one Activity row ("did not install version X by itself … Download the new version from the Runners page.") and asks again at most once an hour.
- **New test tools for the plain files kit** come only from `npm ci --ignore-scripts` with the signed `package-lock.json` (exact versions and integrity hashes, no install scripts). An update without a lock file is refused: an update never runs `npm install`.
- **Personal runners**: only the runner's owner (or a platform admin) may turn its updates off or ask for one (`routes/runner-updates.ts`).
- **A download's own sequence.** `RunnerUpdates.downloadSequence()` gives the sequence of the signed bundle; the kit routes should write it into a new download's `runner.json` as `"updateSequence"` (until they do, a fresh download knows no sequence and accepts any validly signed newer offer).

### Turning it off for one runner

Each runner's row has **Update automatically** (on by default). A project owner can switch it off; the runner then stays on its version and the row says "Version X is available. Automatic updates are off for this runner." with an **Update this runner** button that sends the same update once. Both the switch and the button are recorded in Activity.

A person at the runner's computer can also turn updates off for that runner by starting it with the variable `AITP_UPDATES=0`.

### Going back

`node runner.mjs --rollback` in the runner's folder (with the runner stopped) puts the previous version back: the program files, `runner.json`'s version, the test tools when the update changed them, and a Node.js that came with the update. The version left is **not installed again automatically**; "Update this runner" installs it. Only one previous version is kept.

The runner also goes back by itself when a new version starts three times without once connecting to the platform (it then exits 75 again, so it restarts on the old files), and when a switch was interrupted (power cut, killed process): the next start finds the switch journal and undoes it.

## Which runners update

| Runner | Updates itself |
|---|---|
| Plain files download (start scripts) | yes |
| Complete download (its own Node.js and test tools) | yes, including new test tools from the server's complete build, and a new pinned Node.js |
| Windows installer, Mac app | yes (the program files and test tools; a new Node.js is not swapped, see Limits) |
| Started from a repository checkout (`npm run agent`) | no (it has no runner.json; update the checkout) |
| A download made before this version | no: it has no updater. Download a new runner once; from then on it updates. Its row says "This runner cannot update itself … Download a new runner to get updates." |

## How it works

### Platform side

- The platform's runner version is the kit version of its prebuilt bundle (`dist/runner/manifest.json`: platform version plus a hash of the five program files), the same files a new download holds. A runner reports its version (`kitVersion` from its `runner.json`) and, new, `capabilities.update`: whether it can update itself (`can`), what it is doing (`idle`, `preparing`, `ready`, `updated`, `failed`, `rolled-back`), the versions, a plain error sentence, when it tries again, the sha256 of its `package.json`, whether its `node_modules` came from a complete download and whether it runs the Node.js inside its folder.
- The platform **wants** a runner on its version when the runner can update, reports another version, the bundle is built, and its setting is automatic (or a person pressed the button).
- **Protocol** (additive and optional, version stays 1):
  - `HelloResponse.update`: the offer (version, reason `auto` or `requested`, the five files with size and sha256, and for a complete download the parts that changed).
  - Every poll answer (200 or 204) carries the header `x-runner-update: <auto|requested> <version>` while the platform wants the runner on its version, so an idle runner learns it within one poll.
  - `POST /api/agent/update` `{ agentId }` → `{ update? }`: the same offer, asked when the header says so.
  - `GET /api/agent/update/files/:name`: only names an offer can contain (`runner.mjs`, `task-child.mjs`, `record-child.mjs`, `package.json`, `LICENSES.txt`, `complete-<target>-node_modules.json|.pack`, `complete-<target>-node.json|.pack`), with `content-length` and, for whole files, `x-content-sha256`.
  - Both runner routes are in the agent-route matcher (anchored and exact, like the others) and behind the same token check; the API key is not accepted instead.
- **Complete downloads**: when the runner's `node_modules` came from a complete download and its `package.json` differs from the bundle's, the offer adds the `node_modules` part of the server's complete build for the runner's system and processor (from `capabilities.os`/`arch`): a list file (path, mode, size, compressed size, sha256 per file; its own sha256 is in the offer) and a pack of the compressed files in that order, streamed from the build's `pack.bin`. When the runner runs the Node.js inside its folder and that version differs from the build's, the `node` part is added the same way.
- **Admin routes** (owner): `PUT /api/projects/:id/agents/:agentId/updates` `{ auto }`, `POST /api/projects/:id/agents/:agentId/update` (409 with a plain sentence when the bundle is not built, the runner cannot update itself, or it is already current). `GET /api/projects/:id/agents` gains `update: { can, auto, latest?, outOfDate, requested, state?, from?, to?, error?, at?, retryAt? }` for runners started from a download only (a checkout-based runner's answer is unchanged).
- **Activity**: the switch and the button are recorded by the access hook as usual; what the runner reports is written once per report as the runner (`runner-updated`, `runner-update-failed`, `runner-rolled-back`) with a sentence. Error text from a runner is masked for proxy sign-ins once more.
- **Where the setting lives**: `runner-updates.json` in the data folder (per runner: `auto` when off, a pending request, the last report written to Activity). This round adds no database migrations; a table would be the better home later.

### Runner side (`src/agent/updater.ts`)

- Only when `runner.json` with a kit version sits next to `runner.mjs` and the folder is writable. Everything lives in `.update/` inside the runner's folder: `state.json` (attempts, back-off, the last outcome, the switch journal), `next/` (staging), `previous/` (one rollback), `node-next/` and `node-previous/` (a Node.js waiting for the start script).
- **Back-off**: after a failure 5 minutes, then 15, then 45 (at most an hour); at most **3 attempts an hour**, including requested ones. A requested update ignores the back-off but not the hourly cap. `AITP_UPDATE_RETRY_SECONDS` changes the first wait (tests).
- **Checking**: each file is streamed to disk, never more bytes than announced, and its sha256 compared with the offer's. A part's list is checked against the offer, every file of its pack is inflated (never larger than announced), and its size and sha256 compared with the list; paths are plain relative paths inside the part's folder. Then `@playwright/test` must resolve from the staging folder, and `node .update/next/runner.mjs --version` must start (with the new Node.js when one came).
- **New test tools**: from the complete build's pack (complete downloads), or for the plain files kit with `npm ci --ignore-scripts --no-audit --no-fund` and the signed lock file into the staging folder (refused without a lock file), with the npm that comes with the Node.js the runner runs on and `NODE_USE_SYSTEM_CA=1` (15 minutes at most; needs the npm registry). A complete download whose server has no complete build says so instead.
- **Switching**: the current files and `runner.json` are copied to `previous/`, the journal is written, a new `node_modules` (if any) is moved in (the old one moved to `previous/`), then the files are renamed into place one by one, `runner.json` (only `kitVersion` changes; every line a person added stays) and `runner.mjs` last. Then the runner exits with **75**.
- **Exit code 75**: `start-runner.cmd`, `start-runner.sh` (and so `start-runner.command`), the Windows installer's launcher and the Mac app's loop start the runner again at once. The two start scripts first swap a staged Node.js into `node/` (keeping the old one in `.update/node-previous`). Start scripts from older downloads treat 75 like any unexpected stop and restart after 5 seconds.
- While it prepares or waits, the runner keeps polling with no free slot every 15 seconds or so, so it stays online and the platform does not give up on queued tests.
- **Secrets**: the credential (the operating system's store from round 39, or `runner.token` of an older download) is never touched by an update; it is sent only in the Authorization header. No update file, log line, URL or state file contains it (a test reads every file under `.update/`).

### Company networks (follow-up for the start scripts)

The start scripts give `npm install` `NODE_USE_SYSTEM_CA=1` (company certificates in this computer's store work for npm too) and, when neither `HTTPS_PROXY` nor `https_proxy` is set, the `"proxy"` of `runner.json` as `HTTPS_PROXY`, for npm only (`setlocal` in the .cmd, a per-command variable in the .sh) and never printed. The README now mentions the runner.json lines `"proxy"`, `"noProxy"`, `"caFile"`, `"proxyTests"` and the flags `--proxy` / `--ca-file`, and the installers' "Connection to the platform" failure says a company proxy may be the reason and points to `docs/features/company-networks.md`.

## Tests

- `tests/runner-update-unit.test.ts` (fast tier, 23 tests; every bundle signed with a test key made in the test): the round 39 checks: a good signature installed; no signature, a changed manifest, a foreign key, no key built in, another file or version in the offer: refused before any download (`needs-manual`, Activity once); the platform offers nothing unsigned, wrongly signed or changed after signing; a changed part list, pack size, target or Node.js version refused; an update not newer than the installed sequence refused and the new sequence recorded; nothing downloaded runs before the checks; the lock file travels and `npm ci --ignore-scripts` is used, `npm install` never; the sign script's part lists equal the platform's; `--new-key` writes 0600 and never over a file. And, from before: the routes and roles; the platform's offer, files, setting (surviving a restart), request, Activity once per report, masking; the updater joined in-process to the platform object: download, check, self-test, switch (runner.json's own lines and the token kept), confirmation; a damaged file refused with nothing changed, back-off 5 then 15 minutes and the hourly cap; a new version that does not start refused before switching; rollback after three unconfirmed starts and by hand, the version gone back from not taken again automatically but on request, only one rollback; an interrupted switch undone; a complete download's new test tools from the pack with a damaged file refused, switched in and rolled back; no complete build; a stand-in npm for the plain files kit and npm missing.
- `tests/runner-update-scripts.test.ts` (6 tests): `start-runner.cmd` under cmd.exe and `start-runner.sh` under Git Bash, no Node.js on the PATH: exit 75 restarts at once (no pause, no "stopped unexpectedly") and swaps a staged Node.js; npm gets `NODE_USE_SYSTEM_CA=1` and runner.json's proxy, the runner does not, the password is not printed; a proxy variable already set is left alone.
- `tests/runner-update.test.ts` (browser lock, ports 6970 to 6972, 3 tests): a real platform and real runners of two versions built from this checkout: the update between tasks with `start-runner.cmd` (the slow test finishes and passes first, then the switch, the restart, the row, Activity, the files, another test on the new version, the token in no output); a file damaged on the way by a relay refused (row, retry time, Activity, tests still run on the old version); automatic updates off, "Update this runner", and `--rollback` by hand.

## Limits (what is not covered)

- **The first version with updates must be downloaded once.** Runners from older downloads have no updater.
- **Not run on a real Mac or Linux computer, or ARM.** The `.sh` path ran under Git Bash on Windows; the Mac app's loop (`runner-setup.sh`) only gained the 75 case and was not run here.
- **A new Node.js is swapped only by the start scripts** of a complete download. The Windows installer and the Mac app keep their own Node.js copy (their private `node` folder); the runner works with any Node.js 24 or newer, and a new installer download brings a newer one.
- **The installers do not re-check the test tools** after an update: when an update changes `package.json`, the runner installs or unpacks the new test tools itself before switching (as above), so the installers do not need to.
- The npm path for new test tools in the plain files kit was tested with a stand-in npm only (no real registry here).
- Running the old setup program (`AITestingRunnerSetup.exe` from the original unzipped folder) again copies the old files back over an updated install; the runner then updates again.
- A new version that loads but misbehaves after connecting is not rolled back automatically; use `--rollback`.
- No delta updates: the five program files (about 4 MB) are fetched whole, and new test tools are fetched as the whole `node_modules` part of the complete build (about 21 MB compressed).
- Signed with Ed25519 (above), but **only once the owner makes the key pair** and sets the secret; until then no runner updates itself. The installer programs (`AITestingRunnerSetup.exe`, the Mac app) are not code-signed yet (no certificates bought); the deploy workflow signs them when their secrets are set.
- Key rotation is by hand: add the new public key, deploy, let runners update, then sign with the new key and remove the old one. A leaked private key is replaced the same way; runners that never update past it keep trusting it.
