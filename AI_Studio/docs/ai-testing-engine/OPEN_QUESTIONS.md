# Open questions

All twelve were answered on 2026-11-14 (#1 and #2 earlier, #3-#12 in DECISIONS.md, section H). Kept for the reasoning.

Decisions needed before or during the phases. Each says why it matters and a recommended default.

| # | Question | Why it matters | Recommended default |
|---|---|---|---|
| 1 | Which real AI model and monthly budget may the benchmark use? | Scripted models only prove plumbing; bug-finding numbers need a real model, run several times | One strong model for planning/assertions, a fixed monthly cap for benchmark runs, outside customer usage |
| 2 | May the engine send data-changing requests and submit forms by default in a non-production environment the customer has authorised? | Stateful, boundary, duplicate-submit and authorization testing mostly need it; today it is off by default (`platform/repo.ts:168`) and the crawler never submits (`crawler.ts:310`) | Yes, only for an environment marked non-production with a written authorization record and cleanup; production stays read-only |
| 3 | Is a read-only database connection from the runner acceptable to customers, or should invariants stay API-level? | Database invariants are the most expensive capability (L-XL) | API-level invariants first; database probe later and opt-in per environment |
| 4 | One findings model for functional and security findings, or two tables with the same shape? | Dedupe, history and reporting should work the same for both | One generalised model; security findings migrated or read through it |
| 5 | Should the advanced security profile be startable (with approval)? Today every assessment is created `passive` (`security/store.ts:641`) and scanners do not run in the hosted mode | Object-level and stateful API checks exist in a scanner adapter but are unreachable | Keep passive by default; build the read-only horizontal object check natively (Phase 4) before reviving scanners |
| 6 | Add fast-check (and possibly ajv) as dependencies, or keep generated scripts dependency-free with the existing seeded generator and subset validator? | Generated scripts run on runners; every dependency ships in the runner kit | Use fast-check only inside the engine to generate data; keep scripts dependency-free |
| 7 | Should the authoring step that chooses assertions stay on the fast model? (`llm/routing.ts:43`) | Assertion quality is the core weakness | Sourced assertions on the strong model; routine steps on the fast model |
| 8 | What counts as a "confirmed" bug for the product? | Precision is the trust metric | Reproduced in at least 2 of 3 clean replays and backed by a sourced expectation, or by a deterministic oracle (5xx, crash, contract break, authorization breach) |
| 9 | Which real applications (with permission) are used to verify beyond fixtures in Phase 7? | Benchmarks on owned fixtures overstate real-world results | Two or three consenting customer staging environments, chosen before Phase 3 |
| 10 | Should the PostgreSQL/S3 move happen before Phase 5 (more rows, observation artifacts)? | Single SQLite process and local disk; observation logs add volume | Not required; keep artifacts in the object store with retention; revisit at Phase 5 |
| 11 | Pull-request integration: GitHub only, or also the deploy-trigger route with a commit range? | Change-aware testing needs a diff source | Start with the existing deploy trigger plus GitHub pull requests; others later |
| 12 | Should exploratory sessions be allowed to run long (one active job per project blocks scheduled runs of that project)? | `scheduler.ts:activeJobOf` | Bounded sessions (time/action budgets) and a separate queue slot for benchmark jobs |
