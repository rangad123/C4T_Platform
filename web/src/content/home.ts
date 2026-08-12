import type { IconName, ResourceType } from '@/components/ds'
import { STATS } from './stats'

/**
 * Homepage content, ported from `design/site/data.js` (`window.C4TH`) and the
 * section headers that were inline props in `design/site/Home.jsx`.
 *
 * The prototype could hardcode headings in JSX because it was one throwaway
 * file. Here the homepage is a Server Component that step 5 composes from these
 * objects, so the copy stays reviewable in one place and CLAUDE.md's "never
 * write new marketing copy" rule has something to check against.
 *
 * `nav`, `footerColumns` and `stats` from the same global live in
 * `content/nav.ts` and `content/stats.ts` — they are used site-wide, not only
 * here.
 *
 * ⚠ THREE BLOCKS ARE NOT REAL CONTENT and must not ship as written:
 * `TESTIMONIAL` and every certification claim in `TRUST`. Each is marked at its
 * definition. The case studies moved to `content/case-studies.ts`, which carries
 * its own warning.
 */

/* ─── Hero ─────────────────────────────────────────────────────────────────── */

export const HOME_HERO = {
  /**
   * NO EYEBROW ON THIS HERO — deliberately, and it is the only one without one.
   *
   * It read "AI-Powered Digital Quality Engineering", which is now the opening
   * of the headline itself, so the hero said the same thing twice in a row:
   *
   *   AI-POWERED DIGITAL QUALITY ENGINEERING
   *   AI-Powered Digital Quality Engineering with human Intelligence
   *
   * An eyebrow frames a headline; it should not preview it. Removed rather
   * than reworded because the headline already carries the positioning.
   *
   * `Hero` renders the eyebrow only when the prop is present, so omitting it
   * here is all that is required — page.tsx no longer passes one.
   */
  /**
   * Client-supplied, replacing "Ship AI and software your users can trust."
   * Written as "AI - Powered"; the spaces around the hyphen are closed up so
   * the compound adjective matches the rest of the site.
   */
  title: 'AI-Powered Digital Quality Engineering with Human Intelligence',
  /**
   * The tail of `title`, rendered in the accent colour by `Hero`.
   *
   * Kept as a plain substring rather than JSX so this module stays serialisable
   * data — `opengraph-image.tsx` reads `title` as a string for the social card,
   * and markup here would break it. `Hero` finds this text inside `title` and
   * wraps just that span; if the two ever stop matching it renders the headline
   * plain rather than throwing.
   */
  titleHighlight: 'Human Intelligence',
  description:
    "We combine AI agents that test at machine speed with a vetted global community of human testers who catch what automation can't — wrong answers, broken journeys, cultural misfires and accessibility failures.",
  primaryCta: 'Book a demo',
  secondaryCta: 'Start a pilot',
  /**
   * ⚠ UNVERIFIED. Four certification claims in one line. ISO/IEC 27001 and
   * SOC 2 Type II are auditable facts — publishing either without a current
   * certificate is a misrepresentation, not marketing licence. Do not render
   * this until the Client supplies the certificates.
   */
  trustLine: 'ISO/IEC 27001 · SOC 2 Type II · GDPR · DPDPA',
} as const

/* ─── Section headers ──────────────────────────────────────────────────────── */

export interface SectionCopy {
  /** Mono uppercase kicker. Omitted where it would restate the heading. */
  eyebrow?: string
  title: string
  /**
   * A trailing clause of `title` set at a smaller size, on its own line.
   * For headings that pair a claim with a list of qualities.
   */
  titleSmall?: string
  description?: string
  /** Trailing link on the header row. Omitted where the destination was cut. */
  action?: { label: string; href: string }
}

