import { SiteImage } from '@/components/ds/marketing/SiteImage'
import type { BlogGalleryImage } from '@/lib/blog/types'

/**
 * A post's gallery, in the order the author arranged it.
 *
 * ── Captions are rendered as text, never as HTML
 *
 * `BlogPostImage.caption` does not pass through `sanitizeContent` and never
 * should — it is a plain string, not a document. Rendering it as a React child
 * escapes it. Copying the article body's `dangerouslySetInnerHTML` here would
 * turn an author-supplied field into stored XSS on the marketing site.
 *
 * ── Why the caption is not `SiteImage`'s `caption` prop
 *
 * That prop renders an uppercase chip over the bottom-left corner of the photo
 * — it is the "PLACEHOLDER · UNSPLASH LICENCE" badge. An author's sentence
 * would be uppercased, overlaid and clipped. This uses the same treatment the
 * article body gives a `<figcaption>`, so a caption reads identically whether
 * the image is in the gallery or in the text.
 */
export function PostGallery({
  images,
  title,
  lead,
}: {
  images: BlogGalleryImage[]
  title: string
  /** True when the gallery is the top of the page, so its first image preloads. */
  lead?: boolean
}) {
  if (images.length === 0) return null

  return (
    <ul className="c4t-post-gallery">
      {images.map((image, index) => (
        <li key={`${image.position}-${image.url}`}>
          <SiteImage
            src={image.url}
            // The caption describes the picture to someone who can see it; the
            // alt describes it to someone who cannot. Where an author wrote a
            // caption it is the better of the two, and the post title is a
            // last resort rather than a good answer.
            alt={image.caption ?? title}
            fill
            ratio="4 / 3"
            priority={lead === true && index === 0}
            sizes="(max-width: 700px) 100vw, (max-width: 1100px) 50vw, 380px"
          />
          {image.caption ? <p>{image.caption}</p> : null}
        </li>
      ))}
    </ul>
  )
}
