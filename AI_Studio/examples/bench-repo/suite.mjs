// The PR bench's frozen suite: API tests of bench-shop and bench-rbac written from each app's requirements document (the requirement
// numbers are in `source.requirements`), not from its seeded defects. Every test passes on main. The bench imports it once per app and
// never changes it. Each test signs in as a seeded account only to read, and changes only data it created itself ({{unique}} accounts),
// so the tests do not depend on each other's order.
const req = (method, path, body, extract) => ({ action: "request", method, path, ...(body !== undefined ? { body } : {}), ...(extract ? { extract } : {}) });
const status = (n) => ({ action: "assertResponse", check: "status", expected: n });
const json = (path, expected) => ({ action: "assertResponse", check: "jsonPath", path, expected });
const type = (path, expected) => ({ action: "assertResponse", check: "jsonType", path, expected });
const has = (expected) => ({ action: "assertResponse", check: "bodyContains", expected });
const lacks = (expected) => ({ action: "assertResponse", check: "bodyNotContains", expected });
const spec = (title, category, requirements, steps, priority = "medium") => ({ title, kind: "api", category, priority, source: { origin: "requirements", requirements }, steps });

const PW = "Password1!";
const login = (email) => [req("POST", "/api/login", { email, password: PW }), status(200)];
const newAccount = (who) => [req("POST", "/api/register", { name: `Bench ${who}`, email: `${who}-{{unique}}@example.test`, password: PW }, { me: "id" }), status(201)];
const add = (productId, quantity) => [req("POST", "/api/cart/items", { productId, quantity }), status(201)];
const address = [req("POST", "/api/checkout/address", { address: "1 Test Road, Leeds" }), status(200)];