export const HOME_SECTIONS = {
  problem: {
    eyebrow: 'The problem',
    title: "Software changed. Testing didn't keep up.",
    description:
      "Your team ships weekly. Your product now answers questions in natural language, calls tools, and behaves differently for every user. Traditional QA was built for deterministic software with predictable outputs. It doesn't fit any more.",
  },
  approach: {
    eyebrow: 'The approach',
    title: 'AI for speed. Humans for judgment.',
    description:
      "We run both in one workflow. AI agents generate test cases from your requirements, execute regression at scale, and triage the results. Human experts then validate everything AI can't reliably judge on its own — factual accuracy, tone, cultural fit, accessibility and whether the experience actually works for a real person.",
  },
  aiQuality: {
    /**
     * NO EYEBROW. It read "AI Quality", which the heading beneath it already
     * says twice over — the section opened with the words "AI" and "Testing"
     * immediately below a kicker announcing "AI QUALITY".
     */
    /**
     * Client-supplied, replacing "Testing built for products that think."
     * Written as "AI-Powered Testing Platform  Intelligent, Autonomus, Faster".
     *
     * The double space between "Platform" and "Intelligent" was a separator, so
     * the three qualities are split into `titleSmall` and set smaller on their
     * own line — which is what the gap was reaching for. An em dash stood in
     * for it briefly; it is gone now that the size change does the same job
     * without leaving a dangling mark at the end of a line.
     *
     * "Autonomus" is spelled "Autonomous".
     */
    title: 'AI-Powered Testing Platform',
    titleSmall: 'Intelligent, Autonomous, Faster',
    description:
      'AI features fail in ways traditional QA was never designed to catch. We test the failure modes that matter.',
    action: { label: 'Explore AI testing', href: '/ai-testing' },
  },
  services: {
    /**
     * NO EYEBROW. It read "Software Quality Engineering", and the heading below
     * it is "Comprehensive Quality Engineering Services" — the same three words
     * twice, one directly above the other.
     *
     * Third of three removed for the same reason (the hero and the AI quality
     * section were the others). The pattern: these kickers were written to
     * frame short, oblique headings like "The full QA stack, still." Once the
     * headings became literal descriptions of the discipline, the kickers
     * became echoes of them.
     */
    /** Client-supplied, replacing "The full QA stack, still." */
    title: 'Comprehensive Quality Engineering Services',
    description:
      "AI didn't replace the fundamentals. We cover them across web, mobile, API and desktop.",
    action: { label: 'Explore all services', href: '/services' },
  },
  platform: {
    eyebrow: 'The platform',
    title: 'One platform from test case to release decision.',
    description:
      'Everything runs in one place — AI generation, crowd execution, triage and reporting. Your team sees a single source of truth instead of five spreadsheets.',
    action: { label: 'See the platform', href: '/platform' },
  },
  /**
   * The prototype's header carried a "View all industries" action pointing at
   * an /industries hub. CLAUDE.md rule 10 bars that section, so the action is
   * dropped and the strip below stays a plain list of domains we cover.
   */
  industries: {
    eyebrow: 'Industries',
    title: 'Depth where it matters.',
    description:
      'Regulated industries need testers who understand the domain, not just the app. We match clinicians to healthcare, finance professionals to BFSI, and native speakers to every market you launch in.',
  },
  stories: {
    eyebrow: 'Customer stories',
    title: 'What teams say.',
  },
  proof: {
    eyebrow: 'Proof',
    title: 'Results, not adjectives.',
    action: { label: 'View all case studies', href: '/company/case-studies' },
  },
  resources: {
    eyebrow: 'Resources',
    title: 'Learn how modern QA actually works.',
    action: { label: 'Read the blog', href: '/company/blog' },
  },
} as const satisfies Record<string, SectionCopy>

/* ─── The problem ──────────────────────────────────────────────────────────── */

export interface Problem {
  icon: IconName
  title: string
  description: string
}

