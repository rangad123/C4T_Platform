AI Testing Runner
=================

This app sets up the AI Testing runner on your Mac and starts it. It runs your tests on this computer and reports the results to the
platform. The download from the platform is one installer package, ai-testing-runner-mac.pkg: open it, choose Continue, then Install.
It installs for you only (no administrator password), puts this app in the Applications folder in your home folder and sets up the
runner with it. Open the app again later to see the runner's state or to uninstall it. (An older download was a zip with the files
inside the app, or beside it: open the app from there.)

What it does
  1. Looks for Node.js 24 or newer. If you have it (Homebrew, nvm, fnm, Volta and others are checked), it uses it and downloads nothing.
     Otherwise it downloads the official Node.js from nodejs.org into its own folder and checks the download against nodejs.org's checksum.
  2. Copies the runner files into ~/Library/Application Support/AITestingRunner.
  3. Installs the test tools (npm) if they are not there at the right versions.
  4. Downloads a browser (Chromium) for web tests if it is not there yet.
  5. Checks that this Mac can reach the platform, then starts the runner in a Terminal window.

It never asks for an administrator password and changes nothing outside its own folder, except the browser cache that Playwright shares
(~/Library/Caches/ms-playwright) and, if you say yes, one start-at-sign-in entry (~/Library/LaunchAgents/app.aitesting.runner.plist).

The first time: macOS says "Apple could not verify ... is free of malware". The package and the app are not signed with an Apple
Developer ID, so macOS blocks them until you allow it once (the same steps work for ai-testing-runner-mac.pkg, open it again after):
  - macOS 15 and newer: choose Done, open System Settings, then Privacy & Security, scroll down to Security and choose
    Open Anyway next to "AI Testing Runner". Sign in with your Mac password, then open the app again.
  - macOS 14 and older: right-click the app, choose Open, then Open.
  - Any version, in Terminal: type  xattr -dr com.apple.quarantine  and a space, drag the app into the window,
    press Enter, then open the app again.

Stopping and removing
  - To stop the runner, close the Terminal window or press Ctrl-C in it.
  - To remove everything this app installed, open the app again and choose Uninstall, or run in Terminal:
        sh "AI Testing Runner.app/Contents/Resources/runner-setup.sh" --uninstall
    That stops only the runner this app started and deletes only the folder it created. A Node.js you already had, and the shared browser
    cache, are never touched.
  - To take this runner's access away, open Settings, Your runner in the platform and choose Remove this computer.

For administrators
  sh "AI Testing Runner.app/Contents/Resources/runner-setup.sh" --check      what would be downloaded; changes nothing (exit 0 or 10)
  ... --silent --no-start     set up without any window or question, do not start
  ... --silent --autostart    set up and start at every sign-in
  ... --install-dir DIR  --log FILE  --uninstall
