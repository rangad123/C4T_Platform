# Local execution runner: manual verification on real computers

The automated tests run on Linux, and the real-machine workflow runs on GitHub's machines (Windows Server, not Windows 10 or 11 desktop). Neither proves the runner on a person's own PC or Mac. This checklist does. Run it on each of:

- a Windows 11 PC (x64),
- a Windows 10 PC (22H2, x64),
- a Mac with an Apple chip (macOS 14 or newer),
- an Intel Mac (the newest macOS it can run).

Steps marked **(this round)** check work built in this round (see `archive/IMPLEMENTATION_PLAN.md` and `archive/PROGRESS.md`); none of it has been run on a real Windows PC or Mac before this checklist. If the build you are checking is older and does not have that part, write "not in this build" and move on. Everything else exists at commit `e344261`.

Update signing (steps about updates) needs the update-signing key: until the owner makes it and pins its public key, no runner updates itself and those steps are "not possible in this build".

Expected results describe the design. If what you see differs, that is a finding: write down exactly what you saw.

## What GitHub's machines already proved, and what they did not

The real-machine workflow (`.github/workflows/runner-matrix.yml`) installs and runs the runner on GitHub's hosted machines: Windows Server 2022 and 2025 (x64), macOS 15 on an Apple chip, macOS 15 on Intel, and Ubuntu. Results are in `PROGRESS.md` with run ids. On those machines it has shown: the unattended install, the runner coming online, a web test and an API test run on it, a stop and a restart on the credential it saved in DPAPI or the Keychain, a forced credential renewal, revocation (the runner stops with exit code 3), an uninstall that leaves nothing, plus the `.pkg` and `.dmg` builds (unsigned). The Windows uninstall at first left the empty `app` folder behind: the runner's phone check had started Android's adb server from that folder, adb's server keeps running in the folder it was started from, and Windows cannot delete a folder that is a running program's current folder. The runner now starts the phone tools in the temp folder, and the uninstall then left nothing on Windows Server 2022 and 2025. Steps 36 and 36a matter most on a real Windows PC.

