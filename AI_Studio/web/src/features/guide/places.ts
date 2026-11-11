import { LIBRARY_SECTIONS, RELEASE_SECTIONS, RUNS_SECTIONS, SCRIPTS_SECTIONS, SETTINGS_SECTIONS, SETUP_SECTIONS } from "../../lib/router.js";
import type { WhereTo } from "./types.js";

/**
 * What the Help panel says for every place a person can be in. All of it is plain language, and every button, tab and menu
 * name is written exactly as it is on screen (`ui` lists them so a test can prove they exist in the web code).
 * Actions only ever take the person somewhere or open a topic: the panel never starts a run and never changes data.
 */

export type Target =
    /** Open a guide topic in the panel. `search` is what to look for instead, if the topic id is not there. */
    | { topic: string; search?: string }
    /** Show search results for these words (when no single topic is the answer). */
    | { search: string }
    /** Go to a place of the app (the current project is filled in). */
    | { where: WhereTo }
    /** Go to another tab of the test that is open. */
    | { testTab: "steps" | "text" | "code" | "history" };

export interface HelpAction {
    /** One short plain sentence saying what the person can do here. */
    text: string;
    /** The button that goes with it, verb first. */
    button: string;
    to: Target;
    /** On-screen names used in `text` and `button` (verbatim), so a test can confirm they exist. */
    ui?: string[];
}

export interface PlaceHelp {
    title: string;
    /** What this place is, in one or two plain sentences. */
    what: string;
    /** 3 to 6 things to do here. */
    canDo: HelpAction[];
    /** Glossary ids of the words that matter on this page. */
    words: string[];
    /** One or two suggestions for what to do after this. */
    next: Array<{ text: string; button: string; to: Target; ui?: string[] }>;
    /** The topic that explains this place in full (the "Read more" link). */
    topic?: string;
    /** On-screen names used in `what` and `next` text (verbatim). */
    ui?: string[];
}

export type PlaceId =
    | "projects"
    | "welcome"
    | "new-project"
    | "plan-preview"
    | "overview"
    | "tests"
    | "runs-runs"
    | "runs-schedules"
    | "runs-deploys"
    | "runs-trends"
    | "run-detail"
    | `library-${(typeof LIBRARY_SECTIONS)[number]}`
    | "library-steps-edit"
    | `release-${(typeof RELEASE_SECTIONS)[number]}`
    | "release-detail"
    | `setup-${(typeof SETUP_SECTIONS)[number]}`
    | "test-steps"
    | "test-text"
    | "test-code"
    | "test-history"
    | "recorder"
    | "write-code"
    | "settings"
    | "security-home"
    | "security-project"
    | "guide"
    | "guide-topic"
    | "guide-words"
    // Round 25: the global places and the project places that are new (docs/product-restructure/INFORMATION_ARCHITECTURE.md).
    | "dashboard"
    | "develop"
    | "runners-global"
    // Round 37: integrations set up once for an organisation (features/integrations/IntegrationsPage.tsx).
    | "integrations"
    | "folders"
    // Round 37: Reusable libraries took the Folders place in the menu; project folders open from the Projects page.
    | "libraries"
    | "library-library"
    // Round 37: the testing agents (features/testing-agents).
    | "agents"
    | "profile"
    | "requirements"
    | "suites"
    | "suite-detail"
    | "scripts"
    | "scripts-review"
    | "script-version"
    | "agent-runs"
    | "settings-general"
    | "settings-members"
    | "settings-ai";

const here = (place: WhereTo["place"], section?: string): Target => ({ where: section ? { place, section } : { place } });