export const PROBLEMS: readonly Problem[] = [
  {
    icon: 'gauge',
    title: 'Release velocity outruns coverage',
    description:
      "Teams ship faster every quarter. Test coverage doesn't grow at the same rate, so the gap becomes production risk.",
  },
  {
    icon: 'circle-help',
    title: 'AI outputs have no single right answer',
    description:
      "A pass/fail assertion can't tell you whether a response was accurate, appropriate or safe. Something has to make a judgment call.",
  },
  {
    icon: 'globe',
    title: "Staging doesn't look like the real world",
    description:
      'Your test lab has clean networks, five devices and one language. Your users have none of that.',
  },
  {
    icon: 'banknote',
    title: 'One bad release is expensive',
    description:
      'A hallucinated answer, a failed payment or an inaccessible checkout costs revenue, trust and, increasingly, regulatory exposure.',
  },
]

/* ─── How we work ──────────────────────────────────────────────────────────── */

export interface Step {
  /** Two-digit ordinal, rendered in mono. */
  n: string
  title: string
  body: string
}

/**
 * The three-step engagement. Shared: the homepage renders it, and so does every
 * detail page (`content/details.ts` re-exports it as `DELIVERY`).
 */
export const STEPS: readonly Step[] = [
  {
    n: '01',
    title: 'Scope',
    body: 'A QA lead maps your release process, risk areas and target markets. You get a test strategy and a fixed-price pilot scope, usually within a week.',
  },
  {
    n: '02',
    title: 'Execute',
    body: 'AI agents generate and run tests across your stack. Matched human testers validate on real devices in real markets. Both feed the same pipeline.',
  },
  {
    n: '03',
    title: 'Decide',
    body: 'Bugs land triaged, deduplicated and prioritised in your tracker. A Release Readiness Score tells you whether to ship — with the evidence behind it.',
  },
]

/* ─── Service lines ────────────────────────────────────────────────────────── */

/**
 * One entry per detail page in the AI Testing family. `points` become the
 * numbered capability chips on the detail template.
 */
export interface AiService {
  icon: IconName
  eyebrow: string
  title: string
  /** Detail-page slug under /ai-testing. See content/details.ts. */
  slug: string
  description: string
  points: readonly string[]
  badge?: string
}

export const AI_SERVICES: readonly AiService[] = [
  {
    icon: 'sparkles',
    eyebrow: 'LLM',
    title: 'GenAI & LLM Testing',
    slug: 'genai-llm-testing',
    description:
      'Validate accuracy, consistency and safety across prompts, models and versions — before your users find the gaps.',
    points: [
      'Prompt coverage',
      'Hallucination detection',
      'Output consistency',
      'Regression across model versions',
    ],
  },
  {
    icon: 'bot',
    eyebrow: 'Agents',
    title: 'AI Agent Testing',
    slug: 'ai-agent-testing',
    description:
      'Agents plan, call tools and take real actions. We test the whole chain, including what happens when a step fails.',
    points: [
      'Multi-step workflows',
      'Tool-call accuracy',
      'Failure recovery',
      'MCP server validation',
    ],
    badge: 'New',
  },
  {
    icon: 'message-square',
    eyebrow: 'Conversation',
    title: 'Chatbot & Conversational AI',
    slug: 'chatbot-testing',
    description: 'Intent coverage, tone, escalation and the messy way real people actually type.',
    points: ['Intent coverage', 'Context retention', 'Escalation paths', 'Multilingual'],
  },
  {
    icon: 'mic',
    eyebrow: 'Voice',
    title: 'Voice AI Testing',
    slug: 'voice-ai-testing',
    description:
      'Real accents, real background noise, real interruptions — on real devices in real rooms.',
    points: ['Accent diversity', 'Noise conditions', 'Barge-in', 'Wake-word accuracy'],
  },
  {
    icon: 'library-big',
    eyebrow: 'Retrieval',
    title: 'RAG Evaluation',
    slug: 'rag-evaluation',
    description:
      'Check that answers are grounded in your documents and that citations point where they claim to.',
    points: ['Retrieval precision', 'Grounding', 'Citation accuracy', 'Freshness'],
  },
  {
    icon: 'shield-alert',
    eyebrow: 'Safety',
    title: 'Red Teaming & AI Safety',
    slug: 'red-teaming',
    description: 'Adversarial testing by humans who are genuinely trying to break your model.',
    points: ['Jailbreak attempts', 'Prompt injection', 'Toxicity', 'Misuse scenarios'],
  },
  {
    icon: 'scale',
    eyebrow: 'Fairness',
    title: 'Bias & Fairness Testing',
    slug: 'bias-and-fairness-testing',
    description:
      'Measure output quality across demographic, linguistic and regional slices, with native speakers in each.',
    points: ['Demographic slices', 'Language parity', 'Regional fairness', 'Documented evidence'],
  },
  {
    icon: 'activity',
    eyebrow: 'Production',
    title: 'Model Monitoring',
    slug: 'model-monitoring',
    description:
      'Models drift quietly. Continuous evaluation catches it before your support queue does.',
    points: ['Drift detection', 'Production sampling', 'Sentiment tracking', 'Alerting'],
  },
]

