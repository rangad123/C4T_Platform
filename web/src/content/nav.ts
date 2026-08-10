import type { IconName } from '@/components/ds'
import type { SocialIconName } from '@/components/SocialIcons'
import { STATS } from './stats'

/**
 * The site's information architecture.
 *
 * Ported from `design/site/data.js` (`window.C4TH.nav` / `.footerColumns`), with
 * one structural change: the prototype routed by LABEL through an `onNavigate`
 * callback, so its links carried no URLs. Next routes by path, so every link
 * here carries a real `href`. That is what lets TopNav and Footer render
 * `next/link` and stay prefetchable.
 *
 * Two footer columns from the prototype are NOT here — "Industries" and
 * "Testers". Those sections were cut from the navigation late in design (see the
 * handoff README route map), so their pages are not being built and a footer
 * link would 404. Restore both if the client reinstates the sections.
 *
 * Do NOT use the design system's exported `DEFAULT_NAV`. It is the kit's generic
 * demo IA and carries invented figures ("42,000 vetted testers in 96 countries",
 * "38 languages") that contradict the real ones in content.md.
 */

export interface MegaLink {
  icon: IconName
  label: string
  desc?: string
  href: string
}

export interface MegaColumn {
  title: string
  links: MegaLink[]
}

export interface NavFeature {
  badge?: string
  title: string
  desc: string
  cta: string
  href: string
}

export interface NavItem {
  label: string
  href?: string
  /** Present = renders a full-width mega menu. */
  columns?: MegaColumn[]
  /** Optional promoted panel on the right of the mega menu. */
  feature?: NavFeature
}