const shop = [
    spec("The shop lists its five products", "Products", ["2.1"], [req("GET", "/api/products"), status(200), json("products.length", 5), json("products.4.name", "Water Bottle")]),
    spec("A product reads with its price in cents", "Products", ["2.3", "2.7"], [req("GET", "/api/products/p2"), status(200), json("name", "Desk Lamp"), json("price", 3450)]),
    spec("An unknown product is not found", "Products", ["2.6"], [req("GET", "/api/products/p99"), status(404)]),
    spec("A new account is signed in and has no address yet", "Accounts", ["1.4", "1.10"], [...newAccount("new"), req("GET", "/api/profile"), status(200), json("address", "")]),
    spec("Registering with an invalid email is refused", "Accounts", ["1.6"], [req("POST", "/api/register", { name: "Bench", email: "not-an-email", password: PW }), status(400), json("error", "Enter a valid email address.")], "high"),
    spec("Registering with a short password is refused", "Accounts", ["1.7"], [req("POST", "/api/register", { name: "Bench", email: "short-{{unique}}@example.test", password: "abc" }), status(400)]),
    spec("An email address belongs to one account", "Accounts", ["1.8", "1.9"], [req("POST", "/api/register", { name: "Bench", email: " Alice@Example.test ", password: PW }), status(409)]),
    spec("A wrong password is refused", "Accounts", ["1.11"], [req("POST", "/api/login", { email: "alice@example.test", password: "wrong-password" }), status(401), json("error", "Email or password is wrong.")]),
    spec("Signing out ends the session", "Accounts", ["1.12"], [...login("alice@example.test"), req("POST", "/api/logout"), status(200), req("GET", "/api/cart"), status(401)], "high"),
    spec("A visitor's cart request asks to sign in", "API", ["8.2"], [req("GET", "/api/cart"), status(401), json("error", "Sign in first.")]),
    spec("Adding a product creates a cart line", "Cart", ["3.2", "3.8"], [...newAccount("line"), ...add("p1", 2), json("lines.0.quantity", 2), json("lines.0.lineTotal", 2500)]),
    spec("Adding a product again increases its quantity", "Cart", ["3.3"], [...newAccount("again"), ...add("p1", 1), ...add("p1", 2), json("lines.length", 1), json("lines.0.quantity", 3)]),
    spec("A product that does not exist cannot be added", "Cart", ["3.4"], [...newAccount("ghost"), req("POST", "/api/cart/items", { productId: "p99", quantity: 1 }), status(404), json("error", "Product not found.")]),
    spec("At most 10 of an item can be added", "Cart", ["3.6"], [...newAccount("ten"), ...add("p3", 10), req("POST", "/api/cart/items", { productId: "p3", quantity: 1 }), status(400)], "high"),
    spec("A quantity cannot be changed to more than 10", "Cart", ["3.6", "3.7"], [...newAccount("eleven"), ...add("p3", 1), req("PATCH", "/api/cart/items/p3", { quantity: 11 }), status(400)]),
    spec("The subtotal is the sum of the line totals", "Cart", ["3.9", "3.10"], [...newAccount("sum"), ...add("p1", 2), ...add("p3", 3), json("subtotal", 3775), json("total", 4275)], "critical"),
    spec("SAVE10 takes 10% off the subtotal", "Discounts", ["4.1"], [...newAccount("save"), ...add("p1", 2), ...add("p3", 2), req("POST", "/api/cart/discount", { code: " save10 " }), status(200), json("discount", 335), json("total", 3515)], "critical"),
    spec("Shipping is free from $50.00 after the discount", "Shipping", ["4.5"], [...newAccount("free"), ...add("p1", 4), json("subtotal", 5000), json("shipping", 0)], "high"),
    spec("Shipping costs $5.00 below the threshold", "Shipping", ["4.4"], [...newAccount("ship"), ...add("p3", 1), json("shipping", 500), json("total", 925)]),
    spec("An unknown discount code is refused", "Discounts", ["4.2"], [...newAccount("code"), ...add("p3", 1), req("POST", "/api/cart/discount", { code: "FREE100" }), status(400)]),
    spec("An order needs a delivery address", "Checkout", ["5.5"], [...newAccount("noaddr"), ...add("p1", 1), req("POST", "/api/orders"), status(409), json("error", "Add a delivery address first.")], "high"),
    spec("A short delivery address is refused", "Checkout", ["5.3"], [...newAccount("addr"), req("POST", "/api/checkout/address", { address: "abc" }), status(400)]),
    spec("Placing an order empties the cart", "Checkout", ["5.8", "5.9"], [...newAccount("empty"), ...add("p1", 1), ...address, req("POST", "/api/orders"), status(201), json("total", 1750), req("GET", "/api/cart"), status(200), json("lines.length", 0)], "critical"),
    spec("Orders are listed newest first", "Orders", ["6.3"], [...newAccount("two"), ...add("p3", 1), ...address, req("POST", "/api/orders"), status(201), ...add("p5", 1), ...address, req("POST", "/api/orders", undefined, { second: "id" }), status(201), req("GET", "/api/orders"), status(200), json("orders.length", 2), json("orders.0.id", "{{second}}")]),
    spec("Another customer's order is not found", "Orders", ["6.6"], [...login("alice@example.test"), req("GET", "/api/orders/ord-1001"), status(404)], "critical"),
    spec("A shipped order cannot be cancelled", "Orders", ["6.8"], [...login("alice@example.test"), req("POST", "/api/orders/ord-1000/cancel"), status(409)], "high"),
    spec("A placed order can be paid", "Orders", ["6.7"], [...newAccount("pay"), ...add("p3", 1), ...address, req("POST", "/api/orders", undefined, { order: "id" }), status(201), req("POST", "/api/orders/{{order}}/pay"), status(200), json("status", "paid")]),
    spec("A cancelled order cannot be cancelled again", "Orders", ["6.8", "6.9"], [...newAccount("cancel"), ...add("p3", 1), ...address, req("POST", "/api/orders", undefined, { order: "id" }), status(201), req("POST", "/api/orders/{{order}}/cancel"), status(200), req("POST", "/api/orders/{{order}}/cancel"), status(409)]),
    spec("A saved name and address are the account's", "Account", ["7.2", "7.3"], [...newAccount("profile"), req("PUT", "/api/profile", { name: "Bench Renamed", address: "9 New Street, Hull" }), status(200), req("GET", "/api/profile"), status(200), json("name", "Bench Renamed"), json("address", "9 New Street, Hull")]),
    spec("The API description is served", "API", ["8.1"], [req("GET", "/openapi.json"), status(200)]),
    // Requirements the Phase 4 extension added (catalogue-extension.json), one test each.
    spec("Registering with an existing email in other letter case is refused", "Accounts", ["1.13"], [req("POST", "/api/register", { name: "Bench", email: "ALICE@EXAMPLE.TEST", password: PW }), status(409)]),
    spec("The cart page shows the cart's total after the discount", "Cart", ["3.12"], [...newAccount("page"), ...add("p1", 2), req("POST", "/api/cart/discount", { code: "SAVE10" }), status(200), json("total", 2750), req("GET", "/cart"), status(200), has('data-testid="total">$27.50<')]),
    spec("A refused discount code leaves the applied one", "Discounts", ["4.7"], [...newAccount("keep"), ...add("p1", 2), req("POST", "/api/cart/discount", { code: "SAVE10" }), status(200), req("POST", "/api/cart/discount", { code: "FREE100" }), status(400), req("GET", "/api/cart"), status(200), json("code", "SAVE10"), json("discount", 250)]),
    spec("A default address over 200 characters is refused", "Account", ["7.4"], [...newAccount("longaddr"), req("PUT", "/api/profile", { name: "Bench", address: "{{repeat.a.201}}" }), status(400), json("error", "The address can have at most 200 characters.")]),
    spec("An order's total is a whole number of cents", "API", ["8.5"], [...newAccount("cents"), ...add("p3", 1), ...address, req("POST", "/api/orders", undefined, { order: "id" }), status(201), req("GET", "/api/orders/{{order}}"), status(200), type("total", "number")]),
    spec("The profile answer holds no password", "API", ["8.6"], [...newAccount("secret"), req("GET", "/api/profile"), status(200), lacks('"password"')], "critical"),
];

