import { access, readdir } from 'node:fs/promises'
import { join, dirname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { indexableRoutes } from '../src/lib/seo/routes'

/**
 * Post-build assertion: every route in the registry actually produced HTML.
 *
 * The failure this guards against is quiet and expensive — a route added to
 * `routes.ts` with no `page.tsx` behind it still appears in sitemap.xml, so you
 * submit a URL to Google that serves a 404. Nothing in `next build` complains.
 *
 *   npx tsx scripts/verify-build.ts
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_APP = join(ROOT, '.next', 'server', 'app')

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Every file under `.next/server/app`, as a `/`-joined relative path with
 * every `(group)` segment stripped — a route group organises source files
 * but never appears in the URL, yet Next's dynamic (non-prerendered) output
 * keeps the folder in the server tree. Matching on the raw path missed every
 * indexable route that lives in a route group and isn't statically
 * prerendered (e.g. one reading `searchParams`), which is exactly `ƒ` routes.
 */
async function collectBuiltPaths(dir: string, base: string[] = []): Promise<Set<string>> {
  const paths = new Set<string>()
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const nested = await collectBuiltPaths(join(dir, entry.name), [...base, entry.name])
      for (const p of nested) paths.add(p)
    } else {
      const segments = [...base, entry.name].filter((s) => !/^\(.*\)$/.test(s))
      paths.add(posix.join(...segments))
    }
  }
  return paths
}

/**
 * A prerendered route lands as `<path>.html`; a dynamically rendered one only
 * has `<path>/page.js`. Either proves the page exists — this checks for a
 * page, not for a particular rendering strategy.
 */
function wasBuilt(routePath: string, built: Set<string>): boolean {
  const relative = routePath === '/' ? 'index' : routePath.replace(/^\//, '')
  return (
    built.has(`${relative}.html`) ||
    built.has(`${relative}.js`) ||
    built.has(posix.join(relative, 'page.js'))
  )
}

async function main() {
  if (!(await exists(SERVER_APP))) {
    console.error('No build output found. Run `npm run build` first.')
    process.exit(1)
  }

  const built = await collectBuiltPaths(SERVER_APP)
  const routes = indexableRoutes()
  const missing: string[] = []

  for (const route of routes) {
    if (!wasBuilt(route.path, built)) missing.push(route.path)
  }

  if (missing.length > 0) {
    console.error(`\n${missing.length} route(s) in the registry produced no page:\n`)
    for (const path of missing) console.error(`  ${path}`)
    console.error('\nEither add the page or remove the entry from src/lib/seo/routes.ts.')
    console.error('`npm run routes:generate` will scaffold anything missing.\n')
    process.exit(1)
  }

  console.log(`All ${routes.length} registry routes were built.`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
