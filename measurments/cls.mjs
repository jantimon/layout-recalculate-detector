// @ts-check

/**
 * Inject javascript to track Cumulative Layout Shifts
 *
 * @param {import("puppeteer").Page} page
 */
export const clsStartTracking = async (page) => {
  await page.evaluateOnNewDocument(() => {
    function getXPathForElement(element) {
      const idx = (sib, name) =>
        sib
          ? idx(sib.previousElementSibling, name || sib.localName) +
            (sib.localName == name)
          : 1;
      const segs = (elm) =>
        !elm || elm.nodeType !== 1
          ? [""]
          : elm.id && document.getElementById(elm.id) === elm
          ? [`id("${elm.id}")`]
          : [
              ...segs(elm.parentNode),
              `${elm.localName.toLowerCase()}[${idx(elm)}]`,
            ];
      return segs(element).join("/");
    }

    /** @param {HTMLElement} element */
    const getNodeName = (element) => {
      return `${element.tagName}${
        element.className ? `.${element.className.replace(/ /g, ".")}` : ""
      }`;
    };

    const layoutShifts = [];
    const layoutShiftNodes = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) {
          const entryNodes = [];
          layoutShiftNodes.push(entryNodes);
          /** @type {{node: HTMLElement, previousRect:{x:number,y:number;width:number;height:number}, currentRect:{x:number,y:number;width:number;height:number}}[]} */
          const sources = entry.sources || [];
          const diffs = sources.map(({ currentRect, previousRect, node }) => {
            entryNodes.push(node);
            const nodeName = (node.parentElement ? getNodeName(node.parentElement) + ' > ' + getNodeName(node) : getNodeName(node));
            return {
              nodeName,
              xPath: getXPathForElement(node),
              x: currentRect.x - previousRect.x,
              y: currentRect.y - previousRect.y,
              height: currentRect.height - previousRect.height,
              width: currentRect.width - previousRect.width,
            };
          });
          layoutShifts.push({ value: entry.value, diffs });
        }
      }
    });

    observer.observe({ type: "layout-shift", buffered: true });

    const stopTracking = () => {
      observer.takeRecords();
      observer.disconnect();
    };

    window.__puppeteerClsTracking = {
      layoutShifts,
      layoutShiftNodes,
      stopTracking,
    };
  });
};

/**
 * Gather all information created by clsStartTracking()
 *
 * @param {import("puppeteer").Page} page
 * @param {string} screenshotDirectory
 */
export const clsGetTrackingResult = async (page, screenshotDirectory) => {
  const pageLayoutShifts = await page.evaluate(() => {
    const { layoutShifts, layoutShiftNodes, stopTracking } =
      window.__puppeteerClsTracking;

    // Cleanup
    stopTracking();

    // Attach node ids for screenshots
    layoutShiftNodes.forEach(
      /** @param {HTMLElement[]} nodes */ (nodes, layoutShiftIndex) => {
        nodes.forEach((node, nodeIndex) => {
          node.setAttribute(
            "puppeteer-cls-id",
            JSON.stringify([layoutShiftIndex, nodeIndex])
          );
        });
      }
    );

    // Return results from clsStartTracking()
    return layoutShifts;
  });

  // Create Screenshot for all nodes which are still in DOM
  const layoutShiftElementHandle = await page.$$("[puppeteer-cls-id]");
  await Promise.all(
    layoutShiftElementHandle.map(async (puppeteerElement, i) => {
      const [layoutShiftIndex, nodeIndex] = await puppeteerElement.evaluate(
        async (node) => JSON.parse(node.getAttribute("puppeteer-cls-id"))
      );
      await puppeteerElement.screenshot({
        path: `${screenshotDirectory}/cls-${layoutShiftIndex}-${nodeIndex}.png`,
      });
    })
  );

  return pageLayoutShifts;
};
