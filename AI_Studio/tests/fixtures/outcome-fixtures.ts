/**
 * Outcomes of a Test Case Generation project, as `GET /api/projects/:id/outcome` answers them (PLAN.md "Outcome contract"), for the
 * outcome report's browser test (tests/outcome-report-ui.test.ts, rendered by tests/fixtures/outcome-harness.tsx). The full one is a small
 * shop after three runs: 12 pages in three levels, 16 test cases, 5 addresses that failed to load, two "what is missing" lines.
 */
import type { CaseOutcome, CaseOutcomeCase, CaseOutcomeTreeNode } from "../../src/platform/case-outcome-types.js";

const ORIGIN = "http://127.0.0.1:6731";
const PAGES: Array<[path: string, parent: string | null, title: string, purpose: string]> = [
    ["/", null, "Home", "The shop's front page, with featured products and the main menu."],
    ["/products", "/", "Products", "Lists products, with search, category and price filters."],
    ["/products/1", "/products", "Product: Travel mug", "Shows one product with its price and a quantity field."],
    ["/products?page=2", "/products", "Products, page 2", "The second page of the product list."],
    ["/cart", "/", "Cart", "The items chosen so far, with quantities and a total."],
    ["/checkout", "/cart", "Checkout", "Delivery address and payment, then the order is placed."],
    ["/login", "/", "Sign in", "Email and password sign-in."],
    ["/signup", "/login", "Create an account", "A form for a new customer account."],
    ["/orders", "/", "Your orders", "Past orders; signed-in customers only."],
    ["/orders/1001", "/orders", "Order 1001", "One order's items, status and a cancel button."],
    ["/about", "/", "About us", "Who runs the shop."],
    ["/contact", "/about", "Contact", "A message form and the shop's address."],
];

const tree: CaseOutcomeTreeNode[] = PAGES.map(([node, parent, title]) => ({ node, parent, page: node, title, cases: 0 }));

const auto = (page: string, title: string, priority: CaseOutcomeCase["priority"], preconditions: string[], expected: string[], requirement = ""): Omit<CaseOutcomeCase, "id"> => ({ title, type: "automated", priority, page, preconditions, steps: [], expected, requirement });
const manual = (page: string, title: string, priority: CaseOutcomeCase["priority"], steps: Array<[string, string]>, requirement = ""): Omit<CaseOutcomeCase, "id"> => ({ title, type: "manual", priority, page, preconditions: [], steps: steps.map(([action, expected]) => ({ action, expected })), expected: [], requirement });

const CASES: Array<Omit<CaseOutcomeCase, "id">> = [
    auto("/", "Open a product from the featured list", "high", ["The shop has at least one featured product."], ["The product's page opens with its name and price."]),
    auto("/", "Use the main menu to reach every section", "medium", [], ["Each menu item opens its page without an error."]),
    auto("/products", "Search for a product by name", "high", [], ["Only products whose name contains the words are listed."], "REQ-3 Customers can search the catalogue"),
    auto("/products", "Filter by category and price together", "medium", ["Products exist in two categories."], ["The list shows only products in the category and price range.", "The count above the list matches the rows."]),
    auto("/products", "Show a message when the minimum price is above the maximum", "low", [], ["A message says the price range is not valid, and the list does not change."]),
    auto("/products/1", "Refuse a quantity of zero", "high", [], ["The quantity field says the value must be at least 1."]),
    manual("/products/1", "Check the product photo zooms on a phone", "low", [["Open the product page on a phone.", "The photo fits the screen."], ["Pinch to zoom the photo.", "The photo zooms without blurring."]]),
    auto("/products?page=2", "Go to the second page of products and back", "low", [], ["Page 2 lists different products, and Back returns to page 1."]),
    auto("/cart", "Change a quantity and see the total update", "critical", ["The cart holds one item."], ["The total is the price times the new quantity."], "REQ-7 The cart total is always correct"),
    auto("/checkout", "Place an order with a valid address", "critical", ["Signed in as a customer.", "The cart holds one item."], ["The order confirmation shows an order number."], "REQ-8 Customers can place an order"),
    manual("/checkout", "Check the payment page reads well with a screen reader", "medium", [["Turn on the screen reader and open checkout.", "Every field is announced with its label."], ["Leave the card number empty and press Pay.", "The error is announced and the focus moves to the field."]]),
    auto("/login", "Sign in with a wrong password", "high", [], ["A message says the email or password is wrong, and the person stays signed out."]),
    auto("/signup", "Refuse an email that is already registered", "medium", [], ["A message says an account with this email already exists."]),
    auto("/orders", "Send a signed-out visitor to sign in", "high", ["Signed out."], ["The sign-in page opens, and after signing in the orders list shows."]),
    auto("/orders/1001", "Cancel an order that has not shipped", "high", ["Signed in as the customer who placed order 1001."], ["The order's status is Cancelled."]),
    auto("/contact", "Send a message with an empty email", "low", [], ["The form says the email is needed and sends nothing."]),
];