export const NAV: NavItem[] = [
  {
    label: 'AI Testing',
    href: '/ai-testing',
    columns: [
      {
        title: 'Validate AI systems',
        links: [
          {
            icon: 'sparkles',
            label: 'GenAI & LLM Testing',
            desc: 'Accuracy, safety and consistency for language models',
            href: '/ai-testing/genai-llm-testing',
          },
          {
            icon: 'bot',
            label: 'AI Agent Testing',
            desc: 'Multi-step agent workflows, tool calls and failure recovery',
            href: '/ai-testing/ai-agent-testing',
          },
          {
            icon: 'message-square',
            label: 'Chatbot Testing',
            desc: 'Intent coverage, tone and escalation paths',
            href: '/ai-testing/chatbot-testing',
          },
          {
            icon: 'mic',
            label: 'Voice AI Testing',
            desc: 'Accents, noise, interruptions and barge-in',
            href: '/ai-testing/voice-ai-testing',
          },
          {
            icon: 'library-big',
            label: 'RAG Evaluation',
            desc: 'Retrieval quality, grounding and citation accuracy',
            href: '/ai-testing/rag-evaluation',
          },
        ],
      },
      {
        title: 'Protect AI systems',
        links: [
          {
            icon: 'shield-alert',
            label: 'Red Teaming & AI Safety',
            desc: 'Adversarial prompts, jailbreaks and misuse',
            href: '/ai-testing/red-teaming',
          },
          {
            icon: 'scale',
            label: 'Bias & Fairness Testing',
            desc: 'Demographic and linguistic fairness slices',
            href: '/ai-testing/bias-and-fairness-testing',
          },
          {
            icon: 'activity',
            label: 'Model Monitoring',
            desc: 'Drift detection after you ship',
            href: '/ai-testing/model-monitoring',
          },
          {
            icon: 'database',
            label: 'AI Data Collection',
            desc: 'Human-labelled training and evaluation data',
            href: '/ai-testing/ai-data-collection',
          },
        ],
      },
    ],
    feature: {
      badge: 'New',
      title: 'AI Agent Testing',
      desc: "Agents that call tools and take actions fail differently. Here's how we test them.",
      cta: 'Read the guide',
      href: '/ai-testing/ai-agent-testing',
    },
  },
  {
    label: 'Services',
    href: '/services',
    columns: [
      {
        title: 'Core QA',
        links: [
          { icon: 'users-round', label: 'Crowd Testing', href: '/services/crowd-testing' },
          {
            icon: 'test-tube-diagonal',
            label: 'Functional Testing',
            href: '/services/functional-testing',
          },
          { icon: 'code', label: 'Test Automation', href: '/services/test-automation' },
          { icon: 'smartphone', label: 'Mobile App Testing', href: '/services/mobile-app-testing' },
          { icon: 'monitor', label: 'Web App Testing', href: '/services/web-app-testing' },
          { icon: 'webhook', label: 'API Testing', href: '/services/api-testing' },
        ],
      },
      {
        title: 'Specialised',
        links: [
          { icon: 'gauge', label: 'Performance Testing', href: '/services/performance-testing' },
          { icon: 'shield-check', label: 'Security Testing', href: '/services/security-testing' },
          {
            icon: 'accessibility',
            label: 'Accessibility Testing',
            href: '/services/accessibility-testing',
          },
          { icon: 'globe', label: 'Localization Testing', href: '/services/localization-testing' },
          { icon: 'credit-card', label: 'Payment Testing', href: '/services/payment-testing' },
          { icon: 'eye', label: 'Usability Testing', href: '/services/usability-testing' },
        ],
      },
      {
        title: 'By surface',
        links: [
          {
            icon: 'layout-grid',
            label: 'Compatibility & Device Testing',
            href: '/services/compatibility-testing',
          },
          { icon: 'gamepad-2', label: 'Game Testing', href: '/services/game-testing' },
          { icon: 'cpu', label: 'IoT, AR & VR Testing', href: '/services/iot-and-ar-vr-testing' },
        ],
      },
    ],
    feature: {
      title: 'Not sure what you need?',
      desc: 'Book a 30-minute scoping call with a QA engineer.',
      cta: 'Talk to an expert',
      href: '/contact',
    },
  },
  {
    label: 'Platform',
    href: '/platform',
    columns: [
      {
        title: 'AI engine',
        links: [
          {
            icon: 'wand-sparkles',
            label: 'AI Test Generation',
            href: '/platform/ai-test-generation',
          },
          {
            icon: 'bot',
            label: 'AI Exploratory Agents',
            href: '/platform/ai-exploratory-agents',
          },
          { icon: 'filter', label: 'AI Bug Triage', href: '/platform/ai-bug-triage' },
          {
            icon: 'shuffle',
            label: 'Regression Optimizer',
            href: '/platform/regression-optimizer',
          },
          {
            icon: 'badge-check',
            label: 'Release Readiness Score',
            href: '/platform/release-readiness-score',
          },
        ],
      },
      {
        title: 'Infrastructure',
        links: [
          { icon: 'line-chart', label: 'Analytics & Reporting', href: '/platform/analytics' },
          { icon: 'smartphone', label: 'Device Cloud', href: '/platform/device-cloud' },
          { icon: 'plug', label: 'Integrations', href: '/platform/integrations' },
          { icon: 'lock', label: 'Security & Compliance', href: '/platform/security' },
        ],
      },
    ],
    feature: {
      title: 'See the platform',
      desc: 'A 15-minute walkthrough with a QA engineer, against your own release process.',
      cta: 'Book a demo',
      href: '/contact',
    },
  },
  {
    label: 'Company',
    href: '/company/about',
    columns: [
      {
        title: 'Crowd4Test',
        links: [
          { icon: 'info', label: 'About Crowd4Test', href: '/company/about' },
          { icon: 'briefcase', label: 'Careers', href: '/company/careers' },
          { icon: 'newspaper', label: 'Blog', href: '/company/blog' },
          { icon: 'file-text', label: 'Case Studies', href: '/company/case-studies' },
          { icon: 'handshake', label: 'Partners', href: '/company/partners' },
          { icon: 'shield-check', label: 'Trust & Security', href: '/company/trust' },
          { icon: 'mail', label: 'Contact', href: '/contact' },
        ],
      },
    ],
  },
  { label: 'Pricing', href: '/pricing' },
]

export interface FooterLink {
  label: string
  href: string
}

export interface FooterColumn {
  title: string
  links: FooterLink[]
}

