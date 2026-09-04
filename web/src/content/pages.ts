import type { IconName } from '@/components/ds'
import { STATS } from './stats'
import type { Result, SectionCopy, Step } from './home'

/**
 * Hub and standalone page content, ported from `design/site/pagedata.js`
 * (`window.C4TP`).
 *
 * ONE BLOCK IS DELIBERATELY ABSENT. The global carried an `industries` object
 * with a full Banking & Finance spotlight. CLAUDE.md rule 10 bars
 * `/industries/*`, so that copy is not ported — porting it would leave dead
 * content in the tree inviting someone to build the page. It is still in
 * `design/content.md` §8 if the client reinstates the section.
 *
 * Hero CTA labels come through as `primary` / `secondary` strings, matching the
 * source. Their destinations are set here rather than in the prototype's
 * label-matching `onAction`, so they are real links.
 */

export interface PageHero {
  eyebrow: string
  title: string
  description: string
  primaryCta: string
  primaryHref: string
  secondaryCta: string
  secondaryHref: string
}

export interface Faq {
  q: string
  a: string
}

/* ─── /ai-testing ──────────────────────────────────────────────────────────── */

export interface CoverageRow {
  /** The failure mode. */
  label: string
  /** What we check, lowercase — it reads as a continuation of the label. */
  detail: string
}

export const AI_TESTING_PAGE = {
  hero: {
    eyebrow: 'AI Quality',
    title: 'De-risk every AI release before it reaches a user.',
    description:
      "AI features fail differently. They're confidently wrong, subtly biased, or fine in English and broken in Hindi. We combine automated evaluation with trained human reviewers to find those failures while you can still fix them.",
    primaryCta: 'Talk to an AI expert',
    primaryHref: '/contact',
    secondaryCta: 'Start a pilot',
    secondaryHref: '/contact',
  } satisfies PageHero,

  /** Also the stat band on every AI detail page. */
  stats: [
    { value: STATS.testers, label: 'Vetted testers' },
    { value: STATS.languages, label: 'Languages' },
    { value: STATS.countries, label: 'Countries' },
  ] satisfies readonly Result[],

  whyTitle: "An AI feature that's wrong 3% of the time is a product risk, not a rounding error.",

  why: [
    {
      icon: 'alert-triangle',
      title: 'Confidently wrong',
      description:
        'LLMs produce fluent, well-formatted answers that are factually false. Nothing in the output signals the difference. Only a human who knows the domain can tell.',
    },
    {
      icon: 'languages',
      title: 'Fine in English, broken elsewhere',
      description:
        'A model that performs well in English often degrades badly in other languages — while still sounding fluent enough to be trusted.',
    },
    {
      icon: 'shuffle',
      title: 'Non-deterministic by design',
      description:
        "The same prompt returns different output. Traditional pass/fail assertions can't handle that. You need rubric-based evaluation with human calibration.",
    },
    {
      icon: 'trending-down',
      title: 'Quality decays after launch',
      description:
        'Models drift, providers update, retrieval indexes go stale. A feature that passed in March can be failing by June with nobody watching.',
    },
  ] satisfies readonly { icon: IconName; title: string; description: string }[],

  coverage: [
    {
      label: 'Accuracy & factual grounding',
      detail: 'is the answer true, and is it supported by your sources?',
    },
    {
      label: 'Hallucination detection',
      detail: 'invented facts, fake citations, fabricated policies',
    },
    {
      label: 'Consistency & stability',
      detail: 'same question, repeated: does the answer hold?',
    },
    { label: 'Safety & toxicity', detail: 'harmful, unsafe or inappropriate outputs' },
    {
      label: 'Bias & fairness',
      detail: 'output quality across demographic and linguistic slices',
    },
    {
      label: 'Prompt injection & jailbreaks',
      detail: 'adversarial input, instruction override, data exfiltration attempts',
    },
    {
      label: 'Tool-call correctness',
      detail: 'does the agent call the right tool with the right arguments?',
    },
    { label: 'Context retention', detail: 'does it hold state across a long conversation?' },
    {
      label: 'Multilingual parity',
      detail: 'is quality equivalent across your supported languages?',
    },
    { label: 'Latency & cost', detail: 'response time and token spend under realistic load' },
    {
      label: 'Regression across versions',
      detail: 'does a model or prompt change break what used to work?',
    },
  ] satisfies readonly CoverageRow[],

  method: [
    {
      n: '01',
      title: 'Define the rubric',
      body: 'We work with your team to define what “good” means for your product: accuracy thresholds, tone requirements, safety boundaries, refusal behaviour. This becomes a scoring rubric, not a subjective opinion.',
    },
    {
      n: '02',
      title: 'Build the evaluation set',
      body: 'Golden datasets, adversarial prompts, edge cases and real user queries — assembled to cover the scenarios that actually matter to your business.',
    },
    {
      n: '03',
      title: 'Run automated + human evaluation',
      body: 'Automated scoring gives breadth across thousands of cases. Matched human reviewers — domain experts and native speakers — grade the cases where judgment is required.',
    },
    {
      n: '04',
      title: 'Report and re-run',
      body: 'You get scored results, failure clusters, root-cause analysis and a prioritised fix list. The suite becomes your regression pack for every future release.',
    },
  ] satisfies readonly Step[],

  faqs: [
    {
      q: 'How is this different from an eval framework we could build ourselves?',
      a: 'The framework is the easy part. The hard part is a calibrated pool of domain experts and native speakers who grade consistently, and the operational discipline to re-run it every release. That is what you are buying.',
    },
    {
      q: "Can you test a model we don't host?",
      a: 'Yes. We test through whatever interface your users touch — API, app or web — so third-party and hosted models are in scope.',
    },
    {
      q: 'How many languages can you cover?',
      a: `${STATS.languages} languages with native speakers in market. Coverage is scoped per engagement against the markets you actually serve.`,
    },
    {
      q: 'Do you need access to our training data?',
      a: 'No. Evaluation runs against outputs. If you want us to help build training or evaluation data, that is a separate, scoped engagement.',
    },
    {
      q: 'What does a first engagement look like?',
      a: 'A two-week pilot on one AI feature: rubric definition, evaluation set, one full scored run and a prioritised fix list. Fixed scope, fixed price.',
    },
  ] satisfies readonly Faq[],
} as const

