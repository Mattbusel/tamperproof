import { chromium } from "file:///C:/Users/Matthew/lastmile/node_modules/playwright/index.mjs";
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1200, height: 600 } });
await p.goto("file:///C:/Users/Matthew/tamperproof/assets/demo.html"); const h = await p.evaluate(() => document.body.scrollHeight);
await p.setViewportSize({ width: 1200, height: h }); await p.screenshot({ path: "C:/Users/Matthew/tamperproof/assets/demo.png" }); await b.close();