export const PLACES: Record<PlaceId, PlaceHelp> = {
    projects: {
        title: "Your projects",
        what: "A project is one application you want to test. This page lists them, with how many of their tests are passing.",
        canDo: [
            { text: "Open a project to see its tests and results.", button: "Open the topic about places", to: { topic: "places" } },
            { text: "Start a new project for another application.", button: "Start a project", to: { where: { place: "new-project" } } },
            { text: "Look at the Guide when you are not sure where to begin.", button: "Read the start in 10 minutes", to: { topic: "first-steps" } },
        ],
        words: ["test", "run", "passing"],
        next: [{ text: "Open a project, then look at its Dashboard.", button: "Read how a project is laid out", to: { topic: "places" }, ui: ["Dashboard"] }],
        topic: "places",
    },
    welcome: {
        title: "Welcome",
        what: "You have no project yet. Here you choose how to get your first tests. Nothing runs until you say so.",
        canDo: [
            { text: "Choose Explore my app to let the AI look around your website, API or Android app and suggest tests.", button: "Read how exploring works", to: { topic: "explore-my-app", search: "get tests for my app" }, ui: ["Explore my app"] },
            { text: "Choose Record a test to click through your application yourself and turn it into a test.", button: "Read how recording works", to: { topic: "record-a-test", search: "record a test" }, ui: ["Record a test"] },
            { text: "Choose Start from tests I have to bring tests you already have, from a file or a Git repository.", button: "Read how to bring tests", to: { topic: "import-tests", search: "import tests" }, ui: ["Start from tests I have"] },
        ],
        words: ["test", "exploration", "plan"],
        next: [{ text: "After the AI explores, you get a plan to read. Nothing is created until you agree.", button: "Read the 10-minute start", to: { topic: "first-steps" } }],
        topic: "first-steps",
    },
    "new-project": {
        title: "Start a project",
        what: "Tell us the address of your application and the AI explores it. You will see a plan before anything is made.",
        canDo: [
            { text: "Type the address of your application, then choose Start exploring.", button: "Read how exploring works", to: { topic: "explore-my-app", search: "get tests for my app" }, ui: ["Start exploring"] },
            { text: "Fill in Focus (optional) to tell the AI what matters most. The whole application is still explored.", button: "Read how exploring works", to: { topic: "explore-my-app", search: "get tests for my app" }, ui: ["Focus (optional)"] },
            { text: "Which checks run is set by the project's Testing agents in Settings, then General.", button: "Read about the checks", to: { search: "checks besides clicks" }, ui: ["Testing agents", "Settings", "General"] },
            { text: "Keep the sign-in details on the Requirements tab, under What the agents need, if your application needs a login.", button: "Read about test accounts", to: { topic: "test-accounts", search: "test accounts login" }, ui: ["Requirements", "What the agents need"] },
            { text: "Go back to your list of projects.", button: "Back to projects", to: here("projects") },
        ],
        words: ["exploration", "plan", "test-account"],
        next: [{ text: "When the exploration ends, read the plan on the project page.", button: "Read about the plan", to: { topic: "explore-my-app", search: "plan before tests are made" } }],
        topic: "explore-my-app",
    },
    "plan-preview": {
        title: "The plan",
        what: "The AI has explored your application and wrote down the tests it would make. Nothing has been created yet.",
        canDo: [
            { text: "Read the list of tests and the checks it would add.", button: "Read about the plan", to: { topic: "explore-my-app", search: "plan before tests are made" } },
            { text: "Choose Create the tests when the plan looks right.", button: "Read what happens next", to: { topic: "explore-my-app", search: "create the tests" }, ui: ["Create the tests"] },
            { text: "Choose Explore again to start over with different options.", button: "Read about exploring again", to: { topic: "explore-my-app", search: "explore again" }, ui: ["Explore again"] },
        ],
        words: ["plan", "exploration", "test"],
        next: [{ text: "After the tests are created, choose View tests on the Dashboard to see them.", button: "Open Test scripts", to: here("tests"), ui: ["View tests", "Dashboard"] }],
        topic: "explore-my-app",
    },
    overview: {
        title: "Project dashboard",
        what: "The summary of one project: what the last exploration or run found, which tests need your attention, and what to do next.",
        canDo: [
            { text: "See which tests are failing or need a look.", button: "Open Test scripts", to: here("tests"), ui: ["Test scripts"] },
            { text: "In an AI agent project, choose Explore again to look at the application once more and find new things to test.", button: "Read about exploring again", to: { topic: "explore-my-app", search: "explore again" }, ui: ["Explore again"] },
            { text: "In a code project, choose Add test scripts to start: code projects are not explored.", button: "Read about writing code", to: { topic: "write-code" }, ui: ["Add test scripts"] },
            { text: "While it explores, turn on Watch live to see the browser the AI is using.", button: "Read how to watch the AI", to: { topic: "watch-the-ai" }, ui: ["Watch live"] },
            { text: "Look at past results in Runs.", button: "Open Runs", to: here("runs"), ui: ["Runs"] },
            { text: "Learn what the tabs at the top are for.", button: "Read about the places", to: { topic: "places" } },
        ],
        words: ["passing", "failing", "needs-a-look", "not-run-yet"],
        next: [{ text: "If tests are failing, open one to see what went wrong.", button: "Read how to see why a test failed", to: { topic: "what-the-page-did", search: "why did a test fail" } }],
        topic: "places",
    },
    tests: {
        title: "Test cases",
        what: "The written checks of a code project: a title, steps, what should happen and a requirement. Each is Automated (a tool can do it) or Manual (a person does it).",
        canDo: [
            { text: "Choose Add test case (manual), then Write one by hand, to add one yourself.", button: "Read about test cases", to: { topic: "requirements-coverage" }, ui: ["Add test case (manual)", "Write one by hand"] },
            { text: "Choose Generate from requirements to let the AI write test cases for the requirements you pick.", button: "Read about requirements", to: { topic: "requirements-coverage" }, ui: ["Generate from requirements"] },
            { text: "Choose Import to bring in test cases from a CSV or JSON file.", button: "Read about sharing checks", to: { topic: "release-signoff", search: "manual checks" }, ui: ["Import"] },
            { text: "Use All, Automated and Manual to see one type at a time.", button: "Read about test cases", to: { topic: "requirements-coverage" }, ui: ["All", "Automated", "Manual"] },
            { text: "Use Generate test scripts to have the AI write a runnable test script for each automated test case. It needs both Write tests and Generate tests with AI.", button: "Open Test scripts", to: here("tests"), ui: ["Generate test scripts", "Test scripts", "Write tests", "Generate tests with AI"] },
        ],
        words: ["test", "manual-check"],
        next: [{ text: "Run the test scripts made from your cases on Test scripts.", button: "Open Test scripts", to: here("tests"), ui: ["Test scripts"] }],
        topic: "requirements-coverage",
    },
    "runs-runs": {
        title: "All runs",
        what: "Every exploration and every run of tests, newest first. Open one to see what ran, what passed and what did not.",
        canDo: [
            { text: "Open a run to see its tests and what changed.", button: "Read how to read a run", to: { topic: "runs-page", search: "see why a test failed" } },
            { text: "Start a run from Test scripts; it shows up here at once.", button: "Open Test scripts", to: here("tests"), ui: ["Test scripts"] },
            { text: "Choose Stop run in the strip at the top of the page to stop a run that is going.", button: "Read how to stop a run", to: { topic: "stop-a-run", search: "stop a run" }, ui: ["Stop run"] },
        ],
        words: ["run", "exploration", "passing", "failing"],
        next: [{ text: "To have tests run by themselves, open Schedules.", button: "Open Schedules", to: here("runs", "schedules"), ui: ["Schedules"] }],
        topic: "runs-page",
    },
    "runs-schedules": {
        title: "Schedules",
        what: "Run tests on a timetable, such as every night, and get told when something changes.",
        canDo: [
            { text: "Choose New schedule to run tests every night or every week.", button: "Read how to run tests every night", to: { topic: "schedules", search: "run tests every night" }, ui: ["New schedule"] },
            { text: "Pick which tests and where they run in the schedule form.", button: "Read about schedules", to: { topic: "schedules", search: "schedule" } },
            { text: "Set up who gets told when a run finds something.", button: "Open Alerts", to: here("setup", "alerts"), ui: ["Alerts"] },
        ],
        words: ["schedule", "run", "environment"],
        next: [{ text: "See how results develop over time in Trends.", button: "Open Trends", to: here("runs", "trends"), ui: ["Trends"] }],
        topic: "schedules",
    },
    "runs-deploys": {
        title: "After a deploy",
        what: "Run tests automatically when your build pipeline says a new version of your application is out.",
        canDo: [
            { text: "Choose Create a token, a secret code your pipeline uses to tell us a deploy happened.", button: "Read how deploy runs work", to: { topic: "run-after-deploy", search: "run tests after a deploy" }, ui: ["Create a token"] },
            { text: "See which runs were started by a deploy.", button: "Open All runs", to: here("runs"), ui: ["All runs"] },
            { text: "Pick where the tests run after a deploy, such as staging.", button: "Open Environments", to: here("setup", "environments"), ui: ["Environments"] },
        ],
        words: ["build-pipeline", "environment", "run"],
        next: [{ text: "Add an alert so the right people hear about a failed deploy run.", button: "Open Alerts", to: here("setup", "alerts"), ui: ["Alerts"] }],
        topic: "run-after-deploy",
    },
    "runs-trends": {
        title: "Trends",
        what: "How your results change over time, and which tests are unreliable because they pass and fail on the same code.",
        canDo: [
            { text: "Change the period to look at a week or a month.", button: "Read about trends", to: { topic: "trends", search: "trends over time" } },
            { text: "Find tests that disagree with themselves, called flaky.", button: "Read about flaky tests", to: { topic: "quarantine", search: "flaky test keeps failing" } },
            { text: "Hold an unreliable test back so it stops raising alarms.", button: "Read about quarantine", to: { topic: "quarantine", search: "stop a flaky test" } },
        ],
        words: ["flaky", "quarantine", "passing"],
        next: [{ text: "Open a test that is unreliable and look at its History tab.", button: "Open Test scripts", to: here("tests"), ui: ["Test scripts", "History"] }],
        topic: "trends",
    },
    "run-detail": {
        title: "One run",
        what: "Everything about one run: what ran, where, when, and the result for each test.",
        canDo: [
            { text: "Read the line under About this run for the short story.", button: "Read how to read a run", to: { topic: "runs-page", search: "see why a test failed" }, ui: ["About this run"] },
            { text: "Open a failing test to see what was expected and what happened.", button: "Read how to see why a test failed", to: { topic: "what-the-page-did", search: "why did a test fail" } },
            { text: "Run the failing tests again with Run these tests again.", button: "Read how to run again", to: { topic: "run-panel", search: "run tests again" }, ui: ["Run these tests again"] },
            { text: "Go back to the list of runs.", button: "Open All runs", to: here("runs"), ui: ["All runs"] },
        ],
        words: ["run", "passing", "failing", "needs-a-look", "evidence"],
        next: [{ text: "If a test failed, fix it or hold it back, then run again.", button: "Read about looking after one test", to: { topic: "test-page", search: "fix a test" } }],
        topic: "runs-page",
    },
    "library-steps": {
        title: "Reusable steps",
        what: "Named groups of steps that many tests use, such as signing in. Change one here and every test that uses it follows.",
        canDo: [
            { text: "Make a group of steps once, for example Sign in.", button: "Read about reusable steps", to: { topic: "reusable-steps", search: "reusable steps" } },
            { text: "Use a group inside a test from the step editor.", button: "Read how to use them", to: { topic: "reusable-steps", search: "use reusable steps in a test" } },
            { text: "Type in the search box above to find a shared step, element or helper by name.", button: "Read about what tests share", to: { search: "library" } },
        ],
        words: ["reusable-steps", "test"],
        next: [{ text: "Name the buttons and fields your tests click, once, in Shared elements.", button: "Open Shared elements", to: here("library", "elements"), ui: ["Shared elements"] }],
        topic: "reusable-steps",
    },
    "library-steps-edit": {
        title: "Edit reusable steps",
        what: "One group of reusable steps open for change. Every test that uses it picks up the change.",
        canDo: [
            { text: "Add a step to the group with Add a step.", button: "Read about reusable steps", to: { topic: "reusable-steps", search: "reusable steps" }, ui: ["Add a step"] },
            { text: "Change the name or the steps, then save.", button: "Read how changes spread", to: { topic: "reusable-steps", search: "change reusable steps" } },
            { text: "Go back to the list of reusable steps.", button: "Open Reusable steps", to: here("library", "steps"), ui: ["Reusable steps"] },
        ],
        words: ["reusable-steps", "test"],
        next: [{ text: "Run a test that uses this group to check the change.", button: "Open Test scripts", to: here("tests"), ui: ["Test scripts"] }],
        topic: "reusable-steps",
    },
    "library-elements": {
        title: "Shared elements",
        what: "Buttons and fields of your application, each named once. Tests refer to the name, so a renamed button is fixed in one place.",
        canDo: [
            { text: "Choose Add element to name a button or field.", button: "Read about shared elements", to: { topic: "shared-elements", search: "shared elements" }, ui: ["Add element"] },
            { text: "Use Import or Export to move the list to or from a file.", button: "Read about sharing elements", to: { topic: "shared-elements", search: "import shared elements" }, ui: ["Import", "Export"] },
            { text: "Fix one renamed button for every test at once.", button: "Read how to fix a renamed button", to: { topic: "shared-elements", search: "fix a renamed button in every test" } },
        ],
        words: ["shared-element", "test"],
        next: [{ text: "Use a shared element from a test's Steps tab with Use as shared element.", button: "Read about the Steps tab", to: { topic: "shared-elements", search: "use a shared element" }, ui: ["Use as shared element"] }],
        topic: "shared-elements",
    },
    "library-helpers": {
        title: "Helpers (code)",
        what: "Code that several code tests share, such as a sign-in routine. Only people who write code tests need this.",
        canDo: [
            { text: "Add a helper when two code tests need the same code.", button: "Read about helpers", to: { topic: "write-code", search: "shared helpers code" } },
            { text: "Learn what a code test is and when to use one.", button: "Read about code tests", to: { topic: "write-code", search: "code test" } },
            { text: "Go back to the tests.", button: "Open Test scripts", to: here("tests"), ui: ["Test scripts"] },
        ],
        words: ["helper", "code-test"],
        next: [{ text: "Open a test and look at its Code tab.", button: "Open Test scripts", to: here("tests"), ui: ["Test scripts", "Code"] }],
        topic: "write-code",
    },
    "library-data": {
        title: "Test data",
        what: "Tables of values your tests read, such as names and addresses, and the records your tests create.",
        canDo: [
            { text: "Upload a CSV, JSON or YAML file of values for tests to use.", button: "Read about test data", to: { topic: "test-data", search: "test data" } },
            { text: "Look at each saved set in Test data and replace or remove it.", button: "Read about data sets", to: { topic: "test-data", search: "data sets" }, ui: ["Test data"] },
            { text: "Clean up records that tests created.", button: "Read about cleaning up", to: { topic: "test-data-cleanup", search: "clean up test data" } },
        ],
        words: ["test-data", "test"],
        next: [{ text: "Sign-in details for tests live in Test accounts.", button: "Open Test accounts", to: here("library", "accounts"), ui: ["Test accounts"] }],
        topic: "test-data",
    },
    "library-accounts": {
        title: "Test accounts",
        what: "The logins your tests sign in with, for example an ordinary user and an administrator. Passwords are kept hidden.",
        canDo: [
            { text: "Add an account so tests can check what each kind of user sees.", button: "Read about test accounts", to: { topic: "test-accounts", search: "test accounts" } },
            { text: "Learn why tests use their own accounts.", button: "Read about roles", to: { topic: "test-accounts", search: "different users roles" } },
            { text: "Check that secrets stay hidden.", button: "Read about staying in control", to: { topic: "control", search: "secrets stay hidden" } },
        ],
        words: ["test-account", "test"],
        next: [{ text: "Use the account in a test from its Steps tab.", button: "Open Test scripts", to: here("tests"), ui: ["Test scripts", "Steps"] }],
        topic: "test-accounts",
    },
    "release-releases": {
        title: "Releases",
        what: "Sign off a version of your application: the results of automated tests and the checks done by hand, together.",
        canDo: [
            { text: "Choose New release to start a sign-off for a version.", button: "Read about release sign-off", to: { topic: "release-signoff", search: "release sign-off" }, ui: ["New release"] },
            { text: "See what is still open before you can say yes.", button: "Read how a release is judged", to: { topic: "release-signoff", search: "can we ship" } },
            { text: "Add manual checks that feed the sign-off.", button: "Open Manual checks", to: here("release", "manual"), ui: ["Manual checks"] },
        ],
        words: ["release-sign-off", "manual-check"],
        next: [{ text: "Make sure the latest tests have run before you sign off.", button: "Open Runs", to: here("runs"), ui: ["Runs"] }],
        topic: "release-signoff",
    },
    "release-manual": {
        title: "Manual checks",
        what: "Checks a person does by hand, kept next to the automated tests so one release shows both.",
        canDo: [
            { text: "Import your existing manual checks from a file.", button: "Read about manual checks", to: { topic: "release-signoff", search: "manual checks" } },
            { text: "Export them to share.", button: "Read about sharing checks", to: { topic: "release-signoff", search: "export manual checks" }, ui: ["Export"] },
            { text: "Use them in a release sign-off.", button: "Open Releases", to: here("release", "releases"), ui: ["Releases"] },
        ],
        words: ["manual-check", "release-sign-off"],
        next: [{ text: "Start a release and mark each manual check.", button: "Open Releases", to: here("release", "releases"), ui: ["Releases"] }],
        topic: "release-signoff",
    },
    "release-compliance": {
        title: "Compliance",
        what: "A map of which security-control topics your tests already touch. It shows gaps, not a certificate.",
        canDo: [
            { text: "Read which topics your tests cover and which they do not.", button: "Read about the compliance map", to: { topic: "compliance", search: "compliance map" } },
            { text: "Learn what the map can and cannot say.", button: "Read the limits", to: { topic: "compliance", search: "compliance limits" } },
            { text: "Go to Test scripts to add something that covers a gap.", button: "Open Test scripts", to: here("tests"), ui: ["Test scripts"] },
        ],
        words: ["compliance", "test"],
        next: [{ text: "Use the map when you sign off a release.", button: "Open Releases", to: here("release", "releases"), ui: ["Releases"] }],
        topic: "compliance",
    },
    "release-detail": {
        title: "One release",
        what: "A single release sign-off, with the results of automated tests and manual checks and the decision.",
        canDo: [
            { text: "Read what is passing and what still stops the release.", button: "Read about release sign-off", to: { topic: "release-signoff", search: "release sign-off" } },
            { text: "Mark the manual checks you have done.", button: "Read about manual checks", to: { topic: "release-signoff", search: "manual checks" } },
            { text: "Go back to all releases.", button: "Open Releases", to: here("release", "releases"), ui: ["Releases"] },
        ],
        words: ["release-sign-off", "manual-check"],
        next: [{ text: "When everything is done, record the decision.", button: "Read about release sign-off", to: { topic: "release-signoff", search: "release sign-off" } }],
        topic: "release-signoff",
    },
    "setup-runners": {
        title: "Your runner",
        what: "A runner is the program on your computer that runs your tests. You set it up once in Settings; every run you start then goes to it.",
        canDo: [
            { text: "Download the runner for your computer and start it once.", button: "Read about your runner", to: { topic: "runners", search: "runner" }, ui: ["Download the runner"] },
            { text: "Open Your runner to see whether it is online, and what it may run.", button: "Read about your runner", to: { topic: "runners" }, ui: ["Your runner"] },
            { text: "Run tests with the Run button on Test scripts.", button: "Open Test scripts", to: here("tests"), ui: ["Test scripts", "Run"] },
        ],
        words: ["runner", "run"],
        next: [{ text: "Add an environment such as staging, if you test more than one address.", button: "Open Environments", to: here("setup", "environments"), ui: ["Environments"] }],
        topic: "runners",
    },
    "setup-environments": {
        title: "Environments",
        what: "The addresses your tests can run against, such as staging and production. Production is read only, so tests never change it.",
        canDo: [
            { text: "Save the address of staging or another copy of your application.", button: "Read about environments", to: { topic: "environments", search: "environments staging" } },
            { text: "Use Make default to choose which one is used when you do not pick.", button: "Read about the default", to: { topic: "environments", search: "default environment" }, ui: ["Make default"] },
            { text: "Run a test against an environment from Run.", button: "Open Test scripts", to: here("tests"), ui: ["Test scripts", "Run"] },
        ],
        words: ["environment", "production"],
        next: [{ text: "Run on a timetable against one of them.", button: "Open Schedules", to: here("runs", "schedules"), ui: ["Schedules"] }],
        topic: "environments",
    },
    "setup-frameworks": {
        title: "Frameworks",
        what: "Which test technologies run your tests, and their limits. Most people never need to change this.",
        canDo: [
            { text: "Read what the platform uses by default.", button: "Read about frameworks", to: { topic: "framework-settings", search: "frameworks" } },
            { text: "Change a limit, such as how long a test may take.", button: "Read about settings", to: { topic: "framework-settings", search: "test limits timeout" }, ui: ["Change"] },
            { text: "Use another framework only if your team asks for it.", button: "Read about plug-ins", to: { topic: "plug-ins", search: "plug-in" } },
        ],
        words: ["frameworks", "plug-in"],
        next: [{ text: "Set up your runner in Settings, so your runs have somewhere to go.", button: "Open Your runner", to: here("setup", "runners"), ui: ["Your runner"] }],
        topic: "framework-settings",
    },
    "setup-mobile": {
        title: "Mobile app",
        what: "The phone app your phone tests run against. You only need this to test an Android or iOS app.",
        canDo: [
            { text: "Tell the platform which app to test.", button: "Read about phone tests", to: { topic: "phones-and-emulators", search: "test on a phone" } },
            { text: "Choose Explore with AI to let the AI tap through the app and plan tests.", button: "Read how the AI explores a phone app", to: { topic: "explore-phone-app", search: "explore a phone app" }, ui: ["Explore with AI"] },
            { text: "Learn what a phone emulator is.", button: "Read about emulators", to: { topic: "phones-and-emulators", search: "emulator" } },
            { text: "Skip this page if you test only websites.", button: "Open Test scripts", to: here("tests"), ui: ["Test scripts"] },
        ],
        words: ["emulator", "runner"],
        next: [{ text: "Make a phone test from an existing test.", button: "Open Test scripts", to: here("tests"), ui: ["Test scripts"] }],
        topic: "phones-and-emulators",
    },
    "setup-alerts": {
        title: "Alerts",
        what: "Who is told when a run finds something: a chat channel, email or another program.",
        canDo: [
            { text: "Choose Add a channel to be told in chat or by email.", button: "Read about alerts", to: { topic: "alerts", search: "alerts told when tests fail" }, ui: ["Add a channel"] },
            { text: "Pick which results raise an alert.", button: "Read about what triggers one", to: { topic: "alerts", search: "alert rules" } },
            { text: "Connect an issue tracker as well.", button: "Open Issue tracker", to: here("setup", "issues"), ui: ["Issue tracker"] },
        ],
        words: ["run", "finding"],
        next: [{ text: "Set up a schedule so alerts have something to report.", button: "Open Schedules", to: here("runs", "schedules"), ui: ["Schedules"] }],
        topic: "alerts",
    },
    "setup-issues": {
        title: "Issue tracker",
        what: "Connect GitHub, Jira or Notion so a problem found by a test can become a ticket in one click.",
        canDo: [
            { text: "Connect an issue tracker with its address and a key.", button: "Read about issue trackers", to: { topic: "issue-trackers", search: "issue tracker" } },
            { text: "Choose Test connection to check that it works.", button: "Read how to check it", to: { topic: "issue-trackers", search: "test connection" }, ui: ["Test connection"] },
            { text: "Learn where the key is kept.", button: "Read about staying in control", to: { topic: "control", search: "secrets stay hidden" } },
        ],
        words: ["finding", "access-key"],
        next: [{ text: "Open a failing test and file it as a ticket.", button: "Open Test scripts", to: here("tests"), ui: ["Test scripts"] }],
        topic: "issue-trackers",
    },
    "setup-storage": {
        title: "Storage and backup",
        what: "What this project's files use on disk, how long old files are kept, and a backup you can download or restore.",
        canDo: [
            { text: "See how much room screenshots, videos and results use.", button: "Read about storage", to: { topic: "storage-and-backup", search: "storage backup" } },
            { text: "Choose Download backup to keep a copy of the project.", button: "Read about backups", to: { topic: "storage-and-backup", search: "backup" }, ui: ["Download backup"] },
            { text: "Choose Restore as a new project to bring a backup back as a project.", button: "Read about restoring", to: { topic: "storage-and-backup", search: "restore a backup" }, ui: ["Restore as a new project"] },
        ],
        words: ["evidence"],
        next: [{ text: "Sign-in details are not in a backup. Enter them again after a restore.", button: "Read about staying in control", to: { topic: "control", search: "secrets stay hidden" } }],
        topic: "storage-and-backup",
    },
    "test-steps": {
        title: "A test: Steps",
        what: "The steps of one test, one by one, in order. You can change them here and the script follows.",
        canDo: [
            { text: "Add, move or remove a step with the step editor.", button: "Read about the Steps tab", to: { topic: "test-page", search: "edit steps of a test" } },
            { text: "Look at the same test in the DSL, one line per step.", button: "Show the DSL tab", to: { testTab: "text" }, ui: ["DSL"] },
            { text: "Read the script the platform made from the steps.", button: "Show the Code tab", to: { testTab: "code" }, ui: ["Code"] },
            { text: "Choose Run again at the top of the page to run this test once more.", button: "Read how to run one test", to: { topic: "run-panel", search: "run one test" }, ui: ["Run again"] },
            { text: "See earlier versions and what changed.", button: "Show the History tab", to: { testTab: "history" }, ui: ["History"] },
        ],
        words: ["test", "run", "version"],
        next: [{ text: "After a change, run the test to see that it still passes.", button: "Read how to run one test", to: { topic: "run-panel", search: "run one test" } }],
        topic: "test-page",
    },
    "test-text": {
        title: "A test: DSL",
        what: "The same test written as one line per step, in fixed words. It is another way to read and change the Steps tab.",
        canDo: [
            { text: "Change a line, and the steps follow.", button: "Read about the DSL tab", to: { topic: "write-test-as-text", search: "write a test as text" } },
            { text: "Go back to the steps.", button: "Show the Steps tab", to: { testTab: "steps" }, ui: ["Steps"] },
            { text: "See the script that results.", button: "Show the Code tab", to: { testTab: "code" }, ui: ["Code"] },
        ],
        words: ["test", "version"],
        next: [{ text: "Save the change and run the test.", button: "Read how to run one test", to: { topic: "run-panel", search: "run one test" } }],
        topic: "write-test-as-text",
    },
    "test-code": {
        title: "A test: Code",
        what: "The script that actually runs. For most tests it is made for you and you only read it. A code test is one you own and edit.",
        canDo: [
            { text: "Read the script the platform made from the steps.", button: "Read about the Code tab", to: { topic: "write-code", search: "code test" } },
            { text: "Choose Switch to code to edit the script yourself. The steps and text then stop updating it.", button: "Read what changes", to: { topic: "write-code", search: "switch to code" }, ui: ["Switch to code"] },
            { text: "Go back to the steps.", button: "Show the Steps tab", to: { testTab: "steps" }, ui: ["Steps"] },
            { text: "See earlier versions and go back to one.", button: "Show the History tab", to: { testTab: "history" }, ui: ["History"] },
        ],
        words: ["code-test", "version", "helper"],
        next: [{ text: "Share code with other tests in Helpers (code).", button: "Open Helpers (code)", to: here("library", "helpers"), ui: ["Helpers (code)"] }],
        topic: "write-code",
    },
    "test-history": {
        title: "A test: History",
        what: "Every earlier version of this test, and every time it ran. You can look at what changed and go back.",
        canDo: [
            { text: "See what changed between two versions.", button: "Read about history", to: { topic: "history-and-undo", search: "history versions of a test" } },
            { text: "Go back to an earlier version.", button: "Read how to go back", to: { topic: "history-and-undo", search: "restore an earlier version" } },
            { text: "See which changes were Auto-fix and which you made.", button: "Read about auto-fix", to: { topic: "auto-fix", search: "auto-fix repair" } },
            { text: "Go back to the steps.", button: "Show the Steps tab", to: { testTab: "steps" }, ui: ["Steps"] },
        ],
        words: ["version", "history", "auto-fix", "repair"],
        next: [{ text: "If a repair is suggested, read it, then apply it or leave it.", button: "Read about repairs", to: { topic: "repair-suggestions", search: "repair a failing test" } }],
        topic: "history-and-undo",
    },
    recorder: {
        title: "Record a test",
        what: "Click through your application in a real browser and the platform turns what you do into steps. You see each step as it is added.",
        canDo: [
            { text: "Type the address, then choose Start recording.", button: "Read how recording works", to: { topic: "record-a-test", search: "record a test" }, ui: ["Start recording"] },
            { text: "Check each step as it appears and remove a mistake.", button: "Read about checking steps", to: { topic: "record-a-test", search: "recorded steps" } },
            { text: "Save the recording as a test when you are done.", button: "Read what saving does", to: { topic: "record-a-test", search: "save a recording" } },
            { text: "Go back to the tests without saving.", button: "Open Test scripts", to: here("tests"), ui: ["Test scripts"] },
        ],
        words: ["test", "runner"],
        next: [{ text: "After saving, run the new test to see that it passes.", button: "Open Test scripts", to: here("tests"), ui: ["Test scripts"] }],
        topic: "record-a-test",
    },
    "write-code": {
        title: "Write a code test",
        what: "A blank script to write yourself, started for you. It runs only where code tests are allowed.",
        canDo: [
            { text: "Write the script and save it.", button: "Read about code tests", to: { topic: "write-code", search: "code test" } },
            { text: "Learn where a code test is allowed to run.", button: "Read about the limits", to: { topic: "write-code", search: "where code tests run" } },
            { text: "Go back to the tests without saving.", button: "Open Test scripts", to: here("tests"), ui: ["Test scripts"] },
        ],
        words: ["code-test", "helper"],
        next: [{ text: "Share code between tests with Helpers (code).", button: "Open Helpers (code)", to: here("library", "helpers"), ui: ["Helpers (code)"] }],
        topic: "write-code",
    },
    settings: {
        title: "Settings",
        what: "Your runner, and how this whole platform is set up: the AI model, the people who use it and what kinds of tests are allowed.",
        canDo: [
            { text: "Use Your runner to set up the program on your computer that runs your tests.", button: "Read about your runner", to: { topic: "runners" }, ui: ["Your runner"] },
            { text: "Check that the AI model is connected.", button: "Read about the AI model", to: { topic: "settings-page", search: "AI model settings" } },
            { text: "Let colleagues in with their own accounts and roles.", button: "Read about people and access", to: { topic: "people-and-access", search: "people" } },
            { text: "Read which kinds of tests can run here.", button: "Read about settings", to: { topic: "settings-page", search: "settings" } },
        ],
        words: ["access-key", "frameworks"],
        next: [{ text: "Back to your projects when you are done.", button: "Open projects", to: here("projects") }],
        topic: "settings-page",
    },
    "security-home": {
        title: "Security assessment",
        what: "The projects that use security assessment. It is separate from functional testing: its own applications, assessments, findings and reports.",
        canDo: [
            { text: "Open a project to register an application and record the owner's permission.", button: "Open projects", to: here("projects") },
            { text: "Start a new project for security assessment, or for both kinds of testing.", button: "Start a project", to: here("new-project") },
            { text: "Read how projects and their places are laid out.", button: "Read about places", to: { topic: "places" } },
        ],
        words: ["test"],
        next: [{ text: "Open a project and look at its security overview.", button: "Open projects", to: here("projects") }],
        topic: "places",
    },
    "security-project": {
        title: "Security assessment of this project",
        what: "Applications registered for assessment, the owner's recorded permission, passive assessments, their findings and reports. Kept apart from this project's functional tests.",
        canDo: [
            { text: "Register an application and record the owner's permission before anything runs.", button: "Read about places", to: { topic: "places" } },
            { text: "Go back to this project's functional tests and their results.", button: "Open the tests", to: here("tests") },
            { text: "Change whether this project uses functional testing, security assessment or both, in Settings.", button: "Open setup", to: here("setup") },
        ],
        words: ["test"],
        next: [{ text: "Look at the findings that need review first.", button: "Read about places", to: { topic: "places" } }],
        topic: "places",
    },
    guide: {
        title: "The Guide",
        what: "Plain explanations of everything in the platform. Start with what you want to do, or look through the topics.",
        canDo: [
            { text: "Pick a goal under I want to… and read the steps.", button: "Read the start in 10 minutes", to: { topic: "first-steps" } },
            { text: "Search the Guide with your own words.", button: "Read about search", to: { topic: "help", search: "help inside the app" } },
            { text: "Look up a word you do not know on the words page.", button: "Open the words page", to: { topic: "help", search: "glossary words" } },
            { text: "Take the short tour of the screens.", button: "Read about the tour", to: { topic: "help", search: "tour" } },
        ],
        words: ["test", "run"],
        next: [{ text: "Go to your projects and try one thing.", button: "Open projects", to: here("projects") }],
        topic: "help",
    },
    "guide-topic": {
        title: "A topic in the Guide",
        what: "One topic explained: what it is, why you would use it and the steps. Words with a dotted underline have a short meaning.",
        canDo: [
            { text: "Follow the numbered steps in the app.", button: "Read about the Guide", to: { topic: "help", search: "help inside the app" } },
            { text: "Use Open it in the app to go straight to the place.", button: "Read about places", to: { topic: "places" } },
            { text: "Read a related topic.", button: "Read the start in 10 minutes", to: { topic: "first-steps" } },
        ],
        words: ["test"],
        next: [{ text: "Try it, then come back if you get stuck.", button: "Open projects", to: here("projects") }],
        topic: "help",
    },
    "guide-words": {
        title: "Words",
        what: "A short meaning for every word the platform uses, in alphabetical order.",
        canDo: [
            { text: "Search for a word, including the older names it used to have.", button: "Read about the Guide", to: { topic: "help", search: "help inside the app" } },
            { text: "Go back to the topics.", button: "Read the start in 10 minutes", to: { topic: "first-steps" } },
            { text: "Learn the places of a project.", button: "Read about the places", to: { topic: "places" } },
        ],
        words: ["test", "run"],
        next: [{ text: "Back to the Guide.", button: "Read the start in 10 minutes", to: { topic: "first-steps" } }],
        topic: "help",
    },
    // ── Round 25: the global places, and the project places that are new ──
    dashboard: {
        title: "Dashboard",
        what: "How all your projects are doing, the machines that run them, and the AI they use.",
        canDo: [
            { text: "See which projects pass, which fail and which need a look.", button: "Read about the dashboard", to: { topic: "fleet-dashboard" } },
            { text: "Open a project to work on its tests.", button: "Open projects", to: here("projects") },
            { text: "Check how much AI your projects used.", button: "Read about AI usage", to: { topic: "ai-usage" } },
        ],
        words: ["test", "run", "passing"],
        next: [{ text: "Open a project that needs a look and read its dashboard.", button: "Read how a project is laid out", to: { topic: "places" } }],
        topic: "fleet-dashboard",
    },
    develop: {
        title: "Test development",
        what: "Start writing tests in any of your projects: with the AI, by recording, step by step or as code.",
        canDo: [
            { text: "Let the AI explore an application and write tests for it.", button: "Read how exploring works", to: { topic: "explore-my-app" } },
            { text: "Record a test by using the application yourself.", button: "Read how recording works", to: { topic: "record-a-test" } },
            { text: "Describe a test in your own words and let the AI write the steps.", button: "Read about describing a test", to: { topic: "describe-a-test" } },
        ],
        words: ["test", "exploration", "plan"],
        next: [{ text: "Open a project's test cases to see every way to add a test.", button: "Open projects", to: here("projects") }],
        topic: "first-steps",
    },
    "runners-global": {
        title: "Your runner",
        what: "A runner is the program on your computer that runs your tests. It is set up once in Settings, under Your runner.",
        canDo: [
            { text: "Choose Download the runner, start it on your computer, and wait until it says Online.", button: "Read about your runner", to: { topic: "runners" }, ui: ["Download the runner"] },
            { text: "Choose Set up a different computer to move to another computer, or Remove this computer.", button: "Read about your runner", to: { topic: "runners", search: "runner" }, ui: ["Set up a different computer", "Remove this computer"] },
            { text: "Check that a computer is ready to run tests.", button: "Read about checking a computer", to: { topic: "doctor" } },
        ],
        words: ["runner", "run"],
        next: [{ text: "Once your runner is online, run tests from the project.", button: "Read about runs", to: { topic: "runs-page" } }],
        topic: "runners",
    },
    integrations: {
        title: "Integrations",
        what: "Every system your projects connect to: issue trackers, Sentry, alert channels, Git import, device farms and the test mailbox. Set a tracker or a channel up once for your organisation, then choose the projects that use it.",
        canDo: [
            { text: "Set up Jira, GitHub Issues, Notion, Sentry, Slack, Teams or a webhook once, with its address and token. The token is stored encrypted and never shown again.", button: "Read about issue trackers", to: { topic: "issue-trackers", search: "issue tracker" } },
            { text: "Choose Use in a project to give a project the connection, without entering the details again. Stop using it there with the cross next to the project.", button: "Read about alerts", to: { topic: "alerts", search: "alerts told when tests fail" }, ui: ["Use in a project"] },
            { text: "Choose Test the connection to make one real call and see whether it works.", button: "Read how to check it", to: { topic: "issue-trackers", search: "test connection" }, ui: ["Test the connection"] },
            { text: "Learn where the keys are kept.", button: "Read about staying in control", to: { topic: "control", search: "secrets stay hidden" } },
        ],
        words: ["finding", "access-key"],
        next: [{ text: "Open a project to see the connections it uses in its settings.", button: "Open projects", to: here("projects") }],
        topic: "issue-trackers",
    },
    libraries: {
        title: "Reusable libraries",
        what: "Reusable steps, helpers and shared elements that your organisation's projects share, in folders. A project takes a copy and chooses when to update it.",
        canDo: [
            { text: "Choose New folder to sort the library, and Move to put a folder or an item somewhere else.", button: "Read about reusable steps", to: { topic: "reusable-steps" }, ui: ["New folder", "Move"] },
            { text: "Choose Add item to add a helper or a shared element; reusable steps are published from a project.", button: "Read about reusable steps", to: { topic: "reusable-steps" }, ui: ["Add item"] },
            { text: "Open an item to see its versions and the projects that use it.", button: "Read about reusable steps", to: { topic: "reusable-steps" } },
        ],
        words: ["test"],
        next: [{ text: "Open a project's Test scripts, then Reusable libraries, to add an item to it.", button: "Open projects", to: here("projects") }],
        topic: "reusable-steps",
    },
    "library-library": {
        title: "Reusable libraries",
        what: "Your organisation's library, seen from this project. Add an item to get your own copy, update it when the library has a newer version, and publish your own items.",
        canDo: [
            { text: "Choose Add to project to copy an item into this project. Its tests use it like anything else of the project.", button: "Read about reusable steps", to: { topic: "reusable-steps" }, ui: ["Add to project"] },
            { text: "Choose Update when the library has a newer version. Nothing changes here until you do; the tests that use it are checked again.", button: "Read about reusable steps", to: { topic: "reusable-steps" }, ui: ["Update"] },
            { text: "Choose Publish to library to offer this project's own item to the other projects, as a new version.", button: "Read about reusable steps", to: { topic: "reusable-steps" }, ui: ["Publish to library"] },
        ],
        words: ["test"],
        next: [{ text: "Use the steps you added in a test's Steps tab.", button: "Open Test scripts", to: here("tests"), ui: ["Test scripts"] }],
        topic: "reusable-steps",
    },
    folders: {
        title: "Project folders",
        what: "Folders group your organisation's projects, for example by client or product line. A project is in one folder at most. Open them from Projects.",
        canDo: [
            { text: "Choose Make folder to start a folder, if you can create projects.", button: "Read how a project is laid out", to: { topic: "places" }, ui: ["Make folder"] },
            { text: "Move a project into a folder from the folder itself, or take it out with Move out. Remove folder keeps its projects.", button: "Read how a project is laid out", to: { topic: "places" }, ui: ["Move out", "Remove folder"] },
            { text: "Sort the project list with Grouped by folder, or show one folder only.", button: "Open projects", to: here("projects"), ui: ["Grouped by folder"] },
        ],
        words: ["test"],
        next: [{ text: "Open a project to work on its tests.", button: "Open projects", to: here("projects") }],
        topic: "places",
    },
    agents: {
        title: "Agents",
        what: "The testing agents: API, accessibility, security, responsive UI, UX, performance and test case generation. Each is a kind of checking the AI does when it explores an application. A project tested by the AI agent uses the agents chosen for it.",
        canDo: [
            { text: "Open an agent to see what it checks, which platforms it works on, what it needs and which of your projects use it.", button: "Read how exploring works", to: { topic: "explore-my-app" } },
            { text: "Pick a project's agents when you create it. Change them later in its Settings → General, then use Save agents.", button: "Open projects", to: here("projects"), ui: ["Save agents"] },
            { text: "An agent marked Not available yet cannot be chosen: AI Studio cannot do that kind of testing yet.", button: "Read how exploring works", to: { topic: "explore-my-app" } },
        ],
        words: ["test", "exploration"],
        next: [{ text: "Explore a project's application to run the checks its agents turn on.", button: "Read how exploring works", to: { topic: "explore-my-app" } }],
        topic: "explore-my-app",
    },
    profile: {
        title: "Profile",
        what: "Your account, the features you can use in AI Studio, your personal API tokens and your own preferences.",
        canDo: [
            { text: "See which features a Crowd4Test administrator gave you.", button: "Read about people and access", to: { topic: "people-and-access" } },
            { text: "Pick the alert emails you get and how the Projects page opens, then use Save preferences.", button: "Read about people and access", to: { topic: "people-and-access" }, ui: ["Save preferences"] },
            { text: "Make a personal API token for scripts, on an account of this platform.", button: "Read about access", to: { topic: "people-and-access" } },
        ],
        words: ["test"],
        next: [{ text: "Ask your administrator if you need a feature you do not have.", button: "Read about people and access", to: { topic: "people-and-access" } }],
        topic: "people-and-access",
    },
    requirements: {
        title: "Requirements",
        what: "What the application must do, one requirement at a time, and which test cases check each one. Coverage says which requirements pass, fail or have nothing checking them.",
        canDo: [
            { text: "Add a requirement, or import them from a requirements document (pasted, or a .txt, .md, .docx or .pdf file). You see what was found before it is saved.", button: "Read about requirements coverage", to: { topic: "requirements-coverage" } },
            { text: "In a code project, choose Generate test cases using AI to have the AI write test cases for the requirements you pick. It needs both Write tests and Generate tests with AI.", button: "Open test cases", to: here("cases"), ui: ["Generate test cases using AI", "Write tests", "Generate tests with AI"] },
            { text: "Open a requirement and link the test cases that check it.", button: "Open test cases", to: here("cases") },
            { text: "In an AI agent project, keep the sign-in details, API access and OpenAPI document under What the agents need. They are saved only here: exploring uses them, never changes them, and plans tests from the requirements.", button: "Read how exploring works", to: { topic: "explore-my-app" }, ui: ["AI agent", "What the agents need"] },
        ],
        words: ["test", "exploration", "plan"],
        next: [{ text: "Link a test case to every requirement marked Not covered.", button: "Open test cases", to: here("cases") }],
        topic: "requirements-coverage",
    },
    suites: {
        title: "Test suites",
        what: "Groups of test cases that run together. Build your own suites in the order you choose, or use the groups by area the platform makes.",
        canDo: [
            { text: "Choose New suite to build a list of test cases that run in your order.", button: "Read about the tests list", to: { topic: "tests-list" }, ui: ["New suite"] },
            { text: "See how many tests each area has and how many pass.", button: "Read about the tests list", to: { topic: "tests-list" } },
            { text: "Run a suite on a timetable.", button: "Read about schedules", to: { topic: "schedules" } },
        ],
        words: ["test", "run"],
        next: [{ text: "Schedule the tests that matter most.", button: "Open schedules", to: here("runs", "schedules") }],
        topic: "tests-list",
    },
    "suite-detail": {
        title: "A test suite",
        what: "One suite: its test cases in the order they run, where and how they run, and its last runs.",
        canDo: [
            { text: "Add tests, then move them up or down to set the order.", button: "Read about the tests list", to: { topic: "tests-list" }, ui: ["Add tests"] },
            { text: "Choose Run suite to run its tests in this order with its settings.", button: "Read how to read a run", to: { topic: "runs-page" }, ui: ["Run suite"] },
            { text: "Change where it runs, other browsers, and what happens when a test fails.", button: "Open environments", to: here("setup", "environments") },
            { text: "Run the suite on a timetable.", button: "Open schedules", to: here("runs", "schedules") },
        ],
        words: ["test", "run"],
        next: [{ text: "Open a run to see each test's result.", button: "Open runs", to: here("runs") }],
        topic: "tests-list",
    },
    scripts: {
        title: "Test scripts",
        what: "What actually runs: every test script of this project, each with a DSL view and a Code view, grouped by area.",
        canDo: [
            { text: "Choose Run to run one test, a group or everything, and pick where it runs.", button: "Read how to run tests", to: { topic: "run-panel", search: "run tests now" }, ui: ["Run"] },
            { text: "Choose New test script to describe a test, build its steps, write it as text or code, or import scripts.", button: "Read about making tests", to: { search: "make a new test" }, ui: ["New test script"] },
            { text: "Choose Import to bring scripts from a JSON file, Maestro flows or a Git repository.", button: "Read how to bring tests", to: { topic: "import-tests", search: "import tests" }, ui: ["Import"] },
            { text: "Choose Select scripts to tick the scripts you want, then run only those.", button: "Read how to run only some", to: { topic: "run-panel", search: "run only some tests" }, ui: ["Select scripts"] },
            { text: "Use Search scripts and Filters to find one script or the ones that fail.", button: "Read about finding tests", to: { topic: "run-panel", search: "find a test" }, ui: ["Search scripts", "Filters"] },
            { text: "Open a test to see its DSL, code, steps and history in one place.", button: "Read about a single test", to: { topic: "test-page", search: "open a test steps text code history" } },
        ],
        words: ["test", "run", "passing", "failing", "needs-a-look", "not-run-yet"],
        next: [{ text: "After a run, look at the results in Runs.", button: "Open Runs", to: here("runs"), ui: ["Runs"] }],
        topic: "run-panel",
    },
    "scripts-review": {
        title: "Review",
        what: "Each test script's versions and their review. A draft waits here until it is approved; only approved versions run.",
        canDo: [
            { text: "Open a version to compare its steps and code with the approved version.", button: "Read about the test page", to: { topic: "test-page" } },
            { text: "Choose Send for review on a draft to ask the Project Admins.", button: "Read about history", to: { topic: "history-and-undo" }, ui: ["Send for review"] },
            { text: "Choose Approve, Ask for changes or Reject. Deciding needs Project Admin on this project.", button: "Read about the test page", to: { topic: "test-page" }, ui: ["Approve", "Ask for changes", "Reject"] },
        ],
        words: ["test", "version"],
        next: [{ text: "See what changed in a script over time.", button: "Read about history", to: { topic: "history-and-undo" } }],
        topic: "test-page",
    },
    "script-version": {
        title: "A script version",
        what: "One version of a test's script: its plain-English steps and code beside the approved version's, its comments, and its review.",
        canDo: [
            { text: "Choose Approve so it runs, Ask for changes, or Reject with a reason. Deciding needs Project Admin on this project.", button: "Read about the test page", to: { topic: "test-page" }, ui: ["Approve", "Ask for changes", "Reject"] },
            { text: "Choose Send for review to ask the Project Admins, and add a comment.", button: "Read about history", to: { topic: "history-and-undo" }, ui: ["Send for review"] },
            { text: "Compare the steps and the code with the approved version, line by line.", button: "Read about writing code", to: { topic: "write-code" } },
        ],
        words: ["test", "run"],
        next: [{ text: "See what changed in a script over time.", button: "Read about history", to: { topic: "history-and-undo" } }],
        topic: "test-page",
    },
    "agent-runs": {
        title: "Agent runs",
        what: "Give the AI an objective. It works through the application in a real browser and reports passed, failed, blocked or inconclusive. Deleting, paying, sending and submitting forms wait for a person.",
        canDo: [
            { text: "Write an objective, choose where it starts and set its limits, then choose Start agent run.", button: "Read how exploring works", to: { topic: "explore-my-app" }, ui: ["Start agent run"] },
            { text: "Follow a run live. Choose Stop to end it, and Approve or Refuse when it asks.", button: "Read about watching the AI", to: { topic: "watch-the-ai" }, ui: ["Stop", "Approve", "Refuse"] },
            { text: "Choose Turn into a draft test on a finished run. It goes through review like any draft.", button: "Read about describing a test", to: { topic: "describe-a-test" }, ui: ["Turn into a draft test"] },
        ],
        words: ["exploration", "plan", "runner"],
        next: [{ text: "Open the test cases the AI wrote.", button: "Open test cases", to: here("tests") }],
        topic: "explore-my-app",
    },
    "settings-general": {
        title: "Project settings",
        what: "The project, its one platform and testing mode, its app, who works on it, what tests use, and who is told.",
        canDo: [
            { text: "Set the addresses tests run against.", button: "Open environments", to: here("setup", "environments") },
            { text: "Set up your runner, the program on your computer that runs your tests.", button: "Open Your runner", to: here("setup", "runners") },
            { text: "Set who is told when a run finds something.", button: "Open alerts", to: here("setup", "alerts") },
        ],
        words: ["environment", "runner"],
        next: [{ text: "Add the logins your tests sign in with.", button: "Read about test accounts", to: { topic: "test-accounts" } }],
        topic: "settings-page",
    },
    "settings-members": {
        title: "Members",
        what: "Who can work on this project, and who approves. People are added one by one.",
        canDo: [
            { text: "Read how people get access to AI Studio.", button: "Read about people and access", to: { topic: "people-and-access" } },
            { text: "Set the addresses tests run against.", button: "Open environments", to: here("setup", "environments") },
            { text: "Go back to the project.", button: "Open the project", to: here("overview") },
        ],
        words: ["test"],
        next: [{ text: "Ask your Crowd4Test administrator for features you need.", button: "Read about people and access", to: { topic: "people-and-access" } }],
        topic: "people-and-access",
    },
    "settings-ai": {
        title: "AI configuration",
        what: "Who pays for this project's AI: Crowd4Test's managed AI, or your organisation's own key. If your own key fails, the AI work stops; it never moves to Crowd4Test's key.",
        canDo: [
            { text: "See how much AI the projects used.", button: "Read about AI usage", to: { topic: "ai-usage" } },
            { text: "Add the keys your organisation shares in Settings, under AI configurations.", button: "Open settings", to: here("settings") },
            { text: "Read how the AI is kept reliable.", button: "Read about settings", to: { topic: "settings-page" } },
        ],
        words: ["exploration"],
        next: [{ text: "Run an exploration to see the AI at work.", button: "Read how exploring works", to: { topic: "explore-my-app" } }],
        topic: "ai-usage",
    },
};

