/**
 * The colours of the report workbook.
 *
 * A spreadsheet cannot read CSS variables, so the values have to be written
 * out once, here, and nowhere else. They are the site's own tokens, copied from
 * `styles/tokens/colors.css` — change a token there and change it here:
 *
 *   ink ramp     --ink-950 … --ink-50
 *   teal accent  --teal-50 … --teal-700
 *   status       --red / --amber / --green / --blue  (50, 500, 600)
 *
 * No pure black and no pure white, as everywhere else: the page floor is
 * ink-50 and the darkest surface ink-950. Six-digit RGB, no `#`, because that
 * is what both Excel's cell styles (with an `FF` alpha prefix) and chart XML
 * take.
 */
export const INK = {
  950: '17130F',
  900: '241E18',
  800: '332B23',
  700: '4A423B',
  600: '625950',
  500: '7A716A',
  400: '9A928B',
  300: 'C9C3BC',
  200: 'E4DFD9',
  100: 'F1EDE8',
  50: 'FAF8F5',
} as const

export const TEAL = {
  50: 'EAF6F3',
  100: 'CFE9E3',
  500: '0B7A6E',
  600: '086055',
  700: '05463E',
} as const
export const RED = { 50: 'FDECEA', 500: 'B3261E', 600: '8F1C16' } as const
export const AMBER = { 50: 'FDF3E3', 500: 'B7791F', 600: '935F16' } as const
export const GREEN = { 50: 'E9F5EE', 500: '1F7A4D', 600: '17603C' } as const
export const BLUE = { 50: 'EAF1FA', 500: '2563A8', 600: '1C4D84' } as const

/** The family every cell and chart uses — installed with Office everywhere, unlike the site's webfonts. */
export const FONT = 'Calibri'

/** A cell-style colour: Excel wants an alpha byte in front. */
export const argb = (hex: string): string => `FF${hex}`

/** Severity, worst first. Fill, text and the solid colour a chart uses for it. */
export const SEVERITY_TONE: Record<string, { fill: string; text: string; solid: string }> = {
  CRITICAL: { fill: RED[50], text: RED[600], solid: RED[500] },
  HIGH: { fill: AMBER[50], text: AMBER[600], solid: AMBER[500] },
  MEDIUM: { fill: BLUE[50], text: BLUE[600], solid: BLUE[500] },
  LOW: { fill: GREEN[50], text: GREEN[600], solid: GREEN[500] },
}

/** Bug status: open work warm, finished work green, closed-without-a-fix neutral. */
export const STATUS_TONE: Record<string, { fill: string; text: string; solid: string }> = {
  NEW: { fill: BLUE[50], text: BLUE[600], solid: BLUE[500] },
  TRIAGED: { fill: BLUE[50], text: BLUE[600], solid: BLUE[500] },
  CONFIRMED: { fill: AMBER[50], text: AMBER[600], solid: AMBER[500] },
  IN_PROGRESS: { fill: AMBER[50], text: AMBER[600], solid: AMBER[500] },
  REOPENED: { fill: RED[50], text: RED[600], solid: RED[500] },
  FIXED: { fill: GREEN[50], text: GREEN[600], solid: GREEN[500] },
  VERIFIED: { fill: GREEN[50], text: GREEN[600], solid: GREEN[500] },
  REJECTED: { fill: INK[100], text: INK[700], solid: INK[400] },
  DUPLICATE: { fill: INK[100], text: INK[700], solid: INK[400] },
  WONT_FIX: { fill: INK[100], text: INK[700], solid: INK[400] },
  FEATURE_REQUEST: { fill: TEAL[50], text: TEAL[600], solid: TEAL[500] },
}

/** Test result tones, shared by the table and its chart. */
export const RESULT_TONE: Record<string, { fill: string; text: string; solid: string }> = {
  PASS: { fill: GREEN[50], text: GREEN[600], solid: GREEN[500] },
  FAIL: { fill: RED[50], text: RED[600], solid: RED[500] },
  BLOCKED: { fill: AMBER[50], text: AMBER[600], solid: AMBER[500] },
  NOT_TESTED: { fill: INK[100], text: INK[700], solid: INK[400] },
}

/** Categorical series with no meaning of their own (types, features, reproducibility). */
export const SERIES: readonly string[] = [
  TEAL[500],
  BLUE[500],
  AMBER[500],
  RED[500],
  GREEN[500],
  INK[500],
  TEAL[700],
  BLUE[600],
  AMBER[600],
  INK[300],
]
