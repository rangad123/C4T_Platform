  # AI Testing Platform: user guide

This guide is for testers and product managers. You do not need to know how to program. Whoever installs or runs the platform reads the [admin guide](ADMIN_GUIDE.md). Programs that talk to the platform use the [API reference](API_REFERENCE.md).

## Contents

- [What this is](#what-this-is)
- [Start in 10 minutes](#start-in-10-minutes)
- [Find your way around](#find-your-way-around)
- [Which feature do I need?](#which-feature-do-i-need)
- [Features](#features)
  - [Making tests](#making-tests)
  - [Looking after one test](#looking-after-one-test)
  - [Running tests](#running-tests)
  - [What the platform checks besides clicks](#what-the-platform-checks-besides-clicks)
  - [Seeing the big picture](#seeing-the-big-picture)
  - [Connecting other tools](#connecting-other-tools)
  - [Looking after the platform](#looking-after-the-platform)
- [Security assessment](#security-assessment)
- [Staying in control](#staying-in-control)
- [Words you will meet](#words-you-will-meet)
- [When something goes wrong](#when-something-goes-wrong)
- [Honest limits](#honest-limits)

---

## What this is

The platform tests your application for you. You give it the address of a website, an API or an app. An AI looks around, plans tests, builds them, runs them and shows you what passes and what does not. It also checks things people often forget: accessibility, speed, broken links and basic security. For an Android app the AI taps through the app on an emulator, a phone on your desk or a phone at a device farm. A separate **Security assessment** part runs passive, read-only security assessments of websites a client has authorized, with findings and reports, kept apart from your tests.

It is for testers who want to build and run tests without writing code, and for product managers who want to know whether a release is healthy. If you do write code, you can add your own tests too.

Before you start you need three things:

- The address of the application you want to test.
- A test account for it, if it has a sign-in page. Use an account made for testing, never a real person's.
- An AI service, connected by whoever set up the platform. The sidebar shows **AI connected** when it is. Testing an API on its own works without the AI.

If you can, test a staging copy of your application (a spare copy used for testing). The platform avoids actions that cannot be undone, such as payments and deletions, but tests do run against the real application.

---

## Start in 10 minutes

1. Open the platform in your browser. On your own computer the address is usually `http://127.0.0.1:4000`. On a shared server, your admin gives you the address.
2. On your first visit, or when you choose **New project** on the Projects page, you see three cards under **Ways to start**. Use the first one, **Explore my app**.
3. Type the **Application URL**, the address of the site you want to test. If the site has a sign-in page, choose **Choose what to test first** instead, open **Advanced options** and fill in **Sign in** with a test account. The platform can then see what is behind the sign-in page.
4. Choose **Explore my app** (or **Start exploring** if you used the options form). The AI looks around your application. Nothing is created or run yet. **Stop exploring** is always visible.
5. Read the plan on the project's Overview. It says what was found and what the platform will create, for example "We found 4 pages and 2 API endpoints. We will create about 18 tests." (An API endpoint is a place where programs, not people, talk to your app.) Open **Edit the plan** to switch kinds of test on or off, or to leave out single ideas. The numbers change as you edit.
6. Choose **Create the tests**. Or choose **Discard the plan** to forget it.
7. Watch **Creating your tests**. Each test appears with its status. This takes a few minutes, and you can leave the page and come back.
8. Read the result on the **Overview**. Each test is **Passing**, **Failing**, **Needs a look** or **Not run yet**. Expect a few **Needs a look** on a first run. Real sites nearly always have small problems, such as a missing security setting. That shows the checks work.
9. Open **Tests**, then open one test that is not passing. The page says which step failed, what was expected and what came back.
10. Choose **Run** to run the tests again. The **Next steps** list on the Overview then suggests what to do: set a schedule, add sign-in details, connect a runner.

---

## Find your way around

The left sidebar has **Projects** (your applications), **Settings** (the platform itself) and **Help**. When the security assessment module is switched on, the projects are listed under **Functional testing** and a separate **Security assessment** entry appears under **Security** (see [Security assessment](#security-assessment)). At the bottom the sidebar shows whether the AI is connected and, once people have accounts, who is signed in and their role.

Inside a project, six places appear as tabs under the project's name (a seventh, **Security assessment**, when the project includes it):

| Place | The question it answers |
|---|---|
| **Overview** | Is everything healthy, and what needs me? |
| **Tests** | What do we check? Every test, with search and filters. |
| **Runs** | What happened and when? Past runs, schedules, runs after a deploy, trends. |
| **Library** | What do my tests share? Reusable steps, shared elements, helpers, test data, test accounts. |
| **Release** | Can we ship? Releases, manual checks, compliance. |
| **Setup** | Where and how do tests run? Runners, environments, frameworks, mobile app and device farm, testing type, alerts, issue tracker, storage and backup. |

A place with several parts shows a row of sections under its title. In **Library**, one search box at the top finds reusable steps, shared elements and helpers by name.

The Tests page has three buttons you will use all the time: **Run** (choose what to run and where), **New test** (the one menu for starting a test) and **More actions** (import, export, check other browsers). The Projects page also has **New project**. Old bookmarks to earlier pages open the place and section that now holds them.

Words you may not know are underlined with dots. Press one for a one-sentence explanation. Press Escape to close it.

### Help inside the app

You never need to leave the platform to find out how something works.

- **The Help button.** Every page has a **Help** button in the top bar, and the sidebar has one below Settings. It opens the Help panel beside the page (on a phone it covers the page until you close it). The panel says what this page is, what you can do here (each item has a button that takes you there or opens the matching topic), the words used on the page, and what to do next. It never starts a run or changes anything. When you go to another page, the panel shows that page's help. Press **Escape** or **Close help** to close it.
- **Search.** The box at the top of the panel searches the whole guide. Type a question the way you would ask a colleague, such as “run tests every night”. Small typos and plurals do not matter.
- **The Guide.** **Open the full guide** (or the address `#/guide`) starts with **I want to…**, a list of plain goals. Each opens a topic: what it is, why you would use it, numbered steps with the names of the buttons in bold, things to know, and an **Open it in the app** button that goes to the right place. With several projects and none open, it first asks which project. **Words** lists every word the platform uses, in alphabetical order, and also finds the older names.
- **The tour.** **Take the tour** in the Help panel (or on the Guide page) walks you through the platform in up to 63 short cards, each pinned to a real button or tab, in seven chapters: **Getting around**, **Making tests**, **Running and results**, **Release and Setup**, **Phones**, **Security assessment** and **Help**. You first see the list of chapters and can start at any of them. Each card says "Step N of M" and its chapter, and has **Back**, **Next**, **Skip chapter** and **End tour**; **Chapters** jumps to another chapter, and the arrow keys and Escape work too. Cards that do not apply to you are left out before the tour starts (for example the security chapter when that module is off, or the project tabs when you have no project yet). The tour only opens pages; it never starts a run or changes anything. If you stop half-way, the next **Take the tour** offers to carry on where you stopped. The first time you open the platform it offers the tour once, in a small card you can close with **Not now**.
- **See how.** On a page with nothing in it yet, such as a new project's Tests page, a line says “Not sure how this works? See how”. It opens the matching topic in the Help panel.
- **Explanations in place.** Rest the mouse on a button, status or number for a moment, or reach it with the Tab key, and a small panel says what it does or what it means, for example what **Needs a look** means or how the pass rate is counted. Buttons that show only an icon say their name. A small **?** next to a field, setting or number explains it: hover it, Tab to it, or tap it on a phone (tap again or anywhere else to close it). Escape closes the explanation and nothing else. What you must know to fill in a form, such as limits and warnings, is always written on the page, never only in these panels. In a list or table the status badges are not Tab stops (there would be one per row): the **?** beside the list's heading lists the statuses that list shows, each with what it means. A button that is greyed out with a reason can still be reached with Tab, so you can read why; pressing it does nothing.

---

## Which feature do I need?

| I want to... | Use... | Read |
|---|---|---|
| Get tests for my app without writing any | Explore my app | [Explore my app](#explore-my-app) |
| Add one test by describing it | Describe it | [Describe a test in plain English](#describe-a-test-in-plain-english) |
| Make a test by clicking through my app | Record it in a browser | [Record a test](#record-a-test) |
| Build a test step by step | Build steps by hand | [Build steps by hand](#build-steps-by-hand) |
| Write a test as lines of text | Write it as text | [Write a test as text](#write-a-test-as-text) |
| Write code for a test | Write code | [Write code and switch to code](#write-code-and-switch-to-code) |
| Bring in tests I already have | Import tests… | [Import tests](#import-tests) |
| Reuse the same steps in many tests | Reusable steps | [Reusable steps](#reusable-steps) |
| Fix one renamed button for all tests | Shared elements | [Shared elements](#shared-elements) |
| Run a test many times with different values | Test data | [Test data and test accounts](#test-data-and-test-accounts) |
| Understand why a test failed | The test page | [The test page](#the-test-page) |
| Fix a test after my app changed | Repair suggestions | [Repair suggestions](#repair-suggestions) |
| Run tests now, or only some of them | Run | [The Run panel](#the-run-panel) |
| Run tests every night | Schedules | [Schedules](#schedules) |
| Run tests when a new version goes live | After a deploy | [Run after a deploy](#run-after-a-deploy) |
| Test against staging and production | Environments | [Environments](#environments) |
| Run tests inside my company network | Runners | [Runners](#runners-your-own-computers) |
| See if my app breaks on Firefox or a phone | Other browsers | [Other browsers and screen sizes](#other-browsers-and-screen-sizes) |
| Check accessibility, speed or security | Checks | [What the platform checks besides clicks](#what-the-platform-checks-besides-clicks) |
| Know if my API changed | API changes, API contracts | [API changes between runs](#api-changes-between-runs) |
| Stop a flaky test from raising alarms | Quarantine | [Quarantine](#quarantine) |
| Share a report with people outside the platform | Export | [Reports and sharing](#reports-and-sharing) |
| Decide whether we can ship | Release sign-off | [Release sign-off and manual checks](#release-sign-off-and-manual-checks) |
| Be told when something breaks | Alerts | [Alerts](#alerts) |
| File a problem in GitHub, Jira or Notion | Create issue | [Issue trackers](#issue-trackers) |
| Test a phone app or a Windows program | Mobile app, Windows apps | [Phones and emulators](#phones-and-emulators), [Windows desktop apps](#windows-desktop-apps) |
| Have the AI tap through my Android app and plan tests | Explore with AI | [Phones and emulators](#phones-and-emulators) |
| Test on a real phone on my desk | A runner with the phone on USB | [Phones on a runner](#phones-on-a-runner) |
| Test on many real phones without owning them | Device farm | [Phones in the cloud (device farms)](#phones-in-the-cloud-device-farms) |
| Find crashes and slow starts in my phone app | Phone quality checks | [Crashes, slow starts and accessibility in a phone app](#crashes-slow-starts-and-accessibility-in-a-phone-app) |
| Test pages behind single sign-on, a captcha or an emailed code | Saved sign-ins, Test mailbox | [Test data and test accounts](#test-data-and-test-accounts) |
| Run a client-authorized security assessment of a website | Security assessment | [Security assessment](#security-assessment) |
| Give colleagues their own sign-in and role | People | [People, roles and sign-in](#people-roles-and-sign-in) |
| Let a client see only their own project | Only these projects | [People, roles and sign-in](#people-roles-and-sign-in) |
| Make a runner work behind my company's proxy | Runner network settings | [Runners on a company network](#runners-on-a-company-network) |
| Find out why a runner does not connect | Check this computer | [Check this computer](#check-this-computer) |
| Stop a bad release automatically | Pipeline | [Running in a pipeline](#running-in-a-pipeline) |
| Ask my AI assistant to run tests | AI tool connection | [Using it from an AI tool](#using-it-from-an-ai-tool) |
| Control AI cost | AI usage | [AI usage and limits](#ai-usage-and-limits) |
| Spend less on the AI without worse tests | The AI model switches in Settings | [Reuse of repeated instructions](#reuse-of-repeated-instructions-prompt-caching), [Smaller page snapshots](#smaller-page-snapshots), [A fast model](#a-fast-model-for-routine-steps), [Without AI](#repairs-and-re-explorations-without-ai) |
| Prove a change did not make the AI tester worse | Quality of the AI tester | [Quality of the AI tester](#quality-of-the-ai-tester) |
| Learn the platform by clicking through it | The tour | [Help inside the app](#help-inside-the-app) |
| Free disk space, or back up a project | Storage and backup | [Storage and backup](#storage-and-backup) |

---

## Features

### Making tests

#### Explore my app

*The AI looks around your application and builds tests for it.*

- **Why you'd use it:** It is the fastest way to a first set of tests.
- **How:** Choose **Explore my app** on the welcome page, or **Explore again** on a project's Overview. Enter the address. Read the plan, then choose **Create the tests**. Choose **Choose what to test first** to see every option before exploring.
- **Options:** Open **Advanced options** to see every check you can switch on or off. The defaults are sensible. Speed checks, load check, visual change detection, AI screen review and extra browsers are off until you tick them. Each is explained in [What the platform checks besides clicks](#what-the-platform-checks-besides-clicks).
- **You can also add:** a test account under **Sign in**, so the platform can see pages behind a sign-in. For an API that needs a sign-in, add a **Bearer token** (a secret code that lets a program use your API) or OAuth2 details (another way for programs to sign in). You can also add a requirements document, a **Focus** such as "search and checkout only", and the address of your API's description document.
- **Include API tests that change data:** this is off, because those tests create and delete real records. Turn it on only for a test environment.
- **Good to know:** Pages behind a sign-in are in the plan only if you gave sign-in details. After you create the tests, the platform runs each one, tries to fix failures by itself and keeps what it could not fix as **Failing**. Web tests need the AI. **Stop exploring** keeps the tests already created.

#### Watch the AI explore

*A live picture of the browser the AI is using.*

- **Why you'd use it:** You see what the AI does, instead of reading a log, and you can stop it if it goes somewhere you did not expect.
- **How:** While an exploration runs (or while a test is built from a sentence), turn on **Watch live** under the steps. An **Explorer view** appears with a picture of the page, its address and title, one line saying what the AI just did, the stage it is in, how many pages it has seen and how fresh the picture is. **Stop exploring** is in the panel. The switch is off until you turn it on, and your choice is remembered in this browser.
- **Good to know:** It is a picture that refreshes about once a second, not the real window; it is taken on the platform's computer. Password, one-time-code and card fields are covered, and so is any field that holds your stored sign-in details. A user name you gave may show. Nothing is taken unless someone is watching, the picture is kept in the platform's memory only and is never saved or logged, and it is let go when the exploration ends. When the exploration ends, this page keeps the last picture until you leave. Tests that run on another computer cannot be shown. More: [ux-explorer-view.md](features/ux-explorer-view.md).

#### Describe a test in plain English

*You write one sentence and the AI builds the test.*

- **Why you'd use it:** You add one specific test without learning anything.
- **How:** On the Tests page choose **New test**, then **Describe it**. Write a sentence such as "add a product to the cart and check the total is shown". The platform opens your app, builds the test and runs it for real.
- **Good to know:** If the platform cannot make a meaningful check, it keeps the attempt as **Needs a look** with the reason, never as a pass. It refuses unsafe requests (such as payment details) and never builds on a production environment. The test page shows your sentence, and **Change the description** rebuilds the test. More: [plain-english-tests.md](features/plain-english-tests.md).

#### Record a test

*You click through your app and the platform turns what you do into steps.*

- **Why you'd use it:** You know the journey but want the steps written for you. No AI is needed.
- **How:** Choose **New test**, then **Record it in a browser**. A browser window opens. Click through your application and each step appears on the page. **Pick an element** shows how the platform would find something, without clicking it. **Add a check** turns a click into a check, such as "this text is visible". Choose **Save as a test**.
- **Good to know:** Password and one-time-code fields are never recorded. The step uses a stand-in instead. A **Live view** panel shows the page. If a runner that can record is connected, **Record on** lets you record on that computer, which is useful when your app is reachable only from there. A recording that does not replay stays **Needs a look**. Clicks and typing inside frames (also frames from other sites, up to 3 deep), file uploads (the file's name only: add a file of that name under **Test files**), drag and drop, and what you do in a pop-up window the page opens are recorded too; see [Upload files, drag and drop, frames and popups](#upload-files-drag-and-drop-frames-and-popups). Canvas drawing, hover menus, right-clicks and touch gestures are not recorded. More: [recorder.md](features/recorder.md).

#### Build steps by hand

*Add the steps one by one in a form. The script is made for you.*

- **Why you'd use it:** You get full control with no code and no AI.
- **How:** Choose **New test**, then **Build steps by hand**. You start with one valid step. On the **Steps** tab add steps from the list. Each step is a form in plain words. To say which button or field a step acts on, pick it by what it is called on screen (its role, label, text or placeholder), or choose a shared element. Reorder steps by dragging, with the buttons, or with Alt and the arrow keys. You can also duplicate or delete a step.
- **Good to know:** A preview of the script updates as you type. Problems point at the step. **Save** stores a version without running. **Save and run** also runs it. More: [visual-builder.md](features/visual-builder.md).

#### Write a test as text

*One readable line per step, such as `Click the "Sign in" button`.*

- **Why you'd use it:** Writing lines is quicker than filling forms, and you can paste them in.
- **How:** Choose **New test**, then **Write it as text**. Or open any test and use the **Text** tab. Mistakes are reported with the line and the nearest phrase ("did you mean").
- **Good to know:** No AI is involved. A fixed set of phrases turns each line into a step. If part of a test has no text form, the Text tab shows it read-only and offers **Edit the steps** and **Switch to code**, so a save never loses anything. Comments are not kept. Phone and Windows tests have no text form. More: [text-tests.md](features/text-tests.md).

#### Upload files, drag and drop, frames and popups

*Steps that fill a file field, drag one element onto another, act inside a frame (iframe) and work in a popup window.*

- **Why you'd use it:** Real pages have photos to upload, boards to sort, payment forms in frames and sign-in or terms windows.
- **How:** Put the files your tests upload under **Library**, **Test data**, **Test files** (up to 5 MB each, 50 per project). Add an **Upload a test file** or **Drag and drop** step, or record yourself doing it. Every element can say **Inside a frame**. Tick **Opens a popup** on the click that opens a window, then **Do this in the popup window** on the steps that happen there. As text: `Upload "photo.png" to the "Avatar" field`, `Drag the "Card 1" listitem to the "Done" list`, `Click the "Pay" button inside the frame "checkout"`, `Click the "Terms" link and wait for the popup`, `Click the "Accept" button in the popup`.
- **Reset the test data before a run:** under **Library**, **Test data**, the platform can call one address of your application (for example `POST /test/reset`) before every run, so tests start from the same data. Header values are stored encrypted and never shown again. If the call fails, the run stops before any test and no result changes. Production environments are never reset.
- **Good to know:** The recorder keeps only a chosen file's name: add a file of that name to Test files. Frames are followed 3 deep. Browser and screen-size checks and environment runs do not get test files yet. More: [frames-uploads-popups.md](features/frames-uploads-popups.md).

#### Write code and switch to code

*A code test is a script you write or edit yourself.*

- **Why you'd use it:** You need something the steps cannot say.
- **How:** Choose **New test**, then **Write code**. It starts from a short working example. For a test the platform made, open the **Code** tab and choose **Switch to code**. A dialog lists what you give up: repair suggestions, shared-element updates, and the steps no longer driving the test. You can return with **Go back to the generated version**.
- **Good to know:** The editor has line numbers, colours, search and a problems list that checks as you type. Every save is a version you can compare and restore. **Helpers (code)** in the Library keeps small shared code files. A code test is a program, so it runs only where the platform's owner allowed it (see [Honest limits](#honest-limits)). More: [custom-scripts.md](features/custom-scripts.md).

#### Import tests

*Bring in tests you already have.*

- **Why you'd use it:** You can move tests from another project, from Maestro (a phone testing tool) or from a Git repository (the folder where developers keep their code).
- **How:** Choose **New test**, then **Import tests…** (or **More actions**, then **Import tests…**). Pick a JSON file (the platform's own test file format), Maestro flows, or a Git repository. A preview shows what will be created and what is left out and why, before anything is stored.
- **Good to know:** **Export…** gives you the JSON file back, so you can copy tests between projects. Imported phone tests run on an emulator. The file format is in the [admin guide](ADMIN_GUIDE.md#14-test-file-format-json-import). More: [notifications-and-import.md](features/notifications-and-import.md).

#### Import from Git

*Read Playwright test files (a popular web testing tool) from a Git repository and make one code test for each.*

- **Why you'd use it:** Your developers already wrote tests, and you want them kept in step with the repository.
- **How:** Choose **Import tests…**, pick the Git option and enter the repository address (https). Check the preview, then confirm. Later, **Check for updates** and **Refresh** add a new version only for files that changed.
- **Good to know:** The repository is read without running anything from it. If it is private, you give an access token (a secret code for the repository), used for that one request and never stored. Imported tests are code tests. More: [git-import.md](features/git-import.md).

#### Reusable steps

*A named group of steps, such as "Sign in", that many tests use.*

- **Why you'd use it:** You change the steps once and every test follows.
- **How:** Open **Library**, then **Reusable steps**. Or, in the step editor, choose **Save these steps as reusable steps** on a range of steps. Add a group to a test from **Add a step**. A group can take values (for example the account name) that each test fills in.
- **Good to know:** When a group changes, every test that uses it is rebuilt and run again. A change that would break a test, for example by sending saved sign-in details to another site, is refused and the affected tests are listed. A group still in use cannot be deleted. Groups can contain other groups, up to three levels. More: [step-blocks.md](features/step-blocks.md).

#### Shared elements

*A button or field named once ("Cart / Checkout button") and used by many tests.*

- **Why you'd use it:** When the button is renamed in your app, you fix it in one place.
- **How:** Open **Library**, then **Shared elements**. **Find elements to share** looks through your tests for the same element used in two or more places and suggests names. Nothing changes until you confirm. On a step in the editor, choose **Use as shared element**.
- **Good to know:** When a shared element changes, the scripts of all tests that use it are rebuilt and a run is queued. Scripts you download still contain the real details, so they work without the platform. More: [object-repository.md](features/object-repository.md).

#### Test data and test accounts

*Tables of values a test can read, and the sign-ins a test uses.*

- **Why you'd use it:** You can run one test with many sets of values, or test as different kinds of user.
- **Test data:** Open **Library**, then **Test data**. Import a table as a CSV, JSON or YAML file. A test that names the table runs once per row (up to 25 rows) and can use the column names as stand-ins in its steps. How a test names a table is in [environments-and-data.md](features/environments-and-data.md). Do not put passwords in a table: tables are part of the scripts you download.
- **Test accounts:** Open **Library**, then **Test accounts**. Add up to six named accounts, for example *user* and *admin*.
- **Good to know:** Passwords and secrets are write-only and stored encrypted, and are never shown again. If a sign-in asks for a code from an authenticator app, paste the account's setup key as the **Authenticator secret**. The platform then enters the current code when asked. Codes sent by text message cannot be used. More: [identity.md](features/identity.md), [environments-and-data.md](features/environments-and-data.md).
- **Sign-ins a test can't fill in** (single sign-on, Google or Microsoft sign-in, a captcha): under **Saved sign-ins**, choose **Sign in once yourself**, sign in in the browser that opens, then **I'm signed in, save it** (or upload a saved sign-in file). Runs and explorations then start signed in. Before each run the platform checks you're still signed in; if not, the run stops before any test and asks you to **Sign in again**. Tests that type the password themselves still start signed out.
- **Codes and links sent by email:** set up the **Test mailbox** (forward mail to a private platform address, or let the platform read an IMAP mailbox), then add the step **Use an emailed code or link**. A page with a captcha is reported in plain words, never solved. More: [hard-sign-ins.md](features/hard-sign-ins.md).

### Looking after one test

#### The test page

*One page per test, with four tabs: Steps, Text, Code and History.*

- **Why you'd use it:** It is where you see why a test failed and change it.
- **At the top:** the name, the status, **Run again** (the arrow beside it opens the Run panel) and **More actions** (quarantine, download the script, create a mobile version). The last result stays in a column beside your work whichever tab is open.
- **Where it came from:** one line such as "Recorded in a browser" or "Written from your description". **Why this test?** shows the idea behind it when that is stored.
- **What failed:** for a failing test, the step in plain words, **Expected** and **Got**, and links to the screenshot, recording and trace (a step-by-step recording of what the test did). **What you can do** lists only what applies: *Add an API token*, *Apply the repair*, *Edit steps*, *Switch to code*, *Quarantine* or *Run again*.
- **Saving:** when you change something, a bar shows the number of unsaved changes with **Preview changes**, **Discard changes**, **Save** and **Save and run**. **Save** stores a version and runs nothing. After a save, **Undo** goes back one version.
- **Other actions:** **Accept new screenshot** (for an intended visual change), **Check again** (other browsers), **Create issue**, and, under **More actions**, **Create mobile version** (a phone script you can take elsewhere; the platform does not run it). In the script view the platform's own set-up code is folded behind **Show setup code**. **Copy** and **Download** give the whole script.
- **Good to know:** After a run, each step on the Steps tab shows a mark for passed or failed. The marks disappear when you edit, because they would no longer be true. A test has no duplicate or delete action. More: [ux-workbench.md](features/ux-workbench.md).

#### History and undo

*Every version, run, repair and import of one test, in one list.*

- **Why you'd use it:** You see what changed and when, and you can go back.
- **How:** Open the test and choose the **History** tab. Tick two versions of the same kind to compare them. **Restore this version** saves an old version as the newest and runs the test. **Undo my last edit** appears in the results column when a test passed, you saved an edit, and it then stopped passing.
- **Good to know:** Nothing is deleted when you undo. The platform keeps no step-by-step results for old runs, so only the last run marks steps. More: [ux-workbench.md](features/ux-workbench.md).

#### Repair suggestions

*When your app renamed or moved a button, the platform suggests the new one.*

- **Why you'd use it:** You fix tests broken by harmless changes without hunting for the cause.
- **How:** On a failing test, a card says "We found a likely replacement". Choose **Apply and run again** or **Dismiss**. After you apply, the page says **Repair applied**, shows before and now, and offers **Undo this repair**.
- **Good to know:** Nothing changes until you apply. A repair is offered only when the page has one clear replacement. A check that your app got wrong is never "repaired". Repairing a shared element changes other tests too, so it has no one-press undo. A repair is not the same as [auto-fix](#auto-fix). More: [healing-and-triggers.md](features/healing-and-triggers.md).

#### Auto-fix

*Fixes the platform made by itself while it created a test.*

- **Why you'd use it:** You see how much a test needed fixing before it passed.
- **How:** A test that passed only after more than one try says **Auto-fixed during creation**, with the attempts that did not pass and why.
- **Good to know:** The platform keeps the result of each attempt, not the earlier steps, so there is no before-and-after of the steps.

#### What the page did

*The requests the page made and the errors it showed when a web test failed.*

- **Why you'd use it:** Many failures are explained by a failed request or a script error.
- **How:** Open a failing web test. The results column lists the requests (failed and slow ones first) and the errors, with a one-sentence summary. The same sentence appears in issues and reports.
- **Good to know:** The contents of requests, cookies and anything that looks like a secret are never stored. Phone and API tests are not covered. More: [failure-evidence.md](features/failure-evidence.md).

#### Quarantine

*Keep an unreliable test running and visible, but stop it from counting against you.*

- **Why you'd use it:** One flaky test should not turn alerts red or block a release.
- **How:** Choose **Quarantine** on a flaky test's page (under **More actions**), or in the unreliable tests list under **Runs**, then **Trends**. A quarantined test no longer counts in pass rates, alerts, release sign-off, run sequences or deploy status. Everything that ignores it says how many it ignored.
- **Good to know:** Only genuinely flaky tests qualify. Security, health, accessibility and API contract findings are refused, and so are tests that fail every time. A quarantine ends after 14 days by default (60 at most), or earlier if you choose **Release from quarantine**. The page suggests releasing a test that passed 10 runs in a row. Nothing is quarantined automatically. More: [quarantine.md](features/quarantine.md).

### Running tests

#### The Run panel

*One panel for choosing what to run and where.*

- **Why you'd use it:** It is the same choice everywhere: on the Tests page, on a test's page and on the Runs page.
- **How:** Choose **Run**. Under **What**, pick *Failing now*, *This group*, *Selected tests* (choose **Select tests** in the list and tick rows), *All tests* or *Not run yet*, each with its count. Under **Where**, pick this server, a runner, or an environment. Under **How** you can also check other browsers and screen sizes, or run failing tests once more straight away. One sentence says what will happen, for example "Runs 7 tests on Maya's laptop."
- **Good to know:** No time is promised. Results replace the last results of the tests that run. A production environment asks for confirmation. More: [ux-run-control.md](features/ux-run-control.md).

#### Stopping a run

*Stop a run that is going, and keep what already finished.*

- **Why you'd use it:** You started the wrong run, or it is taking too long.
- **How:** While a run goes, a strip at the top of the project names it, for example "Running 7 tests, 3 done, 1 failing". Choose **Stop run**. For an AI exploration the button says **Stop exploring**. A confirmation says how many results are already recorded.
- **Good to know:** Tests that did not finish keep their previous result. A stopped run reads "Stopped: 3 of 7 ran" on the Runs page, the Overview and the run's own page. Tests run together and report when they finish, so during a run most tests read "running" rather than showing a live step.

#### The Runs page

*Everything that happened, run by run.*

- **Why you'd use it:** It answers "what happened last night?"
- **How:** Open **Runs**, then **All runs**. Open a run to see every test (failures first, with the reason), who started it (a person, a schedule, a deploy or a run sequence), what changed since the last run, and **Run failing tests again** or **Run these tests again**.
- **Good to know:** "Changed since the last run" compares each test with its own previous result. It covers runs of your existing tests, not environment runs, browser checks or explorations. Progress updates live, including from a runner. If the live connection is lost, the page refreshes every few seconds and says so. More: [live-stream.md](features/live-stream.md).

#### Other browsers and screen sizes

*Check whether tests that pass in Chrome also pass in Firefox, Safari, on a phone and on a tablet.*

- **Why you'd use it:** You catch problems that only some visitors see.
- **How:** Tick **Also check on** when exploring. Or choose **More actions**, then **Check other browsers & screen sizes**. Or choose **Check again** on one test. The choices are **Firefox**, **Safari (WebKit)**, **Phone** and **Tablet**. A test that passes in Chrome but fails elsewhere gets a badge such as "Fails on Safari", and its page shows a grid of passes and fails with the failing step, screenshot and video. The **Differs by browser** filter lists them.
- **Good to know:** A test's main status never changes because of this. Accessibility, visual, security, health and API tests are skipped, with the reason. A browser that is not installed shows as unavailable (ask your admin). Safari, phone and tablet are imitations running on a computer, not real devices. More: [variants.md](features/variants.md).

#### Schedules

*Run tests on a timetable, with nobody watching.*

- **Why you'd use it:** You learn about a break the morning after it happens.
- **How:** Open **Runs**, then **Schedules**, then **New schedule**. Choose **Re-run all tests** (no AI needed) or **Explore again**. Choose every few minutes or hours (at least 5 minutes), daily at a time, or weekly. Times use the server's clock, shown on the page. You can run a schedule now, pause it, resume it or delete it.
- **Good to know:** A schedule never overlaps a running job. It is skipped and tried at the next check. After downtime a missed run happens once. Runs a schedule starts carry a **Scheduled** badge. If a scheduled run fails a test, it runs that test once more. If it then passes, it counts as passed and is listed as unreliable. More: [schedules.md](features/schedules.md).

#### Run after a deploy

*Your build pipeline asks the platform to run the tests when a new version goes live.*

- **Why you'd use it:** You test every release without anyone clicking. (A build pipeline is the automatic process that builds and releases your software.)
- **How:** Open **Runs**, then **After a deploy**. Choose **Create a token**. A deploy token is a secret code your pipeline sends to the platform. It is shown once, and you can revoke it. Give it to the person who runs your pipeline.
- **Good to know:** A token can start a run sequence instead of a plain re-run. A token allows one run per 30 seconds, and a busy project answers "busy". The technical details are in the [admin guide](ADMIN_GUIDE.md#8-deploy-trigger). More: [healing-and-triggers.md](features/healing-and-triggers.md).

#### Run sequences

*A chain of steps with branches, such as "run the quick tests, and only if they pass, run everything".*

- **Why you'd use it:** You automate a release routine.
- **How:** Open **Runs**, then **Schedules**, and find **Run sequences**. Choose **From a template** (*Smoke then full run*, *Release gate* or *Nightly with alert*) or **New run sequence**. A step can run tests, check a condition (pass rate, no failures, no high-severity findings, no breaking API change, project is ready), send a message through an alert channel, wait, or explore again. Each step says what happens if it passes or fails.
- **Good to know:** Routes only go forward, so a sequence always ends. Start one by hand, from a schedule or from a deploy token. A production step needs the confirmation box. One sequence runs per project at a time. More: [runbooks.md](features/runbooks.md).

#### Environments

*Named places to run against: staging, production and so on.*

- **Why you'd use it:** You run the same tests against a different address and sign-in.
- **How:** Open **Setup**, then **Environments**. Add one with its address, its sign-in or API token and its own variables. Pick it under **Where** in the Run panel. The environment marked **Default** (the first one you add, or the one you choose with **Make default**) is already picked there, and in the run steps of a new run sequence; choose **Project address** or another environment to run somewhere else.
- **Good to know:** Results are kept per environment. A **production** environment is read-only: it needs the confirmation box, and tests that change data are skipped with the reason. Environment runs leave out phone and Windows tests. More: [environments-and-data.md](features/environments-and-data.md).

#### Runners: your own computers

*A runner is a computer, other than the platform's, that runs your tests.*

- **Why you'd use it:** Your application is reachable only from your network, you need real browsers, or you have a phone on a USB cable.
- **How:** Open **Setup**, then **Runners**. Connected runners show first. Most people do not need one. To add one, choose **Add a runner**. There are three steps, and the panel says "Step 1 of 3" and so on.
  1. **Choose the computer.** Pick **Windows** or **Mac or Linux** (your browser's guess is already chosen) and give the runner a name, such as "Office computer". If the panel warns that the platform's address may not work from another computer, ask whoever runs the platform to fix it first.
  2. **Download and unzip.** Where the panel offers it, choose **Complete download (recommended)**: it holds its own Node.js and test tools, so nothing else is installed, and the panel shows its size and the system and processor it is for (your browser's guess is chosen; change it if it is wrong, for example "Windows on an ARM processor"). Otherwise choose **Installer** (or **Plain files (advanced)**, the script described in step 3 for the other way). Then choose **Download runner**. The file holds a secret that lets a computer run tests for this project, so don't share it, and delete it after the runner connects. You never see or copy a token. Unzip the file on the computer where your app can be reached (right-click, then Extract all, on Windows).
  3. **Start it (complete download).** On Windows, open the folder and double-click **start-runner.cmd**; on a Mac or Linux, run `sh start-runner.sh` in Terminal as described for the plain files below. It says "Using the Node.js that came with this download" and "The test tools came with this download. Nothing to install.", and starts straight away. If it says that Node.js does not start, you have the download for another processor: download the right one. Web tests use Google Chrome or Microsoft Edge if the computer has one; otherwise the runner downloads a browser once. More: [runner-complete-kit.md](features/runner-complete-kit.md).
  3. **Start it (installer).** Open the folder you unzipped and double-click **AITestingRunnerSetup.exe** (on a Mac, **AI Testing Runner**). Windows may say "Windows protected your PC", because the installer is not signed yet: choose **More info**, then **Run anyway** (on a Mac, the first launch is blocked as well: choose **Done**, open **System Settings**, then **Privacy & Security**, scroll down to **Security** and choose **Open Anyway** next to "AI Testing Runner", then sign in with your Mac password; on macOS 14 or older you can right-click the app and choose **Open** instead). A window lists what it checks: Node.js and the test tools (the runner chooses a browser itself). It only downloads what is missing, so you do not need to install anything first, and it needs no administrator rights. Choose **Install and start**. The runner then works in the background and has an icon in the notification area next to the clock; right-click it to open the platform, show the log, stop the runner or remove it from the computer. You can delete the downloaded file and the unzipped folder once the page says "Connected". More: [runner-installer.md](features/runner-installer.md).
  3. **Start it (plain files).** On Windows, open the folder and double-click **start-runner.cmd**. On a Mac or Linux, open Terminal, type `cd` and a space, drag the unzipped folder into the Terminal window, press Enter, then run `sh start-runner.sh` (this avoids the permission prompts; double-clicking **start-runner.command** also works if you right-click it and choose Open). The script looks for Node.js 24 or newer in the usual places, including where nvm, fnm, Volta and Homebrew put it, and prints which one it uses, for example "Using Node.js v26.1.0 from ...". The first start downloads what it needs and can take a few minutes; leave the window open. If you are asked to install Node.js, say yes. If it says it cannot find Node.js but you have it, open Terminal (Command Prompt on Windows) and run `node --version` there; if that works, run the script from that same window. If it says it found a Node.js that is too old, it names the version and where it is, and you update it (nodejs.org LTS, `brew upgrade node` or `nvm install 24`). The page then says "Waiting for your runner to connect" and, when it does, "Connected" with **Done**. After about three minutes without a connection it lists the usual reasons.

  Then pick the runner under **Where** in the Run panel, or set it for the project. A project has **one runner**: once it is set up, **Add a runner** gives way to a note, and a second one is refused until you remove the first (an admin can allow more with `AGENT_MAX_TOKENS`). To delete a runner, choose **Remove access** on its card (or in **Access for runners**): it stops and can't connect again, your tests keep their results, and you can then add a different one. If you have the project folder on that computer, the older way is under **Advanced: start a runner from the project folder**. If the page says the runner download is not available, the platform has not prepared it: ask whoever runs the platform.
- **Good to know:** The runner connects out to the platform, so nobody opens a door into your network. Only running scripts moves to the runner. Exploring, building from a description, repair and the AI screen review stay on the platform. If no suitable runner is online, a run is refused with a plain reason instead of waiting. See the [admin guide](ADMIN_GUIDE.md#6-runner-agents-tests-on-another-computer). More: [runner-agent.md](features/runner-agent.md).

#### Which browser a runner uses

*A runner uses a good browser the computer already has, and downloads one only when it must.*

- **Why you'd use it:** You want tests to run in the Chrome or Edge your users have, or a runner computer should not download a browser.
- **How:** Usually nothing. When the runner starts it uses Playwright's own Chromium if it is already there, else Google Chrome, else Microsoft Edge, else it downloads Chromium once (about 150 MB). Its window says which, for example "Ready for web tests in Microsoft Edge 155, installed on this computer." To choose yourself, start it with `--browser chrome`, `--browser msedge` or `--browser bundled` (Playwright's Chromium), or add `"browser": "msedge"` to `runner.json` in its folder. The runner's card under **Setup**, **Runners** says which browser its web tests run in, and **Show details** lists the Chrome and Edge it found and why one is not used (for example too old). Each run on a runner says it in its details: "Ran in Microsoft Edge 155, installed on Maya's laptop."
- **Good to know:** A Chrome or Edge more than 3 versions older than Playwright's own Chromium is not used. Firefox and WebKit, for **Ran on other browsers**, are downloaded the first time such a run arrives; if that fails, the run says so as a runner problem, never as a failing test. A download follows the company proxy (see below). More: [runner-browsers.md](features/runner-browsers.md).

#### Runners on a company network

*A runner works behind a company proxy and a security tool that checks https traffic.*

- **Why you'd use it:** Your computer reaches the internet only through the company's proxy, or IT installed its own certificate on it.
- **How:** Usually nothing. The runner uses the proxy set in Windows (or the `HTTPS_PROXY` variable) and trusts the certificates installed on the computer. Its window says what it uses, for example "Network: connecting through the proxy http://proxy.example:8080, from the Windows proxy setting." If the proxy needs a password, start the runner with `--proxy http://user:password@proxy.example:8080` (the password is never shown, and never sent to the platform), or add a `"proxy"` line to `runner.json` in the runner's folder. If IT gave you a certificate file, start it with `--ca-file` and the file.
- **Good to know:** When the network is the problem, the window says which problem and what to do: the proxy wants a password, the proxy blocks the platform's address, the proxy cannot be reached, or the platform's certificate is not trusted. Once the runner is connected, its card under **Setup**, **Runners** shows the proxy (**Show details**) and its last network problem. Your tests reach your app directly unless you start the runner with `--proxy-tests`. Automatic proxy scripts and proxies that accept only your Windows sign-in are not supported: ask IT for the proxy's address and a user name and password. More: [company-networks.md](features/company-networks.md).

#### Check this computer

*When a runner does not connect, one double-click says why.*

- **Why you'd use it:** The runner window closed, or it keeps saying it cannot reach the platform, and you want to know what to fix.
- **How:** In the runner's folder, double-click `check-computer.cmd` (Windows), or run `sh check-computer.sh` in Terminal (Mac and Linux; on a Mac `check-computer.command` can be double-clicked). It prints one line per thing with **ok**, **missing** or **optional** and how to fix it: Node.js, the runner's files, the test tools, the browser web tests will use, Firefox and WebKit, the proxy and certificates, whether the platform answers and accepts the runner's token (never shown), free disk space, the clock, phone tools, and on a Mac the processor and the quarantine flag. The installers run the same check when they finish and show its lines.
- **Good to know:** It changes nothing and installs nothing. A connected runner sends the same check when it starts: its row under **Setup**, **Runners** says "2 things need a look" with the lines, and **Show details** lists them all. More: [runner-check.md](features/runner-check.md).

#### Runners keep themselves up to date

*When the platform is updated, a runner you downloaded updates itself between tests.*

- **Why you'd use it:** You never download a new runner after an update of the platform.
- **How:** Nothing to do. The runner finishes the tests it is running, takes no new ones, downloads the new version, checks every file and starts again; its window says "The runner updated itself. Starting the new version." and its row under **Setup**, **Runners** says it updated itself. To keep a runner on its version, switch off **Update automatically** on its row; the row then offers **Update this runner** when a new version is there.
- **Good to know:** A damaged or failed update changes nothing: the row says "Could not update: … Still on version …" and when it tries again (at most 3 times an hour). To go back to the previous version, stop the runner and run `node runner.mjs --rollback` in its folder. Runners downloaded before this version, and runners started from the project folder, do not update themselves: download a new runner once. More: [runner-updates.md](features/runner-updates.md).

#### Phones and emulators

*Test an Android app on an emulator (a phone imitation on a computer) or on a real phone through a runner.*

- **Why you'd use it:** You check a phone app, not only a website.
- **How, the AI way (start here):** The admin sets up the Android tools once (**Settings**, then **Mobile testing**, shows **Ready**), or a runner on a computer with an emulator or a phone is connected (**Setup**, **Runners**). In a project open **Setup**, then **Mobile app**, choose **Change**, and enter the app's package name (its unique name on Android; an `.apk` file, the Android app file, can be added to be installed first). Then start the AI in any of three ways: **Explore with AI** next to **Change**; **New test**, then **Explore the phone app (AI)**; or, on the welcome page, **Explore my app** with **An Android app** chosen. A panel says what will happen and where it will run (**This server** or a runner, with the reason when a place cannot be used), and has **Advanced options** for a test account. Choose **Start exploring**. The AI opens the app, taps through it like a careful user and plans tests; nothing is created until you read the plan and choose **Create the tests**. The plan says "We found 9 screens. We will create about 12 phone tests: ..." with **Edit the plan** (each kind of test and each test idea, with the screens it goes through), **What we found**, **What the AI left alone** and **Discard the plan**.
- **Watching it:** Under the steps, turn on **Watch live** to see the phone screen in a phone-shaped picture, what the AI just did, the screens, activities, actions and AI calls so far (and at the end why it stopped, for example "no new screens after 80 actions: the app looks fully explored"), and a list of what it left alone ("Skipped “Delete account” because it looks destructive"). **Stop exploring** stops it at any time. The AI never taps buttons that look like paying, deleting or sending; passwords are hidden; it signs in with the test account but never answers a one-time code or captcha itself (it pauses and asks you, see below), never uses a fingerprint check, and does not explore games. How far it goes is the project's **How thorough** setting.
- **How, the other way:** Import phone tests (**New test**, **Import tests…**). A project can be phone-only.
- **Good to know:** Phone exploration works on Android only; for an iPhone app, import tests. It needs the AI model and the app's package name. Each test starts from the app's first screen. The first emulator start takes a few minutes, and the emulator needs 2 to 3 GB of free memory. A failed test shows the failing step, a screenshot, a video and a trace. More: [ux-phone-ai.md](features/ux-phone-ai.md), [phone-ai-tests.md](features/phone-ai-tests.md).

#### Phones on a runner

*A real Android phone on USB needs only Google's small phone tools (adb), not the Android SDK, and a downloaded runner gets them itself.*

- **How:** On the phone, turn on USB debugging: **Settings**, **About phone**, tap **Build number** seven times; then **Settings**, **System**, **Developer options**, **USB debugging** on. Plug the phone into the runner's computer, unlock it and tap **Allow** on "Allow USB debugging?". Start the AI exploration on that runner as usual. If the computer has no adb, the runner downloads Google's platform-tools (about 10 MB) into its own folder the first time a phone session arrives, checks it against Google's size and checksum, and the steps appear while it does. The runner's row (**Setup**, **Runners**, **Show details**) says **Android phone tools** and their state.
- **Good to know:** Nothing is installed system-wide. Add `"phoneTools": "now"` to `runner.json` to fetch them when the runner starts, or `"off"` to never fetch them. Emulators still need the Android SDK (`npx @taqwright/taqwright install --with-avd`), and phone **test runs** (Taqwright) still need Taqwright's own tools; the phone tools alone are enough for AI exploration. Google publishes no phone tools for Linux on ARM. More: [phone-setup-simple.md](features/phone-setup-simple.md).

#### Is this phone ready? Where phone tests run, how thorough, signing in

*Before tests run on a real phone, the platform checks it and says exactly what to change; you choose which device runs the project's phone tests and how far the AI explores.*

- **Why you'd use it:** Most failures on a real phone have nothing to do with your app: USB debugging not allowed, a locked screen, animations, the app installed only as a "parallel app", or a maker's battery manager freezing the test helper.
- **How:** Plug in the phone with USB debugging on and open **Setup**, then **Mobile app**. **Is this phone ready?** lists each phone and emulator connected to the platform's computer (model, serial, Android version) with **Ready**, **Check** or **Not ready**, what needs doing with the exact steps, and **Settings this maker's phones need** for OnePlus, OPPO and realme (**Disable permission monitoring**, background activity for the test helper), Xiaomi (**USB debugging (Security settings)**), Samsung (**Auto Blocker** off), vivo and Huawei. **Turn animations off for tests** and **Keep the screen on while charging** do it for you; **Restore animations** and **Put the screen setting back** undo it. Under **Phone test settings** choose **Where phone tests run** (**Choose for me**, **The phone the AI explored on**, a named phone, **An emulator**, **A device farm**), **How thorough** (**Quick** about 40 screens, **Standard** about 150, **Thorough** about 300; it stops earlier when it finds nothing new and says why) and **Already signed in on this phone**, then **Save phone settings**.
- **Signing in:** Give a test account under **Advanced options** when you start exploring; the AI fills sign-in screens with it (the password stays hidden) and never taps log out. When the app asks for a one-time code or shows a captcha, the exploration pauses and its page says "Enter the code on the phone, then choose Continue." with **Continue** and **Go on without signing in**; after 5 minutes without an answer it goes on without signing in. With **Already signed in on this phone** the app's data is kept, so an app you signed into by hand is explored and tested signed in.
- **Good to know:** Nothing on the phone changes unless you press a button. A phone on a runner is checked by **Check this computer** on that computer. **Already signed in on this phone** and **Start every test from a fresh install of the app's data** cannot be on together. The plan says how much was explored ("Explored 142 screens across 31 activities; stopped because ..."). Not yet tried on a real phone by the people who built it. More: [phone-ready-and-sign-in.md](features/phone-ready-and-sign-in.md).

#### Reliable phone tests: a clean start, permission answers, repair

*Every phone test can start from fresh app data with the permissions it needs, answers permission questions the way the AI did, and gets a repair suggestion when an element was renamed.*

- **Why you'd use it:** A test that passes only after another test ran, or that stops at a permission question, is not a test you can trust.
- **How:** In **Setup**, **Mobile app**, open **How each test starts**. Tick **Start every test from a fresh install of the app's data** (off unless you switch it on; only this app's data is cleared) and, under **Grant these permissions before each test**, choose **Read the app's permissions** or add names such as `android.permission.CAMERA`. The plan and every run say how the tests start. Tests the AI writes start with a step such as `Don't allow "send you notifications" when asked`, which answers only if the phone asks. When a phone test fails because an element was not found, a run looks at the phone, the AI picks the matching element on that screen, the test is tried once with it, and a **Repair** waits on the test for you to apply or dismiss.
- **Good to know:** With a clean start each test runs on its own, so a run takes longer. An `.aab` app bundle can be uploaded when the platform's computer has Java and bundletool; otherwise upload an `.apk`. Text with accents or other scripts can be typed only when the phone's keyboard is ADBKeyboard. More: [phone-reliability.md](features/phone-reliability.md).

#### Crashes, slow starts and accessibility in a phone app

*The platform watches the phone's own log for crashes and freezes of your Android app, times how long it takes to open, and checks each screen for accessibility.*

- **Why you'd use it:** You find the crashes and slow starts your users would hit first, with the app's own error message, the screen before it and the steps that led to it.
- **How:** Nothing to switch on. While the AI explores, a crash appears in the job's events ("The app crashed: …"); the app is started again and the exploration goes on. The plan lists the crashes, the start-up time against the budget (5 seconds unless the project sets another one) and the accessibility of each screen. **Create the tests** keeps each crash and a slow start as a test that reads **Needs a look**; run it again after a fix to check it on the phone. Accessibility checks for phone screens (labels for screen readers, touch targets of at least 48 dp, duplicate labels) become tests only when **Accessibility** is switched on.
- **Good to know:** A crash or freeze during any phone test fails that test with the app's error and the stack trace, as a finding of high severity; it is never a silent pass. During exploring, crashes and the start-up time are checked only when the phone is connected to the computer that runs the platform. Text size and colour contrast are not checked on phones. More: [phone-quality-checks.md](features/phone-quality-checks.md).

#### Phones in the cloud (device farms)

*Run phone tests on real phones at BrowserStack, Sauce Labs or LambdaTest, or on your own Appium server, instead of a phone on this computer.*

- **Why you'd use it:** No emulator to install, real phones, and several tests or several phones at once.
- **How:** **Setup**, **Mobile app**, **Device farm**, **Connect a device farm**: pick the provider, give the account's user name and access key, and list the phones (one per line: name, comma, Android version, for example `Google Pixel 8, 14`). **Check connection** says whether the account works. Under **Device farm or this computer** choose **A device farm** (or choose **A device farm** under **Phone test settings**, **Where phone tests run**), set **Phone tests at once**, and with more than one phone tick **Run on several phones** to run every test on each of them. Choose **Save choice**. Then run tests as usual.
- **Good to know:** Upload the app's `.apk` under **Mobile app** first (an Appium server needs the app already installed). The access key is stored encrypted and never shown again. Each test's note or reason links to the provider's video and logs, and **Recent farm sessions** lists the latest ones. The test account's password is typed on the farm's phone, so use a test account. Code tests, data-set tests and phone checks (start-up time, accessibility) do not run on a farm; they say why. "Phone tests at once" also works on this computer when several phones are connected. This has only been tried against a stand-in farm, not a real provider. More: [device-farms.md](features/device-farms.md).

#### Windows desktop apps

*Test a program that runs on Windows.*

- **Why you'd use it:** Not everything is a website.
- **How:** Import desktop tests. They run on a Windows computer that is logged in and unlocked: the platform's own computer if it runs Windows, or a runner on Windows. The test works on the program without moving your mouse or pressing keys, so a person on the same computer is not disturbed.
- **Good to know:** Every computer has a list of programs it may start, set by its owner. A program not on the list is refused with a plain message and is not counted as a failing test. Command shells and script programs can never be started. A failed step attaches a screenshot of the program's window and an outline of its controls. Password fields are never read. More: [windows-desktop-tests.md](features/windows-desktop-tests.md).

#### iOS tests

*Test an iPhone app on a simulator (an iPhone imitation on a Mac).*

- **Why you'd use it:** You cover your iOS app.
- **How:** Imported iPhone tests run only on a runner that is a Mac with Xcode (Apple's developer tools). Without one, a run is refused up front with the reason. The app must already be installed on the simulator.
- **Good to know:** This has been tried only with stand-ins for the Apple tools, not on a real Mac. Read [ios-tests.md](features/ios-tests.md) before you rely on it.

### What the platform checks besides clicks

On a first exploration most of these checks are on by default. Each finding says what is wrong and how to fix it. You switch checks on or off under **Advanced options** when you explore.

#### Visual changes

*The platform remembers what a page looks like and tells you when it changes.*

- **Why you'd use it:** You catch layout accidents no click test sees.
- **How:** Switch on **Visual change detection**. The first run saves a baseline (a reference picture of the page) and checks that the page looks the same twice. Later runs compare against it. A difference shows as **Needs a look** with the new picture and the difference in red. If the change is intended, choose **Accept new screenshot**.
- **Good to know:** Pages that change on every load (clocks, ads) cannot be compared and are marked **Failing**. Save and compare on the same kind of computer, because fonts look different on different systems.

#### Accessibility

*Checks that people with disabilities can use your pages.*

- **Why you'd use it:** You find pages that people who use a keyboard or a screen reader cannot use.
- **How:** On by default. Key pages are audited against the WCAG guidelines (the standard rules for accessible websites, levels A and AA). Serious problems become findings that name the rule, how bad it is and the affected elements.
- **Good to know:** Automatic checks find many problems but not all. They do not replace a person using a screen reader.

#### Page health

*Loads a page like a visitor and looks for broken things.*

- **Why you'd use it:** You find script errors and broken links before your users do.
- **How:** On by default. For up to six key pages that anyone can open, one test looks for script errors, failed requests to your own site, broken links, insecure (http) content on secure pages and page basics (title, language, a setting that makes the page fit phone screens, one main heading). One run reports every problem on the page.
- **Good to know:** A server error or network failure is rated high. A script error, missing page (404), broken link or insecure content is medium. Page basics are low. Known noise such as favicons, analytics and browser extensions is ignored. More: [checks.md](features/checks.md).

#### Speed checks

*Times key pages and API calls against budgets.*

- **Why you'd use it:** You notice when the app gets slower.
- **How:** Tick **Speed checks (takes longer)**. Up to five key pages are each loaded three times from scratch, and the middle result is compared with budgets for how soon content appears, how much the layout jumps, page size and number of requests. Up to eight safe API reads are timed.
- **Good to know:** A page over budget is a finding with the numbers and a hint. The Overview lists **Slowest pages**. Timings reflect the computer and network they ran on. This is not a load test. Custom budgets are in [performance.md](features/performance.md).

#### Load check

*Asks "does this stay fast with 10 people at once?"*

- **Why you'd use it:** It is a quick sign that an API call struggles under a little pressure.
- **How:** Switch on **Load check (test environments only)**. It uses up to 3 read-only API calls for about 10 seconds, with at most 300 requests each.
- **Good to know:** It stops early if the app starts failing and never runs on a production environment. A finding appears only if the call also struggled at half the users. It is not a capacity test. More: [load-testing.md](features/load-testing.md).

#### Form input checks

*Tries harmless odd text in search forms and checks a form's own limits.*

- **Why you'd use it:** You find forms that break on emoji, quotes or very long text.
- **How:** On by default. For search forms only, the platform tries seven harmless inputs, such as nothing, only spaces, 5,000 characters and emoji. It reports a finding if the text shows up as real page content, the server fails, the page goes blank or a script errors. It also checks that a field with a length limit stops at the limit, that empty required fields are reported, and that email, web address and number fields reject clearly wrong values.
- **Good to know:** Sign-in, sign-up, payment and checkout forms, and any form with a password, card or one-time-code field, are never touched. The limit checks submit nothing. More: [input-checks.md](features/input-checks.md).

#### Basic security checks

*A read-only look at your site from the outside.*

- **Why you'd use it:** You catch common hygiene problems quickly.
- **How:** On by default. It reads your site and checks the security settings your server sends, cookies, files that should never be public (such as backups and configuration files), version banners, directory listings and the HTTPS certificate.
- **Good to know:** It changes nothing, signs in nowhere and sends no attack text. Exposed secrets are rated critical, permissive sharing with credentials high, a missing content policy or insecure session cookie medium, the rest low. A file is reported only when its real contents are confirmed, so sites that answer "found" for every address do not cause false alarms. This is a hygiene check, not a penetration test (a hired attack on your site).

#### API tests

*Tests of your API, built from its description or from what the platform saw the app send.*

- **Why you'd use it:** You cover the API without writing any request.
- **How:** On when an API is found. The platform tries valid requests, missing and invalid fields, wrong types, unknown ids, extreme values, odd text, access without signing in, and multi-step flows such as list then detail.
- **Good to know:** Server errors, and access that should have been refused, are reported as findings. Tests that create, change or delete records are off until you switch on **Include API tests that change data**. Add an API token or sign-in details so tests of protected calls work.

#### API changes between runs

*Notices when your API changed shape.*

- **Why you'd use it:** You learn that a field disappeared before a client breaks.
- **How:** Nothing to switch on. The API tests remember the shape of each successful read (field names and types, never values). After two runs the Overview shows an **API changes** card with breaking changes (a field removed or changed, a call now failing or gone) and harmless ones (new fields or calls). Alerts for breaking changes are opt-in on each alert channel.
- **Good to know:** An empty list is never counted as a removal, and re-running a single test never reports calls as gone. More: [api-drift.md](features/api-drift.md).

#### API contract checks

*Compares each documented API call's real answer with its description.*

- **Why you'd use it:** The documentation and the real API disagree more often than you think.
- **How:** On by default when your API has an OpenAPI (Swagger) description, which is the document that lists the API's calls. A missing required field or wrong type is rated high, a value outside the allowed values medium, and a wrong format or extra field low. Turn it off with **Check API responses against the documentation**.
- **Good to know:** Parts of the description that allow several shapes are skipped to avoid false alarms. To compare two versions of a description, ask your admin to use the command in the [admin guide](ADMIN_GUIDE.md#7-pipelines-and-the-command-line-ai-test). More: [contracts.md](features/contracts.md).

#### Access-control checks

*Checks that pages meant for admins cannot be opened by other people.*

- **Why you'd use it:** You catch "anyone can open the admin page" mistakes.
- **How:** Add named accounts, for example *user* and *admin*, under **Library**, then **Test accounts**. While exploring, the platform signs in as each account and as a visitor, and opens pages that only a stronger account normally reaches. If the page content shows, it reports "possible broken access control". If you give an account an API token, the API's privileged-looking reads are checked too.
- **Good to know:** Addresses such as `/admin` are rated high, others low. It is a guess based on addresses, so check each finding. More: [identity.md](features/identity.md).
- **Signed-in speed and visual checks:** with a test account saved, speed and visual tests sign in first, for up to 3 pages per account and 2 accounts. A failed sign-in is reported as "could not sign in", never as a finding. More: [role-aware-checks.md](features/role-aware-checks.md).

#### AI screen review

*An AI that can read images judges screenshots for overlapping or cut-off elements and broken pictures.*

- **Why you'd use it:** You catch visual faults no fixed rule can describe.
- **How:** Tick **AI screen review (needs a vision-capable AI model)**. It is off by default and uses your configured AI.
- **Good to know:** A verdict becomes a finding only when the AI is confident, and it is labelled as an AI judgement with the screenshot. If the AI cannot read images, the test fails with a clear reason instead of passing. More: [vision-judgement.md](features/vision-judgement.md).

#### Requirements coverage

*Checks that every requirement you supplied has a test.*

- **Why you'd use it:** You show that nothing on the list was forgotten.
- **How:** Add a requirements document when exploring. Each test lists the requirements it covers. The job shows "X of Y requirements covered".
- **Good to know:** A requirement with no matching screen is listed as uncovered in the activity log, never faked.

#### Compliance

*Shows which security-control topics your tests touch.*

- **Why you'd use it:** You spot gaps before an audit.
- **How:** Open **Release**, then **Compliance**. Each control (from NIST 800-53, HIPAA and ISO 27001, three well-known security standards) shows **Covered**, **Needs attention** or **No tests yet**. A security or accessibility test's page has a **Compliance** line that opens its controls and says why.
- **Good to know:** It is an indication, not a certification. Other tests show nothing about controls.

### Seeing the big picture

#### The Overview

*Is it healthy, and what needs me?*

- **Why you'd use it:** It is the first page to open each day.
- **How:** Open a project. You see the latest result, a ribbon of passing, needing a look, failing and not run yet, **Needs your attention** (the five most serious tests) and the next scheduled run. Cards appear only when they have something to say: **API changes**, **Slowest pages**, **Test data cleanup**, **What we remember about this site**, and other-browser and environment results.
- **Good to know:** A finished exploration reads **Test suite ready** only when every planned test was made and passed. Otherwise it reads **Ready, some tests need a look** (with the reason) or **Exploration failed** (with what to do next). A finished run reads **Run finished** or **Run failed**. A project with a plan and no tests reads **Plan ready**. Detailed activity is under **View technical details**.
- **Severity:** a finding is rated critical (for example a protected page open without signing in), high (a server error, or a critical accessibility problem), medium (a serious accessibility problem) or low (a visual change, or a minor accessibility problem). A defect takes the priority of the journey it broke.

#### The Tests list

*Every test in the project, with search and filters.*

- **Why you'd use it:** You find a test, or all the tests in one state.
- **How:** Open **Tests**. Tests are grouped by feature area, 50 at a time per area (**Show more** loads the rest). Use **Search tests**, the status buttons (**Passing**, **Failing**, **Needs a look**, **Not run yet**) and, under **Filters**, the type and priority. When some tests qualify, extra buttons appear: **Weak checks**, **Quarantined** and **Differs by browser**. **Select tests** adds a tick box to each row so you can choose **Run selected**.
- **Weak checks:** a test that opens a page or clicks without checking the result passes even when the feature is broken. Such tests carry a **Weak checks** badge (hover for the reason) and a filter lists them. This is advice only: status and runs do not change. More: [test-quality.md](features/test-quality.md).
- **Good to know:** Each test has a reference number (like `API-007`) in grey small print after its type and priority. The status words are the same on every screen.

#### The fleet dashboard

*One page for all your projects.*

- **Why you'd use it:** You see at a glance which application needs you.
- **How:** With two or more projects, the **Projects** page shows each one as **ready**, **needs attention**, **blocked** or **unknown**, with reasons in words ("2 high-severity findings", "last run 12 days ago"), a ribbon and a recent trend. "How readiness is decided" lists every rule.
- **Good to know:** A project is blocked by any critical or high finding, or when its latest run failed. The page is read-only and starts nothing. More: [dashboard.md](features/dashboard.md).

#### Trends and unreliable tests

*How results develop over time, and which tests flip between pass and fail.*

- **Why you'd use it:** You tell a real decline from noise.
- **How:** Open **Runs**, then **Trends**. You see pass rate and counts over 7, 30 or 90 days, and the **Unreliable tests** list.
- **Good to know:** A test is unreliable (flaky) when its result changes without anything changing in your app. It can be put in [quarantine](#quarantine). More: [schedules.md](features/schedules.md).

#### Reports and sharing

*A report for people who will never open the platform.*

- **Why you'd use it:** You send results to a manager, a client or an auditor.
- **How:** Open **Tests**, then **More actions**, then **Export…**. The dialog offers **Download PDF**, a web page version, **Download tests** (the passing tests as a zip you can run in your own pipeline), **Export as JSON** (every test, in the format **Import tests…** understands) and **Download results** (a results file in the standard JUnit format that other tools read).
- **Good to know:** The report has a plain headline, the most serious findings with screenshots, coverage by area, security-control coverage, browser differences, slowest pages, weak tests and the full test list. Text from your application is made safe, and credentials are never included. More: [reports.md](features/reports.md).

#### Run downloaded tests on your own computer

*Take the tests with you: they run anywhere with Node.js 20 or newer, nothing else installed first.*

- **Why you'd use it:** You run the tests in your own pipeline, or keep them in your own Git repository.
- **How:** For every passing test, **Download tests** in **Export…** (above). For one test, open it, then **Code**, then **Download ready to run**. Unpack the zip, then in that folder: `npm ci`, `npx playwright install`, `npx playwright test`. The README in the folder says which settings (such as `BASE_URL` and the test account) the tests read.
- **Good to know:** The folder pins the exact versions the platform runs the tests with, with a lockfile, so every computer gets the same ones. Tests made from steps also work with Playwright 1.42.1 or newer; code tests may need the version they were written with. Phone tests run with `npm run test:phone` and need an emulator or phone. Screenshot comparisons start without their approved screenshots, and email steps only work on the platform. The folder can go into Git as it is; the platform does not push it there for you. More: [portable-code-tests.md](features/portable-code-tests.md).

#### Release sign-off and manual checks

*Decide whether a version can ship, using tests and people's checks together.*

- **Why you'd use it:** You keep a record of who approved what and why.
- **How:** Open **Release**. In **Manual checks**, add checks a person does by hand (or import and export them as CSV or JSON files). In **Releases**, create a release, mark each manual check passed, failed, blocked or skipped, then approve or reject the release. A signed release downloads as a report.
- **Good to know:** Approval is refused, with reasons, while the automatic result is blocked, a manual check failed, or a critical or high check was not run. You can override this in writing. Every decision goes into a record with the name typed in the decision dialog; **Activity** (Settings) also records which account made it. More: [manual-cases-and-signoff.md](features/manual-cases-and-signoff.md).

### Connecting other tools

#### Issue trackers

*Turn a problem a test found into an issue in GitHub, Jira or Notion.*

- **Why you'd use it:** You hand a problem to the people who fix it, with the evidence.
- **How:** Open **Setup**, then **Issue tracker**. Connect GitHub (repository and **Access token**), Jira (your Jira address, project key, Atlassian account email and **API token**) or Notion (**Notion database** link and **Notion integration token**). A token is a secret code you create in that tool so the platform can act for you. The platform tests the connection before saving. Then open a failing test, or one that needs a look, and choose **Create issue**.
- **Good to know:** The title starts with the severity. The body has what failed, the steps and a link back. Choosing twice never creates a duplicate. More: [issues.md](features/issues.md), [notion-and-sentry.md](features/notion-and-sentry.md).

#### Sentry

*Shows errors from your live app that might relate to a failed test.*

- **Why you'd use it:** A failure may already be known to your error tracker.
- **How:** Open **Setup**, then **Issue tracker**, and connect Sentry (organisation, project and **Sentry auth token**). A failed test's page then shows **Related errors in Sentry**.
- **Good to know:** Matches are by time and address, so they only might be related. The platform reads titles, counts and links only. The connection is read-only.

#### Alerts

*Be told when a run finds something.*

- **Why you'd use it:** You hear about a break without opening the platform.
- **How:** Open **Setup**, then **Alerts**, then **Add channel**. Under **Send alerts to**, choose Slack, Microsoft Teams, **Email** or **Any web address** (another system receives the message at that address). Choose the events: **A test starts failing**, **A run has failures**, **A test is unreliable**, **A failing test is fixed** and **The API changed in a breaking way**. Use **Send test** to see the real result.
- **Good to know:** Repeats of the same unchanged failure are suppressed. A list of recent alerts is on the page. Email needs a mail server set up by your admin. More: [notifications-and-import.md](features/notifications-and-import.md).

#### Running in a pipeline

*Your build pipeline replays your tests and passes or fails the build.*

- **Why you'd use it:** You stop a bad release automatically.
- **How:** Export the tests as JSON once, keep the file with your code, and ask your admin or a developer to run the `ai-test` command in the pipeline. It uses no AI and gives the same result every time. It can write reports in several formats and keep one comment up to date on a GitHub pull request (a proposed code change).
- **Good to know:** The details and examples are in the [admin guide](ADMIN_GUIDE.md#7-pipelines-and-the-command-line-ai-test). The pipeline files were tested against stand-ins, not real services. More: [ci.md](features/ci.md).

#### Using it from an AI tool

*Let Claude, Cursor or another AI assistant drive the platform.*

- **Why you'd use it:** You can ask your assistant "run the tests and tell me what failed".
- **How:** Your admin connects the assistant (see the [admin guide](ADMIN_GUIDE.md#9-use-the-platform-from-an-ai-tool-mcp)). It can then list projects, start an exploration, read failures, re-run tests, write a test and drive a live browser step by step, then save what it did as a test that is run for real.
- **Good to know:** Risky switches stay off unless asked. A run on production still needs a confirmation. Passwords, codes and card fields are never typed from the assistant's input. More: [mcp-server.md](features/mcp-server.md), [live-session.md](features/live-session.md).

#### Plug-in frameworks

*An owner can add another testing technology as a plug-in.*

- **Why you'd use it:** You run tests written for a tool the platform does not include.
- **How:** Your admin adds it. It then appears in **Settings** under **Test formats**, marked **Plug-in**.
- **Good to know:** A plug-in runs with the full power of the platform, so load only plug-ins that someone wrote or reviewed. Plug-ins run on the platform's computer only, not on runners. If a plug-in is missing, its tests stay in place and the page says what is missing. More: [adapter-plugins.md](features/adapter-plugins.md).

### Looking after the platform

#### The Settings page

*How the platform itself is set up.*

- **Why you'd use it:** You see whether the AI is connected and the platform is ready.
- **How:** Choose **Settings** in the sidebar. You see:
  - **AI model**: connected or not set up, how its recent requests went, **Fallback models**, and the switches that make AI work cheaper (prompt caching, smaller page snapshots, repairs and re-explorations without AI, a fast model for routine steps; each is described below).
  - **Access to this platform**: where you save the access key in your browser if the platform asks for one.
  - **People**, **Your account**, **Activity** and **Single sign-on** (see [People, roles and sign-in](#people-roles-and-sign-in)).
  - **Mobile testing**, **Test formats**, **AI usage**, **Storage** and **Quality of the AI tester**.
- **Good to know:** Viewers and editors can read these settings; owners change them. A choice saved here wins over the server's own setting, and **Use the server's setting** goes back to it. Pages for the whole platform (AI usage, Storage, Quality of the AI tester, People, Activity) are shown only to people with access to all projects. Your admin, not you, connects the AI service and changes other server settings. See the [admin guide](ADMIN_GUIDE.md#2-settings-env).

#### People, roles and sign-in

*Everyone signs in with their own account and has a role; Activity shows who changed what.*

- **Why you'd use it:** Each colleague gets the access they need (Owner, Editor or Viewer), nobody shares one key, and you can see who did what.
- **How:** While nobody has an account, enter the access key, open **Settings** and, under **People**, create your owner account. Then choose **Add a person**, enter the email and a role, and send the **invite link** you get to that person yourself; they choose their own password with it. Under **Your account** you change your password and make **API tokens** for scripts. **Activity** lists every change with who made it. Owners can set up **Single sign-on** with the company's OpenID Connect provider.
- **Good to know:** Owner can do everything (people, runner tokens, connections to other systems, backups). Editor creates, changes and runs tests and projects. Viewer looks at everything and downloads reports but cannot change anything. The access key keeps working for scripts and runners. The platform sends no e-mail: forgotten passwords need a reset link from an owner. More: [people-and-access.md](features/people-and-access.md).
- **Limit a person to some projects:** for a client who should see only their own work, open the person's **Projects … can see** in **Settings, People**, choose **Only these projects**, tick their projects, choose the role in each (never above their own role) and **Save access**. They then see only those projects everywhere (projects list, dashboard, security), and anything of another project looks as if it did not exist. Everyone starts with **All projects**, so nothing changes until you limit someone.

#### When the AI provider has a bad minute

*The platform asks again, or uses a fallback model, and tells you.*

- **Why you'd use it:** A busy or out-of-credit AI provider does not quietly ruin a job, and you know what happened.
- **How:** Under **Settings**, **AI model** shows how the model's recent requests went (share that worked, how long answers take, the last problem in plain words). **Check the connection** sends one tiny request. **Fallback models** lists the models to ask, in order, when the main one is unavailable or out of credit. During a job, its activity says when the platform asked again, switched to a fallback model, or paused calls to a failing provider, and which model answered.
- **Good to know:** A connection check counts as AI usage ("Connection checks" under AI usage). A fallback on another provider needs that provider's key on the server; one the server cannot use is listed with the reason. More: [ai-model-reliability.md](features/ai-model-reliability.md).

#### Storage and backup

*See how much disk the files use, remove old files, and back up a project.*

- **Why you'd use it:** You keep the disk from filling up, and you keep a copy.
- **How:** Open **Setup**, then **Storage and backup** (or **Settings**, then **Storage** for the whole platform). Turn on automatic clean-up to remove old screenshots, videos, traces and evidence after the number of days you choose. A preview shows exactly what would go before you confirm. **Download backup** saves a project as a zip file. **Restore from a backup** makes a new project from it.
- **Good to know:** Clean-up is off by default. Tests, run history, issues, releases, approved reference pictures, the newest runs and the files behind an open issue or a signed release are never removed. A backup contains no secrets. After a restore, the tests wait to be run, and you get a list of secrets to enter again. More: [storage-and-backup.md](features/storage-and-backup.md).

#### AI usage and limits

*See what the AI costs in use, and set limits.*

- **Why you'd use it:** You avoid surprise bills.
- **How:** Open **Settings**, then **AI usage**. It shows tokens (the small units an AI service bills in) used this month by day, project, purpose and model. Set an optional monthly limit for the platform, a monthly limit per project and a limit per job. Enter a price per model to see a cost.
- **Good to know:** When a limit is reached, the job stops cleanly, keeps the tests it made and still runs them. A scheduled exploration is skipped. No prices are built in. Only counts are stored, never questions or answers. More: [ai-usage-budgets.md](features/ai-usage-budgets.md).

#### Reuse of repeated instructions (prompt caching)

*The same instructions are not paid for in full on every AI call.*

- **Why you'd use it:** AI work costs less. A web test written step by step resends its instructions and the conversation so far at every step; a provider with a prompt cache reads that part at a fraction of the price.
- **How:** Nothing to do: it is on by default. **Settings**, **AI model** has the switch **Reuse repeated instructions (prompt caching)** and one sentence on what it does for your model. **AI usage** then shows how much of the input came from the cache (**From cache**), and a job's technical details say it too. Under **Prices** you can enter your provider's price for cached input and cache writes.
- **Good to know:** The model gets exactly the same request either way, so the tests and their results do not change. It works with Anthropic directly and with Anthropic models on OpenRouter; OpenAI and Google cache on their own. Toward the limits, a token read from the cache counts as a tenth of a token. More: [prompt-caching.md](features/prompt-caching.md).

#### Smaller page snapshots

*The AI reads a shorter version of each page while it writes a test.*

- **Why you'd use it:** AI work costs less. After every action the AI reads the page again, and every earlier look stays in the conversation, so long pages make up most of the cost.
- **How:** Nothing to do: it is on by default. The AI gets a compact first look at each page (decorations left out, long lists shortened to the first few plus the names of the rest) and then only what changed; it can ask for the whole page whenever it needs it. **Settings**, **AI model**, **Send smaller page snapshots to the AI** turns it off. A job's technical details show about how many tokens it saved.
- **Good to know:** Names and roles the AI copies into a test are never changed, so the tests stay the same. Phone exploration uses shorter screen descriptions the same way. More: [smaller-snapshots.md](features/smaller-snapshots.md).

#### A fast model for routine steps

*Routine AI steps go to a cheaper model; the main model keeps the hard work and takes over when the fast one struggles.*

- **Why you'd use it:** AI work costs less. Most calls of a job are the next step of a test being written or the next tap of a phone exploration, and a smaller model handles those.
- **How:** In **Settings**, **AI model**, type a model under **Fast model for routine steps** (for example `claude-haiku-4-5`) and choose **Save fast model**. **What goes to which model** lists the split. Understanding the application, planning, repairs and anything with a screenshot stay on the main model. When the fast model gives an unusable answer, fails the same action twice, repeats itself or makes no progress, the main model does the rest of that test, and the job's activity says so.
- **Good to know:** Empty (the default) means the main model does everything, as before. Hand-overs are counted in **AI usage** ("escalated to the main model"), and each model's tokens are listed separately so its own price applies. A fast model on another provider needs that provider's key on the server. More: [model-routing.md](features/model-routing.md).

#### Repairs and re-explorations without AI

*Simple repairs and unchanged pages do not go to the AI.*

- **Why you'd use it:** AI work costs less. A button renamed from "Sign In" to "Sign in", or a button that became a link with the same text, does not need the AI to be fixed; a page that did not change since the last exploration does not need to be read again.
- **How:** Nothing to do: both are on by default. When a test being created cannot find an element, the platform first tries plain fixes (another way to find a shared element, the same role and name, the same text, the element's own attributes) and keeps one only if the test then passes; the AI is asked only when none does. When you explore a site again, pages that have not changed are not sent to the AI again. **Settings**, **AI model** has a switch for each. To have every page looked at afresh once, tick **Send every page to the AI again** under **Advanced options** when you start the exploration.
- **Good to know:** The job's activity says which fixes were made without AI and which pages were reused, and its technical details count them under **Done without AI**. To check these savings and the others do not cost quality, run `node scripts/eval.mjs --compare` (see the next section). More: [repair-and-reuse-without-ai.md](features/repair-and-reuse-without-ai.md).

#### Quality of the AI tester

*Measure how well the AI tester does on your own list of websites and apps.*

- **Why you'd use it:** You see in numbers whether a new version or another AI model makes better tests, instead of guessing.
- **How:** List your apps in `eval/corpus.json`, then run `node scripts/eval.mjs` on the computer that has the platform. For each app the AI explores, plans and creates tests, then every test is run 3 more times. Open **Settings**, then **Quality of the AI tester**, to see each run: stable, flaky, passing first time, coverage, and whether it is better or worse than the run before.
- **Good to know:** It uses your AI model, so it costs money; `--plan-only` is cheaper. `--compare --warm` runs the list twice, with the AI savings off and then on, and says whether the quality held (pass rate at most 2 points lower, no more false failures) and how many tokens were saved. Sign-in details in the list are names of environment variables, never the values. Whether a failing test is a product problem or a wrong test is a guess from the reason, so check a few. More: [evaluation.md](features/evaluation.md).

#### Site memory

*The platform remembers the structure of your site between explorations.*

- **Why you'd use it:** The next exploration starts from what is known and shows what changed.
- **How:** After an exploration, the Overview shows **What we remember about this site**, with what changed ("2 new pages, 1 page changed"). Choose **Forget what we learned** to clear it. You can turn it off for a single run with **Start from what we learned last time**.
- **Good to know:** It remembers pages, journeys and API addresses, never page text, credentials or user data. Until something is remembered, the card is not shown. More: [site-memory.md](features/site-memory.md).

#### Test data cleanup

*Removes the records your tests created.*

- **Why you'd use it:** Tests that change data leave no mess in your app.
- **How:** When tests that change data are on, the platform notes each record a test creates and removes only those afterwards, using the same sign-in. The Overview card **Test data cleanup** shows what was removed and what stayed and why, with a retry for failures. The Library's **Test data** section shows the same list. You can switch cleanup off per project.
- **Good to know:** Scripts you download delete their own records. A record the platform cannot safely delete is left and listed. More: [test-data-cleanup.md](features/test-data-cleanup.md).

#### Framework settings

*The few settings that change how each kind of test runs.*

- **Why you'd use it:** You raise a time limit for a slow app, or turn a kind of test off.
- **How:** Open **Setup**, then **Frameworks**, then **Change**. Each kind of test (web, API, Android, Windows desktop) shows where it can run, an on and off switch, and settings such as the test time limit, how many tests run at once, showing the browser (only on a runner where someone can watch), the default emulator and the Windows start time limit.
- **Good to know:** A kind that is turned off is refused with a plain reason. Retries are deliberately not offered because they hide flaky tests. A project that never touches these runs as before. More: [framework-settings.md](features/framework-settings.md).

#### Check a new machine (doctor)

*A check that a computer is ready to run the platform.*

- **Why you'd use it:** You find out what is missing before a test fails for a reason that has nothing to do with your app.
- **How:** Ask your admin, or the person who set the computer up, to run it. It lists what is ready, missing or optional, with a fix for each.
- **Good to know:** It never shows secret values and never starts a browser or a server. See the [admin guide](ADMIN_GUIDE.md#4-check-a-new-machine-doctor). More: [doctor.md](features/doctor.md).

---

## Security assessment

A separate part of the platform for **passive, read-only security assessments** of applications a client has authorized you to assess,
and for managing what they find. It is not functional testing and its results never mix with your tests. It sends only the ordinary
requests a visitor's browser makes (no attack payloads, no forms submitted, nothing outside the scope you set) and judges the answers for
configuration problems: security headers, cookie flags, HTTPS, cross-site access (CORS), files that should not be public, version banners,
directory listings. When your admin has turned the module off, none of this shows.

- **Where:** *Security assessment* in the sidebar (under its own heading; the projects you test are under *Functional testing*). Inside a
  project: the *Security assessment* tab, with Overview, Applications, New assessment, Assessments, Findings, Reports, Activity and
  Notifications.
- **Choose what a project is for:** on *New project*, pick **Functional testing**, **Security assessment** or **Both**. An existing project
  can include it too: open *Setup*, then *Testing type*, Change. Nothing is deleted when you change it.
- **1. Register the application:** its name, target address, environment and anything else in scope; under *Advanced*, paths never to
  request, the most requests per second (1 to 10) and an API document address. To look at signed-in pages too, choose a **saved
  sign-in** (the project's own or a test account's; the page says whether it is ready or has expired). Under *Advanced*, list
  **sensitive workflows** (payments, deleting an account): their paths are never requested. On the application's page you can upload a
  saved sign-in file and an **API document** (OpenAPI or Swagger, JSON or YAML, up to 2 MB); the page lists its operations and which
  ones an assessment would request (only GET operations that need no values).
- **2. Record the authorization:** who approved the assessment, their email, the permission document and any restrictions, then tick the
  statement that names the client, the target and the scope. Only a project owner can record or withdraw one. Changing the target, scope,
  exclusions, request limit, saved sign-in or sensitive workflows makes it **out of date**: the page says so and asks for it again before the next assessment.
- **3. Run a passive assessment:** *New assessment* says exactly what it does and does not do and shows the limits; Start. The progress page
  says what is happening in plain words; **Stop assessment** stops it within seconds and keeps what was found. **Emergency stop** (top right
  of every security page) stops every running assessment of the project at once. A signed-in assessment checks every few pages that the
  saved sign-in still works; if the session ends, it carries on signed out (it never signs in again) and the coverage says after how many
  pages signed-in pages were no longer inspected: save the sign-in again in *Setup*.
- **4. Work through the findings:** filter by application, severity, category, state, date, location or words. A finding shows its evidence
  (secret-looking values are hidden), why it matters, how to fix it and how to see it yourself in a browser. Change its state (Needs a
  look, Probable, Confirmed, Risk accepted, Not a problem, Fixed) with a reason; the history keeps who, when and why. *Risk accepted* is an
  owner's decision. **Add a finding by hand** for something the client's own tools found.
- **5. Retest and report:** *Retest* on a finished assessment re-checks the open findings; those no longer seen are marked fixed.
  *Reports* shows the report in the page and downloads it as PDF, the findings as CSV, or an **Excel workbook** with a Summary sheet
  and a Findings sheet (every cell plain text or a number, never a formula).
- **Activity and notifications:** *Activity* lists who did what and when in the project's security work, with filters. *Notifications*
  chooses when the project's alert channels hear about an assessment (new critical or high findings, including ones marked fixed that
  came back, and failures are on unless you change them; every finish is off) and which channels; the alert channels themselves are set up under *Setup*, *Alerts*.
- **Backups:** a project's backup (*Storage and backup*, *Download backup*) includes its security work: applications, authorizations,
  assessments, findings with their history, and the activity, with secrets left out as everywhere. Restoring it makes a new project in
  which nothing is authorized and nothing runs: record a new authorization before the next assessment, and sign in again for a signed-in
  assessment. To restore a project on a platform version from before the security data was in backups, an owner ticks **Leave out the
  security assessment data** before *Download backup* (recorded in Activity).
- **Who can do what:** viewers read everything; editors register and change applications, run assessments and set the testing type;
  owners record and withdraw authorizations, accept risks and delete applications. A person limited to some projects (see
  [People, roles and sign-in](#people-roles-and-sign-in)) sees only the security work of those projects.
- **What it never does:** it never sends attack text, never submits a form, never signs in by itself (a signed-in assessment only
  loads a saved sign-in) and never requests anything but plain reads (GET, HEAD, OPTIONS). It stays on the authorized addresses: excluded
  and sensitive paths are never requested, every redirect is checked again, a redirect that leaves the scope is not followed, and
  addresses inside a company network or a cloud provider's internal addresses are refused (private ones only when your admin allows
  them). It keeps to the request rate you set (1 to 10 per second, 2 unless you change it).
- **Good to know:** the overview's risk line comes with the rules that decide it, and every assessment says what it could not inspect
  (for example signed-in areas). It is never a statement that an application is secure. More:
  [security-assessment.md](features/security-assessment.md).
- **Optional extra tools:** an admin can switch on ZAP, Nuclei, Schemathesis or Promptfoo for chosen projects
  ([security-scanners.md](features/security-scanners.md)). Nothing runs until both an admin names the tool for the platform and an editor
  allows it for that project, and the report says in plain words which tools ran, which did not, and why.

---

## Staying in control

These ideas run through the whole product.

- **You can always see the test.** Every test shows its steps, its text and its script. Nothing is hidden in a black box.
- **Nothing is created behind your back.** An exploration stops at a plan. You approve it before any test exists.
- **The AI's work is labelled.** Where the AI acted, the page says so. A test says where it came from. An AI judgement of a screenshot is marked as one.
- **Nothing risky runs on production without asking.** A production environment is read-only and always asks for confirmation. Tests that change data are skipped there.
- **You can stop a run.** Stop says what it keeps. Tests that did not finish keep their previous result.
- **Changes can be undone.** Every edit is a version. **Undo**, **Undo this repair** and **Restore this version** go back. Nothing is deleted.
- **Secrets are never shown.** Passwords and tokens are write-only, stored encrypted and hidden in reports, issues and logs.
- **Dangerous things are opt-in.** Tests that change data, load checks, code tests, plug-ins and desktop programs are off until an owner turns them on.
- **Each person sees what they should.** Everyone signs in with their own account and role, a person can be limited to some projects, and **Activity** lists who changed what.
- **No security assessment without permission.** An assessment runs only with a current authorization recorded by a project owner, stays inside its scope, and **Emergency stop** stops all of them at once.
- **Saving on the AI never changes what is judged.** Each saving can be switched off in **Settings**, **AI model**, triage and repairs stay on the main model, and **Quality of the AI tester** can compare results with the savings off and on.

---

## Words you will meet

- **Accessibility:** how usable a page is for people with disabilities, for example people who use a screen reader.
- **Alert:** a message sent to Slack, Teams, email or another system when a run finds something.
- **API:** the way programs talk to your application. A website's screens are for people, and its API is for programs. Like a restaurant's kitchen window: customers use the menu, the waiters use the window.
- **API endpoint:** one place in an API where a program asks for something, such as "the list of products".
- **Access key** (also called the API key): a secret code the owner may set so that only people who have it can use the platform. You type it on the first screen or save it under **Settings**, **Access to this platform**. It is not the AI provider key. The AI provider key stays on the server, and nobody who uses the platform ever sees or needs it.
- **API token:** a secret code that lets a program use your API as a signed-in user. Other tools use the same word, or "access token", for a secret code you create there. The sign-in form calls it a **Bearer token**.
- **Authorization:** in a security assessment, the record that the client owns the application, or that its owner agreed in writing, to have it assessed within a stated scope. No assessment runs without a current one.
- **Auto-fix:** a fix the platform makes by itself while it creates a test. It is listed in the test's history. Compare *repair*.
- **Baseline:** the saved picture a page is compared against. Like a "before" photo.
- **Build pipeline:** the automatic process that builds your software and releases it, often called CI. It can ask this platform to run tests.
- **Code test:** a test written as a script. Also called a hand-written test. You get one with **Write code** or **Switch to code**.
- **Contract:** the promise your API's description makes about what its answers look like. A contract check compares the real answer with the promise.
- **Deploy token:** a secret code your build pipeline sends to ask the platform to run tests after a new version goes live.
- **Device farm:** a company such as BrowserStack, Sauce Labs or LambdaTest that rents out real phones over the internet for running tests.
- **Drift (API changes):** the API's answers slowly changing shape between runs.
- **Emulator:** a phone imitation that runs on a computer. Like a flight simulator, but for phones.
- **Environment:** a named place to run against, such as staging or production, with its own address and sign-in.
- **Escalation (escalated to the main model):** the fast model handing the rest of a test to the main model because it gave an unusable answer, repeated itself or made no progress.
- **Evidence:** what a failed test leaves behind: screenshot, recording, trace and the requests the page made.
- **Exploration:** the AI looking around your application and planning tests. Also called analysis. Not the same as a run.
- **Failing:** a check did not pass, or the test could not run.
- **Fast model:** a cheaper AI model the owner can name in **Settings**, **AI model**, for routine steps. The main model keeps the hard work.
- **Finding:** a problem the platform found in your application, such as a missing security setting. A finding is not a broken test. A test that found one reads **Needs a look**. A security assessment's findings are kept apart from your tests and have their own states (Needs a look, Probable, Confirmed, Risk accepted, Not a problem, Fixed).
- **Flaky (unreliable):** a test that sometimes passes and sometimes fails without any change in your app. Like a light that flickers.
- **Frameworks:** the different technologies tests are written in, such as web, API, Android or Windows desktop. **Setup**, then **Frameworks**, holds their settings.
- **Git repository:** a project folder kept in Git, where developers store their code and its history.
- **Journey:** a path a real person takes through your app, such as searching and then buying.
- **Library:** the project place where shared things live: reusable steps, shared elements, helpers, test data and test accounts.
- **Needs a look:** a test that ran and found something wrong in your application. Its job worked. Open it to see what.
- **Not run yet:** a test that has never been run.
- **Passing:** the test ran and every check passed.
- **Phone tools (adb):** Google's small program that lets a computer talk to an Android phone over USB. A downloaded runner fetches it by itself when it needs it.
- **Plan:** what an exploration proposes to create. Nothing is built until you choose **Create the tests**.
- **Plug-in:** an extra piece of code an owner adds to teach the platform a new testing technology.
- **Prompt caching:** the AI provider keeping the instructions that repeat on every call, so they are billed at a fraction of the price the next time.
- **Quarantine:** setting a flaky test aside so it still runs but stops counting. Like benching a player who is not fit.
- **Repair:** a suggestion to fix a test after your app moved a button. You apply it. Compare *auto-fix*.
- **Reusable steps:** a named group of steps, such as "Sign in", used in many tests. Also called a block.
- **Role:** what a person may do: **Owner** (everything), **Editor** (create, change and run) or **Viewer** (look and download). A person limited to some projects has a role per project.
- **Run:** executing tests that already exist. Not the same as an exploration.
- **Run sequence:** a chain of steps with branches, for example run quick tests, then everything only if they pass. Also called a runbook.
- **Runner:** a computer that runs your tests, other than the platform's own. Also called a runner agent.
- **Saved sign-in:** the state of a browser after you signed in yourself once, kept so tests, explorations and signed-in security assessments start signed in without typing a password.
- **Schedule:** a timetable that runs tests or an exploration by itself.
- **Scope:** in a security assessment, the addresses the client authorized. Nothing outside it is ever requested.
- **Security assessment:** a passive, read-only look at a client-authorized application's security settings, kept apart from functional testing.
- **Severity:** how serious a finding is: critical, high, medium or low.
- **Shared element:** a button or field named once and used in many tests. Also called an object.
- **Site memory:** the platform's notes about the structure of your site, kept between explorations.
- **Test:** one check of one thing in your app, made of steps. Each test is **Passing**, **Failing**, **Needs a look** or **Not run yet**.
- **Test account:** a sign-in made for testing, not a real person's login.
- **Test data:** a table of values a test can run with, one row at a time.
- **Trace:** a recording of everything a failed test did, which you open in a browser to step through.
- **Weak checks:** a badge on a test that passes while checking very little.

---

## When something goes wrong

| Problem | What to do |
|---|---|
| **The AI is not set up.** The sidebar says **AI not set up**, or exploring says the AI model is not set up. | Ask your admin to add the AI service key and restart. API tests and accessibility checks still work without it. |
| **I cannot reach the platform, or it asks for a key.** | Check the address. If it says access is denied, ask the owner for the access key and save it under **Settings**, **Access to this platform**. |
| **"We couldn't access this application".** | Check that the address is right and that the app is running and reachable from the platform's computer. A site on your own network may need a runner. |
| **Only sign-in tests were made.** | Add a test account when you explore, so the platform can see past the sign-in page. |
| **Protected API tests fail.** | Give an API token, or OAuth2 sign-in details, when you explore. |
| **Few or no API tests.** | Give the address of your API description, or an API token. If appropriate, switch on **Include API tests that change data**. |
| **Lots of findings on the first run.** | This is expected. The health and security checks find real small problems, and each says how to fix it. You can switch a check off when exploring. |
| **A test fails only sometimes.** | It is flaky. Run it again and look at **Trends**. If it cannot be fixed, use **Quarantine**. |
| **A visual test says the page is "not visually stable".** | The page changes on every load, so it cannot be compared. Visual checks do not suit that page. |
| **Some test ideas "could not be authored".** | Check that the platform can reach the site, then explore again. |
| **A phone test "couldn't find" something.** | Compare the text or label in the test with what the emulator shows. The failed step's screenshot shows what was visible. |
| **A test failed after my app changed.** | Open the test. If a repair is offered, read it and apply it. Otherwise edit the steps. |
| **The runner shows offline.** | The computer is off, lost its network or the runner program stopped. Ask whoever owns that computer. See the [admin guide](ADMIN_GUIDE.md#6-runner-agents-tests-on-another-computer). |
| **Firefox or Safari show "unavailable".** | The browser is not installed on that computer. Ask your admin. |
| **A code test will not run.** | Code tests run only where the owner allowed them. Ask your admin to allow it, or use a runner started for it. |
| **"Mobile tests need an app to test".** | Open **Setup**, **Mobile app**, **Change**, and add a package name or an `.apk` file. |
| **"This computer can't run mobile tests yet".** | The Android tools are not installed. Ask your admin ([admin guide](ADMIN_GUIDE.md#5-mobile-desktop-and-ios-tests)). |
| **Scheduled runs do not happen.** | Check the schedule's note for "skipped" (an earlier job was still running), and that scheduling is on. Ask your admin if it is switched off. |
| **Alerts do not arrive.** | Choose **Send test** on the channel. The recent alerts list shows the real result. |
| **I hit an AI limit.** | Raise the limit under **Settings**, **AI usage**, or wait until next month. Tests already made are kept. The switches under **Settings**, **AI model** (prompt caching, smaller snapshots, a fast model, without AI) make each job use less. |
| **The runner does not connect.** | Run **Check this computer** in the runner's folder (`check-computer.cmd` on Windows, `sh check-computer.sh` on Mac and Linux). It names what is wrong: Node.js, the proxy, a certificate, the platform's address or the token. See [Runners on a company network](#runners-on-a-company-network). |
| **The phone is not found on the runner.** | Unlock the phone and tap **Allow** on "Allow USB debugging?". The runner's row (**Setup**, **Runners**, **Show details**) shows the state of the **Android phone tools**; the first phone session downloads them, which needs internet access. |
| **A device farm run fails at once.** | Choose **Check connection** under **Setup**, **Mobile app**, **Device farm**, and check that the app's `.apk` was uploaded. |
| **A page says "This is for people with access to all projects".** | You are limited to some projects, and that page covers the whole platform. Ask an owner. |
| **A project I expected is missing.** | You may be limited to some projects. An owner can add it under **Settings**, **People**. |
| **A security assessment will not start: the authorization is out of date.** | The target, scope, exclusions, request rate, saved sign-in or sensitive workflows changed after it was recorded. A project owner records it again. |
| **A signed-in security assessment stopped seeing signed-in pages.** | The saved sign-in expired during the assessment. Save the sign-in again under **Setup** and run the assessment again; the coverage says how far it got. |
| **The AI wrote a different test after I turned on a fast model.** | Turn **Fast model for routine steps** off (leave it empty) and compare. To measure it properly, ask your admin to run `node scripts/eval.mjs --compare --warm`. |

---

## Honest limits

- **iOS is not proven on real hardware.** It has been tried only with stand-ins for the Apple tools, not on a real Mac.
- **Phones are imitations.** Phone and tablet checks in browsers, and Android tests, run in imitations on a computer. A real phone on a runner is also not verified on real hardware.
- **Code tests and plug-ins are not sandboxed.** They run with the rights of the computer that runs them, and only where an owner allowed it. The check before saving catches mistakes, not attackers.
- **The AI explores Android apps, not iPhone apps or Windows programs.** For an Android app it taps through the app on an emulator or phone and plans tests; it cannot get past captchas or a fingerprint check, and it does not explore games or screens drawn without labels. For an iPhone app or a Windows program you write or import the tests. Nothing about phone exploration has been verified on a real phone or emulator by the people who built it.
- **Some sign-ins need you once.** A test cannot type its way through a CAPTCHA (the "I am not a robot" puzzle), single sign-on or a Google or Microsoft sign-in: sign in yourself once and save the sign-in. Codes from an authenticator app and codes or links sent by email (through the test mailbox) work; codes sent by text message do not.
- **Security, compliance and accessibility results are indications.** The security checks and the security assessment are a passive, read-only look from outside, not a penetration test: they send no attack text and find configuration problems, not every weakness. A report never says an application is secure. Compliance shows coverage, not certification. Automatic accessibility checks find many problems, not all.
- **Device farms were tried only against a stand-in**, not a real BrowserStack, Sauce Labs or LambdaTest account.
- **The AI savings were measured with stand-in AI models.** How much they save, and that tests stay as good, is checked on your own apps with `node scripts/eval.mjs --compare --warm`, which uses your AI model and costs money.
- **Timings depend on the computer and network.** Speed and load checks are quick signals, not capacity tests.
- **Pipeline files and the GitHub and Jira connections were tested against stand-ins**, not live services.
- **Names in a release sign-off are typed.** The decision dialog asks for a name; **Activity** records which account made the decision.
- **The platform sends no email to people.** Invite and password reset links are made by an owner and passed on by hand. (Alerts can go to email when your admin set up a mail server.)
- **A test has no duplicate or delete action.**