/* ─── /services ────────────────────────────────────────────────────────────── */

export const SERVICES_PAGE = {
  hero: {
    eyebrow: 'Quality Engineering',
    title: 'The full QA stack, delivered as a service.',
    description:
      'No tool to buy. No team to hire. A named QA lead, a scoped plan, and results in your tracker.',
    primaryCta: 'Book a demo',
    primaryHref: '/contact',
    secondaryCta: 'Start a pilot',
    secondaryHref: '/contact',
  } satisfies PageHero,

  models: [
    {
      icon: 'flask-conical',
      title: 'Pilot',
      description:
        "One release, fixed scope, fixed price, two weeks. The best way to find out whether we're any good.",
    },
    {
      icon: 'trending-up',
      title: 'On-demand bursts',
      description:
        'Scale testers up for a launch, down afterwards. You pay for the coverage you use.',
    },
    {
      icon: 'users-round',
      title: 'Dedicated team',
      description: 'A consistent squad that learns your product and works in your sprint rhythm.',
    },
    {
      icon: 'shield-check',
      title: 'Fully managed QA',
      description:
        'We own the quality function end to end, from strategy through release sign-off.',
    },
  ] satisfies readonly { icon: IconName; title: string; description: string }[],

  /**
   * "What every engagement includes". Shared with every detail page — see
   * `INCLUDED` in `content/details.ts`.
   */
  included: [
    'A named QA lead',
    'A written test strategy',
    'Results in your tracker, not a PDF',
    'Reproducible bugs with video, logs and device details',
    'Weekly reporting',
    'A retrospective after every cycle',
  ] satisfies readonly string[],
} as const

/* ─── /platform ────────────────────────────────────────────────────────────── */

export const PLATFORM_PAGE = {
  hero: {
    eyebrow: 'The Platform',
    title: 'Test case to release decision, in one place.',
    description:
      'Our platform runs the AI side of the work and coordinates the human side. Your team sees one pipeline, one set of results, one number that says whether you’re ready to ship.',
    primaryCta: 'Book a demo',
    primaryHref: '/contact',
    secondaryCta: 'See pricing',
    secondaryHref: '/pricing',
  } satisfies PageHero,

  flow: [
    { n: 'Generate', body: 'AI Test Case Generator turns requirements into executable cases.' },
    {
      n: 'Execute',
      body: "Automation runs at scale. Matched testers cover what automation can't. AI exploratory agents probe the gaps.",
    },
    {
      n: 'Triage',
      body: 'Every finding is deduplicated, categorised, severity-scored and routed to the right team.',
    },
    {
      n: 'Optimise',
      body: 'The Regression Optimizer learns which tests matter for which changes.',
    },
    {
      n: 'Decide',
      body: 'Release Readiness Score, backed by quality, risk and coverage evidence.',
    },
  ] satisfies readonly { n: string; body: string }[],

  stack:
    'Bugs go to your tracker. Runs trigger from your pipeline. Reports go to your dashboards. Nobody has to check another tool.',

  /** ⚠ The first item is an audited certification — see TRUST in content/home.ts. */
  security: [
    'ISO/IEC 27001:2022',
    'SSO and SAML',
    'Role-based access control',
    'Audit logging',
    'Regional data residency',
    'NDA coverage across the tester community',
    'Configurable data retention',
  ] satisfies readonly string[],
} as const

