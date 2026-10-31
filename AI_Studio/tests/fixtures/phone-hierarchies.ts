/**
 * Recorded-style `uiautomator dump` hierarchies for the screen identity tests (R24, EXPLORE): a LinkedIn-like app (home feed, the feed scrolled
 * twice and refreshed, a profile, search with results and without, a bottom-sheet dialog, settings with a switch) and a Jetpack Compose app.
 * Written by hand in the shape a real dump has (class names, resource ids with the package prefix, bounds of a 1080 x 2400 phone, nested
 * layouts, a RecyclerView that holds the posts); the people and texts are made up.
 */
type Attrs = Partial<Record<string, string | boolean>>;

const PKG = "com.linkedin.android";
export const LINKEDIN = PKG;
export const COMPOSE_APP = "com.example.compose";

/** One view; children make it a parent. Attributes in the order a dump writes them. */
export function node(a: Attrs, ...kids: string[]): string {
    const d: Record<string, string | boolean> = {
        index: "0", text: "", "resource-id": "", class: "android.widget.TextView", package: (a.package as string) ?? PKG, "content-desc": "", checkable: false, checked: false, clickable: false, enabled: true,
        focusable: false, focused: false, scrollable: false, "long-clickable": false, password: false, selected: false, bounds: "[0,0][1080,2400]", ...a,
    };
    const attrs = Object.entries(d).map(([k, v]) => `${k}="${String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"`).join(" ");
    return kids.length ? `<node ${attrs}>${kids.join("")}</node>` : `<node ${attrs} />`;
}
export const dump = (...kids: string[]): string =>
    `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${node({ class: "android.widget.FrameLayout", bounds: "[0,0][1080,2400]" }, ...kids)}</hierarchy>\nUI hierchary dumped to: /dev/tty\n`;

const id = (x: string, pkg = PKG) => `${pkg}:id/${x}`;
const b = (l: number, t: number, r: number, bo: number) => `[${l},${t}][${r},${bo}]`;

// ── LinkedIn-like ───────────────────────────────────────────────────────────

/** The top bar of the home tabs: the avatar, the search box (a button here, it opens search) and messaging. */
const homeTopBar = () =>
    node(
        { class: "android.widget.LinearLayout", "resource-id": id("home_toolbar"), bounds: b(0, 80, 1080, 220) },
        node({ class: "android.widget.ImageView", "resource-id": id("me_launcher"), "content-desc": "View profile", clickable: true, bounds: b(30, 100, 130, 200) }),
        node({ class: "android.widget.TextView", "resource-id": id("search_bar_text"), text: "Search", clickable: true, bounds: b(160, 110, 900, 190) }),
        node({ class: "android.widget.ImageButton", "resource-id": id("home_messaging"), "content-desc": "Messaging, 2 new", clickable: true, bounds: b(940, 100, 1050, 200) }),
    );

/** The bottom navigation; `badge` is the count on Notifications; `selected` the tab that is on. */
export const bottomNav = (selected: "home" | "network" | "post" | "notifications" | "jobs" | null = "home", badge = 3) => {
    const items: Array<[string, string, string]> = [
        ["home", "nav_home", "Home"],
        ["network", "nav_my_network", "My Network"],
        ["post", "nav_post", "Post"],
        ["notifications", "nav_notifications", `Notifications, ${badge} new notifications`],
        ["jobs", "nav_jobs", "Jobs"],
    ];
    return node(
        { class: "com.google.android.material.bottomnavigation.BottomNavigationView", "resource-id": id("bottom_navigation"), bounds: b(0, 2250, 1080, 2400) },
        ...items.map(([key, rid, desc], i) => node({ class: "com.google.android.material.bottomnavigation.BottomNavigationItemView", "resource-id": id(rid), "content-desc": desc, clickable: true, selected: key === selected, bounds: b(i * 216, 2250, i * 216 + 216, 2400) })),
    );
};

