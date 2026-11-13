# Text tests

A test written as plain text, one line per step. The words are fixed, so a test can be written, reviewed, compared and kept in Git as text. No AI model is involved: a fixed grammar reads the text, the same text always gives the same test.

```
Test: Sign in and see the dashboard
Kind: web

Go to /login
Type "{{credentials.username}}" into the "Email" field
Type "{{credentials.password}}" into the "Password" field
Click the "Sign in" button
Expect the text "Welcome back" to be visible
Run the reusable steps "Open the cart" with item = "Mug"
```

## What a person sees

- **Step editor, Steps | Text switch.** The Text view shows the test as text in the same editor the code feature uses (named "Test text"). While you type, the platform checks the text and lists problems with line and column; each problem jumps to its line, and a near miss gets a "did you mean". **Save and run** saves through the same checks as the step editor (new version in the history, script rendered again, a validation run). **Copy text** and **Download as .txt** are on the toolbar. **Phrases you can use** lists every line you can write, made from the grammar itself.
- **Switching views keeps unsaved work.** Steps you changed but did not save appear in the text. Text that reads is shown as steps (the lines at the top that the steps view does not show, such as Priority and Tag, ride along and are saved with the next save). Text that does not read yet stays in the Text view with the first problem named, and can be dropped.
- **A test that has no text form** (a step with a setting no phrase has, a desktop or mobile test) is shown read-only with the reasons, and a `# not expressible` line where the step would be. Hand-written tests have no Text view; they are edited as code.
- **Tests page, Write as text.** Opens the same editor on a short example (web or API), checks it as you type and creates the test. The platform's own refusals (a typed-in password, sign-in details sent to another site, an address that is not allowed) come back on the line they belong to, and nothing is created.
- Keyboard: Escape, then Tab leaves the editor. Phone width has no sideways scroll.

## The format

- Line based, UTF-8, at most 500 lines and 50 KB. Blank lines and lines that start with `#` are ignored and are **not kept** when a test is saved (comments do not round-trip).
- Header lines come first: `Test:` (required, 3 to 160 characters), `Kind:` (web or api, default web), `Category:`, `Type:`, `Priority:`, `Description:`, and repeatable `Tag:`, `Precondition:`, `Result:` and `Data: name = "value"` (a value steps can use as `{{name}}`). `Title:` is read as `Test:`. A value is plain text, or in double quotes when it has leading or trailing spaces, starts with a quote or holds a line break.
- One step per line. Words can be in any case, extra spaces are ignored. Texts are in double quotes with `\"`, `\\`, `\n`, `\r`, `\t` and `\uXXXX` escapes. Placeholders such as `{{credentials.password}}` and `{{name}}` are kept exactly as typed; nothing is evaluated, nothing is fetched, there are no includes.
- A step may end with `note "why"`, which keeps the step's description.
- An element with a role and **no name** is written `the button`. For a role whose word the grammar also uses (status, application, ...) it is `the role "status"`. Once there is a name, any role word works (`the "Cart updated" status`). Before this, the common generated check "the status message says Added to the cart" could not be written, so the Text view refused a plain 3-step generated test.
- Elements are written once and used in every phrase: `the "Email" field` (a label), `the "Search" placeholder`, `the "Sign in" button` (any role: `the "Settings" tab`, or just `the button`), `the text "Welcome"`, `the test id "cart"`, `the element "#id"` (CSS selector), `the shared element "Cart / Checkout button"`. Add `exactly` or `loosely`, and `number 2` to pick the second match.
- Requests: `Send a POST request to /api/orders with the query "a" = "1" with the header "X-Id" = "7" with the body {"sku":"A1"} without signing in and remember "orderId" from "id"`. The body and schemas are JSON on the same line.

Every action and every check of the test specification has a phrase; a unit test fails when a later schema addition has none, and another reads every example back as its own phrase.

## How it works

