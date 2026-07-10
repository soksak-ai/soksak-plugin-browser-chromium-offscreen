// ../../kits/soksak-kit-browser-common/src/url.ts
function normalizeUrl(raw) {
  const s = raw.trim();
  if (!s) return "about:blank";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith("about:") || s.startsWith("data:")) return s;
  if (/^[^\s.]+\.[^\s]+/.test(s)) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

// ../../kits/soksak-kit-browser-common/src/nav-state.ts
var initialNavState = { loading: false, canBack: false, canForward: false };
function renderNavState(s) {
  return {
    reloadGlyph: s.loading ? "\u2715" : "\u27F3",
    reloadAction: s.loading ? "stop" : "reload",
    progressVisible: s.loading,
    progressWidth: s.loading ? 70 : 100,
    backEnabled: s.canBack,
    forwardEnabled: s.canForward
  };
}

// ../../kits/soksak-kit-browser-common/src/lifecycle.ts
function createLifecycle(opts) {
  const LEDGER = `${opts.storagePrefix}-created`;
  const BYVIEW = `${opts.storagePrefix}-byview`;
  const CLAIMS = `${opts.storagePrefix}-claims`;
  const debounceMs = opts.closeDebounceMs ?? 800;
  const pendingClose = /* @__PURE__ */ new Map();
  const INSTANCE = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  function ssRead(key, fallback) {
    try {
      const raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }
  function ssWrite(key, value) {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
    }
  }
  const claimsRead = () => ssRead(CLAIMS, {});
  const claimWrite = (id, owner) => {
    const m = claimsRead();
    if (owner) m[String(id)] = owner;
    else delete m[String(id)];
    ssWrite(CLAIMS, m);
  };
  const ledgerRead = () => {
    const v = ssRead(LEDGER, []);
    return Array.isArray(v) ? v.filter((x) => typeof x === "number") : [];
  };
  const byviewRead = () => {
    const v = ssRead(BYVIEW, {});
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  };
  return {
    ledgerRead,
    ledgerAdd(id) {
      const l = ledgerRead();
      if (!l.includes(id)) ssWrite(LEDGER, [...l, id]);
    },
    ledgerRemove(id) {
      ssWrite(LEDGER, ledgerRead().filter((x) => x !== id));
    },
    byviewGet(viewId) {
      return byviewRead()[viewId];
    },
    byviewValues() {
      return Object.values(byviewRead());
    },
    byviewEntries() {
      return Object.entries(byviewRead());
    },
    byviewSet(viewId, id) {
      ssWrite(BYVIEW, { ...byviewRead(), [viewId]: id });
    },
    byviewDelete(viewId) {
      const m = byviewRead();
      delete m[viewId];
      ssWrite(BYVIEW, m);
    },
    scheduleClose(id, onFire) {
      const t = setTimeout(() => {
        pendingClose.delete(id);
        const owner = claimsRead()[String(id)];
        if (owner && owner !== INSTANCE) return;
        onFire();
      }, debounceMs);
      pendingClose.set(id, t);
    },
    reattach(id) {
      claimWrite(id, INSTANCE);
      const t = pendingClose.get(id);
      if (!t) return false;
      clearTimeout(t);
      pendingClose.delete(id);
      return true;
    },
    claim(id) {
      claimWrite(id, INSTANCE);
    },
    claimRelease(id) {
      claimWrite(id, null);
    },
    pendingCloseIds() {
      return [...pendingClose.keys()];
    }
  };
}

