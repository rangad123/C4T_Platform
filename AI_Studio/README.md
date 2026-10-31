# AI Testing Platform

Give it an application URL. It explores the app, understands it, plans tests, generates
executable Playwright / API test scripts from a framework-independent specification, **runs them to
validate them**, and stores the validated suite. No chat interface — the AI is a backend worker.

```
URL → discover → understand → plan → author specs → render scripts → execute → repair → validated suite
```

**Feature guides:** [identity & access control](docs/features/identity.md) · [performance](docs/features/performance.md) · [API contracts & diff](docs/features/contracts.md) · [form input](docs/features/input-checks.md) · [reports](docs/features/reports.md) · [test quality](docs/features/test-quality.md) · [checks](docs/features/checks.md) · [browsers](docs/features/variants.md) · [schedules & alerts](docs/features/schedules.md) · [CI](docs/features/ci.md) · [issues](docs/features/issues.md) · [environments & test data](docs/features/environments-and-data.md) · [site memory](docs/features/site-memory.md) · [vision judgement](docs/features/vision-judgement.md) · [repair suggestions & deploy triggers](docs/features/healing-and-triggers.md) · [load check](docs/features/load-testing.md) · [test data cleanup](docs/features/test-data-cleanup.md) · [dashboard](docs/features/dashboard.md) · [plain-English tests](docs/features/plain-english-tests.md) · [failure evidence](docs/features/failure-evidence.md) · [MCP server](docs/features/mcp-server.md) · [Teams, email & Maestro](docs/features/notifications-and-import.md) · [runbooks](docs/features/runbooks.md) · [manual cases & sign-off](docs/features/manual-cases-and-signoff.md) · [Notion & Sentry](docs/features/notion-and-sentry.md) · [storage & backup](docs/features/storage-and-backup.md) · [AI usage budgets](docs/features/ai-usage-budgets.md) · [quarantine](docs/features/quarantine.md) · [framework adapters](docs/features/framework-adapters.md) · [runner agent](docs/features/runner-agent.md) · [agent setup](docs/features/runner-agent-setup.md) · [Windows desktop tests](docs/features/windows-desktop-tests.md) · [object repository](docs/features/object-repository.md) · [framework settings](docs/features/framework-settings.md) · [live updates](docs/features/live-stream.md) · [recorder](docs/features/recorder.md) · [hand-written tests](docs/features/custom-scripts.md) · [Git import](docs/features/git-import.md) · [visual builder](docs/features/visual-builder.md) · [iOS tests](docs/features/ios-tests.md) · [live session](docs/features/live-session.md) · [doctor](docs/features/doctor.md) · [reusable steps](docs/features/step-blocks.md) · [text tests](docs/features/text-tests.md) · [run control](docs/features/ux-run-control.md) · [explain in place](docs/features/ux-explain.md) · [navigation](docs/features/ux-navigation.md) · [test workbench](docs/features/ux-workbench.md) · [first run](docs/features/ux-first-run.md) · [in-app guide](docs/features/ux-guide.md) · [adapter plug-ins](docs/features/adapter-plugins.md) · [frames, uploads and pop-ups](docs/features/frames-uploads-popups.md) · [hard sign-ins](docs/features/hard-sign-ins.md) · [phone quality checks](docs/features/phone-quality-checks.md) · [phone reliability](docs/features/phone-reliability.md) · [device farms](docs/features/device-farms.md) · [people and access](docs/features/people-and-access.md) · [AI model reliability](docs/features/ai-model-reliability.md) · [measuring the AI tester](docs/features/evaluation.md) · [test suite](docs/features/test-suite.md) · [production hosting](docs/features/production-hosting.md) · [complete runner download](docs/features/runner-complete-kit.md) · [runner browsers](docs/features/runner-browsers.md) · [company networks](docs/features/company-networks.md) · [runner updates](docs/features/runner-updates.md) · [check this computer](docs/features/runner-check.md) · [simple phone setup](docs/features/phone-setup-simple.md) · [portable code tests](docs/features/portable-code-tests.md) · [real-machine checks](docs/features/real-machine-checks.md) · [security assessment](docs/features/security-assessment.md) · [external scanners](docs/features/security-scanners.md)

**How to use it:** [docs/USER_GUIDE.md](docs/USER_GUIDE.md) (plain language, for testers) · **Install and run it:** [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md) · **For programs:** [docs/API_REFERENCE.md](docs/API_REFERENCE.md) · **How it works:** [docs/AI_TESTING_ARCHITECTURE.md](docs/AI_TESTING_ARCHITECTURE.md)

Quick start:

```bash
npm install && npx playwright install chromium
cp .env.example .env     # add ANTHROPIC_API_KEY (or another provider)
npm run build:web && npm start        # http://127.0.0.1:4000
npm run test:fast                     # ~20 s: the tests that need no browser
npm test                              # the full suite (no LLM needed; ~30 min; `npm test -- --shard=1/4` runs a quarter)
npm run test:ui:browsers              # UI tests on Chromium, Firefox and WebKit
npm run ai-test -- run --specs specs.json --url <app> --fail-on high   # gate a CI pipeline (no AI needed)
npx @taqwright/taqwright install --with-avd      # optional: Android emulator for mobile tests
MOBILE_E2E=1 npm run test:mobile:device   # mobile tests on a real emulator
npm run demo:e2e                      # real LLM run against the bundled sample app
docker compose up --build             # or run it in Docker (set API_KEY in .env)
```

- Web tests need an LLM key. OpenAPI-driven API tests do not.
- Licensing of the reused open-source code: [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
- `references/` holds the cloned upstream repos for study; it is git-ignored.