`src/engine/dsl/*` is pure (no database, no network, no model): `grammar.ts` is the one table of phrases (templates with slots; the parser, the printer, the reference list and this page's list are all made from it), `lexer.ts` cuts a line into words and quoted texts, `match.ts` reads a line with the table and remembers how far the best attempt got (that is how a mistake is reported where it happened), `parser.ts` handles headers, caps, per-line recovery (up to 50 problems, each with line, column and an optional suggestion) and builds the canonical `TestSpec`, `printer.ts` writes a spec as text.

**No silent loss.** The printer reads back every line it writes and compares it with the step. A step that does not read back identical is not written; the test is then "not fully expressible in text", and the platform refuses to save its text. Empty `query`, `headers`, `extract` and `args` count as missing.

**Safety.** JSON bodies and schemas that contain `__proto__` (or `constructor.prototype`) are refused, as are `__proto__` names for headers, queries, remembered values, block values and test data; maps are built with own keys only, so nothing can change an object's prototype. JSON nesting is capped at 64 levels and 20,000 characters. Creating and saving go through the platform's own rules, so the credential-origin rule, the address guard, secret checks, shared elements and reusable steps all apply, and they resolve only inside the test's own project.

## API (behind the API key)

- `GET /api/dsl/phrases`: the reference list (headers, phrases with examples, notes).
- `POST /api/dsl/parse` `{ text }` returns `{ spec | null, diagnostics, truncated, stepLines }`. Pure; nothing is stored. At most five a second per caller (429 with `retry-after`).
- `POST /api/dsl/print` `{ spec }` returns `{ text, expressible, reasons }`. Pure; used when the editor switches from steps to text.
- `POST /api/projects/:id/dsl-tests` `{ text }` creates a test through the spec import (201 with `testId`, `key`, `jobId`). When another run is in progress the test is saved, `jobId` is null and `note` says why. A category line is optional (default "Written as text"). Problems come back as 422 `{ error, diagnostics }`, each with `line`, `column`, `message`.
- `GET /api/tests/:id/dsl` returns `{ text, expressible, reasons, editable, busy?, editReason? }`. Hand-written tests answer 409 pointing to the code editor.
- `PUT /api/tests/:id/dsl` `{ text, note? }` has the same answer as `PUT /api/tests/:id/spec`. 422 with line diagnostics (nothing saved) when the text does not read or a rule refuses it; 409 when the test is not fully expressible, hand-written or a run is in progress. The kind and the category of an existing test cannot be changed from the text (leave the Category line out to keep it).
- Creating and saving are recorded in the project's audit trail (`write-text`, `edit-steps`).

No migration, no new dependency.

## Every generated test can be written

A round-trip test (`tests/ux-text-roundtrip.test.ts`, specs from `tests/fixtures/spec-corpus.ts`) prints specs made by the platform's own paths as text and reads them back as the same test: API generation from OpenAPI (with and without contract checks), workflows, latency, load and access checks, the health, security, accessibility, input, page-speed, AI-judgement, visual and access-control families, the recorder, the plain-English API builder, and hand-written web steps with every locator strategy, action and check. A step the grammar genuinely cannot show (a locator with both a CSS selector and a role, a mobile or desktop test) is still refused with its reason; the text is never written wrong.

## What is not covered

- Desktop and mobile tests have no text form (their phrases for starting and closing an application exist only so every step has one, and they are refused in text).
- Comments and blank lines are not kept. A test's `source` and id are never in the text.
- Tests generated by the platform that use a setting no phrase has (for example an accessibility check with a number as its setting) stay read-only in the Text view.
- Phrases use the platform's own words; there is no way to define new phrases or macros (reusable steps are the way to share steps).
- Text is not compared with a version in Git for you: keep it in Git yourself and create or save from it.
- Line-by-line "did you mean" works on the first words of a step and on the words a phrase expects next; a typo inside quoted text is data and is not checked.

## Phrases

The list below is generated from the grammar table (`tests/dsl-unit.test.ts` fails if it drifts).

### Go to a page

- `Go to /login`: Open an address or a path of the site.

### Do something on the page

- `Click the "Sign in" button`: Click an element.
- `Type "{{credentials.username}}" into the "Email" field`: Type text into a field. Use a {{credentials.password}} style placeholder for secrets.
- `Choose the option "Large" in the "Size" field`: Choose an option of a drop-down list.
- `Check the "Remember me" field`: Tick a box or a switch.
- `Uncheck the "Newsletter" field`: Clear a box or a switch.
- `Press the key "Enter" in the "Search" field`: Press a key while an element has focus.
- `Press the key "Escape"`: Press a key on the page.
- `Hover over the "Menu" button`: Move the pointer over an element.
- `Click the "Terms" link and wait for the popup`: Click an element that opens a popup window or a new tab. Later steps that end with in the popup work in it.
- `Upload "photo.png" to the "Avatar" field`: Put a file of the project's test files into a file field (or the file chooser a button opens).
- `Drag the "Card 1" listitem to the "Done" list`: Drag an element and drop it on another one.
- `Drop "report.pdf" onto the "Drop files here" text`: Drop a file of the project's test files onto a drop zone (an area files are dragged onto).
- `Accept the next dialog saying "Delete course?"`: Accept the next alert, confirm or prompt dialog; the next step must open it, and it must contain this text.
- `Answer the next dialog with "Blue"`: Answer the next prompt dialog with a text (the next step must open it).
- `Accept the next dialog`: Accept the next alert, confirm or prompt dialog (the next step must open it). Without this, dialogs are dismissed.
- `Dismiss the next dialog`: Dismiss (cancel) the next dialog (the next step must open it).
- `Download from the "Export" button a file named like "report"`: Click a link or button that downloads a file, and check the file is not empty and its name contains a text.
- `Download from the "Export" button`: Click a link or button that downloads a file, and check the file is not empty.
- `Wait for an email to "qa+{{unique}}@example.test" and type its code after "Your code is" into the "Code" field`: Wait for an email to an address of the test mailbox, then type the code that follows this text into a field (see `hard-sign-ins.md`).
- `Wait for an email to "qa+{{unique}}@example.test" and type its code into the "Code" field`: Wait for an email to an address of the test mailbox, then type the code it contains (4 to 8 digits after a word such as code) into a field.
- `Wait for an email to "qa+{{unique}}@example.test" and open its link containing "sign-in"`: Wait for an email to an address of the test mailbox, then open its link (only a link to the application's own site). Optionally the link whose address or words contain a text.
- Frames and popups (see `frames-uploads-popups.md`): an element inside a frame is written with the frame after it, `the "Pay" button inside the frame "checkout"` (or `inside the frame titled "Payment"`, `inside the frame at "pay.example.com/form"`; inner frame first), and any page step can end with `in the popup`.
- `Take over the clock from "2025-01-15T09:00:00Z"`: Take over the page's clock from a date and time: time then moves only when a step moves it.
- `Take over the clock`: Take over the page's clock from now.
- `Move the clock 30 minutes ahead`: Move the page's clock ahead by some minutes (timers due on the way fire), for timeouts, expiry and countdowns.
- `Stop the clock at "2025-01-15T10:00:00Z"`: Stop the page's clock at a date and time.
- `Let the clock run again`: Let a stopped clock run again.
- `Set the condition "colorScheme" to "dark"`: Change a condition from here on: offline, online, colorScheme (light or dark), reducedMotion, forcedColors (high contrast), media (print), viewport (390x844), grantPermissions (geolocation,notifications), denyPermissions, geolocation (52.52,13.40).
- `Set the condition "offline"`: Change a condition that takes no value: offline, online or denyPermissions.
- `Remember the value of the "Quantity" field as "qty"`: Remember what a field holds under a name, to compare later or use as {{name}}.
- `Remember the text of the test id "price" as "price"`: Remember an element's text under a name (such as a price), to compare later or use as {{name}}.
- `Wait until the address contains "/cart"`: Wait until the address contains this text.
- `Wait for a response from "/api/cart"`: Wait for a response from an address that contains this text (the step before causes it).
- `Wait until the text "Loading" is gone`: Wait until an element is gone.
- `Wait until the text "Saved" shows`: Wait until an element shows.
- `Wait 500 ms`: Wait a fixed time, in milliseconds (at most 10000). Prefer an expectation: it waits only as long as needed.

### Check what the page shows

- `Expect the page to show "Welcome back"`: The page shows this text somewhere.
- `Expect the page not to show "Error"`: The page does not show this text.
- `Expect the text "Welcome back" to be visible`: An element is visible.
- `Expect the test id "spinner" to be hidden`: An element is not visible.
- `Expect the "Pay" button to be enabled`: An element can be used.
- `Expect the "Pay" button to be disabled`: An element cannot be used yet.
- `Expect the page to contain the text "Order placed"`: The page contains this text.
- `Expect the "Total" heading to contain the text "$12"`: An element contains this text.
- `Expect the "Email" field to have the value "ada@example.test"`: A field holds this value.
- `Expect the "Item" listitem to appear 3 times`: This many elements match.
- `Expect the address to contain "/dashboard"`: The address of the page contains this text.
- `Expect the page title to contain "Dashboard"`: The title of the page contains this text.
- `Expect the "Gift wrap" field to be ticked`: A box or switch is ticked.
- `Expect the "Express" field not to be ticked`: A box or switch is not ticked.
- `Expect the "Email" field to have the focus`: An element has the keyboard focus.
- `Expect the "Email" field to be editable`: A field can be typed in.
- `Expect the "Pay" button to be in view`: An element is in the visible part of the page.
- `Expect the "Email" field to have the attribute "aria-invalid" set to "true"`: An element's attribute has this value.
- `Expect the "Email" field to have the attribute "required"`: An element has this attribute.
- `Expect the "Save" button to have the class "primary"`: An element has this class among its classes.
- `Expect the "Save" button to have the style "color" set to "rgb(200, 0, 0)"`: An element's computed style property has this value.
- `Expect the test id "close" to have the accessible name "Close"`: An element's accessible name is this.
- `Expect the "Email" field to have the error message "Enter a valid email"`: A field's error message (aria-errormessage) contains this text.
- `Expect the test id "total" to show exactly "Total: $15.50"`: An element's whole text is exactly this.
- `Expect the page not to contain the text "undefined"`: The page does not contain this text anywhere.
- `Expect the "Cart" list not to contain the text "Red cup"`: An element does not contain this text.
- `Expect the address to match "/orders/*"`: The address matches a pattern: * is any characters within one part, ** anything.
- `Expect the "Cart" list to have the structure "- listitem: Blue mug"`: A region (a list, a table, a summary) has this structure, written as an ARIA snapshot; parts that change are /patterns/.
- `Expect the test id "line" to contain the remembered "price"`: An element contains the value remembered earlier under this name.
- `Expect the test id "total" to be more than the remembered "price"`: An element's number is bigger than the remembered one.
- `Expect the test id "discount" to be less than the remembered "price"`: An element's number is smaller than the remembered one.
- `Expect the test id "cart-price" to equal the remembered "price"`: An element shows exactly the value remembered earlier under this name.
- `Expect no accessibility problems of impact "moderate" or worse`: No accessibility problems (axe-core). The impact is minor, moderate, serious (default) or critical.
- `Expect the test id "header" to match its approved screenshot within 50 pixels`: An element looks like its approved screenshot. The number is how many pixels may differ.
- `Expect the page to match its approved screenshot`: The page looks like its approved screenshot. The first run saves it.
- `Ask the AI whether the test id "cart" looks right checking "the total is visible"`: A model looks at an element and says whether it looks right. Needs an AI model; never passes without one.
- `Ask the AI whether the page looks right`: A model looks at the page and says whether it looks right. Needs an AI model; never passes without one.

### Check the page as a whole

- `Expect the page to have no JavaScript errors`: The page reports no JavaScript errors while it loads.
- `Expect no failed requests`: No request to this site fails.
- `Expect no broken links`: No link to this site's own pages is broken.
- `Expect no insecure content`: No insecure (http) content is loaded on a secure page.
- `Expect the page basics to be in place`: The page has a title, a language, a viewport setting and one main heading.
- `Expect the page to load within its speed budget of "lcp:2500 ttfb:800"`: The page loads within its speed budgets. Optional budgets look like lcp:2500 ttfb:800.
- `Expect forms to handle unusual input`: Forms handle unusual input safely. The setting is safe (default) or all.
- `Expect access to the page to be restricted as "{\"as\":\"anonymous\",\"path\":\"/admin\"}"`: A page is closed to people who may not see it. The setting is the JSON the access check takes.

### Call an API

- `Send a POST request to /api/orders with the header "X-Trace" = "1" with the body {"sku":"A1"} and remember "orderId" from "id"`: Send a request. Add with the query, with the header, with the body (JSON), without signing in, and remember a value of the answer for later steps.

### Check the answer

- `Expect the status to be below 500`: The status is lower than this number (500 means no server error).
- `Expect the status to be 200`: The status is exactly this.
- `Expect the status class to be "2xx"`: The status is in this family, such as 2xx.
- `Expect the response field "items.0.id" to exist`: The answer has this field (a dotted path such as items.0.id).
- `Expect the response field "items" to be of type "array"`: The field is of this type: string, number, boolean, array, object or null.
- `Expect the response to be of type "array"`: The whole answer is of this type.
- `Expect the response field "name" to be "Mug"`: The field has exactly this value.
- `Expect the response header "content-type" to contain "json"`: A header of the answer contains this text.
- `Expect the response body not to contain "error"`: The answer body does not contain this text.
- `Expect the response body to contain "Mug"`: The answer body contains this text.
- `Expect the response to match the schema {"type":"object","required":["id"]}`: The answer matches a documented JSON schema (a subset of JSON Schema).

### Check the answer's safety and speed

- `Expect the browser security headers to be set for "csp,hsts"`: Browser security headers are set. The setting lists csp, frame, nosniff, referrer, hsts.
- `Expect session cookies to be protected`: Session cookies are protected (HttpOnly, Secure, SameSite). The setting lists httponly, secure, samesite.
- `Expect the CORS policy to be safe`: Cross-origin access (CORS) is not wide open.
- `Expect no sensitive files to be exposed`: No sensitive file can be read.
- `Expect no software versions to be revealed`: The server does not reveal software versions or list folders.
- `Expect the HTTPS certificate to be valid for at least 30 days`: The HTTPS certificate is valid and not about to expire (default 14 days).
- `Expect the response time to stay within its budget of "p95:800"`: The request before this step answers fast enough, measured on repeated calls. Optional budgets look like p95:1000.
- `Expect the endpoint to hold up under load within "users:5 seconds:5"`: The GET request before this step holds up with several users at once. Optional limits look like users:5.
- `Expect the request to be refused`: The request is refused (401, 403, 404 or a redirect). The setting is the JSON the access check takes.

### Reuse steps

- `Run the reusable steps "Open the cart" with item = "Mug"`: Run a group of steps saved once for the project. Give values for its parameters after with.

### Lines at the top

- `Test: Sign in and see the dashboard`: The title of the test (3 to 160 characters). Required.
- `Kind: web`: web (default) or api.
- `Category: Authentication`: The group the test is listed under.
- `Type: functional`: What the test is for: functional, negative, boundary, security, smoke, validation, navigation, accessibility, workflow, visual, health, performance, input or vision.
- `Priority: high`: critical, high, medium (default) or low.
- `Description: Checks the sign-in form`: A sentence about the test.
- `Tag: smoke`: A label. Repeat the line for more.
- `Precondition: The account exists`: Something that must be true before the test. Repeat the line for more.
- `Result: The dashboard is shown`: What a person should see when it works. Repeat the line for more.
- `Data: name = "Ada"`: A value steps can use as {{name}}. Repeat the line for more.
- `Date: 2025-01-15T12:00:00Z`: Web tests: the page's date and time stay at this moment for the whole test, so dates on the page read the same every day.