const NOTE = "{{note}}";
const rbac = [
    spec("A new account is a user", "Accounts", ["2.4", "2.9"], [...newAccount("user"), json("role", "user")]),
    spec("Registering with a short password is refused", "Accounts", ["2.7"], [req("POST", "/api/register", { name: "Bench", email: "short-{{unique}}@example.test", password: "abc" }), status(400)], "high"),
    spec("Registering with an invalid email is refused", "Accounts", ["2.6"], [req("POST", "/api/register", { name: "Bench", email: "nope", password: PW }), status(400)]),
    spec("An email address belongs to one account", "Accounts", ["2.8"], [req("POST", "/api/register", { name: "Bench", email: "ben@example.test", password: PW }), status(409)]),
    spec("A wrong password is refused", "Accounts", ["2.11"], [req("POST", "/api/login", { email: "ana@example.test", password: "wrong-password" }), status(401)]),
    spec("A session that signed out gives no access", "Accounts", ["2.12"], [...login("ana@example.test"), req("POST", "/api/logout"), status(200), req("GET", "/api/me"), status(401)], "critical"),
    spec("A visitor's notes request asks to sign in", "API", ["6.2"], [req("GET", "/api/notes"), status(401)]),
    spec("The account shows the person's role", "Accounts", ["2.13"], [...login("mia@example.test"), req("GET", "/api/me"), status(200), json("role", "manager")]),
    spec("A new note belongs to the person who wrote it", "Notes", ["3.3"], [...newAccount("writer"), req("POST", "/api/notes", { title: "Shopping", body: "Milk" }), status(201), json("owner", "Bench writer")]),
    spec("A note without a title is refused", "Notes", ["3.4"], [...newAccount("untitled"), req("POST", "/api/notes", { title: "  ", body: "text" }), status(400), json("error", "Give the note a title.")], "high"),
    spec("A title longer than 120 characters is refused", "Notes", ["3.5"], [...newAccount("long"), req("POST", "/api/notes", { title: "{{repeat.a.121}}" }), status(400)]),
    spec("Someone else's private note is not found", "Notes", ["3.7", "3.8"], [...login("ana@example.test"), req("GET", "/api/notes/n2"), status(404)], "critical"),
    spec("A manager reads every note", "Notes", ["1.4"], [...login("mia@example.test"), req("GET", "/api/notes/n2"), status(200)]),
    spec("A shared note can be read by the colleague", "Sharing", ["3.7"], [...login("ana@example.test"), req("GET", "/api/notes/n3"), status(200), json("title", "Team lunch ideas")]),
    spec("Only the owner can change a note", "Notes", ["3.10"], [...login("ana@example.test"), req("PUT", "/api/notes/n3", { title: "Changed by Ana" }), status(403)], "critical"),
    spec("The owner saves changes to a note", "Notes", ["3.11", "3.12"], [...newAccount("editor"), req("POST", "/api/notes", { title: "Draft" }, { note: "id" }), status(201), req("PUT", `/api/notes/${NOTE}`, { title: "Final", body: "Done" }), status(200), json("title", "Final")]),
    spec("Only the owner can delete a note", "Notes", ["3.13"], [...login("ana@example.test"), req("DELETE", "/api/notes/n3"), status(403)]),
    spec("Sharing with an unknown email is refused", "Sharing", ["4.3"], [...newAccount("lonely"), req("POST", "/api/notes", { title: "Solo" }, { note: "id" }), status(201), req("POST", `/api/notes/${NOTE}/share`, { email: "nobody@example.test" }), status(404)]),
    spec("A note cannot be shared with its owner", "Sharing", ["4.4"], [...newAccount("self"), req("POST", "/api/notes", { title: "Mine" }, { note: "id" }), status(201), req("POST", `/api/notes/${NOTE}/share`, { email: "self-{{unique}}@example.test" }), status(400)]),
    spec("A colleague reads a note shared with them", "Sharing", ["4.2"], [...newAccount("sharer"), req("POST", "/api/notes", { title: "For Ben" }, { note: "id" }), status(201), req("POST", `/api/notes/${NOTE}/share`, { email: "ben@example.test" }), status(200), ...login("ben@example.test"), req("GET", `/api/notes/${NOTE}`), status(200)]),
    spec("Stopping sharing removes the colleague's access", "Sharing", ["4.6"], [...newAccount("unsharer"), req("POST", "/api/notes", { title: "Was for Ben" }, { note: "id" }), status(201), req("POST", `/api/notes/${NOTE}/share`, { email: "ben@example.test" }), status(200), req("DELETE", `/api/notes/${NOTE}/share/u2`), status(200), ...login("ben@example.test"), req("GET", `/api/notes/${NOTE}`), status(404)], "high"),
    spec("A user cannot list the people", "People", ["5.3"], [...login("ben@example.test"), req("GET", "/api/admin/users"), status(403)], "critical"),
    spec("An admin lists the people", "People", ["5.1"], [...login("ada@example.test"), req("GET", "/api/admin/users"), status(200), json("users.0.email", "ana@example.test")]),
    spec("A manager cannot change roles", "People", ["5.4"], [...newAccount("target"), ...login("mia@example.test"), req("PATCH", "/api/admin/users/{{me}}", { role: "manager" }), status(403)], "critical"),
    spec("A role outside user, manager and admin is refused", "People", ["5.5"], [...login("ada@example.test"), req("PATCH", "/api/admin/users/u1", { role: "boss" }), status(400)]),
    spec("Changing an unknown person's role is refused", "People", ["5.6"], [...login("ada@example.test"), req("PATCH", "/api/admin/users/u999", { role: "user" }), status(404)]),
    // Requirements the Phase 4 extension added (catalogue-extension.json), one test each.
    spec("Five failed sign-ins lock the email for a minute", "Accounts", ["2.14"], [...newAccount("locked"), req("POST", "/api/logout"), status(200), ...[1, 2, 3, 4, 5].flatMap(() => [req("POST", "/api/login", { email: "locked-{{unique}}@example.test", password: "wrong-password" }), status(401)]), req("POST", "/api/login", { email: "locked-{{unique}}@example.test", password: PW }), status(429)], "high"),
    spec("A note's title is shown as plain text", "Notes", ["3.15"], [...newAccount("markup"), req("POST", "/api/notes", { title: "<b>Bold</b> plan" }, { note: "id" }), status(201), req("GET", `/notes/${NOTE}`), status(200), has("&lt;b&gt;Bold&lt;/b&gt; plan"), lacks("<b>Bold</b>")], "high"),
    spec("A changed role applies from the next request", "People", ["5.7"], [...newAccount("promoted"), ...login("ada@example.test"), req("PATCH", "/api/admin/users/{{me}}", { role: "manager" }), status(200), req("POST", "/api/login", { email: "promoted-{{unique}}@example.test", password: PW }), status(200), req("GET", "/api/me"), json("role", "manager")]),
];

export const SUITE = { "bench-shop": shop, "bench-rbac": rbac };
