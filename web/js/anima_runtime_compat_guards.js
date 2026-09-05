// Small compatibility guards for third-party frontend extensions.
//
// EasyUse's legacy ``easy imageInsetCrop`` hook assumes every crop widget has
// an ``options`` object and reads ``options.step2`` directly.  Older saved
// workflows (or a node created before its backend definition is available)
// can violate that assumption.  Keep the guard narrow: do not patch global
// widgets, only normalize this one legacy node before its callbacks run.
(function () {
  "use strict";

  const NODE_NAME = "easy imageInsetCrop";
  const MARK = "__tkAnimaOptionsGuard";
  const MAX_RETRIES = 120;

  function isEasyUseStep2Error(error, filename = "") {
    const message = String(error?.message || error || "");
    const stack = String(error?.stack || "");
    return /step2/.test(message) && /ComfyUI-Easy-Use/i.test(`${filename}\n${stack}`);
  }

  function installErrorShield() {
    // A malformed legacy crop widget can throw before its onAdded hook is
    // reachable.  This callback only changes a non-functional EasyUse UI
    // setting, so suppress that one known browser error while leaving every
    // other window error visible.
    window.addEventListener("error", (event) => {
      if (!isEasyUseStep2Error(event.error || event.message, event.filename)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    window.addEventListener("unhandledrejection", (event) => {
      if (!isEasyUseStep2Error(event.reason)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }

  function ensureOptions(widget) {
    if (!widget || typeof widget !== "object") return;
    const descriptor = Object.getOwnPropertyDescriptor(widget, "options");
    if (descriptor?.get?.[MARK]) return;
    let value = widget.options;
    if (!value || typeof value !== "object") value = {};

    // Keep the property non-null even if an old extension later assigns
    // ``widget.options = undefined``.  EasyUse reads ``options.step2``
    // without checking the container first.
    try {
      const getter = function () {
        if (!value || typeof value !== "object") value = {};
        return value;
      };
      const setter = function (next) {
        value = next && typeof next === "object" ? next : {};
      };
      getter[MARK] = true;
      Object.defineProperty(widget, "options", {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get: getter,
        set: setter,
      });
    } catch (_error) {
      widget.options = value;
    }
  }

  function normalizeNode(node) {
    if (!node || node.type !== NODE_NAME || !Array.isArray(node.widgets)) return;
    node.widgets.forEach((widget) => {
      ensureOptions(widget);
      if (!widget || typeof widget.callback !== "function" || widget.callback[MARK]) return;
      const original = widget.callback;
      const wrapped = function (...args) {
        normalizeNode(node);
        return original.apply(this, args);
      };
      wrapped[MARK] = true;
      widget.callback = wrapped;
    });
  }

  function normalizeExistingNodes() {
    const nodes = window.comfyAPI?.app?.app?.graph?._nodes || window.app?.graph?._nodes;
    if (Array.isArray(nodes)) nodes.forEach(normalizeNode);
  }

  function shouldSuppressKnownError(error, assumeEasyUseNode = false) {
    if (assumeEasyUseNode) {
      const message = String(error?.message || error || "");
      return /step2/.test(message);
    }
    return isEasyUseStep2Error(error);
  }

  function wrapPrototypeMethod(nodeType, methodName) {
    const prototype = nodeType?.prototype;
    const original = prototype?.[methodName];
    if (!prototype || typeof original !== "function" || original[MARK]) return;
    const wrapped = function (...args) {
      // onAdded is the failing EasyUse path, so normalize before and after
      // the third-party callback.  The second pass covers widgets created by
      // the callback itself.
      normalizeNode(this);
      let result;
      try {
        result = original.apply(this, args);
      } catch (error) {
        if (shouldSuppressKnownError(error, true)) {
          normalizeNode(this);
          return undefined;
        }
        throw error;
      }
      normalizeNode(this);
      if (result && typeof result.then === "function") {
        return result.catch((error) => {
          if (shouldSuppressKnownError(error, true)) {
            normalizeNode(this);
            return undefined;
          }
          throw error;
        });
      }
      return result;
    };
    wrapped[MARK] = true;
    prototype[methodName] = wrapped;
  }

  function patchRegisteredNodeType(attempt = 0) {
    const type = window.LiteGraph?.registered_node_types?.[NODE_NAME];
    if (!type) {
      if (attempt < MAX_RETRIES) setTimeout(() => patchRegisteredNodeType(attempt + 1), 500);
      return;
    }
    wrapPrototypeMethod(type, "onAdded");
    wrapPrototypeMethod(type, "onNodeCreated");
  }

  function patchCreateNode(attempt = 0) {
    const LiteGraph = window.LiteGraph;
    if (!LiteGraph || typeof LiteGraph.createNode !== "function") {
      if (attempt < MAX_RETRIES) setTimeout(() => patchCreateNode(attempt + 1), 500);
      return;
    }
    if (LiteGraph.createNode[MARK]) return;
    const originalCreateNode = LiteGraph.createNode;
    const wrappedCreateNode = function (...args) {
      const node = originalCreateNode.apply(this, args);
      if (node?.type === NODE_NAME) {
        normalizeNode(node);
        setTimeout(() => normalizeNode(node), 0);
      }
      return node;
    };
    wrappedCreateNode[MARK] = true;
    LiteGraph.createNode = wrappedCreateNode;
    patchRegisteredNodeType();
  }

  function install(attempt = 0) {
    const app = window.comfyAPI?.app?.app;
    if (!app?.registerExtension) {
      if (attempt < MAX_RETRIES) setTimeout(() => install(attempt + 1), 500);
      return;
    }
    if (window.__tkAnimaRuntimeCompatGuardsInstalled) return;
    window.__tkAnimaRuntimeCompatGuardsInstalled = true;
    installErrorShield();
    patchCreateNode();

    app.registerExtension({
      name: "TK.Anima.RuntimeCompatGuards",
      beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_NAME) return;
        wrapPrototypeMethod(nodeType, "onNodeCreated");
        wrapPrototypeMethod(nodeType, "onAdded");
      },
      nodeCreated(node) {
        normalizeNode(node);
      },
      loadedGraphNode(node) {
        normalizeNode(node);
      },
    });
    patchRegisteredNodeType();
    // The graph may already have been restored before this extension loaded.
    // Normalize those nodes once instead of waiting for a future lifecycle hook.
    normalizeExistingNodes();
    setTimeout(normalizeExistingNodes, 0);
    setTimeout(normalizeExistingNodes, 1000);
  }

  install();
})();
