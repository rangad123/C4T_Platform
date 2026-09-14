import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { LegalText } from '@/components/legal/LegalText'
import { Scaffold } from '@/components/scaffold'
import { PRIVACY_POLICY, TERMS_AND_CONDITIONS, type LegalDocument } from '@/content'
import { fromRoute } from '@/lib/seo/metadata'
import { getRoute, slugsUnder } from '@/lib/seo/routes'

const PREFIX = '/legal'

/**
 * The two documents the client has supplied. The other three legal routes
 * (cookies, dpa, accessibility-statement) are registered and still render the
 * scaffold — they get their text the same way these did, by being written into
 * `content/legal.ts` and listed here.
 */
const DOCUMENTS: Record<string, LegalDocument> = {
  terms: TERMS_AND_CONDITIONS,
  privacy: PRIVACY_POLICY,
}

/**
 * Fully prerendered at build time from the route registry. `dynamicParams`
 * is false so an unregistered slug 404s rather than rendering an empty shell —
 * a stray URL should not become a soft-404 that Google indexes.
 */
export const dynamicParams = false

export function generateStaticParams() {
  return slugsUnder(PREFIX).map((slug) => ({ slug }))
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const route = getRoute(`${PREFIX}/${slug}`)
  if (!route) return {}
  return fromRoute(route)
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const path = `${PREFIX}/${slug}`
  if (!getRoute(path)) notFound()

  const document = DOCUMENTS[slug]
  return document ? <LegalText document={document} /> : <Scaffold path={path} />
}
