/**
 * The frame every Crowd4Test email is rendered into.
 *
 * ── WHY THIS LOOKS NOTHING LIKE THE WEB CODE
 *
 * The web app forbids raw colour and spacing values and reads everything from
 * CSS custom properties. Email has no custom properties: Outlook's Word
 * renderer, Gmail's clipper and a dozen others resolve `var()` to nothing and
 * paint the fallback — which is usually "transparent" and "0". So the values
 * are literal here, and the ONE place they are written down is `PALETTE`
 * below. Nothing outside this file spells a colour.
 *
 * Same reason for the table scaffolding and the inline `style` attributes:
 * `<div>` + a `<style>` block is stripped or ignored by enough clients that
 * the layout would collapse for a meaningful share of recipients.
 *
 * The palette is the ink ramp and teal accent from the design system, so an
 * email and the page it links to look like the same product. Per the
 * no-pure-black/white rule, the darkest value is ink-950 and the lightest is
 * ink-50 — there is no #000 or #fff in here.
 */

const PALETTE = {
  /** Page ground behind the card. */
  page: '#f1ede8',
  /** The card itself. */
  surface: '#faf8f5',
  /** Hairlines. */
  border: '#e4dfd9',
  /** Headings. */
  ink: '#17130f',
  /** Body copy. */
  body: '#4a423b',
  /** Footer and other quiet text. */
  muted: '#7a716a',
  /** Accent — buttons, links. */
  accent: '#0b7a6e',
  /** Text on the accent. */
  onAccent: '#faf8f5',
} as const

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Instrument Sans', Roboto, Helvetica, Arial, sans-serif"

export interface EmailBlock {
  /** The one-line headline inside the card. */
  heading: string
  /** Paragraphs of body copy, in order. Plain text — escaped for you. */
  paragraphs: string[]
  /** The single action. Emails with two competing buttons get neither pressed. */
  action?: { label: string; url: string }
  /**
   * A quoted passage — a message body, an inviter's note, an announcement.
   * Rendered as an indented block so it reads as someone else's words.
   */
  quote?: string
  /** Small print under the action: link expiry, "ignore this if…". */
  note?: string
}

export interface RenderedEmail {
  html: string
  text: string
}

/** HTML-escape. Every interpolated value in this module goes through it. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * A URL safe to put in `href`. Anything that is not http(s) becomes '#' —
 * `javascript:` and `data:` URLs are live in a few webmail clients, and every
 * URL this module renders is built from `WEB_PUBLIC_URL` plus a path that has
 * passed validation, so a non-http value here means something is wrong
 * upstream rather than something to render.
 */
function safeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? esc(url) : '#'
}

/**
 * Render one email.
 *
 * Returns both parts on purpose. A text/plain alternative is not decoration:
 * it is what plain-text clients show, what screen readers in some setups
 * prefer, and one of the signals spam filters weigh — an HTML-only message
 * scores worse than the same message sent as `multipart/alternative`.
 */
export function renderEmail(
  block: EmailBlock,
  footer: { unsubscribeUrl?: string; reason?: string },
): RenderedEmail {
  const paragraphs = block.paragraphs
    .map(
      (text) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${PALETTE.body};">${esc(text)}</p>`,
    )
    .join('')

  const quote = block.quote
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
         <tr>
           <td style="padding:14px 18px;background:${PALETTE.page};border-left:3px solid ${PALETTE.accent};border-radius:6px;font-size:15px;line-height:1.6;color:${PALETTE.body};white-space:pre-wrap;">${esc(block.quote)}</td>
         </tr>
       </table>`
    : ''

  /* A table-wrapped anchor, not a bare one. Outlook ignores padding on inline
     elements, so a plain <a> button renders as a text link with no box. */
  const action = block.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px;">
         <tr>
           <td style="border-radius:6px;background:${PALETTE.accent};">
             <a href="${safeUrl(block.action.url)}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;font-weight:600;color:${PALETTE.onAccent};text-decoration:none;border-radius:6px;">${esc(block.action.label)}</a>
           </td>
         </tr>
       </table>
       <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:${PALETTE.muted};">
         If the button does not work, paste this into your browser:<br>
         <a href="${safeUrl(block.action.url)}" style="color:${PALETTE.accent};word-break:break-all;">${esc(block.action.url)}</a>
       </p>`
    : ''

  const note = block.note
    ? `<p style="margin:0;font-size:13px;line-height:1.6;color:${PALETTE.muted};">${esc(block.note)}</p>`
    : ''

  const reason = footer.reason
    ? `<p style="margin:0 0 6px;font-size:12px;line-height:1.5;color:${PALETTE.muted};">${esc(footer.reason)}</p>`
    : ''

  const unsubscribe = footer.unsubscribeUrl
    ? `<p style="margin:0;font-size:12px;line-height:1.5;color:${PALETTE.muted};">
         <a href="${safeUrl(footer.unsubscribeUrl)}" style="color:${PALETTE.muted};text-decoration:underline;">Turn off emails like this</a>
       </p>`
    : ''

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(block.heading)}</title>
</head>
<body style="margin:0;padding:0;background:${PALETTE.page};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PALETTE.page};padding:32px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;font-family:${FONT};">
        <tr>
          <td style="padding:0 0 16px;font-size:15px;font-weight:600;letter-spacing:-0.01em;color:${PALETTE.ink};">
            Crowd<span style="color:${PALETTE.accent};">4</span>Test
          </td>
        </tr>
        <tr>
          <td style="padding:28px;background:${PALETTE.surface};border:1px solid ${PALETTE.border};border-radius:10px;">
            <h1 style="margin:0 0 14px;font-size:20px;line-height:1.35;font-weight:600;color:${PALETTE.ink};">${esc(block.heading)}</h1>
            ${paragraphs}
            ${quote}
            ${action}
            ${note}
          </td>
        </tr>
        <tr>
          <td style="padding:16px 4px 0;">
            ${reason}
            ${unsubscribe}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`

  const textParts = [
    block.heading,
    '',
    ...block.paragraphs,
    ...(block.quote ? ['', block.quote.replace(/^/gm, '> ')] : []),
    ...(block.action ? ['', `${block.action.label}:`, block.action.url] : []),
    ...(block.note ? ['', block.note] : []),
    ...(footer.reason ? ['', '—', footer.reason] : []),
    ...(footer.unsubscribeUrl ? [`Turn off emails like this: ${footer.unsubscribeUrl}`] : []),
  ]

  return { html, text: textParts.join('\n') }
}
