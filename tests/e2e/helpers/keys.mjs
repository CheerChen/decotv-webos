// tests/e2e/helpers/keys.mjs — remote-control key helpers.

export async function press(page, key) {
  await page.keyboard.press(key);
  await page.waitForTimeout(80); // let the app apply focus/DOM changes
}

// Back = Escape (keyCode 27). FocusEngine debounces Back at 180 ms,
// so consecutive backs must be spaced out or the second one is swallowed.
export async function pressBack(page) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
}

// Press `key` repeatedly until the element matching `selector` gains .focused.
export async function pressUntilFocused(page, key, selector, max = 10) {
  for (let i = 0; i < max; i += 1) {
    if (await page.locator(`${selector}.focused`).count()) return;
    await press(page, key);
  }
  if (!(await page.locator(`${selector}.focused`).count())) {
    throw new Error(`focus never reached ${selector} after ${max} x ${key}`);
  }
}