/**
 * One entry per detail page in the Services family. `meta` is a middot-separated
 * list that the detail template splits back into capability chips.
 */
export interface QaService {
  icon: IconName
  title: string
  /** Detail-page slug under /services. See content/details.ts. */
  slug: string
  description: string
  /** Middot-separated capability list; the detail template splits it to chips. */
  meta: string
}

export const QA_SERVICES: readonly QaService[] = [
  {
    icon: 'users-round',
    title: 'Crowd Testing',
    slug: 'crowd-testing',
    description:
      'Real users, real devices, real networks, real countries. Coverage no lab can reproduce.',
    meta: `${STATS.countries} countries · ${STATS.devices} devices · 24/7`,
  },
  {
    icon: 'code',
    title: 'Test Automation',
    slug: 'test-automation',
    description: 'Build and maintain suites in the frameworks your team already uses.',
    meta: 'Playwright · Selenium · Appium · Cypress · REST Assured',
  },
  {
    icon: 'test-tube-diagonal',
    title: 'Functional Testing',
    slug: 'functional-testing',
    description: 'Structured and exploratory testing across every core flow before each release.',
    meta: 'Regression · Smoke · Exploratory · UAT support',
  },
  {
    icon: 'gauge',
    title: 'Performance Engineering',
    slug: 'performance-testing',
    description: 'Find the breaking point in staging instead of in production.',
    meta: 'Load · Stress · Soak · Scalability',
  },
  {
    icon: 'shield-check',
    title: 'Security Testing',
    slug: 'security-testing',
    description: 'OWASP-aligned validation of your app, APIs and auth flows.',
    meta: 'OWASP Top 10 · API security · Auth & session · VAPT',
  },
  {
    icon: 'accessibility',
    title: 'Accessibility Testing',
    slug: 'accessibility-testing',
    description: 'Tested with assistive technology by people who use it every day.',
    meta: 'WCAG 2.2 AA · ADA · Section 508 · EN 301 549',
  },
  {
    icon: 'globe',
    title: 'Localization Testing',
    slug: 'localization-testing',
    description:
      'In-market validation by native speakers — language, layout, currency and cultural fit.',
    meta: `${STATS.languages} languages · Native speakers · Regional UX`,
  },
  {
    icon: 'credit-card',
    title: 'Payment Testing',
    slug: 'payment-testing',
    description: 'Real cards, real wallets, real bank flows in each market you operate in.',
    meta: 'UPI · Cards · Wallets · 3DS · Refunds',
  },
]

/** One entry per detail page in the Platform family. */
export interface PlatformModule {
  icon: IconName
  title: string
  /** Detail-page slug under /platform. See content/details.ts. */
  slug: string
  description: string
}

