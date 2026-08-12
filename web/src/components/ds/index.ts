/**
 * The Crowd4Test design system, ported from
 * handoff_supplement_crowd4test/ds_components/.
 *
 * Server Components unless a component genuinely needs interactivity. Only
 * TopNav, Tabs, FaqAccordion, the case-study carousel and ContactForm carry
 * "use client".
 *
 * Import from here, not from the individual files, so the surface stays one
 * module and a component can be relocated without touching call sites.
 */

// ─── Core ────────────────────────────────────────────────────────────────────
export { Icon, type IconProps } from './core/Icon'
export { ICON_REGISTRY, isIconName, type IconName } from './core/icon-registry'
export { Button, type ButtonProps } from './core/Button'
export { IconButton, type IconButtonProps } from './core/IconButton'
export { Badge, type BadgeProps } from './core/Badge'
export { Tag, type TagProps } from './core/Tag'
export { Logo, type LogoProps } from './core/Logo'

// ─── Forms ───────────────────────────────────────────────────────────────────
export { Input, controlBase, type InputProps } from './forms/Input'
export { Field, type FieldProps } from './forms/Field'
export { Textarea, type TextareaProps } from './forms/Textarea'
export { Select, type SelectProps, type SelectOption } from './forms/Select'
export { Checkbox, type CheckboxProps } from './forms/Checkbox'

// ─── Navigation ──────────────────────────────────────────────────────────────
export { TopNav, type TopNavProps } from './navigation/TopNav'
export { Footer, type FooterProps } from './navigation/Footer'

// ─── Marketing ───────────────────────────────────────────────────────────────
export { Section, type SectionProps } from './marketing/Section'
export { SectionHeader, type SectionHeaderProps } from './marketing/SectionHeader'
export { Hero, type HeroProps } from './marketing/Hero'
export { FeatureCard, type FeatureCardProps } from './marketing/FeatureCard'
export { StatBlock, type StatBlockProps, type Stat } from './marketing/StatBlock'
export { CtaBanner, type CtaBannerProps } from './marketing/CtaBanner'
export { FaqAccordion, type FaqAccordionProps, type FaqItem } from './marketing/FaqAccordion'
export { Media, type MediaProps } from './marketing/Media'
export { SiteImage, type SiteImageProps } from './marketing/SiteImage'
export { ServiceCard, type ServiceCardProps } from './marketing/ServiceCard'
export { ResourceCard, type ResourceCardProps, type ResourceType } from './marketing/ResourceCard'
export {
  CaseStudyCard,
  type CaseStudyCardProps,
  type CaseStudyResult,
} from './marketing/CaseStudyCard'
export { Testimonial, type TestimonialProps } from './marketing/Testimonial'
export { PricingTable, type PricingTableProps, type PricingPlan } from './marketing/PricingTable'
export { ContactForm, type ContactFormProps } from './marketing/ContactForm'
export {
  CapabilitySection,
  type CapabilitySectionProps,
  type Capability,
} from './marketing/CapabilitySection'
export { LogoWall, type LogoWallProps } from './marketing/LogoWall'