/** One post of the feed. */
const post = (top: number, who: string, when: string, text: string, o: { promoted?: boolean; likes?: number } = {}) =>
    node(
        { class: "android.widget.LinearLayout", "resource-id": id("feed_item_update_card"), clickable: true, bounds: b(0, top, 1080, top + 600) },
        node({ class: "android.widget.TextView", "resource-id": id("feed_item_actor_name"), text: who, bounds: b(150, top + 20, 800, top + 70) }),
        node({ class: "android.widget.TextView", "resource-id": id("feed_item_actor_secondary"), text: o.promoted ? "Promoted" : when, bounds: b(150, top + 70, 800, top + 110) }),
        node({ class: "android.widget.TextView", "resource-id": id("feed_item_commentary"), text, clickable: true, bounds: b(30, top + 130, 1050, top + 400) }),
        ...(o.promoted ? [node({ class: "android.widget.Button", "resource-id": id("feed_item_cta"), text: "Learn more", clickable: true, bounds: b(30, top + 410, 400, top + 470) })] : []),
        node({ class: "android.widget.TextView", "resource-id": id("feed_item_social_counts"), text: `${o.likes ?? 12} reactions`, bounds: b(30, top + 480, 600, top + 520) }),
        node({ class: "android.widget.Button", "resource-id": id("feed_item_like"), text: "Like", "content-desc": "React Like", clickable: true, bounds: b(0, top + 530, 270, top + 590) }),
        node({ class: "android.widget.Button", "resource-id": id("feed_item_comment"), text: "Comment", clickable: true, bounds: b(270, top + 530, 540, top + 590) }),
        node({ class: "android.widget.Button", "resource-id": id("feed_item_reshare"), text: "Repost", clickable: true, bounds: b(540, top + 530, 810, top + 590) }),
        node({ class: "android.widget.Button", "resource-id": id("feed_item_send"), text: "Send", clickable: true, bounds: b(810, top + 530, 1080, top + 590) }),
    );

/** "People you may know": a carousel that scrolls sideways inside the feed. */
const peopleYouMayKnow = (top: number) =>
    node(
        { class: "android.widget.LinearLayout", "resource-id": id("pymk_card"), bounds: b(0, top, 1080, top + 600) },
        node({ class: "android.widget.TextView", "resource-id": id("pymk_header"), text: "People you may know", bounds: b(30, top + 10, 900, top + 70) }),
        node(
            { class: "androidx.recyclerview.widget.RecyclerView", "resource-id": id("pymk_carousel"), scrollable: true, bounds: b(0, top + 80, 1080, top + 580) },
            ...["Gita Rao", "Hugo Lind"].map((n, i) =>
                node(
                    { class: "android.widget.FrameLayout", "resource-id": id("pymk_person"), clickable: true, bounds: b(20 + i * 520, top + 90, 500 + i * 520, top + 570) },
                    node({ class: "android.widget.TextView", "resource-id": id("pymk_name"), text: n, bounds: b(40 + i * 520, top + 300, 480 + i * 520, top + 350) }),
                    node({ class: "android.widget.Button", "resource-id": id("pymk_connect"), text: "Connect", clickable: true, bounds: b(40 + i * 520, top + 480, 480 + i * 520, top + 550) }),
                ),
            ),
        ),
    );

const feed = (items: string[], o: { badge?: number } = {}) =>
    dump(
        node(
            { class: "android.widget.LinearLayout", bounds: b(0, 0, 1080, 2400) },
            homeTopBar(),
            node({ class: "androidx.recyclerview.widget.RecyclerView", "resource-id": id("feed_recycler_view"), scrollable: true, bounds: b(0, 230, 1080, 2240) }, ...items),
            bottomNav("home", o.badge ?? 3),
        ),
    );

/** The home feed as it opens. */
export const FEED = feed([post(240, "Alice Smith", "2h", "Proud to share that our team shipped the new release."), post(850, "Bob Jones", "5h", "Hiring two engineers in Lisbon.")]);
/** Scrolled once: an ad and another post. */
export const FEED_SCROLLED_ONCE = feed([post(230, "Acme Cloud", "", "Scale your apps with Acme.", { promoted: true }), post(840, "Carol White", "1d", "Three lessons from ten years of support work.", { likes: 340 })]);
/** Scrolled twice: the "people you may know" carousel and a post. */
export const FEED_SCROLLED_TWICE = feed([peopleYouMayKnow(230), post(840, "Dave Brown", "3d", "Our conference talk is online.", { likes: 7 })]);
/** Pulled to refresh: other posts, other counts, a new badge count. */
export const FEED_REFRESHED = feed([post(240, "Erin Green", "now", "Excited to start a new position.", { likes: 1 }), post(850, "Frank Hall", "12m", "What is your favourite book this year?", { likes: 98 })], { badge: 5 });