export const PLATFORM_MODULES: readonly PlatformModule[] = [
  {
    icon: 'wand-sparkles',
    title: 'AI Test Case Generator',
    slug: 'ai-test-generation',
    description:
      'Turn requirements into executable test cases in minutes. Feed it PRDs, user stories, Jira tickets, Figma files or an API spec.',
  },
  {
    icon: 'compass',
    title: 'AI Exploratory Agents',
    slug: 'ai-exploratory-agents',
    description:
      'Agents explore your app like curious users, following unexpected paths and surfacing defects a scripted suite would never reach.',
  },
  {
    icon: 'filter',
    title: 'AI Bug Triage',
    slug: 'ai-bug-triage',
    description:
      'Every incoming bug is deduplicated, categorised, severity-scored and routed. Your team reads signal instead of noise.',
  },
  {
    icon: 'repeat',
    title: 'Regression Optimizer',
    slug: 'regression-optimizer',
    description:
      'Predicts which tests actually matter for this change. Cut execution time while holding risk coverage flat.',
  },
  {
    icon: 'gauge',
    title: 'Release Readiness Score',
    slug: 'release-readiness-score',
    description:
      'A single number backed by quality, risk and coverage sub-scores — plus the evidence behind each one.',
  },
  {
    icon: 'line-chart',
    title: 'Analytics & Reporting',
    slug: 'analytics',
    description:
      'Test runs, pass rates, coverage by device and country, defect distribution and release health over time.',
  },
]

/* ─── Strips ───────────────────────────────────────────────────────────────── */

/** The scrolling marquee under the AI section. */
export const USE_CASES: readonly string[] = [
  'Chatbots',
  'Voice assistants',
  'LLM applications',
  'AI agents & copilots',
  'RAG systems',
  'Recommendation engines',
  'Computer vision & image AI',
  'Document AI',
  'Translation & multilingual AI',
  'Fraud detection models',
]

/**
 * Domains we staff testers for. NOT links — CLAUDE.md rule 10 bars the
 * /industries pages, so these render as a plain hairline grid.
 */
export const INDUSTRIES: readonly { icon: IconName; name: string }[] = [
  { icon: 'landmark', name: 'Banking & Finance' },
  { icon: 'heart-pulse', name: 'Healthcare' },
  { icon: 'shopping-cart', name: 'Retail & Ecommerce' },
  { icon: 'clapperboard', name: 'Media & Entertainment' },
  { icon: 'radio-tower', name: 'Telecom' },
  { icon: 'gamepad-2', name: 'Gaming' },
  { icon: 'plane', name: 'Travel & Hospitality' },
  { icon: 'car', name: 'Automotive' },
  { icon: 'cloud', name: 'SaaS' },
  { icon: 'graduation-cap', name: 'Education' },
]

export const INTEGRATIONS: readonly string[] = [
  'Jira',
  'Linear',
  'GitHub',
  'GitLab',
  'Azure DevOps',
  'Jenkins',
  'TestRail',
  'Xray',
  'Slack',
  'Microsoft Teams',
  'Webhooks',
  'REST API',
]

/**
 * ⚠ TWO OF THESE ARE AUDITED CERTIFICATIONS, not positioning. "ISO/IEC
 * 27001:2022 certified" and "SOC 2 Type II" are false until a current
 * certificate exists, and stating them is a misrepresentation a customer can
 * act on. The remaining five describe practices and are safe once confirmed
 * with the Client. The prototype's own card copy says "Confirm each badge
 * before launch".
 */
export const TRUST: readonly string[] = [
  'ISO/IEC 27001:2022 certified',
  'SOC 2 Type II',
  'GDPR and DPDPA aligned',
  'NDAs with every tester',
  'Role-based access',
  'Regional data residency options',
  'Audit logs',
]

/* ─── Twin cards above the resources strip ─────────────────────────────────── */

