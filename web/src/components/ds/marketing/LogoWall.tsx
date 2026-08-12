import Image from 'next/image'
import type { Client } from '@/content/clients'
import styles from './LogoWall.module.css'

export interface LogoWallProps {
  clients: readonly Client[]
  /**
   * Link each entry to the company's site. Off by default: a logo wall of
   * outbound links sends a reader who is evaluating you away from the page,
   * and it can read as an endorsement running in the other direction.
   */
  linked?: boolean
  className?: string
}

/**
 * The "trusted by" client wall for the homepage — content.md §4.2.
 *
 * ⚠ EVERY ENTRY NEEDS WRITTEN PERMISSION. See the header of content/clients.ts.
 * `npm run launch-check` blocks a production deploy until each client records
 * `permission: true`.
 *
 * RENDERS A WORDMARK WHEN THERE IS NO LOGO FILE. Each client may carry a
 * self-hosted `logo` under `public/clients/`; where none exists the company
 * name is set in the display face instead. That is a deliberate design, not a
 * placeholder state — a row of wordmarks is a legitimate treatment, and it
 * means the section ships and looks finished before ten brand kits have been
 * collected. Dropping a file in and setting `logo` upgrades one entry without
 * touching this component.
 *
 * NOT <SiteImage>. CLAUDE.md rule 6 routes photography through that wrapper so
 * a rotted Unsplash URL is one edit, and it paints a `--surface-sunken` floor
 * behind every image for slow loads. Both are wrong here: these are
 * transparent self-hosted logos on a dark band, where that floor would draw a
 * light card behind each mark, and they need `object-fit: contain` with a
 * height cap rather than the wrapper's `cover`. This uses `next/image`
 * directly with explicit dimensions, which is what rule 6 is actually
 * protecting — no unsized images, no layout shift.
 */
export function LogoWall({ clients, linked = false, className }: LogoWallProps) {
  return (
    <ul
      className={[styles.wall, className].filter(Boolean).join(' ')}
      // A plain list: this is an enumeration of companies, and a screen reader
      // announcing "list, 10 items" is the correct summary of it.
      style={{ listStyle: 'none', margin: 0, padding: 0 }}
    >
      {clients.map((client) => {
        const body =
          client.logo && client.logoWidth && client.logoHeight ? (
            <Image
              src={client.logo}
              // The company name IS the information the logo carries, so it is
              // the alt text. Never "Airmeet logo" — the word "logo" describes
              // the file, not what the reader needs to know.
              alt={client.name}
              width={client.logoWidth}
              height={client.logoHeight}
              className={styles.logo}
            />
          ) : (
            <span className={styles.wordmark}>{client.name}</span>
          )

        return (
          <li key={client.slug} style={{ display: 'flex' }}>
            {linked ? (
              <a
                href={client.website}
                className={styles.item}
                target="_blank"
                // `noopener` closes the reverse-tabnabbing hole on target=_blank;
                // `noreferrer` keeps this site's URL out of their analytics.
                rel="noopener noreferrer"
              >
                {body}
              </a>
            ) : (
              <span className={styles.item}>{body}</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}
