import type { NextConfig } from 'next'
import { legacyRedirects } from './src/lib/seo/redirects'

const nextConfig: NextConfig = {
  reactStrictMode: true,

  /**
   * Cache Components (Partial Prerendering) is deliberately NOT enabled.
   *
   * It is the direction Next.js is heading and will eventually be the default,
   * but turning it on makes every uncached data read inside an otherwise
   * prerenderable route a build error until it is explicitly cached or marked
   * dynamic. For a marketing site that is fully static and a dashboard that is
   * fully dynamic, it buys little today and costs a learning curve.
   *
   * Revisit when the dashboard needs a static shell with data streaming behind
   * Suspense. Enable with:  cacheComponents: true
   */
  // cacheComponents: true,

  images: {
    /**
     * Next 16 changed four next/image defaults that bite silently:
     *   - `qualities` defaults to [75] ONLY; other values are coerced
     *   - `minimumCacheTTL` went from 60s to 4 hours
     *   - 16 was removed from `imageSizes`
     *   - `images.domains` is deprecated in favour of `remotePatterns`
     */
    qualities: [75, 90],
    remotePatterns: [
      // Placeholder imagery during design. Agreement §5 makes sourcing real
      // media the Client's responsibility — remove this before launch.
      { protocol: 'https', hostname: 'images.unsplash.com' },
      { protocol: 'https', hostname: 'cdn.crowd4test.com' },
    ],
  },

  /**
   * Cross-origin API access.
   *
   * The browser calls the API directly at `NEXT_PUBLIC_API_BASE/v1/*`. The
   * API allows CORS from this origin and the cookies are `SameSite=None;
   * Secure` so they survive the cross-origin boundary.
   *
   * No Next.js rewrite proxy is registered. A proxy only makes sense when
   * the API and the web are on the same domain, which is not the case in
   * the Vercel + Render deploy. The dev-local setup uses `API_BASE` of
   * `/api/v1` together with a local Express proxy to keep the same code
   * paths.
   *
   * If you ever move the API back to the same domain, change the rewrite
   * block in this file to the one in git history dated before this comment.
   */
  // No `rewrites` for /api/v1/* — intentionally absent.

  async redirects() {
    return legacyRedirects()
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
          },
        ],
      },
    ]
  },

  /**
   * Type errors fail the build. Next 16 dropped the built-in `eslint` config
   * key along with `next lint`, so linting is a separate step — `npm run check`
   * locally and the CI job.
   */
  typescript: { ignoreBuildErrors: false },

  poweredByHeader: false,
}

export default nextConfig
