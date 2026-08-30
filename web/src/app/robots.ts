import type { MetadataRoute } from 'next'
import { env, isProduction } from '@/lib/env'

export default function robots(): MetadataRoute.Robots {
  // Staging and preview deployments must never be crawled. Shipping a preview
  // that Google indexes creates duplicate content against the real site.
  if (!isProduction) {
    return { rules: [{ userAgent: '*', disallow: '/' }] }
  }

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/app/',
          '/api/',
          '/login',
          '/register',
          '/reset-password',
          '/verify-email',
          // A JSON endpoint (the blog's debounced search), not a content page.
          '/company/blog/search',
        ],
      },
    ],
    sitemap: new URL('/sitemap.xml', env.NEXT_PUBLIC_SITE_URL).toString(),
    host: env.NEXT_PUBLIC_SITE_URL,
  }
}
