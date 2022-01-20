#!/usr/bin/env node
// @ts-check
import puppeteer from "puppeteer";
import { readFile, writeFile, mkdir } from "fs/promises";
import { applySourceMapsForProfile } from "chrome-profile-sourcemap-resolver";
import colors from "chalk";
import { clsStartTracking, clsGetTrackingResult } from "./measurments/cls.mjs";
import { resolve } from "path";

const resultDirectory = `measurments-${new Date()
  .toLocaleString("en-US", { hour12: false })
  .replace(/\D+/g, "-")}`;
const tempName = resolve(resultDirectory, "./profile.json");
const tempMappedName = resolve(resultDirectory, "./profile.mapped.json");
const screenshotDirectory = resolve(resultDirectory, "./screenshots");

(async () => {
  const url = process.argv[2];
  if (!url) {
    console.log("url argument missing");
    process.exit(0);
  }

  await mkdir(screenshotDirectory, { recursive: true });

  console.log("🚀 launch browser");
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  // Browser Emulation
  const chromeDevtoolsProtocolSession = await page.target().createCDPSession();
  await chromeDevtoolsProtocolSession.send("Network.enable");
  await chromeDevtoolsProtocolSession.send("ServiceWorker.enable");
  await chromeDevtoolsProtocolSession.send("Emulation.setCPUThrottlingRate", {
    rate: 4,
  });
  await page.emulate(puppeteer.devices["Nexus 5X"]);

  await clsStartTracking(page);

  await page.tracing.start({ path: tempName, screenshots: false });

  console.log("\n🌎 open " + url);
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });

  console.log(" - wait for network idle");
  try {
    await page.waitForNetworkIdle({ idleTime: 2000, timeout: 120000 });
  } catch (e) {
    console.warn("Network didn't idle");
  }

  // Scroll to bottom to trigger CLS
  console.log(" - scroll to footer");
  await scrollToBottom(page);
  try {
    await page.waitForTimeout(3000);
    await page.waitForNetworkIdle({ idleTime: 2000, timeout: 2000 });
  } catch (e) {
    console.warn("Network didn't idle");
  }

  console.log("\n📐 gather metrics");
  await page.tracing.stop();

  const clsResult = await clsGetTrackingResult(page, screenshotDirectory);

  await browser.close();

  const profile = await loadProfileWithSourceMaps(tempName);
  await writeFile(tempMappedName, JSON.stringify(profile, null, 2));

  console.log("\n\nStyle Recalculates / Layout Reflows");

  logRecalculates(profile);

  console.log("\n\nLayout Shifts");

  logLayoutShifts(clsResult);
})();

async function loadProfileWithSourceMaps(filename) {
  const profile = JSON.parse(await readFile(filename, "utf-8"));
  return await applySourceMapsForProfile(profile);
}

function logRecalculates(profile) {
  const traceEvents = "traceEvents" in profile ? profile.traceEvents : profile;
  const updateLayoutTreeEvents = {};

  traceEvents.forEach((traceEvent) => {
    if (traceEvent.name !== "UpdateLayoutTree") return;
    const stackTrace = traceEvent.args.beginData?.stackTrace?.[0];
    if (!stackTrace) return;

    const codeLocation = `${stackTrace.url}:${stackTrace.lineNumber}:${stackTrace.columnNumber}`;

    const tracesForCodeLocation = updateLayoutTreeEvents[codeLocation] || {
      url: stackTrace.url,
      functionName: stackTrace.functionName,
      lineNumber: stackTrace.lineNumber,
      columnNumber: stackTrace.columnNumber,
      duration: 0,
      count: 0,
    };
    updateLayoutTreeEvents[codeLocation] = tracesForCodeLocation;
    tracesForCodeLocation.duration += traceEvent.dur;
    tracesForCodeLocation.count++;
  });

  Object.values(updateLayoutTreeEvents)
    .sort((a, b) => b.duration - a.duration)
    .forEach((entry) => {
      console.log(
        `🕚 Recalculate Layout ${colors.yellow(
          `${entry.count} time` + (entry.count !== 1 ? "s" : "")
        )}` +
          ` took ${colors.yellow(`${(entry.duration / 1000).toFixed(2)} ms`)}`
      );
      entry.functionName &&
        console.log(`   fn: ${colors.green(entry.functionName)}`);
      console.log(
        `   ${entry.url}:${entry.lineNumber}${
          entry.columnNumber > 120 ? `:${entry.columnNumber}` : ""
        }\n`
      );
    });
}

function logLayoutShifts(layoutShifts) {
  if (layoutShifts.length === 0) {
    console.log("No layout shifts detected");
    return;
  }
  layoutShifts.forEach(({ value, diffs }) => {
    console.log(`💥 CLS by ${(value * 100).toFixed(2)}%`);
    diffs.forEach((diff) => {
      console.log(" " + diff.nodeName);
      console.log(" $x(`" + diff.xPath + "`)");
      if (diff.y) {
        console.log(
          ` ${diff.y < 0 ? "⬆️" : "⬇️"} moved ${
            diff.y > 0 ? "down" : "top"
          } by ${Math.abs(diff.y)}px`
        );
      } else if (diff.x) {
        console.log(
          ` ${diff.x < 0 ? "⬅️" : "➡️"} moved ${
            diff.x > 0 ? "right" : "left"
          } by ${Math.abs(diff.x)}px`
        );
      }
    });
    console.log("");
  });
}

async function scrollToBottom(page) {
  await page.evaluate(
    async () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          window.scrollBy(0, 10000);
        });
        requestAnimationFrame(resolve);
      })
  );
}