export const FOOTER_COLUMNS: FooterColumn[] = [
  {
    title: 'AI Testing',
    links: [
      { label: 'GenAI & LLM Testing', href: '/ai-testing/genai-llm-testing' },
      { label: 'AI Agent Testing', href: '/ai-testing/ai-agent-testing' },
      { label: 'Chatbot Testing', href: '/ai-testing/chatbot-testing' },
      { label: 'Voice AI Testing', href: '/ai-testing/voice-ai-testing' },
      { label: 'RAG Evaluation', href: '/ai-testing/rag-evaluation' },
      { label: 'Red Teaming', href: '/ai-testing/red-teaming' },
      { label: 'Bias & Fairness', href: '/ai-testing/bias-and-fairness-testing' },
      { label: 'Model Monitoring', href: '/ai-testing/model-monitoring' },
      { label: 'AI Data Collection', href: '/ai-testing/ai-data-collection' },
    ],
  },
  {
    title: 'Services',
    links: [
      { label: 'Crowd Testing', href: '/services/crowd-testing' },
      { label: 'Functional Testing', href: '/services/functional-testing' },
      { label: 'Test Automation', href: '/services/test-automation' },
      { label: 'Mobile App Testing', href: '/services/mobile-app-testing' },
      { label: 'Web App Testing', href: '/services/web-app-testing' },
      { label: 'API Testing', href: '/services/api-testing' },
      { label: 'Performance Testing', href: '/services/performance-testing' },
      { label: 'Security Testing', href: '/services/security-testing' },
      { label: 'Accessibility Testing', href: '/services/accessibility-testing' },
      { label: 'Localization Testing', href: '/services/localization-testing' },
      { label: 'Payment Testing', href: '/services/payment-testing' },
      { label: 'Usability Testing', href: '/services/usability-testing' },
      { label: 'Game Testing', href: '/services/game-testing' },
    ],
  },
  {
    title: 'Platform',
    links: [
      { label: 'Overview', href: '/platform' },
      { label: 'AI Test Generation', href: '/platform/ai-test-generation' },
      { label: 'AI Exploratory Agents', href: '/platform/ai-exploratory-agents' },
      { label: 'AI Bug Triage', href: '/platform/ai-bug-triage' },
      { label: 'Regression Optimizer', href: '/platform/regression-optimizer' },
      { label: 'Release Readiness Score', href: '/platform/release-readiness-score' },
      { label: 'Analytics', href: '/platform/analytics' },
      { label: 'Device Cloud', href: '/platform/device-cloud' },
      { label: 'Integrations', href: '/platform/integrations' },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'About', href: '/company/about' },
      { label: 'Careers', href: '/company/careers' },
      { label: 'Blog', href: '/company/blog' },
      { label: 'Case Studies', href: '/company/case-studies' },
      { label: 'Partners', href: '/company/partners' },
      { label: 'Trust & Security', href: '/company/trust' },
      { label: 'Contact', href: '/contact' },
      { label: 'Pricing', href: '/pricing' },
    ],
  },
]

/**
 * Copy from content.md §3.1, verbatim. Rendered in the strip above the nav bar.
 * The team count is a placeholder resolved from content/stats.ts.
 */
export const ANNOUNCEMENT = {
  text: `New: The State of AI Quality 2026 report is out. ${STATS.surveyedTeams} teams told us how they test AI. Read it`,
  href: '/company/blog',
} as const

/**
 * The company's social profiles — CONFIRMED URLs, supplied by the client.
 *
 * ONE SOURCE OF TRUTH, TWO CONSUMERS. The footer renders these as a row of
 * links, and `lib/seo/structured-data.ts` feeds the same list to the
 * `Organization` JSON-LD `sameAs` array. `sameAs` is how Google reconciles this
 * entity with its social accounts, so the two must never disagree — a footer
 * link the structured data does not corroborate is a weaker signal than either
 * alone. Keeping them derived from one array makes divergence impossible.
 *
 * `icon` keys into SOCIAL_ICONS in `components/SocialIcons.tsx`. Adding a
 * profile here without adding the matching glyph there is a type error, not a
 * blank space in the footer.
 */
export const SOCIAL_PROFILES = [
  {
    label: 'LinkedIn',
    url: 'https://www.linkedin.com/company/crowd4test/',
    icon: 'linkedin',
  },
  {
    label: 'YouTube',
    url: 'https://www.youtube.com/channel/UCt-w9dMYL2foPmggRVWJv0Q',
    icon: 'youtube',
  },
  {
    label: 'Facebook',
    url: 'https://www.facebook.com/Crowd4Test',
    icon: 'facebook',
  },
  {
    label: 'Instagram',
    url: 'https://www.instagram.com/crowd4test/',
    icon: 'instagram',
  },
] as const satisfies readonly { label: string; url: string; icon: SocialIconName }[]
