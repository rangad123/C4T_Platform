import puppeteer, { type Browser } from 'puppeteer'
import { logger } from '../logger.js'

/**
 * HTML-to-PDF rendering, single-flight — the production box has ~86MB RAM
 * free out of 1.9GB, and a headless Chromium instance typically needs
 * 200-500MB. This is the ONE thing standing between that and an OOM: no
 * matter how many payslip/report requests arrive together, at most one
 * Chromium process runs at a time. Everything else about the risk (accepted
 * despite it) is recorded in the project plan, not repeated here.
 *
 * Deliberately no warm/persistent browser instance — launch, render, close,
 * every single call. A long-lived browser would save the ~1-2s launch cost,
 * but it would also hold its (largest) chunk of memory permanently instead
 * of only for the few seconds a generation actually takes, and any leak
 * inside a kept-alive Chromium accumulates for the life of the process
 * instead of being closed away on every call.
 */

let queue: Promise<unknown> = Promise.resolve()

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  // Swallow so one caller's rejection doesn't poison the chain for the next
  // caller waiting behind it — each `run` still rejects with its own error.
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * `--single-process`/`--no-zygote` were tried first for the extra memory
 * saving, but they made `page.pdf()` crash the render target outright
 * (`Protocol error (Page.printToPDF): Target closed`) — confirmed by
 * reproducing it locally, not assumed. A render that reliably fails is a
 * worse outcome than the RAM it would have saved, so this stays with the
 * flags that are merely disabling sandboxing/GPU/shm, not the process model
 * itself.
 */
async function launchBrowser(): Promise<Browser> {
  return puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  })
}

async function render(html: string): Promise<Buffer> {
  const start = Date.now()
  let browser: Browser | null = null
  try {
    browser = await launchBrowser()
    const page = await browser.newPage()
    // 'load' is enough here — every payslip/report template is self-contained
    // inline HTML/CSS with no external network resources to wait on.
    await page.setContent(html, { waitUntil: 'load' })
    const pdf = await page.pdf({
      format: 'a4',
      printBackground: true,
      margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
    })
    return Buffer.from(pdf)
  } finally {
    if (browser) {
      await browser.close().catch((error: unknown) => {
        logger.warn({ err: error }, 'Failed to close Chromium after PDF render')
      })
    }
    logger.info({ ms: Date.now() - start }, 'HRMS PDF render completed')
  }
}

/** The only export — every caller queues through here, never calls `render` directly. */
export function renderHtmlToPdf(html: string): Promise<Buffer> {
  return enqueue(() => render(html))
}