/* ─── /pricing ─────────────────────────────────────────────────────────────── */

export interface Plan {
  name: string
  description: string
  price: string
  period: string
  cta: string
  href: string
  badge?: string
  highlighted?: boolean
  featuresLabel: string
  features: readonly string[]
}

export const PRICING_PAGE = {
  hero: {
    eyebrow: 'Pricing',
    title: 'Pricing that starts small.',
    description:
      "You shouldn't have to sign an annual contract to find out whether a QA partner is any good. Start with a pilot on one release.",
    primaryCta: 'Start a pilot',
    primaryHref: '/contact',
    secondaryCta: 'Book a demo',
    secondaryHref: '/contact',
  } satisfies PageHero,

  components: [
    {
      icon: 'layout-dashboard',
      title: 'Platform',
      description:
        'Access to the Crowd4Test platform: AI test generation, triage, analytics, integrations and reporting. Billed as a subscription.',
    },
    {
      icon: 'users',
      title: 'Delivery',
      description:
        'The testing work itself: crowd execution, automation engineering, specialist testing, AI evaluation. Billed against a consumption fund you draw down as you use it.',
    },
  ] satisfies readonly { icon: IconName; title: string; description: string }[],

  /**
   * ⚠ "Up to X test hours" / "Up to X markets and X languages" are literal
   * placeholders in content.md, not typos. They must be resolved with the
   * Client before the pricing page ships.
   */
  plans: [
    {
      name: 'Pilot',
      description: 'Best for: finding out whether this works for you.',
      price: 'Fixed',
      period: 'per release',
      cta: 'Start a pilot',
      href: '/contact',
      featuresLabel: 'Includes',
      features: [
        'One release, fixed scope, fixed price',
        'Two-week turnaround',
        'Up to X test hours',
        'Core devices and up to 2 markets',
        'Bug reports in your tracker',
        'A named QA lead',
        'Findings review call at the end',
      ],
    },
    {
      name: 'Growth',
      description: 'Best for: teams releasing regularly who need consistent coverage.',
      price: 'Scoped',
      period: 'per cycle',
      cta: 'Book a demo',
      href: '/contact',
      badge: 'Most chosen',
      highlighted: true,
      featuresLabel: 'Everything in Pilot, plus',
      features: [
        'Recurring test cycles aligned to your release schedule',
        'Full platform access including AI test generation and triage',
        'Automation suite build and maintenance',
        'Up to X markets and X languages',
        'CI/CD integration',
        'Next business day support response',
      ],
    },
    {
      name: 'Enterprise',
      description:
        'Best for: organisations with compliance requirements, multiple products or global scale.',
      price: 'Custom',
      period: '',
      cta: 'Talk to sales',
      href: '/contact',
      featuresLabel: 'Everything in Growth, plus',
      features: [
        'Dedicated testing team who learn your product',
        'Unlimited markets and languages',
        'Full AI quality suite: red teaming, bias evaluation, monitoring',
        'SSO, SAML, audit logs, custom data retention',
        'Regional data residency',
        'Custom SLAs',
        'Named account team and quarterly business reviews',
      ],
    },
  ] satisfies readonly Plan[],

  always: [
    'A named QA lead',
    'A written test strategy',
    'Bugs in your tracker, not a PDF',
    'Video, logs and reproduction steps on every finding',
    'Deduplication before delivery',
    'Weekly reporting',
    'A retrospective after every cycle',
  ] satisfies readonly string[],

  faqs: [
    {
      q: "Why aren't prices listed?",
      a: 'Because a two-market mobile regression cycle and a multilingual AI red team engagement cost very different amounts, and a number on a page would be wrong for almost everyone. A 30-minute scoping call gets you a real figure, usually within two business days.',
    },
    {
      q: 'How much is a pilot?',
      a: "Pilots are fixed-price and scoped to your product. We'll give you an exact number before you commit anything.",
    },
    {
      q: 'Do we have to sign an annual contract?',
      a: "Not to start. Pilots are standalone. Annual commitments come with better rates, and they're a choice, not a requirement.",
    },
    {
      q: 'Are test transaction costs extra?',
      a: 'Payment testing reimburses testers for real transactions. Those costs are estimated in your scope up front, and billed at cost with no markup.',
    },
    {
      q: 'Do you charge per bug?',
      a: 'No. You pay for coverage, not for volume of findings — that would create exactly the wrong incentive for everyone.',
    },
    {
      q: 'Can we start with just AI testing?',
      a: 'Yes. Many clients start with a single AI evaluation engagement and add traditional QA later, or vice versa.',
    },
  ] satisfies readonly Faq[],
} as const

