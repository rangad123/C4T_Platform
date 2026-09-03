/**
 * Recovers demo requests that were logged instead of stored.
 *
 * ── Why there are any
 *
 * `POST /v1/leads` answered 401 to every submission from the marketing form
 * between the day a root-mounted router was placed above it and 2026-09-02,
 * when that was fixed. The web app's own fallback caught it — see the
 * "THE LEAD IS NOT LOST WHEN THE API IS DOWN" note in
 * `web/src/app/(marketing)/contact/actions.ts` — showed the visitor a
 * confirmation, and wrote the enquiry to the server log in a form meant to be
 * replayed by hand. This is that replay.
 *
 * ── How to run it
 *
 *     cd /var/www/c4t/api
 *     npx tsx scripts/recover-logged-leads.ts /var/log/c4t-web/error.log
 *
 * That is a DRY RUN: it prints what it found and what it would write, and
 * touches nothing. Add `--write` once the list looks right.
 *
 * Rotated logs work too — pass several paths, or a glob your shell expands.
 *
 * ── What it writes
 *
 * Straight to the database rather than back through the API, for two reasons.
 * The original `receivedAt` is preserved as `createdAt`, so a lead from three
 * weeks ago is dated three weeks ago and the pipeline is not distorted; and
 * replaying through the endpoint would fire a "New demo request" notification
 * to every admin for every recovered lead at once.
 *
 * `sourcePath` is marked `/contact (recovered)` so these rows are honestly
 * distinguishable from ones that arrived normally.
 *
 * Re-running is safe: a lead is skipped when one with the same email and the
 * same createdAt already exists.
 */
import { readFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma.js'

const MARKER = 'capture by hand from this line'

interface LoggedLead {
  firstName: string
  lastName: string
  email: string
  company: string
  teamSize: string | null
  marketingConsent: boolean
  receivedAt: string
}

/**
 * Pulls the fields out of one `console.error` block.
 *
 * Node prints the object with `util.inspect`, not as JSON — unquoted keys, no
 * trailing comma, and `undefined` written out literally — so this reads it
 * with a per-field pattern rather than a parser. Only the fields needed to
 * recreate the row are read; `hasMessage` and `cause` are diagnostic, and the
 * message body was deliberately never logged.
 */
function parseBlock(block: string): LoggedLead | null {
  const str = (key: string): string | null => {
    // `util.inspect` quotes with ' normally and switches to " when the value
    // contains an apostrophe — O'Brien is printed as "O'Brien". Matching only
    // one style dropped exactly the surnames most likely to have one, and
    // dropped them silently: the field fell back to empty and the recovered
    // lead would have had no last name.
    const single = new RegExp(`\\b${key}:\\s*'((?:[^'\\\\]|\\\\.)*)'`).exec(block)
    const double = new RegExp(`\\b${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(block)
    const raw = single?.[1] ?? double?.[1]
    if (raw === undefined) return null
    return raw.replace(/\\(['"\\])/g, '$1')
  }
  const email = str('email')
  const firstName = str('firstName')
  const receivedAt = str('receivedAt')
  if (!email || !firstName || !receivedAt) return null

  return {
    firstName,
    lastName: str('lastName') ?? '',
    email: email.toLowerCase(),
    company: str('company') ?? '',
    teamSize: str('teamSize'),
    marketingConsent: /\bmarketingConsent:\s*true\b/.test(block),
    receivedAt,
  }
}

/** Every logged block in a file, from the marker to the closing brace. */
function extract(text: string): LoggedLead[] {
  const out: LoggedLead[] = []
  let index = text.indexOf(MARKER)
  while (index !== -1) {
    const open = text.indexOf('{', index)
    const close = text.indexOf('\n}', open)
    if (open !== -1 && close !== -1) {
      const parsed = parseBlock(text.slice(open, close + 2))
      if (parsed) out.push(parsed)
    }
    index = text.indexOf(MARKER, index + MARKER.length)
  }
  return out
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const files = args.filter((a) => !a.startsWith('--'))

  if (files.length === 0) {
    console.error('Usage: npx tsx scripts/recover-logged-leads.ts <logfile...> [--write]')
    process.exit(1)
  }

  const found: LoggedLead[] = []
  for (const file of files) {
    try {
      found.push(...extract(readFileSync(file, 'utf8')))
    } catch (error) {
      console.error(`Could not read ${file}: ${(error as Error).message}`)
    }
  }

  // The same enquiry can appear twice if the log was rotated mid-write.
  const unique = new Map(found.map((lead) => [`${lead.email}|${lead.receivedAt}`, lead]))
  console.log(`Found ${found.length} logged enquiries, ${unique.size} distinct.\n`)

  let written = 0
  let skipped = 0
  for (const lead of unique.values()) {
    const createdAt = new Date(lead.receivedAt)
    const already = await prisma.lead.findFirst({
      where: { email: lead.email, createdAt },
      select: { id: true },
    })
    if (already) {
      skipped += 1
      continue
    }

    console.log(
      `${write ? 'writing' : '  would write'}  ${lead.receivedAt.slice(0, 10)}  ` +
        `${lead.email.padEnd(34)} ${lead.firstName} ${lead.lastName} at ${lead.company}`,
    )

    if (write) {
      await prisma.lead.create({
        data: {
          firstName: lead.firstName,
          lastName: lead.lastName,
          email: lead.email,
          company: lead.company,
          teamSize: lead.teamSize,
          marketingConsent: lead.marketingConsent,
          sourcePath: '/contact (recovered)',
          createdAt,
        },
      })
      written += 1
    }
  }

  console.log(
    `\n${write ? `Wrote ${written}.` : 'Dry run — nothing written. Add --write to store these.'}` +
      (skipped > 0 ? ` Skipped ${skipped} already present.` : ''),
  )
  process.exit(0)
}

void main()
