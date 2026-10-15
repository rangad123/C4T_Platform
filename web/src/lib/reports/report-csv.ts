/**
 * The rule every report download here answers to — kept as a record, because
 * the downloads themselves are now Excel workbooks (`summary-report-xlsx.ts`
 * for the Reports module, `build-report-xlsx.ts` for a project's build) and no
 * longer CSV. Other files point here for the history; nothing imports it.
 *
 * ── READ THIS BEFORE ADDING A COLUMN
 *
 * Export was built once across this platform and removed entirely on
 * 2026-09-02 as a PII leak. The old `exportBugsCSV` emitted one row per bug
 * including the reporter's email address, and a customer-facing proxy meant a
 * customer could download testers' contact details from their own project
 * page. Eleven API routes, seven buttons and the API's own `lib/csv.ts` went
 * with it.
 *
 * What exists now is not that export restored:
 *
 *   - The Reports module (by project, build, date, build range) writes only the
 *     AGGREGATE figures its page already renders — counts by severity, status,
 *     type and reproducibility, and the summary tiles. No per-bug row, no name,
 *     no email, no tester identity of any kind. A count is fine; a list of
 *     people is not.
 *   - A project's own build report (`/projects/[id]/download`) is deliberately
 *     wider: per-bug rows and tester names, because it is reached only from
 *     inside that project, and a name is what "which testers, which bugs" needs
 *     to mean anything. It still never carries an email address, a phone
 *     number or a signed download link — the types it is built from do not
 *     declare them, so nothing built on them can read them.
 *
 * If a future change wants more identity than that, it is a decision about
 * identity columns and it needs making deliberately — not by adding a field
 * because the data happened to be in scope.
 *
 * Callers must also leave out figures that identify by arithmetic. The
 * by-project payload carries `testersByCountry`, and it is deliberately not
 * written: a per-country head count identifies a person the moment that count
 * is one.
 */
export {}