export const HOME_CARDS = {
  integrations: {
    title: 'Fits the tools you already use.',
    description: 'Bugs go where your team already works. No new dashboard to check.',
    action: { label: 'See all integrations', href: '/platform/integrations' },
  },
  trust: {
    title: 'Enterprise-ready by default.',
    description: 'Certifications, access control and data residency, evidenced.',
    action: { label: 'Read about our security', href: '/company/trust' },
  },
} as const

/* ─── Proof ────────────────────────────────────────────────────────────────── */

export interface Result {
  value: string
  label: string
}

/**
 * ⚠ UNVERIFIED. Outcome claims of the kind a prospect will hold you to.
 * Each needs a named engagement behind it before launch.
 */
export const RESULTS: readonly Result[] = [
  { value: '40%', label: 'Faster regression cycles' },
  { value: '15%', label: 'Fewer production defects' },
  { value: '3 weeks', label: 'To first release-ready report' },
]

/**
 * ⚠ NOT REAL. The prototype's own placeholder text: "Use only real,
 * attributable quotes with written consent." Rendering an invented testimonial
 * attributed to an invented person is a fabricated endorsement. The homepage
 * must omit the section until the Client supplies a consented quote.
 */
export const TESTIMONIAL = {
  quote:
    'Testimonial quote goes here — one to two sentences, ideally with a number in it. Use only real, attributable quotes with written consent.',
  name: 'Name',
  role: 'Title',
  company: 'Company',
  /** Flips to true only when a real, consented quote replaces the above. */
  cleared: false,
} as const

/**
 * The homepage "Proof" carousel reads the real collection in
 * `content/case-studies.ts` — it used to hold a second, duplicate copy of the
 * three placeholder studies plus its own `CaseStudy` type, which then collided
 * with the collection's when both were re-exported from the barrel.
 *
 * The cards on the homepage and the About page link to the case-study INDEX, not
 * to individual studies: every entry is a draft, so a per-study link would 404 in
 * production. See CASE_STUDY_ENTRIES for the ⚠ on the placeholder values.
 */

/* ─── Resources ────────────────────────────────────────────────────────────── */

export interface Resource {
  /** Drives the plate icon on ResourceCard, so it is the card's union. */
  type: ResourceType
  title: string
  description: string
}

export const RESOURCES: readonly Resource[] = [
  {
    type: 'Guide',
    title: 'The Ultimate Guide to Testing AI Applications',
    description: 'A practical framework for validating LLMs, agents and RAG systems.',
  },
  {
    type: 'Report',
    title: 'The State of AI Quality 2026',
    description: `What ${STATS.surveyedTeams} engineering teams told us about testing AI in production.`,
  },
  {
    type: 'Article',
    title: 'GenAI Testing Checklist',
    description: '45 checks to run before you ship an AI feature.',
  },
  {
    type: 'Article',
    title: 'Crowd Testing vs. In-House QA: The Real Cost',
    description: 'An honest cost model, including the parts vendors leave out.',
  },
]

/* ─── Closing band ─────────────────────────────────────────────────────────── */

/**
 * Also used verbatim at the foot of every detail page, which is why it lives
 * here rather than inline in the homepage.
 */
export const CLOSING_CTA = {
  eyebrow: 'Ready when you are',
  title: 'Ready to ship with confidence?',
  description:
    "Book a 30-minute call. We'll map your release process, show you where quality is leaking, and scope a pilot you can run on your next release.",
  primaryCta: 'Book a demo',
  primaryHref: '/contact',
  secondaryCta: 'Start a pilot',
  // Both CTAs land on Contact, as they did in the prototype (`go("Contact")`).
  // content.md's sitemap had a separate /start-a-pilot page; the README route
  // map does not, so the path redirects there instead of being built.
  secondaryHref: '/contact',
  note: 'No commitment. No sales script. A QA engineer will be on the call.',
} as const