const cases: CaseOutcomeCase[] = CASES.map((c, i) => ({ ...c, id: `TC-${String(i + 1).padStart(3, "0")}` }));
for (const n of tree) n.cases = cases.filter((c) => c.page === n.node).length;

export const FULL: CaseOutcome = {
    caseAgent: true,
    runs: [
        { jobId: "job-3", startedAt: "2026-11-19T15:00:00.000Z", status: "completed", addedPages: 2, addedCases: 3 },
        { jobId: "job-2", startedAt: "2026-11-19T12:00:00.000Z", status: "stopped", addedPages: 4, addedCases: 6 },
        { jobId: "job-1", startedAt: "2026-11-19T09:00:00.000Z", status: "completed", addedPages: 6, addedCases: 7 },
    ],
    pages: PAGES.map(([path, , title, purpose]) => ({ path, url: `${ORIGIN}${path}`, title, purpose })),
    tree,
    cases,
    notOpened: 5,
    missing: ["How a customer pays by bank transfer: the explorer could not reach it.", "What an administrator can do: no administrator account was given."],
};

/** The newest run was stopped part way: what it found is kept. */
export const STOPPED: CaseOutcome = { ...FULL, runs: [{ jobId: "job-4", startedAt: "2026-11-20T10:00:00.000Z", status: "stopped", addedPages: 3, addedCases: 4 }, ...FULL.runs], missing: [] };

/** Never explored. */
export const EMPTY: CaseOutcome = { caseAgent: true, runs: [], pages: [], tree: [], cases: [], notOpened: 0, missing: [] };

/** The first run was stopped before it found a page (only failed addresses). */
export const STOPPED_EMPTY: CaseOutcome = { ...EMPTY, runs: [{ jobId: "job-1", startedAt: "2026-11-20T10:00:00.000Z", status: "stopped", addedPages: 0, addedCases: 0 }], notOpened: 2 };

/** The first run is still exploring. */
export const RUNNING_EMPTY: CaseOutcome = { ...EMPTY, runs: [{ jobId: "job-1", startedAt: "2026-11-20T10:00:00.000Z", status: "running", addedPages: 0, addedCases: 0 }] };

/** A run from the requirements alone (SPEC R16): three requirement areas with two cases each, no page (F3 round 2 M5, L11). */
const AREAS = ["REQ-1 Sign in", "REQ-2 Search the products", "REQ-3 Pay for an order"];
export const REQUIREMENTS: CaseOutcome = {
    caseAgent: true,
    runs: [{ jobId: "job-1", startedAt: "2026-11-20T10:00:00.000Z", status: "completed", addedPages: 0, addedCases: 6 }],
    pages: [],
    tree: AREAS.map((a) => ({ node: a, parent: null, page: "", title: a, cases: 2 })),
    cases: AREAS.flatMap((a, i) => [
        { ...auto("", `Verify ${a.slice(6)} works`, "high", [], []), requirement: a.slice(0, 5), area: a, id: `TC-00${2 * i + 1}` },
        { ...manual("", `Check ${a.slice(6)} by hand`, "low", [[`Open ${a.slice(6)}`, "It opens"]]), requirement: a.slice(0, 5), area: a, id: `TC-00${2 * i + 2}` },
    ]),
    notOpened: 0,
    missing: [],
};

/** Two cases with one title whose start pages are not pages of the tree: each row names its own start page (F3 round 2 L10). */
export const SAME_TITLE: CaseOutcome = {
    ...REQUIREMENTS,
    runs: [{ jobId: "job-1", startedAt: "2026-11-20T10:00:00.000Z", status: "completed", addedPages: 1, addedCases: 3 }],
    pages: [{ path: "/", url: `${ORIGIN}/`, title: "Home", purpose: "" }],
    tree: [{ node: "/", parent: null, page: "/", title: "Home", cases: 3 }],
    cases: [
        { ...auto("/", "Open the cart", "high", [], []), start: "/basket", id: "TC-001" },
        { ...auto("/", "Open the cart", "high", [], []), start: "/basket/mini", id: "TC-002" },
        { ...auto("/", "Open home", "high", [], []), id: "TC-003" },
    ],
};

export const OUTCOMES = { full: FULL, stopped: STOPPED, empty: EMPTY, "stopped-empty": STOPPED_EMPTY, "running-empty": RUNNING_EMPTY, requirements: REQUIREMENTS, "same-title": SAME_TITLE } as const;
export type OutcomeFixture = keyof typeof OUTCOMES;