/** Every id of the table, so a test can walk it. */
export const PLACE_IDS = Object.keys(PLACES) as PlaceId[];

interface RouteLike {
    parts: string[];
    query: URLSearchParams;
}

const pick = <T extends string>(list: readonly T[], v: string | null): T => list.find((x) => x === v) ?? list[0]!;

/**
 * Which place a route is. The same function the tests walk over the router's own section lists, so a section added to the
 * router without help text makes `PLACES[placeOf(...)]` undefined and a test fail.
 */
export function placeOf(route: RouteLike): PlaceId {
    const [a, b, c, d] = route.parts;
    const q = route.query;
    if (!a) return "projects";
    if (a === "new" || a === "create") return "new-project";
    if (a === "dashboard") return "dashboard";
    if (a === "develop") return "develop";
    if (a === "runners") return "runners-global";
    if (a === "integrations") return "integrations";
    if (a === "project-folders") return "folders";
    if (a === "libraries" || a === "folders") return "libraries";
    if (a === "agents") return "agents";
    if (a === "profile") return "profile";
    if (a === "settings") return "settings";
    if (a === "security") return "security-home";
    if (a === "guide") return b === "words" ? "guide-words" : b ? "guide-topic" : "guide";
    if (a === "tests" && b) return c === "text" ? "test-text" : c === "code" ? "test-code" : c === "history" ? "test-history" : "test-steps";
    if (a === "projects" && b) {
        // Round 25 places. A section that moved keeps the help it had in its old place (the same page, under a new name).
        if (c === "tests") return q.get("section") === "manual" ? "release-manual" : "tests";
        if (c === "requirements") return "requirements";
        if (c === "suites") return d ? "suite-detail" : "suites";
        if (c === "agent") return "agent-runs";
        if (c === "scripts") {
            const s = pick(SCRIPTS_SECTIONS, q.get("section"));
            if ((s === "scripts" || s === "review") && q.get("test") && q.get("version")) return "script-version";
            if (s === "scripts") return "scripts";
            if (s === "review") return "scripts-review";
            return s === "steps" && q.get("edit") ? "library-steps-edit" : (`library-${s}` as PlaceId);
        }
        if (c === "settings") {
            const s = pick(SETTINGS_SECTIONS, q.get("section"));
            if (s === "general" || s === "members" || s === "ai") return `settings-${s}` as PlaceId;
            if (s === "data" || s === "accounts") return `library-${s}` as PlaceId;
            return `setup-${s}` as PlaceId;
        }
        if (c === "runs") {
            if (d) return "run-detail";
            const s = pick(RUNS_SECTIONS, q.get("section"));
            return s === "releases" || s === "compliance" ? (`release-${s}` as PlaceId) : (`runs-${s}` as PlaceId);
        }
        if (c === "library") {
            const s = pick(LIBRARY_SECTIONS, q.get("section"));
            return s === "steps" && q.get("edit") ? "library-steps-edit" : (`library-${s}` as PlaceId);
        }
        if (c === "setup") return `setup-${pick(SETUP_SECTIONS, q.get("section"))}` as PlaceId;
        if (c === "release") return d ? "release-detail" : (`release-${pick(RELEASE_SECTIONS, q.get("section"))}` as PlaceId);
        if (c === "write-code") return "write-code";
        if (c === "record") return "recorder";
        if (c === "security") return "security-project";
        return "overview";
    }
    return "projects";
}