/** Somebody's profile: a back arrow, the name in the top bar, sections in a list. */
export const PROFILE = (name = "Alice Smith") =>
    dump(
        node(
            { class: "android.widget.LinearLayout", bounds: b(0, 0, 1080, 2400) },
            node(
                { class: "androidx.appcompat.widget.Toolbar", "resource-id": id("profile_toolbar"), bounds: b(0, 80, 1080, 220) },
                node({ class: "android.widget.ImageButton", "content-desc": "Navigate up", clickable: true, bounds: b(0, 90, 130, 210) }),
                node({ class: "android.widget.TextView", "resource-id": id("profile_toolbar_search"), text: name, clickable: true, bounds: b(150, 110, 900, 190) }),
                node({ class: "android.widget.ImageButton", "resource-id": id("profile_overflow"), "content-desc": "More options", clickable: true, bounds: b(940, 100, 1050, 200) }),
            ),
            node(
                { class: "androidx.recyclerview.widget.RecyclerView", "resource-id": id("profile_view_recycler_view"), scrollable: true, bounds: b(0, 230, 1080, 2240) },
                node({ class: "android.widget.TextView", "resource-id": id("profile_top_card_full_name"), text: name, bounds: b(30, 600, 1050, 680) }),
                node({ class: "android.widget.TextView", "resource-id": id("profile_top_card_headline"), text: "Product designer at Acme", bounds: b(30, 690, 1050, 740) }),
                node({ class: "android.widget.Button", "resource-id": id("profile_top_card_primary_button"), text: "Message", clickable: true, bounds: b(30, 800, 520, 880) }),
                node({ class: "android.widget.Button", "resource-id": id("profile_top_card_overflow"), text: "More", clickable: true, bounds: b(540, 800, 1050, 880) }),
                node({ class: "android.widget.TextView", "resource-id": id("profile_section_header"), text: "About", bounds: b(30, 950, 1050, 1010) }),
                node({ class: "android.widget.TextView", "resource-id": id("profile_section_header"), text: "Experience", bounds: b(30, 1300, 1050, 1360) }),
            ),
            bottomNav(null),
        ),
    );

/** Search with what was typed and the results (people). */
export const SEARCH_RESULTS = (query = "product manager", people = ["Ivy Chen", "Jon Park", "Kim Lee"]) =>
    dump(
        node(
            { class: "android.widget.LinearLayout", bounds: b(0, 0, 1080, 2400) },
            node(
                { class: "android.widget.LinearLayout", "resource-id": id("search_toolbar"), bounds: b(0, 80, 1080, 220) },
                node({ class: "android.widget.ImageButton", "content-desc": "Back", clickable: true, bounds: b(0, 90, 130, 210) }),
                node({ class: "android.widget.EditText", "resource-id": id("search_bar_edit_text"), text: query, clickable: true, focusable: true, bounds: b(150, 100, 1050, 200) }),
            ),
            node(
                { class: "android.widget.HorizontalScrollView", "resource-id": id("search_filters_bar"), scrollable: true, bounds: b(0, 230, 1080, 330) },
                ...["People", "Jobs", "Posts", "Companies"].map((c, i) => node({ class: "android.widget.Button", "resource-id": id("search_filter_chip"), text: c, clickable: true, selected: i === 0, bounds: b(20 + i * 260, 240, 260 + i * 260, 320) })),
            ),
            node(
                { class: "androidx.recyclerview.widget.RecyclerView", "resource-id": id("search_results_list"), scrollable: true, bounds: b(0, 340, 1080, 2240) },
                ...people.map((p, i) =>
                    node(
                        { class: "android.widget.LinearLayout", "resource-id": id("search_entity_result"), clickable: true, bounds: b(0, 350 + i * 300, 1080, 640 + i * 300) },
                        node({ class: "android.widget.TextView", "resource-id": id("search_entity_title"), text: p, bounds: b(200, 370 + i * 300, 1050, 430 + i * 300) }),
                        node({ class: "android.widget.TextView", "resource-id": id("search_entity_subtitle"), text: `${i + 1}nd · Product manager`, bounds: b(200, 440 + i * 300, 1050, 490 + i * 300) }),
                    ),
                ),
            ),
        ),
    );

/** Search before anything was typed: recent searches. */
export const SEARCH_EMPTY = dump(
    node(
        { class: "android.widget.LinearLayout", bounds: b(0, 0, 1080, 2400) },
        node(
            { class: "android.widget.LinearLayout", "resource-id": id("search_toolbar"), bounds: b(0, 80, 1080, 220) },
            node({ class: "android.widget.ImageButton", "content-desc": "Back", clickable: true, bounds: b(0, 90, 130, 210) }),
            node({ class: "android.widget.EditText", "resource-id": id("search_bar_edit_text"), text: "Search", clickable: true, focusable: true, bounds: b(150, 100, 1050, 200) }),
        ),
        node(
            { class: "androidx.recyclerview.widget.RecyclerView", "resource-id": id("search_typeahead_list"), scrollable: true, bounds: b(0, 230, 1080, 2240) },
            node({ class: "android.widget.TextView", "resource-id": id("search_history_item"), text: "designer", clickable: true, bounds: b(30, 250, 1050, 330) }),
            node({ class: "android.widget.TextView", "resource-id": id("search_history_item"), text: "react jobs", clickable: true, bounds: b(30, 340, 1050, 420) }),
        ),
    ),
);

