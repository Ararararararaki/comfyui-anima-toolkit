import assert from "node:assert/strict";
import { installDOMWidgetSizeSync } from "../web/js/anima_dom_widget_size_sync.js";

globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
globalThis.cancelAnimationFrame = () => {};

class FakeStyle {
  constructor() { this.values = new Map(); }
  setProperty(name, value) { this.values.set(name, String(value)); }
  getPropertyValue(name) { return this.values.get(name) || ""; }
  removeProperty(name) { this.values.delete(name); }
}

function makeElement() {
  return {
    style: new FakeStyle(),
    parentElement: null,
    closest: () => null,
  };
}

function makeNode() {
  return { size: [420, 500], setSize(next) { this.size = next; }, graph: { setDirtyCanvas() {} } };
}

const modernElement = makeElement();
const modernWidget = {
  computeSize: () => [420, 999],
  computeLayoutSize: () => ({ minHeight: 50 }),
  element: modernElement,
};
const originalModernComputeSize = modernWidget.computeSize;
const modernSync = installDOMWidgetSizeSync({
  node: makeNode(),
  domWidget: modernWidget,
  element: modernElement,
  minHeight: 180,
  maxHeight: 1600,
});
assert.equal(modernWidget.computeSize, originalModernComputeSize, "现代前端不应覆盖 computeSize");
assert.equal(modernElement.style.getPropertyValue("--comfy-widget-min-height"), "180px");
assert.equal(modernElement.style.getPropertyValue("--comfy-widget-max-height"), "1600px");
modernSync.dispose();
assert.equal(modernElement.style.getPropertyValue("--comfy-widget-min-height"), "");
assert.equal(modernElement.style.getPropertyValue("--comfy-widget-max-height"), "");

const legacyElement = makeElement();
const legacyWidget = { computeSize: () => [420, 999], element: legacyElement };
const originalLegacyComputeSize = legacyWidget.computeSize;
const legacySync = installDOMWidgetSizeSync({
  node: makeNode(),
  domWidget: legacyWidget,
  element: legacyElement,
  minHeight: 180,
});
assert.notEqual(legacyWidget.computeSize, originalLegacyComputeSize, "旧版前端仍需 computeSize 兜底");
assert.deepEqual(legacyWidget.computeSize(420), [420, 180]);
legacySync.dispose();
assert.equal(legacyWidget.computeSize, originalLegacyComputeSize);

console.log("PASS: modern and legacy DOM widget sizing modes");