// ../../kits/soksak-kit-browser-common/src/input-forward.ts
function modsOf(e) {
  return (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
}
function forwardInput(container, send) {
  const pt = (e) => {
    const r = container.getBoundingClientRect();
    return { x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top) };
  };
  const proxy = document.createElement("input");
  proxy.type = "text";
  proxy.setAttribute("aria-hidden", "true");
  proxy.style.cssText = "position:absolute;left:0;top:0;width:2em;height:1.4em;border:0;padding:0;margin:0;background:transparent;color:transparent;caret-color:transparent;outline:none;pointer-events:none;";
  container.appendChild(proxy);
  let moveRaf = 0;
  let lastMove = null;
  const flushMove = () => {
    moveRaf = 0;
    if (!lastMove) return;
    const m = lastMove;
    lastMove = null;
    send({ type: "mouse", kind: "move", x: m.x, y: m.y, mods: m.mods });
  };
  const onMove = (e) => {
    lastMove = { ...pt(e), mods: modsOf(e) };
    if (!moveRaf) moveRaf = requestAnimationFrame(flushMove);
  };
  const onDown = (e) => {
    e.preventDefault();
    proxy.focus({ preventScroll: true });
    const p = pt(e);
    send({ type: "focus" });
    send({
      type: "mouse",
      kind: "down",
      x: p.x,
      y: p.y,
      button: e.button === 1 ? 1 : e.button === 2 ? 2 : 0,
      clicks: Math.max(1, e.detail),
      mods: modsOf(e)
    });
  };
  const onUp = (e) => {
    const p = pt(e);
    send({
      type: "mouse",
      kind: "up",
      x: p.x,
      y: p.y,
      button: e.button === 1 ? 1 : e.button === 2 ? 2 : 0,
      clicks: Math.max(1, e.detail),
      mods: modsOf(e)
    });
  };
  const onWheel = (e) => {
    e.preventDefault();
    const p = pt(e);
    send({ type: "wheel", x: p.x, y: p.y, dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) });
  };
  const onContext = (e) => e.preventDefault();
  let composing = false;
  let pending = "";
  const isHangul = (s) => {
    const cp = s ? s.codePointAt(0) ?? 0 : 0;
    return cp >= 4352 && cp <= 4607 || cp >= 12592 && cp <= 12687 || cp >= 44032 && cp <= 55215 || cp >= 43360 && cp <= 43391 || cp >= 55216 && cp <= 55295;
  };
  const setPreedit = (text) => {
    if (!composing && text.length > 0) send({ type: "focus" });
    composing = text.length > 0;
    pending = text;
    send({ type: "ime", kind: "set", text, caret: text.length });
  };
  const commitPending = () => {
    if (!composing) return;
    const t = pending;
    composing = false;
    pending = "";
    if (t) send({ type: "ime", kind: "commit", text: t });
  };
  const clearComposition = () => {
    composing = false;
    pending = "";
    send({ type: "ime", kind: "set", text: "", caret: 0 });
  };
  const onKeyDown = (e) => {
    if (composing && !e.isComposing && e.keyCode !== 229) commitPending();
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    const mods = modsOf(e);
    send({ type: "key", kind: "down", code: e.keyCode, mods });
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      send({ type: "key", kind: "char", code: e.keyCode, char: e.key, mods });
    }
  };
  const onKeyUp = (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    send({ type: "key", kind: "up", code: e.keyCode, mods: modsOf(e) });
  };
  const onInput = (e) => {
    const ie = e;
    const data = ie.data ?? "";
    if (ie.inputType === "insertReplacementText") {
      if (data) setPreedit(data);
      else clearComposition();
      return;
    }
    if (ie.inputType === "insertText" && data && isHangul(data)) {
      if (composing) commitPending();
      setPreedit(data);
      return;
    }
    if (ie.inputType === "deleteContentBackward" && composing) {
      clearComposition();
      return;
    }
  };
  const onCompUpdate = (e) => {
    setPreedit(e.data ?? "");
  };
  const onCompEnd = (e) => {
    const text = e.data ?? "";
    composing = false;
    pending = "";
    proxy.value = "";
    if (text) send({ type: "ime", kind: "commit", text });
    else send({ type: "ime", kind: "cancel" });
  };
  const onBlur = () => {
    commitPending();
    proxy.value = "";
    send({ type: "ime", kind: "finish" });
  };
  container.addEventListener("mousemove", onMove);
  container.addEventListener("mousedown", onDown);
  container.addEventListener("mouseup", onUp);
  container.addEventListener("wheel", onWheel, { passive: false });
  container.addEventListener("contextmenu", onContext);
  proxy.addEventListener("keydown", onKeyDown);
  proxy.addEventListener("keyup", onKeyUp);
  proxy.addEventListener("input", onInput);
  proxy.addEventListener("compositionupdate", onCompUpdate);
  proxy.addEventListener("compositionend", onCompEnd);
  proxy.addEventListener("blur", onBlur);
  return () => {
    if (moveRaf) cancelAnimationFrame(moveRaf);
    container.removeEventListener("mousemove", onMove);
    container.removeEventListener("mousedown", onDown);
    container.removeEventListener("mouseup", onUp);
    container.removeEventListener("wheel", onWheel);
    container.removeEventListener("contextmenu", onContext);
    proxy.remove();
  };
}

// ../../kits/soksak-kit-browser-common/src/toolbar.ts
function btn(node, label, title) {
  const b = document.createElement("button");
  b.type = "button";
  b.setAttribute("data-node", node);
  b.textContent = label;
  b.title = title;
  b.style.cssText = "flex:0 0 auto;width:30px;height:30px;border-radius:6px;border:0;background:var(--inset);color:var(--fg);font:15px system-ui;cursor:pointer";
  return b;
}
function createBrowserToolbar(container, cb) {
  const bar = document.createElement("div");
  bar.setAttribute("data-node", "toolbar");
  bar.style.cssText = "position:relative;display:flex;gap:4px;padding:6px;flex:0 0 auto;align-items:center;background:var(--side);border-bottom:1px solid var(--bd)";
  const back = btn("back", "\u2039", "\uB4A4\uB85C");
  const forward = btn("forward", "\u203A", "\uC55E\uC73C\uB85C");
  const reload = btn("reload", "\u27F3", "\uC0C8\uB85C\uACE0\uCE68");
  const home = btn("home", "\u2302", "\uD648");
  const url = document.createElement("input");
  url.setAttribute("data-node", "urlbar");
  url.type = "text";
  url.placeholder = "URL \uB610\uB294 \uAC80\uC0C9\uC5B4";
  url.style.cssText = "flex:1 1 auto;padding:6px 10px;border-radius:6px;border:1px solid var(--bd);background:var(--inset);color:var(--fg);font:13px system-ui";
  const go = btn("go", "\u21B5", "\uC774\uB3D9");
  go.style.background = "var(--acc)";
  go.style.color = "var(--bg)";
  const star = btn("bookmark", "\u2606", "\uBD81\uB9C8\uD06C");
  const extraSlot = document.createElement("div");
  extraSlot.setAttribute("data-node", "extra");
  extraSlot.style.cssText = "display:flex;gap:4px;flex:0 0 auto;align-items:center";
  const progress = document.createElement("div");
  progress.setAttribute("data-node", "progress");
  progress.style.cssText = "position:absolute;left:0;bottom:0;height:2px;width:0;background:var(--acc);transition:width .25s ease-out;opacity:0";
  bar.append(back, forward, reload, home, url, go, star, extraSlot, progress);
  container.appendChild(bar);
  let nav = initialNavState;
  const apply = () => {
    const r = renderNavState(nav);
    reload.textContent = r.reloadGlyph;
    reload.title = r.reloadAction === "stop" ? "\uC815\uC9C0" : "\uC0C8\uB85C\uACE0\uCE68";
    progress.style.opacity = r.progressVisible ? "1" : "0";
    progress.style.width = `${r.progressWidth}%`;
    back.style.opacity = r.backEnabled ? "1" : "0.35";
    forward.style.opacity = r.forwardEnabled ? "1" : "0.35";
  };
  apply();
  back.addEventListener("click", () => {
    if (renderNavState(nav).backEnabled) cb.onBack();
  });
  forward.addEventListener("click", () => {
    if (renderNavState(nav).forwardEnabled) cb.onForward();
  });
  reload.addEventListener("click", () => {
    if (renderNavState(nav).reloadAction === "stop") cb.onStop();
    else cb.onReload();
  });
  home.addEventListener("click", () => cb.onHome());
  go.addEventListener("click", () => cb.onNavigate(url.value));
  url.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      cb.onNavigate(url.value);
      url.blur();
    }
  });
  star.addEventListener("click", () => cb.onBookmarkToggle());
  return {
    root: bar,
    extraSlot,
    setUrl(u) {
      if (document.activeElement !== url) url.value = u;
    },
    getInput() {
      return url.value;
    },
    setNavState(s) {
      nav = s;
      apply();
    },
    setBookmarked(on) {
      star.textContent = on ? "\u2605" : "\u2606";
    },
    dispose() {
      bar.remove();
    }
  };
}