/** The "more" sheet of a post, over the feed (a dialog: the dump holds only its window). */
export const POST_SHEET = (who = "Alice Smith") =>
    dump(
        node(
            { class: "android.widget.FrameLayout", "resource-id": id("design_bottom_sheet"), bounds: b(0, 1500, 1080, 2400) },
            ...[
                ["control_menu_save", "Save"],
                ["control_menu_share", "Share via"],
                ["control_menu_unfollow", `Unfollow ${who}`],
                ["control_menu_report", "Report post"],
            ].map(([rid, t], i) => node({ class: "android.widget.TextView", "resource-id": id(rid!), text: t!, clickable: true, bounds: b(0, 1550 + i * 200, 1080, 1740 + i * 200) })),
        ),
    );

/** Settings with a switch outside any list. */
export const SETTINGS = (on: boolean) =>
    dump(
        node(
            { class: "android.widget.LinearLayout", bounds: b(0, 0, 1080, 2400) },
            node({ class: "android.widget.TextView", "resource-id": id("toolbar_title"), text: "Settings", bounds: b(150, 110, 900, 190) }),
            node({ class: "android.widget.TextView", text: "Dark mode", bounds: b(30, 300, 800, 380) }),
            node({ class: "android.widget.Switch", "resource-id": id("dark_mode_switch"), checkable: true, checked: on, clickable: true, bounds: b(850, 300, 1050, 380) }),
            node({ class: "android.widget.TextView", "resource-id": id("settings_sign_out"), text: "Sign out", clickable: true, bounds: b(30, 500, 1050, 580) }),
        ),
    );

// ── a Jetpack Compose app (test tags as resource ids, no package prefix; every view is android.view.View) ──

const view = (a: Attrs, ...kids: string[]) => node({ class: "android.view.View", package: COMPOSE_APP, ...a }, ...kids);

export const composeDump = (...kids: string[]): string =>
    `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${node({ class: "android.widget.FrameLayout", package: COMPOSE_APP, bounds: "[0,0][1080,2400]" }, node({ class: "androidx.compose.ui.platform.ComposeView", package: COMPOSE_APP, bounds: "[0,0][1080,2400]" }, ...kids))}</hierarchy>`;

/** A list of jobs: the title in the top bar, a lazy column of cards. */
export const COMPOSE_JOBS = (jobs = ["Android engineer", "Data analyst", "Designer"]) =>
    composeDump(
        node({ class: "android.widget.TextView", package: COMPOSE_APP, text: "Jobs", bounds: b(40, 100, 600, 180) }),
        view({ "resource-id": "filter_button", "content-desc": "Filter jobs", clickable: true, bounds: b(900, 100, 1040, 180) }),
        view(
            { "resource-id": "jobs_list", scrollable: true, bounds: b(0, 220, 1080, 2300) },
            ...jobs.map((j, i) => view({ "resource-id": "job_card", clickable: true, bounds: b(20, 240 + i * 300, 1060, 520 + i * 300) }, node({ class: "android.widget.TextView", package: COMPOSE_APP, text: j, bounds: b(40, 260 + i * 300, 1000, 320 + i * 300) }))),
        ),
    );

/** One job's details. */
export const COMPOSE_JOB = (title = "Android engineer") =>
    composeDump(
        view({ "resource-id": "back_button", "content-desc": "Back", clickable: true, bounds: b(0, 100, 120, 180) }),
        node({ class: "android.widget.TextView", package: COMPOSE_APP, text: "Job details", bounds: b(140, 100, 700, 180) }),
        view(
            { "resource-id": "job_details", scrollable: true, bounds: b(0, 220, 1080, 2100) },
            node({ class: "android.widget.TextView", package: COMPOSE_APP, text: title, bounds: b(40, 260, 1000, 340) }),
            node({ class: "android.widget.TextView", package: COMPOSE_APP, text: "Lisbon, full time", bounds: b(40, 360, 1000, 420) }),
        ),
        view({ "resource-id": "save_job_button", text: "Save job", clickable: true, bounds: b(40, 2150, 1040, 2280) }),
    );
