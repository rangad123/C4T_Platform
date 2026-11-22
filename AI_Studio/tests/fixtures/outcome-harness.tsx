/**
 * A test page for the outcome report (tests/outcome-report-ui.test.ts bundles it with esbuild): the app's styles and one CaseOutcome,
 * chosen by `?fixture=` (tests/fixtures/outcome-fixtures.ts). `&download=0` leaves out the workbook link (a person who may not export).
 */
import { createRoot } from "react-dom/client";
import "../../web/src/styles/tokens.css";
import "../../web/src/styles/base.css";
import "../../web/src/styles.css";
import { CaseOutcome } from "../../web/src/features/outcome/CaseOutcome";
import { OUTCOMES, type OutcomeFixture } from "./outcome-fixtures";

const q = new URLSearchParams(location.search);
const outcome = OUTCOMES[(q.get("fixture") ?? "full") as OutcomeFixture];
const href = q.get("download") === "0" ? null : "/api/projects/p1/outcome/workbook";

createRoot(document.getElementById("root")!).render(
    <main className="content">
        <h1 className="t-page" style={{ marginBottom: 24 }}>
            Practice Store
        </h1>
        <CaseOutcome outcome={outcome} downloadHref={href} emptyActions={<button className="btn btn-primary">Explore</button>} />
    </main>,
);