// ../../kits/soksak-kit-browser-common/src/dom-snippets.ts
var jsStr = (s) => JSON.stringify(s);
function domTextBody(selector, maxLength = 2e4) {
  return selector ? `const el = document.querySelector(${jsStr(selector)}); return el ? el.innerText.slice(0, ${maxLength}) : null;` : `return document.body.innerText.slice(0, ${maxLength});`;
}
function domHtmlBody(selector, maxLength = 2e4) {
  return selector ? `const el = document.querySelector(${jsStr(selector)}); return el ? el.outerHTML.slice(0, ${maxLength}) : null;` : `return document.documentElement.outerHTML.slice(0, ${maxLength});`;
}
function domQueryBody(selector, limit = 20) {
  return `
          const all = [...document.querySelectorAll(${jsStr(selector)})];
          return { count: all.length, elements: all.slice(0, ${limit}).map(e => ({
            tag: e.tagName.toLowerCase(),
            text: (e.innerText || "").trim().slice(0, 120) || undefined,
            id: e.id || undefined,
            class: (typeof e.className === "string" && e.className) || undefined,
            name: e.getAttribute("name") || undefined,
            href: e.getAttribute("href") || undefined,
            type: e.getAttribute("type") || undefined,
            value: e.value !== undefined ? String(e.value).slice(0, 120) : undefined,
          })) };`;
}
function domClickBody(selector) {
  return `const el = document.querySelector(${jsStr(selector)}); if (!el) return { clicked: false, reason: "selector \uB9E4\uCE6D \uC5C6\uC74C" }; el.click(); return { clicked: true };`;
}
function domFillBody(selector, text) {
  return `
          const el = document.querySelector(${jsStr(selector)});
          if (!el) return { filled: false, reason: "selector \uB9E4\uCE6D \uC5C6\uC74C" };
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (setter) setter.call(el, ${jsStr(text)}); else el.value = ${jsStr(text)};
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { filled: true };`;
}
function domSubmitBody(selector) {
  return `
          const el = document.querySelector(${jsStr(selector)});
          if (!el) return { submitted: false, reason: "selector \uB9E4\uCE6D \uC5C6\uC74C" };
          const form = el instanceof HTMLFormElement ? el : el.closest("form");
          if (!form) return { submitted: false, reason: "form \uC5C6\uC74C" };
          form.requestSubmit ? form.requestSubmit() : form.submit();
          return { submitted: true };`;
}
function domWaitForBody(selector, timeoutMs = 5e3) {
  return `
          const find = () => document.querySelector(${jsStr(selector)});
          if (find()) return { found: true };
          return await new Promise((resolve) => {
            const obs = new MutationObserver(() => {
              if (find()) { obs.disconnect(); clearTimeout(timer); resolve({ found: true }); }
            });
            const timer = setTimeout(() => { obs.disconnect(); resolve({ found: false }); }, ${timeoutMs});
            obs.observe(document.documentElement, { childList: true, subtree: true });
          });`;
}

// src/status.ts
var STRINGS = {
  loading: { en: "Loading\u2026", ko: "\uBD88\uB7EC\uC624\uB294 \uC911\u2026" },
  error: { en: "Engine surface unavailable", ko: "\uC5D4\uC9C4 \uC11C\uD53C\uC2A4\uB97C \uB9CC\uB4E4 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4" }
};
function browserStatus(phase, lang) {
  if (phase === "ready") return null;
  const s = STRINGS[phase];
  return { code: phase, message: lang === "ko" ? s.ko : s.en };
}

