import Parser from "devtools-timeline-parser";
import { readFileSync } from "fs";
const trace = JSON.parse(readFileSync("profile.mapped.json", "utf8"));

// Find the hydration start event
const hydrationStartIndex = trace.traceEvents.findIndex((e) =>
  e.args?.data?.cpuProfile?.nodes?.some(
    (node) => node.callFrame && (node.callFrame.functionName || "").endsWith(".hydrate")
  )
);

if (hydrationStartIndex < 0) {
    console.error("Could not find the react hydration");
    process.exit(1);
}

// Find all Recalculate Styles which are not triggered by JS
// as they usually wrap the hydration
const updateLayoutTreeEvents = trace.traceEvents.filter(
  (e) => e.name === "UpdateLayoutTree" && !e.args.beginData.stackTrace
);

// find the frame before and after the hydration
const redrawTimings = updateLayoutTreeEvents.map((x) => ({
  start: x.ts,
  end: x.ts + (x.dur || 0),
}));
const redrawIndexBeforeHydration =
  redrawTimings.findIndex(
    ({ end }) => end > trace.traceEvents[hydrationStartIndex].ts
  ) - 1;
const redrawIndexAfterHydration = redrawIndexBeforeHydration + 1;
const timingBefore = redrawTimings[redrawIndexBeforeHydration].end;
const timingAfter = redrawTimings[redrawIndexAfterHydration].start;

// analyse the hydration
const parser = new Parser(trace);
const topDownRootNode = parser.topDown(
  Math.floor(timingBefore / 1000),
  Math.floor(timingAfter / 1000)
);

const traverseTopDownNode = (node, callback, depth = 0) => {
  if (callback(node, depth) === false) {
    return;
  }
  if (!node.hasChildren() && depth > 0) return;
  const nextDepth = depth + 1;
  for (const child of node.children().values()) {
    traverseTopDownNode(child, callback, nextDepth);
  }
};

function getReactComponents() {
  const reactComponents = {};
  traverseTopDownNode(topDownRootNode, (node, depth) => {
    const callFrame = node.event?.args?.data?.callFrame;
    if (!callFrame) {
      return;
    }
    // Ignore constructors which are no React Components
    if (callFrame.functionName === 'ResizeObserver') {
        return;
    }
    if (
      callFrame.url &&
      !callFrame.url.includes("node_module") &&
      /^[A-Z][a-z]+[A-Za-z][A-Za-z]+$/.test(callFrame.functionName)
    ) {
      reactComponents[callFrame.functionName] = reactComponents[
        callFrame.functionName
      ] || {
        name: callFrame.functionName,
        nodes: [],
        duration: 0,
      };
      const componentEntry = reactComponents[callFrame.functionName];
      componentEntry.nodes.push(node);
      componentEntry.duration += node.totalTime;
      return false;
    }
  });
  const sortedComponents = Object.entries(reactComponents).sort(
    ([, a], [, b]) =>
      a.duration < b.duration ? 1 : a.duration > b.duration ? -1 : 0
  );
  return sortedComponents.map((a) => a[1]);
}

function getNodeModules() {
  const nodeModuleEntries = {};
  traverseTopDownNode(topDownRootNode, (node, depth) => {
    const callFrame = node.event?.args?.data?.callFrame;
    if (!callFrame) {
      return;
    }
    const [, nodeModule] =
      (callFrame.url || "").match(
        /node_modules.(@[^\\\/]+[\\\/][^\\\/]+|[^\\\/]+)/i
      ) || [];

    // Ignore some modules
    if (
      nodeModule === "next" ||
      nodeModule === "react" ||
      nodeModule === "react-dom" ||
      nodeModule === "scheduler" ||
      nodeModule === "@dg/search"
    ) {
      return;
    }

    if (nodeModule) {
      nodeModuleEntries[nodeModule] = nodeModuleEntries[nodeModule] || {
        name: nodeModule,
        nodes: [],
        duration: 0,
      };
      const componentEntry = nodeModuleEntries[nodeModule];
      componentEntry.nodes.push(node);
      componentEntry.duration += node.totalTime;

      return false;
    }
  });
  const sortedNodeModules = Object.entries(nodeModuleEntries).sort(
    ([, a], [, b]) =>
      a.duration < b.duration ? 1 : a.duration > b.duration ? -1 : 0
  );
  return sortedNodeModules.map((a) => a[1]);
}

console.log("React Components");
console.log("----------------");
const componentTimings = getReactComponents();
const componentTimingSum = componentTimings.reduce((a,b) => a + b.duration, 0);
componentTimings.forEach((component) => {
  console.log(
    `${component.duration.toFixed(3)}ms`,
    `(${(component.duration / componentTimingSum * 100).toFixed(0)}%)`,
    component.name
  );
});

console.log("");
console.log("Node Modules");
console.log("------------");
const nodeModuleTimings = getNodeModules();
const nodeModuleDuration = nodeModuleTimings.reduce((a,b) => a + b.duration, 0);
nodeModuleTimings.forEach((component) => {
  console.log(
    `${component.duration.toFixed(3)}ms`,
    `(${(component.duration / nodeModuleDuration * 100).toFixed(0)}%)`,
    component.name
  );
});