/* ─── /contact ─────────────────────────────────────────────────────────────── */

export const CONTACT_PAGE = {
  eyebrow: 'Book a demo',
  title: 'See it working on your product.',
  description:
    "Thirty minutes. A QA engineer, not just a salesperson. We'll look at your release process, show you the platform, and tell you honestly whether we're a fit.",

  agenda: [
    {
      n: '0–5',
      title: 'Where you are',
      body: "What you're building and how you release today.",
    },
    {
      n: '5–20',
      title: 'The platform',
      body: 'Walked through against your use case, not a generic tour.',
    },
    {
      n: '20–30',
      title: "Where we'd start",
      body: 'Roughly what it costs, and what a pilot would cover.',
    },
  ] satisfies readonly Step[],

  note: "You'll get a written scope within two business days. No obligation.",

  /** ⚠ The last item is an audited certification — see TRUST in content/home.ts. */
  trust: [
    `${STATS.testers} vetted testers`,
    `${STATS.countries} countries`,
    `${STATS.devices} real devices`,
    'ISO 27001 certified',
  ] satisfies readonly string[],
} as const

/* ─── Hub section headers ──────────────────────────────────────────────────── */

/**
 * Header copy for the sections each hub page assembles.
 *
 * ⚠ CORRECTED. The first version of this object paraphrased these titles from
 * memory of the section's purpose instead of transcribing them, which is exactly
 * what CLAUDE.md's "never write new marketing copy" rule forbids. Every string
 * below is now lifted verbatim from `design/site/pages.jsx` — the hub pages had
 * their header copy inline as JSX props, the same as the homepage did.
 *
 * Note that several of these deliberately DIFFER from the detail-page headers in
 * `content/details.ts`, even where the section does a similar job. "What we
 * test / Coverage across the AI stack." is the hub; "What we cover / The failure
 * modes we test for." is the detail page. Do not consolidate them.
 *
 * The pricing entries are unverified against pages.jsx and are marked; the
 * Pricing page lands in step 7 and they will be checked then.
 */
export const HUB_SECTIONS = {
  aiWhy: {
    eyebrow: 'Why it matters',
    title: AI_TESTING_PAGE.whyTitle,
  },
  aiCoverage: {
    eyebrow: 'What we test',
    title: 'Coverage across the AI stack.',
  },
  aiMethod: {
    eyebrow: 'How we do it',
    title: 'Rubrics, not vibes.',
  },
  aiServices: {
    eyebrow: 'Services',
    title: 'Every AI failure mode, covered.',
    action: { label: 'Talk to an AI expert', href: '/contact' },
  },
  servicesChoose: {
    eyebrow: 'Choose by need',
    title: 'Core QA, delivered by people who do it every day.',
    description:
      'Fifteen services across web, mobile, API and desktop. Pick the ones your release actually needs.',
  },
  servicesModels: {
    eyebrow: 'Engagement models',
    title: 'Four ways to work with us.',
  },
  servicesIncluded: {
    eyebrow: 'Always included',
    title: 'What every engagement includes.',
  },
  platformFlow: {
    eyebrow: 'How the pieces fit',
    title: 'Five stages, one pipeline.',
  },
  platformModules: {
    eyebrow: 'Modules',
    title: 'Everything in the platform.',
    action: { label: 'Book a demo', href: '/contact' },
  },
  platformIntegrations: {
    eyebrow: 'Integrations',
    title: 'Built to fit your stack',
  },
  platformSecurity: {
    eyebrow: 'Security',
    title: 'Enterprise controls',
    action: { label: 'Read about security', href: '/company/trust' },
  },
  // Checked against pages.jsx when Pricing was built. Both of these had been
  // paraphrased and are now verbatim.
  pricingComponents: {
    eyebrow: 'How pricing works',
    title: 'Two components, so you only pay for what you use.',
  },
  pricingPlans: {
    eyebrow: 'Plans',
    title: 'Start on one release.',
  },
  pricingAlways: {
    eyebrow: 'Always included',
    title: "What's always included.",
  },
  pricingFaq: {
    eyebrow: 'Pricing FAQ',
    title: 'The questions procurement asks.',
  },
  faq: {
    eyebrow: 'FAQ',
    title: 'Questions we get asked.',
  },
} as const satisfies Record<string, SectionCopy>