// src/plugin-entry.ts
function measureRect(el) {
  const r = el.getBoundingClientRect();
  const x = Math.ceil(r.left);
  const y = Math.ceil(r.top);
  return { x, y, w: Math.max(1, Math.floor(r.right) - x), h: Math.max(1, Math.floor(r.bottom) - y) };
}
var views = /* @__PURE__ */ new Map();
var MOUNT_DECISIONS = [];
var activeViewId = null;
var lastMountedViewId = null;
function resolveEntry(viewId) {
  if (viewId && views.has(viewId)) return views.get(viewId);
  if (activeViewId && views.has(activeViewId)) return views.get(activeViewId);
  if (lastMountedViewId && views.has(lastMountedViewId)) return views.get(lastMountedViewId);
  const first = views.values().next();
  return first.done ? null : first.value;
}
var PLUGIN_ID = "soksak-plugin-browser-chromium-offscreen";
var pendingUrl = null;
var lc = createLifecycle({ storagePrefix: "soksak-offscreen" });
function activate(ctx) {
  const { app } = ctx;
  if (app.data) {
    void app.data.kv.keys("vurl:").then((ks) => {
      for (const k of ks) void app.data.kv.delete(k);
    }).catch(() => {
    });
  }
  let handleP = null;
  function engine() {
    if (!app.sidecar) return Promise.reject(new Error("sidecar \uAD8C\uD55C/\uC120\uC5B8 \uC5C6\uC74C"));
    if (!handleP) {
      handleP = app.sidecar.open("browser-chromium").catch((e) => {
        handleP = null;
        throw e;
      });
    }
    return handleP;
  }
  async function send(msg) {
    try {
      return await (await engine()).send(msg);
    } catch (e) {
      console.warn("[chromium-offscreen] sidecar send \uC2E4\uD328:", e);
      return null;
    }
  }
  ctx.subscriptions.push(
    app.events.on("view.activated", (p) => {
      const id = p?.viewId;
      if (typeof id === "string") activeViewId = id;
    })
  );
  const RECONCILE_GRACE_MS = 4e3;
  const reconcileTimer = setTimeout(() => {
    void (async () => {
      const stats = await send({ type: "stats" });
      const alive = new Set((stats?.ids ?? []).map(Number));
      const claimed = /* @__PURE__ */ new Set([
        ...[...views.values()].map((v) => v.surfaceId).filter((x) => x != null),
        ...lc.byviewValues(),
        ...lc.pendingCloseIds()
      ]);
      const surfaces = stats?.surfaces;
      const reapPool = surfaces ? surfaces.filter((x) => x.owner === PLUGIN_ID).map((x) => x.id) : lc.ledgerRead();
      if (!surfaces) console.warn("[chromium-offscreen] \uC5D4\uC9C4\uC774 owner \uB97C \uBAA8\uB978\uB2E4(\uAD6C dylib) \u2014 \uC7A5\uBD80 \uD3F4\uBC31 \uD68C\uC218");
      for (const id of reapPool) {
        if (!alive.has(id)) {
          lc.ledgerRemove(id);
          continue;
        }
        if (claimed.has(id)) continue;
        console.warn(`[chromium-offscreen] \uC720\uB839 \uC11C\uD53C\uC2A4 \uD68C\uC218: id=${id}`);
        void send({ type: "close", id }).then((r) => {
          if (r && r.ok) {
            lc.ledgerRemove(id);
            lc.claimRelease(id);
          }
        });
      }
    })();
  }, RECONCILE_GRACE_MS);
  ctx.subscriptions.push({ dispose: () => clearTimeout(reconcileTimer) });
  if (app.commands) {
    const reg = (name, spec) => ctx.subscriptions.push(app.commands.register(name, spec));
    reg("ping", {
      description: "Load/version check \u2014 returns the plugin id and engine (E2E).",
      message: (d) => `${d.engine} \uC5D4\uC9C4(offscreen)\uC774 \uC751\uB2F5\uD569\uB2C8\uB2E4.`,
      handler: () => ({ ok: true, plugin: app.pluginId, engine: "chromium", mode: "offscreen" })
    });
    reg("navigate", {
      description: "Navigate the active (or specified) offscreen browser view to a URL.",
      triggers: { ko: "\uC774\uB3D9 \uC8FC\uC18C \uC5F4\uAE30 navigate chromium offscreen" },
      params: { viewId: { type: "string" }, url: { type: "string", description: "URL or search terms", required: true } },
      message: () => "\uD398\uC774\uC9C0\uB85C \uC774\uB3D9\uD588\uC2B5\uB2C8\uB2E4.",
      handler: (p) => {
        const e = resolveEntry(p.viewId);
        if (!e) return { ok: false, code: "NO_TARGET", message: "no active offscreen browser view" };
        const url = normalizeUrl(String(p.url ?? ""));
        app.events.progress?.("navigate", url);
        e.navigate(url);
        return { ok: true, viewId: e.viewId, url };
      }
    });
    const historyCmd = (name, msg) => reg(name, {
      description: `Go ${name} in the active (or specified) offscreen view's session history.`,
      params: { viewId: { type: "string" } },
      message: () => msg,
      handler: (p) => {
        const e = resolveEntry(p.viewId);
        if (!e || e.surfaceId == null) return { ok: false, code: "NO_TARGET", message: "no active offscreen browser view" };
        void send({ type: name, id: e.surfaceId });
        return { ok: true, viewId: e.viewId };
      }
    });
    historyCmd("back", "\uB4A4\uB85C \uC774\uB3D9\uD588\uC2B5\uB2C8\uB2E4.");
    historyCmd("forward", "\uC55E\uC73C\uB85C \uC774\uB3D9\uD588\uC2B5\uB2C8\uB2E4.");
    reg("reload", {
      description: "Reload the current page of the active (or specified) offscreen view.",
      params: { viewId: { type: "string" }, ignoreCache: { type: "boolean" } },
      message: () => "\uC0C8\uB85C\uACE0\uCE68\uD588\uC2B5\uB2C8\uB2E4.",
      handler: (p) => {
        const e = resolveEntry(p.viewId);
        if (!e || e.surfaceId == null) return { ok: false, code: "NO_TARGET", message: "no active offscreen browser view" };
        void send({ type: "reload", id: e.surfaceId, ignoreCache: !!p.ignoreCache });
        return { ok: true, viewId: e.viewId };
      }
    });
    reg("stop", {
      description: "Stop loading the active (or specified) offscreen view.",
      params: { viewId: { type: "string" } },
      message: () => "\uB85C\uB529\uC744 \uC815\uC9C0\uD588\uC2B5\uB2C8\uB2E4.",
      handler: (p) => {
        const e = resolveEntry(p.viewId);
        if (!e || e.surfaceId == null) return { ok: false, code: "NO_TARGET", message: "no active offscreen browser view" };
        void send({ type: "stop", id: e.surfaceId });
        return { ok: true, viewId: e.viewId };
      }
    });
    reg("home", {
      description: "Navigate the active (or specified) offscreen view to the configured home URL.",
      params: { viewId: { type: "string" } },
      message: () => "\uD648\uC73C\uB85C \uC774\uB3D9\uD588\uC2B5\uB2C8\uB2E4.",
      handler: (p) => {
        const e = resolveEntry(p.viewId);
        if (!e) return { ok: false, code: "NO_TARGET", message: "no active offscreen browser view" };
        const url = normalizeUrl(String(app.settings?.get("homeUrl") ?? "https://example.com"));
        e.navigate(url);
        return { ok: true, viewId: e.viewId, url };
      }
    });
    reg("open", {
      description: "Open a new offscreen browser tab (optionally at a URL).",
      params: { url: { type: "string" } },
      message: () => "\uC0C8 offscreen \uBE0C\uB77C\uC6B0\uC800 \uD0ED\uC744 \uC5F4\uC5C8\uC2B5\uB2C8\uB2E4.",
      handler: async (p) => {
        if (p.url) pendingUrl = normalizeUrl(String(p.url));
        app.events.progress?.("open", pendingUrl ?? "");
        const out = await app.commands.execute("view.open", { program: "browser-chromium-offscreen" });
        return { ok: !!out.ok, viewId: out.viewId };
      }
    });
    const pendingEvals = /* @__PURE__ */ new Map();
    let evalWired = false;
    async function evalOnEntry(e, body, timeoutMs = 1e4) {
      if (e.surfaceId == null) return { ok: false, value: "\uC11C\uD53C\uC2A4 \uC5C6\uC74C(\uC0DD\uC131 \uC911)" };
      const h = await engine();
      if (!evalWired) {
        evalWired = true;
        h.on("eval-result", (p) => {
          const cb = typeof p.evalId === "number" ? pendingEvals.get(p.evalId) : void 0;
          if (cb) cb({ ok: !!p.ok, value: p.value });
        });
      }
      const out = await send({ type: "eval", id: e.surfaceId, js: body });
      const evalId = out.evalId;
      if (typeof evalId !== "number")
        return { ok: false, value: String(out.error ?? "eval \uC2E4\uD328") };
      return await new Promise((resolve) => {
        const t = setTimeout(() => {
          pendingEvals.delete(evalId);
          resolve({ ok: false, value: "eval \uC751\uB2F5 \uC2DC\uAC04 \uCD08\uACFC" });
        }, timeoutMs);
        pendingEvals.set(evalId, (r) => {
          clearTimeout(t);
          pendingEvals.delete(evalId);
          resolve(r);
        });
      });
    }
    async function runDom(p, body, timeoutMs) {
      const e = resolveEntry(p.viewId);
      if (!e) return { ok: false, code: "NO_TARGET", message: "no active offscreen browser view" };
      const r = await evalOnEntry(e, body, timeoutMs);
      if (!r.ok) return { ok: false, code: "INTERNAL", message: String(r.value) };
      const v = r.value;
      if (v && typeof v === "object" && !Array.isArray(v)) return { ok: true, ...v, viewId: e.viewId };
      return { ok: true, value: v, viewId: e.viewId };
    }
    reg("eval", {
      description: "Run JavaScript in the page (async function body; return a JSON-serializable value).",
      triggers: { ko: "\uC790\uBC14\uC2A4\uD06C\uB9BD\uD2B8 \uC2E4\uD589 \uD398\uC774\uC9C0 \uC2A4\uD06C\uB9BD\uD2B8 eval" },
      params: {
        js: { type: "string", description: "JS body \u2014 must return a JSON-serializable value", required: true },
        viewId: { type: "string" }
      },
      handler: async (p) => {
        const e = resolveEntry(p.viewId);
        if (!e) return { ok: false, code: "NO_TARGET", message: "no active offscreen browser view" };
        const r = await evalOnEntry(e, String(p.js ?? ""));
        return r.ok ? { ok: true, value: r.value, viewId: e.viewId } : { ok: false, code: "INTERNAL", message: String(r.value) };
      }
    });
    reg("dom.text", {
      description: "Get the visible text of the page or a specific selector element.",
      triggers: { ko: "DOM \uD14D\uC2A4\uD2B8 \uC77D\uAE30 \uD398\uC774\uC9C0 \uD14D\uC2A4\uD2B8 \uC120\uD0DD\uC790 \uD14D\uC2A4\uD2B8" },
      params: {
        selector: { type: "string", description: "CSS selector (omit = entire body)" },
        maxLength: { type: "number", description: "Max character length" },
        viewId: { type: "string" }
      },
      handler: (p) => runDom(p, domTextBody(p.selector ? String(p.selector) : void 0, typeof p.maxLength === "number" ? p.maxLength : 2e4))
    });
    reg("dom.html", {
      description: "Get the HTML of the page or a specific selector element.",
      triggers: { ko: "DOM HTML \uC77D\uAE30 \uD398\uC774\uC9C0 \uC18C\uC2A4" },
      params: {
        selector: { type: "string", description: "CSS selector (omit = entire document)" },
        maxLength: { type: "number", description: "Max character length" },
        viewId: { type: "string" }
      },
      handler: (p) => runDom(p, domHtmlBody(p.selector ? String(p.selector) : void 0, typeof p.maxLength === "number" ? p.maxLength : 2e4))
    });
    reg("dom.query", {
      description: "Summarize matching elements (tag / text / attributes) for a CSS selector \u2014 use to understand page structure.",
      triggers: { ko: "DOM \uC694\uC18C \uC870\uD68C \uC120\uD0DD\uC790 \uB9E4\uCE6D \uAD6C\uC870 \uD30C\uC545" },
      params: {
        selector: { type: "string", description: "CSS selector", required: true },
        limit: { type: "number", description: "Max element count" },
        viewId: { type: "string" }
      },
      handler: (p) => runDom(p, domQueryBody(String(p.selector), typeof p.limit === "number" ? p.limit : 20))
    });
    reg("dom.click", {
      description: "Click the first element matching a CSS selector.",
      triggers: { ko: "DOM \uD074\uB9AD \uBC84\uD2BC \uD074\uB9AD \uB9C1\uD06C \uD074\uB9AD \uD398\uC774\uC9C0 \uD074\uB9AD" },
      params: { selector: { type: "string", description: "CSS selector", required: true }, viewId: { type: "string" } },
      handler: (p) => runDom(p, domClickBody(String(p.selector)))
    });
    reg("dom.fill", {
      description: "Fill an input element with a value (fires input/change events \u2014 React form compatible).",
      triggers: { ko: "DOM \uC785\uB825 \uCC44\uC6B0\uAE30 \uD3FC \uC785\uB825 \uD14D\uC2A4\uD2B8 \uC785\uB825 \uD544\uB4DC \uCC44\uC6B0\uAE30" },
      params: {
        selector: { type: "string", description: "CSS selector", required: true },
        text: { type: "string", description: "Value to enter", required: true },
        viewId: { type: "string" }
      },
      handler: (p) => runDom(p, domFillBody(String(p.selector), String(p.text ?? "")))
    });
    reg("dom.submit", {
      description: "Submit a form (selector can be the form element or any element inside it).",
      triggers: { ko: "\uD3FC \uC81C\uCD9C submit \uC804\uC1A1 \uC591\uC2DD \uC81C\uCD9C" },
      params: { selector: { type: "string", description: "CSS selector", required: true }, viewId: { type: "string" } },
      handler: (p) => runDom(p, domSubmitBody(String(p.selector)))
    });
    reg("dom.wait-for", {
      description: "Wait until a selector appears on the page (dynamic pages \u2014 uses MutationObserver).",
      triggers: { ko: "\uC694\uC18C \uB300\uAE30 \uB098\uD0C0\uB0A0 \uB54C\uAE4C\uC9C0 \uAE30\uB2E4\uB9AC\uAE30 \uB3D9\uC801 \uB85C\uB529 \uB300\uAE30" },
      params: {
        selector: { type: "string", description: "CSS selector", required: true },
        timeoutMs: { type: "number", description: "Max wait time (ms)" },
        viewId: { type: "string" }
      },
      handler: (p) => {
        const t = typeof p.timeoutMs === "number" ? p.timeoutMs : 5e3;
        return runDom(p, domWaitForBody(String(p.selector), t), t + 5e3);
      }
    });
    reg("surface.close", {
      description: "Close one engine surface by id (diagnostics). Cleans the ledger and the reattach map entry that points to it. The owning view recreates its surface on next remount.",
      params: { id: { type: "number", required: true, description: "engine surface id (see stats)" } },
      handler: async (p) => {
        const id = Number(p.id);
        if (!Number.isFinite(id)) return { ok: false, error: "id \uD544\uC694" };
        const r = await send({ type: "close", id });
        if (r && r.ok) {
          lc.ledgerRemove(id);
          lc.claimRelease(id);
        }
        for (const [vid, sid] of [...views.entries()].map((e) => [e[0], e[1].surfaceId])) {
          if (sid === id) views.get(vid).surfaceId = null;
        }
        for (const [vid, sid] of lc.byviewEntries()) {
          if (sid === id) lc.byviewDelete(vid);
        }
        return { ok: true, closed: id };
      }
    });
    reg("stats", {
      description: "offscreen view surface ids + engine dbg (framesPresented \u2014 proves the shared-texture present path is alive).",
      message: (d) => `offscreen \uC11C\uD53C\uC2A4 ${d.ids?.length ?? 0}\uAC1C, present ${d.engine?.dbg?.framesPresented ?? "?"}\uD504\uB808\uC784.`,
      handler: async () => ({
        ok: true,
        ids: [...views.values()].map((v) => ({ viewId: v.viewId, surfaceId: v.surfaceId, url: v.getUrl() })),
        ledger: lc.ledgerRead(),
        // 유령 방지 장부 스냅샷 — chromium 어댑터 stats 와 동형 진단
        mountDecisions: MOUNT_DECISIONS.slice(-10),
        // 재부착 판정 기록(진단)
        engine: await send({ type: "stats" })
      })
    });
  }
  const bookmarks = /* @__PURE__ */ new Map();
  async function loadBookmarks() {
    if (!app.data) return;
    const keys = await app.data.kv.keys("bm:");
    bookmarks.clear();
    for (const k of keys) {
      const v = await app.data.kv.get(k);
      if (v?.url) bookmarks.set(v.url, v);
    }
  }
  if (app.data) {
    void loadBookmarks();
    ctx.subscriptions.push(app.data.kv.watch((k) => {
      if (k == null || k.startsWith("bm:")) void loadBookmarks();
    }));
  }
  const newWindowMode = () => String(app.settings?.get("browserNewWindow") ?? "tab") === "window";
  const provider = {
    mount(container, vctx) {
      const viewId = vctx.viewId;
      if (!viewId) return;
      lastMountedViewId = viewId;
      const reportStatus = (phase) => vctx.setStatus?.(browserStatus(phase, app.locale?.() ?? "en"));
      views.get(viewId)?.teardown();
      container.replaceChildren();
      container.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;background:transparent";
      const homeUrl = () => normalizeUrl(String(app.settings?.get("homeUrl") ?? "https://example.com"));
      const tb = createBrowserToolbar(container, {
        onNavigate: (raw) => entry.navigate(normalizeUrl(raw)),
        onBack: () => {
          if (surfaceId != null) void send({ type: "back", id: surfaceId });
        },
        onForward: () => {
          if (surfaceId != null) void send({ type: "forward", id: surfaceId });
        },
        onReload: () => {
          if (surfaceId != null) void send({ type: "reload", id: surfaceId });
        },
        onStop: () => {
          if (surfaceId != null) void send({ type: "stop", id: surfaceId });
        },
        onHome: () => entry.navigate(homeUrl()),
        onBookmarkToggle: () => {
          if (!app.data || !currentUrl || currentUrl === "about:blank") return;
          if (bookmarks.has(currentUrl)) {
            bookmarks.delete(currentUrl);
            void app.data.kv.delete(`bm:${currentUrl}`);
          } else {
            const b = { url: currentUrl, title: (() => {
              try {
                return new URL(currentUrl).host;
              } catch {
                return currentUrl;
              }
            })() };
            bookmarks.set(currentUrl, b);
            void app.data.kv.set(`bm:${currentUrl}`, b);
          }
          tb.setBookmarked(bookmarks.has(currentUrl));
        }
      });
      const cell = document.createElement("div");
      cell.setAttribute("data-node", "offscreen-cell");
      cell.style.cssText = "flex:1 1 auto;position:relative;overflow:hidden;background:transparent";
      container.append(cell);
      let surfaceId = null;
      let currentUrl = "about:blank";
      let stopInput = null;
      let stopFollow = null;
      let disposed = false;
      const teardown = () => {
        if (disposed) return;
        disposed = true;
        if (views.get(viewId) === entry) views.delete(viewId);
        if (activeViewId === viewId) activeViewId = null;
        stopInput?.();
        stopFollow?.();
        if (surfaceId != null) {
          const id = surfaceId;
          void send({ type: "hidden", id, hidden: true });
          lc.scheduleClose(id, () => {
            if (lc.byviewGet(viewId) === id) lc.byviewDelete(viewId);
            void send({ type: "close", id }).then((r) => {
              if (r && r.ok) {
                lc.ledgerRemove(id);
                lc.claimRelease(id);
              }
            });
          });
        }
        surfaceId = null;
      };
      const entry = {
        viewId,
        surfaceId: null,
        getUrl: () => currentUrl,
        navigate: (u) => {
          tb.setUrl(u);
          currentUrl = u;
          if (surfaceId != null) void send({ type: "load", id: surfaceId, url: u });
        },
        teardown
      };
      views.set(viewId, entry);
      function setUrlBar(u) {
        currentUrl = u;
        tb.setUrl(u);
        tb.setBookmarked(bookmarks.has(u));
        if (u && u !== "about:blank") vctx.setRestoreState?.({ url: u });
      }
      function startUrl() {
        if (pendingUrl) {
          const u = pendingUrl;
          pendingUrl = null;
          return normalizeUrl(u);
        }
        const rs = vctx.restore?.state;
        if (typeof rs?.url === "string" && rs.url) return normalizeUrl(rs.url);
        return normalizeUrl(String(app.settings?.get("homeUrl") ?? "https://example.com"));
      }
      function follow(id) {
        let lastKey = "";
        let raf = 0;
        let frames = 0;
        const STABLE = 4;
        const sync = () => {
          const r = measureRect(cell);
          const key = `${r.x},${r.y},${r.w},${r.h}`;
          if (key === lastKey) return;
          lastKey = key;
          void send({ type: "bounds", id, x: r.x, y: r.y, w: r.w, h: r.h });
        };
        const tick = () => {
          const before = lastKey;
          sync();
          frames = before === lastKey ? frames + 1 : 0;
          if (frames < STABLE) raf = requestAnimationFrame(tick);
          else raf = 0;
        };
        const arm = () => {
          frames = 0;
          if (!raf) raf = requestAnimationFrame(tick);
        };
        const ro = new ResizeObserver(arm);
        ro.observe(cell);
        window.addEventListener("resize", arm);
        const offPark = app.events.on("view.parked", (p) => {
          const q = p;
          if (q.viewId !== viewId) return;
          void send({ type: "hidden", id, hidden: !!q.parked });
          if (!q.parked) {
            lastKey = "";
            arm();
          }
        });
        const io = new IntersectionObserver((entries) => {
          const visible = entries.some((e) => e.isIntersecting);
          void send({ type: "hidden", id, hidden: !visible });
          if (visible) {
            lastKey = "";
            arm();
          }
        });
        io.observe(cell);
        arm();
        return () => {
          offPark.dispose();
          ro.disconnect();
          io.disconnect();
          window.removeEventListener("resize", arm);
          if (raf) cancelAnimationFrame(raf);
        };
      }
      const priorId = lc.byviewGet(viewId);
      if (priorId != null) lc.reattach(priorId);
      void (async () => {
        let id;
        let prior = priorId ?? null;
        if (prior != null) {
          const st = await send({ type: "stats" });
          const alive = new Set((st.ids ?? []).map(Number));
          MOUNT_DECISIONS.push({ viewId, prior, alive: [...alive].slice(0, 20), aliveOk: alive.has(prior) });
          if (!alive.has(prior)) {
            lc.byviewDelete(viewId);
            lc.claimRelease(prior);
            prior = null;
          }
        } else {
          MOUNT_DECISIONS.push({ viewId, prior: null, alive: [], aliveOk: false });
        }
        if (prior != null) {
          id = prior;
          const rs = vctx.restore?.state;
          if (typeof rs?.url === "string" && rs.url) {
            currentUrl = rs.url;
            tb.setUrl(rs.url);
          }
        } else {
          const first = startUrl();
          const r = measureRect(cell);
          const out = await send({ type: "create", mode: "offscreen", owner: PLUGIN_ID, scale: window.devicePixelRatio || 1, x: r.x, y: r.y, w: r.w, h: r.h, url: first });
          const created = out && typeof out.id === "number" ? out.id : null;
          if (created == null) {
            cell.textContent = "\uC5D4\uC9C4 \uC11C\uD53C\uC2A4 \uC0DD\uC131 \uC2E4\uD328";
            reportStatus("error");
            return;
          }
          id = created;
          lc.ledgerAdd(id);
          lc.byviewSet(viewId, id);
          lc.claim(id);
          setUrlBar(first);
        }
        if (disposed || views.get(viewId) !== entry) {
          if (prior == null) {
            void send({ type: "close", id }).then((r2) => {
              if (r2 && r2.ok) {
                lc.ledgerRemove(id);
                lc.claimRelease(id);
              }
            });
            if (lc.byviewGet(viewId) === id) lc.byviewDelete(viewId);
          }
          return;
        }
        surfaceId = id;
        entry.surfaceId = id;
        reportStatus(prior != null ? "ready" : "loading");
        if (prior != null) void send({ type: "hidden", id, hidden: false });
        void send({ type: "popup-mode", asWindow: newWindowMode() });
        stopFollow = follow(id);
        stopInput = forwardInput(cell, (m) => void send({ ...m, id }));
        const h = await engine();
        h.on("nav", (p) => {
          if (p.id === id && typeof p.url === "string") setUrlBar(p.url);
        });
        h.on("title", (p) => {
          if (p.id === id && typeof p.title === "string") vctx.setTitle?.(p.title);
        });
        h.on("favicon", (p) => {
          if (p.id !== id || typeof p.url !== "string") return;
          vctx.setIcon?.(p.url === "data:," ? "" : p.url);
        });
        h.on("cursor", (p) => {
          if (p.id === id) cell.style.cursor = String(p.type ?? "default");
        });
        h.on("loading", (p) => {
          if (p.id !== id) return;
          tb.setNavState({ loading: !!p.loading, canBack: !!p.canBack, canForward: !!p.canForward });
          reportStatus(p.loading ? "loading" : "ready");
        });
        h.on("popup-url", (p) => {
          if (p.id !== id || typeof p.url !== "string") return;
          pendingUrl = p.url;
          void app.commands?.execute("view.open", { program: "browser-chromium-offscreen" }).then((o) => {
            if (!o?.ok) {
              pendingUrl = null;
              entry.navigate(normalizeUrl(p.url));
            }
          });
        });
      })();
      container.__offscreenCleanup = teardown;
    },
    unmount(container) {
      const c = container;
      c.__offscreenCleanup?.();
      c.__offscreenCleanup = void 0;
    }
  };
  ctx.subscriptions.push(app.ui.registerView("content", provider));
}
var plugin_entry_default = { activate };
export {
  activate,
  plugin_entry_default as default
};