It does **not** prove: a Windows 10 or Windows 11 **desktop** (GitHub's Windows machines are Windows Server, with no signed-in desktop user, no SmartScreen and no tray), the windowed installer and the tray menu, start at sign-in after a real sign-out and sign-in, sleep and wake, a network change, antivirus products, Gatekeeper and "Background items added" on a real Mac, or a person's own Chrome or Edge profile. Those are this checklist's job.

## Before you start

You need:

- [ ] A platform with this round's build, set to `EXECUTION_MODE=runners`. Use a test deployment unless the release has been approved.
- [ ] Person A: an account that can run tests in a project (a tester account is the important case). Person B: a second account in the same project. Person C: an account that may change the project's settings.
- [ ] A test project with **throwaway test accounts only**. When the project allows people's own computers, its test accounts reach the runner's computer. Never use real customer credentials for this.
- [ ] In that project: an approved Playwright web test against a public site that signs in with a test account and takes at least one minute, a short API test, and (if the project has one) a code script.
- [ ] On the computer: a normal user account, not an administrator, signed in. Note whether Node.js, Google Chrome and Microsoft Edge are installed. For the Windows 11 PC and one Mac, use a computer without Node.js.
- [ ] A way to take screenshots, and a stopwatch.

Never paste the enrollment code, the runner credential or any test password into the record, a chat or a ticket. Before sharing a log, search it for the test account's password and for the pattern below, and remove what you find.

Credential and code pattern (used in several steps): `ait[ge]_[A-Za-z0-9_-]{40,}`. It matches a real enrollment code (`aite_…`) or runner credential (`aitg_…`), not the short prefixes inside the program files.

## What to record

Copy this block once per computer and fill it in.

```
Date:
Platform address and version:
Runner version (from the runner's page):
Computer: OS edition, version and build:
Processor (x64, Apple chip, Intel):          Memory:
Node.js installed before:   Chrome:   Edge:   Antivirus product:
Account type (standard or administrator):
Download file name, size and SHA-256:
Time from download to "connected":

Step | Result (pass, fail, not tried, not in this build) | Time | Screenshot | Exact text when wrong
```

Get the SHA-256 with `Get-FileHash <file>` (PowerShell) or `shasum -a 256 <file>` (Terminal). Get the OS details from Settings, System, About (Windows) or `sw_vers` and `uname -m` (Mac).

## Windows 11 (then repeat on Windows 10)

### Add this computer and download

1. [ ] Sign in to the website as person A. Open **Runners** and choose **Add this computer** (this round). Expected: the page says Windows, offers the Windows download, and says the code is valid for 30 minutes. Record the wording.
2. [ ] Download it. Expected: a zip whose name says Windows. Record the name, size and SHA-256.
3. [ ] Open the zip without unzipping. Expected: `AITestingRunnerSetup.exe`, `runner.json`, `runner.enroll`, the runner files and `README.txt`, and **no** `runner.token` (this round).

### Install

4. [ ] Unzip it and double-click `AITestingRunnerSetup.exe`. Expected: "Windows protected your PC" (the program is not signed). Choose **More info**, then **Run anyway**. Screenshot it. Record any antivirus warning.
5. [ ] The setup window lists six rows (Node.js, runner files, test tools, browser, extras, connection). Record each row's state. On a computer without Node.js, expect "came with this download" rather than a download.
6. [ ] Check the options. Expected: **Start the runner when I sign in** is ticked by default (this round). Leave it ticked. Choose **Install and start**.
7. [ ] Expected: the window says the runner is running, and a tray icon shows a green dot with "Connected to <platform> as <name>". Record the time from step 4.
7a. [ ] At the end of setup, the computer check is printed. Expected: "ok  Runner files match this download (version ...)". Before 2026-11-09 every download said "Runner files do not match this download" here although nothing was damaged (the check left the lock file out); record it if you still see it.
8. [ ] On the website, the Add this computer page says the runner connected (this round). The runner's page shows: kind "yours", owner person A, Windows with its version, x64, memory, agent version, Playwright version, capabilities, last heartbeat (this round). Record anything missing or wrong.

### Credential checks

9. [ ] In PowerShell, run:

    ```
    Get-ChildItem "$env:LOCALAPPDATA\AITestingRunner" -Recurse -File -ErrorAction SilentlyContinue |
      Select-String -Pattern 'ait[ge]_[A-Za-z0-9_-]{40,}' -List | Select-Object Path
    ```

    Expected: no result (this round). `runner.enroll` is gone from the install folder, and no `runner.token` is there. The credential is kept in `runner.credential` in the install folder, protected with Windows DPAPI for this user (the search above finds no `aitg_` in it). Record the result.
10. [ ] Delete the zip and the unzipped folder. Expected: the runner stays connected.
11. [ ] Reuse the code: on a second computer (or after the uninstall at the end), run the setup from the same download. Expected: a plain message that the code was already used, telling the person to make a new one on the Runners page (this round). Record it. (The same install, with its `runner.machine` file, may trade the same code again only while the code is valid and its first credential was never used.)
12. [ ] Make a new code, wait 31 minutes, then install with it. Expected: a plain message that the code has expired (this round).

### Background start

13. [ ] Close the setup window. Expected: only the tray icon remains, and the runner stays online on the website.
14. [ ] Lock the screen for two minutes. Expected: still online.
15. [ ] Sign out and sign in again. Expected: the runner starts by itself, hidden, with the tray icon; online on the website within about a minute (this round, because sign-in start is now the default). Record the time.
16. [ ] Restart the computer and sign in. Same as step 15.
17. [ ] Put the computer to sleep for five minutes while the runner is idle, then wake it. Record how long until the website shows it online again.

### Run a test from the website

18. [ ] As person A, open the project, then **Test scripts**, choose the Playwright web test and choose **Run**. Expected: the Run panel has no "This server"; it lists this computer first, marked as theirs, online (this round). Start the run.
19. [ ] Live view (this round): the run shows its phase moving through queued, offered, accepted, preparing, running; the runner's name; the start time; the current test and step; steps done; live log lines; screenshots as they arrive. Record how long the first live step took to appear.
20. [ ] Reload the page in the middle of the run. Expected: everything shown before is still there and new events keep arriving. Then open another page and come back. Same.
21. [ ] When it ends: the final report shows the result, counts, steps, screenshots, duration and where it ran (this computer). Record anything missing.
22. [ ] Search the runner's logs for the test account's password:

    ```
    Select-String -Path "$env:LOCALAPPDATA\AITestingRunner\logs\*.log" -SimpleMatch "<the test password>"
    ```

    Expected: no result. Also run the pattern search from step 9 on the logs folder: no result.
23. [ ] Run the API test. Expected: it runs and reports.
24. [ ] If the project allows a visible browser for a run, start one. Expected: a browser window opens on the desktop and closes at the end.
24a. [ ] **Secrets in the failure trace.** Make the web test fail once (for example, change its expected text in a draft and approve it on the test deployment), run it, and download the failure trace from the run's page. Search the zip's contents for the test account's password:

    ```
    Expand-Archive trace.zip -DestinationPath trace-out
    Get-ChildItem -Recurse trace-out | Select-String -SimpleMatch "<the test password>"
    ```

    Expected: no result (the password is replaced). Also open the trace in Playwright's trace viewer (`npx playwright show-trace trace.zip` on a computer with Node.js): it opens, and the typed value shows as masked. Record whether the viewer opened.
24b. [ ] **Priority.** While a web test runs, open Task Manager, **Details**: the `node.exe` and `chrome.exe` (or `msedge.exe`) processes of the run show priority **Below normal**. The computer stays usable. Record what you see.
24c. [ ] **A platform restart during a run** (test deployment only; the person running the platform restarts it). Start the one-minute web test, and restart the platform while it runs. Expected: the run carries on, finishes once, shows one result, and its log says it was handed over and picked up again. Record whether the test ran once or twice (the sample app's or the site's own logs show it).

### Stop

25. [ ] Start the web test again, and choose **Stop** on the website while it runs. Expected: the run ends as cancelled within about 20 seconds and the browser the run opened closes. It is never shown as passed.
26. [ ] Start it again, and choose **Stop the runner** from the tray menu while it runs. Expected (this round): the run reports "The agent was stopped." within about 25 seconds, instead of waiting for the server to give up on it. Record what the website shows and how long it took. Then choose **Start the runner**.
27. [ ] Start it again and turn off Wi-Fi (or unplug the network) for two minutes, then turn it back on. Record what the website shows during and after, how the run ends, and when the runner is online again. It must never show an interrupted run as passed.

### Switches and who may use the runner

28. [ ] On the runner's page, turn off code scripts (this round). Run a code script on this computer. Expected: refused before it starts, with a sentence saying why. Turn it back on.
29. [ ] Run a test whose address is `http://localhost:9` (nothing needs to listen there). Expected (this round): refused, with a sentence, because a personal runner refuses private and local addresses by default. Allow private addresses on the runner's page and try again: the run is let through and fails to connect, which is expected. Switch it back off.
30. [ ] Sign in as person B in another browser. Expected: person A's computer does not appear in their Run panel, and opening its runner page by its address answers "not found" (this round).
31. [ ] As person C, turn off **Allow people's own computers** in the project's settings (this round). Record the help text: it must say that the project's test accounts reach that computer. As person A, start a run. Expected: refused with a sentence. Turn it back on.

### Update

These need the person running the platform to publish a newer runner version.

32. [ ] With the update-signing key set, publish a newer runner version (this round: the signature check). Expected: the runner finishes its current work, updates itself, and its page says it updated, with the old and new versions. Record the time it took.
33. [ ] On a test deployment only, publish an update whose signature does not check (for example signed with another key). Expected (this round): the runner refuses it, keeps running tests on its version, and its page says a new version is available to download by hand.
34. [ ] Turn off **Update automatically** for the runner and publish another version. Expected: it stays on its version and the page says so.

### Retire and uninstall

35. [ ] On the runner's page, choose **Retire** (this round; older builds call it remove or revoke). Expected: the tray shows "Access removed" and the runner does not restart. Record the wording.
36. [ ] From the tray menu, choose **Remove this runner from the computer** and confirm. Expected: `%LOCALAPPDATA%\AITestingRunner` is gone, there is no "AI Testing Runner" in the Startup folder (`shell:startup`) or the Start menu, and the stored credential is deleted (this round).
36a. [ ] On a PC with Android tools (Android Studio or platform-tools, so `adb` works in a terminal): run `adb kill-server` first, then install, start the runner, wait until it is online, and uninstall. Expected: the install folder is gone and the uninstall says nothing is left; `adb devices` still works afterwards. If the runner fetched its own phone tools instead (a PC without them, and the runner's phone tools setting on), record whether `app\work\phone-tools` is left and what the uninstall said: a running adb server from that folder holds its own program file (a known limit, see `docs/features/runner-installer.md`). (this round)
37. [ ] Check that no runner process is left:

    ```
    Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object CommandLine -like '*AITestingRunner*'
    ```

    Expected: no result. Sign out and in: nothing starts.
38. [ ] Install again from a new download, then uninstall without retiring first. Expected: the website shows the runner offline. Record what it says.

### Windows 10 differences to watch

Repeat steps 1 to 38. Record any difference in the SmartScreen wording, the tray icon, sign-in start, and the credential store (Windows 10 uses the same DPAPI through Windows PowerShell 5.1).

## Mac (Apple chip, then Intel)

### Add this computer and download

1. [ ] Sign in as person A, open **Runners**, choose **Add this computer** (this round). Expected: the page says Mac. A browser cannot always tell an Apple chip from an Intel one; record what was offered and whether you could choose. Pick the one that matches `uname -m` (`arm64` is an Apple chip, `x86_64` is Intel).
2. [ ] Download it. Record the name, size and SHA-256.
3. [ ] Look inside the zip. Expected: `AI Testing Runner.app`, `runner.json`, `runner.enroll`, the runner files, and **no** `runner.token` (this round).
4. [ ] If a `.pkg` is offered as well (this round; the zip stays the default until this check passes), note it and test it on a second pass.

### Install

5. [ ] Unzip it in Finder and open **AI Testing Runner.app**. Expected: macOS blocks it because it is not signed or notarised. On macOS 15 and newer: choose **Done** (never Move to Bin), open System Settings, Privacy & Security, choose **Open Anyway** next to "AI Testing Runner", sign in, and open the app again. On macOS 14 and older: right-click the app, choose **Open**, then **Open**. Screenshot each warning.
6. [ ] Terminal opens and runs the setup. A dialog says what it will set up and what it needs from the internet. Continue.
7. [ ] The question "Start the runner automatically when you sign in?" has **Yes** preselected (this round). Choose Yes.
8. [ ] Record any "Background Items Added" notification and its wording.
9. [ ] Expected: a notification "Connected to <platform> as <name>". On the website, the runner's page shows kind "yours", macOS with its version, arm64 or x64, memory, agent and Playwright versions (this round).
10. [ ] In Terminal:

    ```
    ls ~/Library/LaunchAgents/app.aitesting.runner.plist
    launchctl print gui/$(id -u)/app.aitesting.runner | head -20
    ```

    Expected: the file exists and the service is running.

### Credential checks

11. [ ] In Terminal:

    ```
    grep -rlIE 'ait[ge]_[A-Za-z0-9_-]{40,}' ~/Library/Application\ Support/AITestingRunner
    ```

    Expected: no result (this round). `runner.enroll` is gone and there is no `runner.token`. Open Keychain Access, the login keychain, and find the runner's item: service "Crowd4Test AI Studio runner", account = the runner's folder. Record its name; do not reveal its value.
12. [ ] Delete the zip and the unzipped folder. Expected: still online.
13. [ ] Reuse the code and try an expired code, as in Windows steps 11 and 12.

### Background start

14. [ ] Close the Terminal window. Expected: still online (the LaunchAgent runs it).
15. [ ] Lock the screen for two minutes. Expected: still online.
16. [ ] Log out and log in. Expected: online again within about a minute. Record the time.
17. [ ] Restart and log in. Same.
18. [ ] Sleep for five minutes while idle, then wake. Record how long until it is online.

### Run, watch, stop

19. [ ] Do Windows steps 18 to 25 (run, live view, reload, final report, API test, visible browser, Stop from the website). For the log search in step 22 use:

    ```
    grep -rF '<the test password>' ~/Library/Application\ Support/AITestingRunner/logs
    ```

    Expected: no result. (A password typed into Terminal goes into the shell history. Use a throwaway one.)
20. [ ] Stop the runner while a test runs:

    ```
    launchctl bootout gui/$(id -u)/app.aitesting.runner
    ```

    Expected: the run reports "The agent was stopped." Record the time. Start it again by opening the app (or log out and in).
21. [ ] Do Windows step 27 (network off for two minutes during a run).
21a. [ ] Do Windows steps 24a and 24c. For the trace search use `unzip -o trace.zip -d trace-out && grep -rF '<the test password>' trace-out`.
21b. [ ] **Priority.** While a web test runs: `ps -o pid,nice,comm -ax | grep -Ei 'node|chrom'`. Expected: the run's processes show nice 10.
22. [ ] Open the app a second time while the runner is running. Expected: it shows the status and the end of the log, and offers "Leave it running" or "Uninstall". It never starts a second runner.

### Switches, isolation and update

23. [ ] Do Windows steps 28 to 34.

### Logs

24. [ ] After a day of use, record the sizes of `runner.log` and `launchd.log` in `~/Library/Application Support/AITestingRunner/logs`. Expected (this round): each is rotated at about 5 MB, with at most three older copies (`runner.log.1` …).

### Retire and uninstall

25. [ ] Retire the runner on the website. Expected (this round): the runner stops and stays stopped until the next sign-in; it does not retry every hour. Check with `launchctl print gui/$(id -u)/app.aitesting.runner`.
26. [ ] Uninstall: open the app and choose **Uninstall**, or run `sh ~/Library/Application\ Support/AITestingRunner/runner-setup.sh --uninstall`. Expected: the LaunchAgent is gone (`launchctl print` says it cannot find the service), the plist is gone, the install folder is removed after asking, and the Keychain item is deleted (this round). The shared Playwright browser cache is kept, and the setup says where it is.
27. [ ] Log out and in: nothing starts.

## After the pass

- [ ] Add a dated entry to `archive/PROGRESS.md`: the computer, OS version, the build, and the result of each section. Change the status to "verified on a real machine" only for what passed.
- [ ] For each failure, file an issue with the record block, the screenshots and the log lines (secrets removed).
- [ ] Note anything the docs promise that was not true on this computer, so the docs can be fixed.