/**
 * The line under the plan table. Transcribed from the `note` prop in
 * `PricingPage`; it is the page's answer to "why is there no number here".
 */
export const PRICING_TABLE_NOTE =
  'Prices are scoped per engagement. A 30-minute call gets you a real figure, usually within two business days.'

/* ─── Contact form ─────────────────────────────────────────────────────────── */

/**
 * Copy for the form itself, transcribed from the `ContactForm` props in
 * `ContactPage` plus the component's own defaults.
 *
 * The `description` and `footnote` lines are gone on purpose. Both said the
 * same thing ("we reply within one business day"), once above the fields and
 * again under the button, and between them they pushed the submit button off
 * the first screen — the form has to be scrolled past to be sent. The promise
 * still appears once, on the confirmation, where it is actually load-bearing.
 */
export const CONTACT_FORM = {
  title: 'Book my demo',
  submitLabel: 'Book my demo',
  /** Label above the agenda table. */
  agendaLabel: 'What happens on the call',
  /**
   * Only the admin's manual-lead form uses this now. The public demo form no
   * longer offers the opt-in, so a lead from the website is recorded with
   * `marketingConsent: false` — nothing is claimed that nobody agreed to.
   */
  consentLabel: 'Email me the quarterly QE benchmark report.',
  success: {
    title: "Thanks — we'll be in touch",
    body: 'A quality engineer will reply within one business day with times that suit your team.',
  },
  /** Team-size options. Numbers use the true en dash, per the copy rules. */
  teamSizes: ['1–50', '51–500', '501–5,000', '5,000+'],
} as const

/* ─── Error pages ──────────────────────────────────────────────────────────── */

/**
 * 404 and 500 copy, transcribed from content.md §3.6 and §3.7.
 *
 * The tone is the one place the brand voice gets to be wry, and it earns it by
 * being self-deprecating about the thing the company sells. Keep it.
 */
export const NOT_FOUND_PAGE = {
  title: "This page doesn't exist. We'd have caught that.",
  description:
    "The link is broken or the page moved. Ironic, we know — we're writing the bug report now.",
  suggestionsLabel: 'Try one of these instead:',
  cta: 'Back to homepage',
  suggestions: [
    { label: 'Homepage', href: '/' },
    { label: 'AI Testing', href: '/ai-testing' },
    { label: 'Services', href: '/services' },
    { label: 'Platform', href: '/platform' },
    { label: 'Pricing', href: '/pricing' },
    { label: 'Contact', href: '/contact' },
  ] as readonly { label: string; href: string }[],
} as const

export const ERROR_PAGE = {
  title: 'Something broke on our side.',
  description:
    'Not your fault. Our team has been notified and is on it. Try again in a moment, or email',
  email: 'admin@crowd4test.com',
  emailSuffix: "if it's urgent.",
  cta: 'Try again',
  /** Prefix for the server-side correlation id, shown only when one exists. */
  referenceLabel: 'Reference:',
} as const

/* ─── Cookie consent ───────────────────────────────────────────────────────── */

/**
 * Banner copy, transcribed from content.md §3.4.
 *
 * The source gives the title, the body and three button labels. The two category
 * labels and the "Save" action under "Manage preferences" are NOT in content.md —
 * §3.4 stops at the three buttons. They are UI text for a panel the copy asks for
 * but does not spell out, kept factual and non-persuasive on purpose: a consent
 * choice is the one place where nudging is both a dark pattern and a compliance
 * problem.
 */
export const COOKIE_BANNER = {
  title: 'We use cookies',
  body: "We use essential cookies to run this site and optional ones to understand how it's used. You choose.",
  acceptAll: 'Accept all',
  essentialOnly: 'Essential only',
  manage: 'Manage preferences',
  policyLabel: 'Read our Cookie Policy →',
  policyHref: '/legal/cookies',

  // The preferences panel.
  save: 'Save preferences',
  essentialLabel: 'Essential',
  essentialDescription: 'Required to load pages and remember this choice. Always on.',
  analyticsLabel: 'Analytics',
  analyticsDescription: 'Anonymous page views, so we can see which pages are useful.',
} as const
