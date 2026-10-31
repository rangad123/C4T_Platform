# Phone test ideas and locators (round 24)

What a tester sees: after an exploration of an Android app, the plan offers test ideas that follow the app's real journeys, the most
important first, each with one sentence saying what it covers ("Covers the main navigation: the “Jobs” tab."). The tests written from them
find elements by stable names with checked fallbacks, so an app update that renames one id does not break them.

## Screen names
- A screen is called by the AI's name for it, else its toolbar heading, else its selected tab, else a short static label outside its lists,
  else the words of its activity. Never a count, a time or feed content.
- Screens that share a name are told apart in words, never with a number in brackets: their selected tab, their activity, the kind of
  screen, "signed in", a label or id only they show, or the screen they open from ("Notifications, Push notifications"). An older plan's
  "Search (4)" is renamed the same way. (`explore/screens.ts` `nameScreens`; the planner runs it on every model, the AI-led loop at its end.)

## Test ideas (`explore/candidates.ts`, `explore/planner.ts`)
Every idea is a path the exploration really walked, replayed from a fresh start. Paths never use an edge that did not replay, lost steps or
went back. Families, best first: app start, signing in, each main tab (bottom navigation or tabs), searching and opening a result, a list
item opened and closed again, forms sent filled in and empty, other screens (fewer steps away and more visited first), settings pages,
longer journeys (the deepest paths that add screens, checking every screen on the way), going back. An idea whose steps and checks equal a
higher-ranked one is not offered again. The AI only chooses and words ideas; the plan is topped up by importance.

How many ideas a plan offers follows "How thorough": Quick 15, Standard 40, Thorough 80 (a project that asked for fewer than 25 scenarios
keeps its number).

## Checks
Each test checks that its screen arrived: the screen's heading (by its words, since every toolbar has the same id) or an element with a
stable id (a list itself counts), never text inside a list or feed, never a count or a time. What the screen before also showed (a tab bar)
is used only when nothing else is there.

## Locators (`explore/locators.ts`)
Main locator, first that names exactly the element on the recorded screen: a designed resource id (not an optimizer's "a1"/"b2c", not a
numbered list id like "row_1" next to "row_2", not a framework default), the accessibility label, the exact static text (a field's hint),
role plus name where Taqwright looks the class up exactly, the name of what is inside a row or card ("Product Designer" for a job's row),
else a shared name with its number. Then up to three fallbacks, each checked unique: the other names, UiSelector combinations (id + text,
class + text or label), a name inside a stable ancestor (UiSelector `childSelector` and a relative XPath anchored on the ancestor's id).
A Jetpack Compose test tag (resource id without the package prefix) gets `new UiSelector().resourceId("tag")` first, because Appium's id
lookup adds the package. Never coordinates, never an absolute XPath.

The hierarchy reader now records, per element, the ids of its ancestors (`scopes`), whether it is inside a scrolling view (`inScroll`),
whether it is selected, and whether its id is a bare test tag (`bareId`). They pass through runners too (optional protocol fields).

## The script (`generators/taqwright.ts` step emission)
- A locator with fallbacks is written `(await firstOf(10000, main, fallback...))`: the first that shows is used, in order. Taqwright's own
  `.or()` cannot do this (it stops when the first locator finds nothing). The `firstOf` helper is added only to scripts that need it.
- A list item revealed by scrolling is reached with `device:scroll-to`: a UiSelector Taqwright wraps in Android's UiScrollable (it swipes
  and looks again when that is not possible), instead of replaying blind swipes. Waits the AI made are left out: every step waits for its
  element and every screen's arrival is checked.
- A numbered locator now gets `.nth(n)` (before, the number was dropped and the first match was used).
- iOS scripts ignore the Android-only fallbacks. Scripts without fallbacks or numbers read exactly as before.
- The device-farm reader understands `firstOf`, `.nth()`, `getByUiSelector` and `getByXpath`; a farm tries UiScrollable for list items.

## Not covered / limits
- Fallbacks are checked unique against the recorded `uiautomator dump`, not against the UiAutomator2 page source a run uses; elements beyond
  the first 120 of a screen are not seen, so a fallback can match more than the recording showed.
- A UiSelector `instance()` counts in UiAutomator's order and `.nth()` in reading order; they agree for ordinary lists.
- A row named by its inner text depends on that text staying (job titles change in real feeds); its fallbacks are the inner element's.
- Forms are tested only as the exploration sent them (filled in, empty); no new invalid input is invented.
- Verified on the fake phone (tests/fixtures/fake-uia2.ts, the real Taqwright `Mobile` class) and by typechecking generated scripts against
  the installed Taqwright 1.1.0; not on a real phone or a real Appium server.
