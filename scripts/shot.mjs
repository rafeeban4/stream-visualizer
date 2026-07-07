// One-off screenshot helper for the README. Not part of the app.
import { chromium } from "playwright";

const url = process.env.SHOT_URL || "http://localhost:5185";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1120, height: 720 }, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: "networkidle" });

// Advance to chapter 3 (consumer groups & rebalancing) — the richest scene.
const next = page.locator(".chapter-nav button", { hasText: "Next" });
await next.click();
await next.click();
await page.waitForTimeout(2000); // let messages populate the lanes
await page.evaluate(() => window.scrollTo(0, 0));

await page.screenshot({ path: "docs/screenshot.png", fullPage: true });
await browser.close();
console.log("saved docs/screenshot.png");
