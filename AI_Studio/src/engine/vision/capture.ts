/**
 * The script side of a `looksRight` step.
 *
 * A generated script cannot embed a model call: that would put an API key in a file people download and share. So the
 * rendered step only takes a screenshot (JPEG, viewport or element) and attaches it to the Playwright report together with
 * what the check should look for. The platform reads those attachments after the run and asks its model (see judge.ts).
 * Run anywhere else, the step still saves the screenshot, never fails, and says in the report annotations that no judgement happened.
 */
export const VISION_HELPER_SOURCE = String.raw`async function visionCapture(page, info, index, expected, scope) {
    await page.waitForLoadState("load");
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
    const body = await (scope ? scope.first() : page).screenshot({ type: "jpeg", quality: 70, animations: "disabled", caret: "hide" });
    await info.attach("vision-shot-" + index, { body, contentType: "image/jpeg" });
    await info.attach("vision-ask-" + index, { body: JSON.stringify({ expected }), contentType: "application/json" });
    info.annotations.push({ type: "ai-judgement", description: "Screenshot saved. The AI judgement of it runs only inside the platform; this script does not judge it." });
}
`;
