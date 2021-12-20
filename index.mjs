import puppeteer from "puppeteer";
import { readFile } from "fs/promises";
import { applySourceMapsForProfile } from "chrome-profile-sourcemap-resolver";
import colors from "chalk";

const tempName = './profile.json';

(async () => {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  console.log("🚀 start");
  await page.tracing.start({ path: tempName, screenshots: true });

  const url = process.argv[2];
  if (!url) {
    console.log("url argument missing")
    process.exit(0);
  }

  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 120000
  });

  try {
    await page.waitForNetworkIdle({ idleTime: 2000, timeout: 120000 });
  } catch(e) {
    console.warn("Network didn't idle");
  }

  await page.tracing.stop();
  await browser.close();

  const profile = await loadProfileWithSourceMaps(tempName);
  logRecalculates(profile);
})();

async function loadProfileWithSourceMaps(filename) {
  const profile = JSON.parse(await readFile(filename, "utf-8"));
  return await applySourceMapsForProfile(profile);
}

function logRecalculates(profile) {
  const traceEvents = "traceEvents" in profile ? profile.traceEvents : profile;
  const updateLayoutTreeEvents = {};

  traceEvents.forEach((traceEvent) => {
    if (!traceEvent.name === "UpdateLayoutTree") return;
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
      entry.functionName && console.log(`   fn: ${colors.green(entry.functionName)}`);
      console.log(
        `   ${entry.url}:${entry.lineNumber}${
          entry.columnNumber > 120 ? `:${entry.columnNumber}` : ""
        }\n`
      );
    });
}
