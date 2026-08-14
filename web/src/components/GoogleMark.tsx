/**
 * The Google "G", for the sign-in button.
 *
 * INLINED, LIKE THE FOOTER SOCIAL MARKS. `lucide-react` carries no brand logos
 * and the design system's rule against hand-rolled SVG exists to stop people
 * drawing their own icons where a Lucide glyph would do — it is not a reason to
 * ship a wrong or missing brand mark. Same reasoning as components/SocialIcons.tsx.
 *
 * ⚠ DO NOT RECOLOUR THIS. Google's branding guidelines for "Sign in with Google"
 * require the four-colour mark reproduced exactly, on a white or dark button of
 * their specified styling. The fills below are Google's own published values,
 * which is the one place in this codebase a raw hex is correct: they are another
 * party's trademark, not a value from our palette, and mapping them onto the ink
 * ramp would be a licensing problem rather than a design improvement.
 */
export function GoogleMark({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      style={{ flex: 'none', display: 'block' }}
    >
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  )
}
