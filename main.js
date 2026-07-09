// src/input-forward.ts
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
  proxy.style.cssText = "position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;border:0;padding:0;pointer-events:none;";
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
  const onKeyDown = (e) => {
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
  const onCompStart = () => {
    send({ type: "ime", kind: "set", text: "", caret: 0 });
  };
  const onCompUpdate = (e) => {
    const text = e.data ?? "";
    send({ type: "ime", kind: "set", text, caret: text.length });
  };
  const onCompEnd = (e) => {
    const text = e.data ?? "";
    proxy.value = "";
    if (text) send({ type: "ime", kind: "commit", text });
    else send({ type: "ime", kind: "cancel" });
  };
  const onBlur = () => {
    send({ type: "ime", kind: "finish" });
  };
  container.addEventListener("mousemove", onMove);
  container.addEventListener("mousedown", onDown);
  container.addEventListener("mouseup", onUp);
  container.addEventListener("wheel", onWheel, { passive: false });
  container.addEventListener("contextmenu", onContext);
  proxy.addEventListener("keydown", onKeyDown);
  proxy.addEventListener("keyup", onKeyUp);
  proxy.addEventListener("compositionstart", onCompStart);
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

// src/plugin-entry.ts
function measureRect(el) {
  const r = el.getBoundingClientRect();
  const x = Math.ceil(r.left);
  const y = Math.ceil(r.top);
  return { x, y, w: Math.max(1, Math.floor(r.right) - x), h: Math.max(1, Math.floor(r.bottom) - y) };
}
function normalizeUrl(raw) {
  const s = raw.trim();
  if (!s) return "about:blank";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith("about:") || s.startsWith("data:")) return s;
  if (/^[^\s.]+\.[^\s]+/.test(s)) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}
var views = /* @__PURE__ */ new Map();
var activeViewId = null;
var lastMountedViewId = null;
function resolveEntry(viewId) {
  if (viewId && views.has(viewId)) return views.get(viewId);
  if (activeViewId && views.has(activeViewId)) return views.get(activeViewId);
  if (lastMountedViewId && views.has(lastMountedViewId)) return views.get(lastMountedViewId);
  const first = views.values().next();
  return first.done ? null : first.value;
}
var pendingUrl = null;
function activate(ctx) {
  const { app } = ctx;
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
      console.warn("[browser-osr] sidecar send \uC2E4\uD328:", e);
      return null;
    }
  }
  ctx.subscriptions.push(
    app.events.on("view.activated", (p) => {
      const id = p?.viewId;
      if (typeof id === "string") activeViewId = id;
    })
  );
  if (app.commands) {
    const reg = (name, spec) => ctx.subscriptions.push(app.commands.register(name, spec));
    reg("ping", {
      description: "Load/version check \u2014 returns the plugin id and engine (E2E).",
      message: (d) => `${d.engine} \uC5D4\uC9C4(offscreen)\uC774 \uC751\uB2F5\uD569\uB2C8\uB2E4.`,
      handler: () => ({ ok: true, plugin: app.pluginId, engine: "chromium", mode: "offscreen" })
    });
    reg("navigate", {
      description: "Navigate the active (or specified) OSR browser view to a URL.",
      triggers: { ko: "\uC774\uB3D9 \uC8FC\uC18C \uC5F4\uAE30 navigate osr" },
      params: { viewId: { type: "string" }, url: { type: "string", description: "URL or search terms", required: true } },
      message: () => "\uD398\uC774\uC9C0\uB85C \uC774\uB3D9\uD588\uC2B5\uB2C8\uB2E4.",
      handler: (p) => {
        const e = resolveEntry(p.viewId);
        if (!e) return { ok: false, code: "NO_TARGET", message: "no active OSR browser view" };
        const url = normalizeUrl(String(p.url ?? ""));
        app.events.progress?.("navigate", url);
        e.navigate(url);
        return { ok: true, viewId: e.viewId, url };
      }
    });
    const historyCmd = (name, msg) => reg(name, {
      description: `Go ${name} in the active (or specified) OSR view's session history.`,
      params: { viewId: { type: "string" } },
      message: () => msg,
      handler: (p) => {
        const e = resolveEntry(p.viewId);
        if (!e || e.surfaceId == null) return { ok: false, code: "NO_TARGET", message: "no active OSR browser view" };
        void send({ type: name, id: e.surfaceId });
        return { ok: true, viewId: e.viewId };
      }
    });
    historyCmd("back", "\uB4A4\uB85C \uC774\uB3D9\uD588\uC2B5\uB2C8\uB2E4.");
    historyCmd("forward", "\uC55E\uC73C\uB85C \uC774\uB3D9\uD588\uC2B5\uB2C8\uB2E4.");
    reg("reload", {
      description: "Reload the current page of the active (or specified) OSR view.",
      params: { viewId: { type: "string" }, ignoreCache: { type: "boolean" } },
      message: () => "\uC0C8\uB85C\uACE0\uCE68\uD588\uC2B5\uB2C8\uB2E4.",
      handler: (p) => {
        const e = resolveEntry(p.viewId);
        if (!e || e.surfaceId == null) return { ok: false, code: "NO_TARGET", message: "no active OSR browser view" };
        void send({ type: "reload", id: e.surfaceId, ignoreCache: !!p.ignoreCache });
        return { ok: true, viewId: e.viewId };
      }
    });
    reg("stop", {
      description: "Stop loading the active (or specified) OSR view.",
      params: { viewId: { type: "string" } },
      message: () => "\uB85C\uB529\uC744 \uC815\uC9C0\uD588\uC2B5\uB2C8\uB2E4.",
      handler: (p) => {
        const e = resolveEntry(p.viewId);
        if (!e || e.surfaceId == null) return { ok: false, code: "NO_TARGET", message: "no active OSR browser view" };
        void send({ type: "stop", id: e.surfaceId });
        return { ok: true, viewId: e.viewId };
      }
    });
    reg("home", {
      description: "Navigate the active (or specified) OSR view to the configured home URL.",
      params: { viewId: { type: "string" } },
      message: () => "\uD648\uC73C\uB85C \uC774\uB3D9\uD588\uC2B5\uB2C8\uB2E4.",
      handler: (p) => {
        const e = resolveEntry(p.viewId);
        if (!e) return { ok: false, code: "NO_TARGET", message: "no active OSR browser view" };
        const url = normalizeUrl(String(app.settings?.get("homeUrl") ?? "https://example.com"));
        e.navigate(url);
        return { ok: true, viewId: e.viewId, url };
      }
    });
    reg("open", {
      description: "Open a new OSR browser tab (optionally at a URL).",
      params: { url: { type: "string" } },
      message: () => "\uC0C8 OSR \uBE0C\uB77C\uC6B0\uC800 \uD0ED\uC744 \uC5F4\uC5C8\uC2B5\uB2C8\uB2E4.",
      handler: async (p) => {
        if (p.url) pendingUrl = normalizeUrl(String(p.url));
        app.events.progress?.("open", pendingUrl ?? "");
        const out = await app.commands.execute("view.open", { program: "browser-osr" });
        return { ok: !!out.ok, viewId: out.viewId };
      }
    });
    reg("stats", {
      description: "OSR view surface ids + engine dbg (framesPresented \u2014 proves the shared-texture present path is alive).",
      message: (d) => `OSR \uC11C\uD53C\uC2A4 ${d.ids?.length ?? 0}\uAC1C, present ${d.engine?.dbg?.framesPresented ?? "?"}\uD504\uB808\uC784.`,
      handler: async () => ({
        ok: true,
        ids: [...views.values()].map((v) => ({ viewId: v.viewId, surfaceId: v.surfaceId, url: v.getUrl() })),
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
      views.get(viewId)?.teardown();
      container.replaceChildren();
      container.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;background:transparent";
      const bar = document.createElement("div");
      bar.style.cssText = "display:flex;gap:4px;padding:6px;flex:0 0 auto;align-items:center;background:var(--color-background-soft,#222)";
      const mkBtn = (node, label, title) => {
        const b = document.createElement("button");
        b.setAttribute("data-node", node);
        b.textContent = label;
        b.title = title;
        b.style.cssText = "flex:0 0 auto;width:30px;height:30px;border-radius:6px;border:0;background:var(--color-background,#111);color:var(--color-text,#eee);font:15px system-ui;cursor:pointer";
        return b;
      };
      bar.style.position = "relative";
      const backBtn = mkBtn("back", "\u2039", "\uB4A4\uB85C");
      const fwdBtn = mkBtn("forward", "\u203A", "\uC55E\uC73C\uB85C");
      const reloadBtn = mkBtn("reload", "\u27F3", "\uC0C8\uB85C\uACE0\uCE68");
      const homeBtn = mkBtn("home", "\u2302", "\uD648");
      const url = document.createElement("input");
      url.setAttribute("data-node", "urlbar");
      url.type = "text";
      url.placeholder = "URL \uB610\uB294 \uAC80\uC0C9\uC5B4";
      url.style.cssText = "flex:1 1 auto;padding:6px 10px;border-radius:6px;border:1px solid var(--color-border,#444);background:var(--color-background,#111);color:var(--color-text,#eee);font:13px system-ui";
      const go = mkBtn("go", "\u21B5", "\uC774\uB3D9");
      go.style.background = "var(--color-accent,#3b82f6)";
      go.style.color = "#fff";
      const star = mkBtn("bookmark", "\u2606", "\uBD81\uB9C8\uD06C");
      bar.append(backBtn, fwdBtn, reloadBtn, homeBtn, url, go, star);
      const progress = document.createElement("div");
      progress.setAttribute("data-node", "progress");
      progress.style.cssText = "position:absolute;left:0;bottom:0;height:2px;width:0;background:var(--color-accent,#3b82f6);transition:width .25s ease-out;opacity:0";
      bar.appendChild(progress);
      const cell = document.createElement("div");
      cell.setAttribute("data-node", "osr-cell");
      cell.style.cssText = "flex:1 1 auto;position:relative;overflow:hidden;background:transparent";
      container.append(bar, cell);
      let surfaceId = null;
      let currentUrl = "about:blank";
      let stopInput = null;
      let stopFollow = null;
      let disposed = false;
      let loading = false;
      let canBack = false;
      let canForward = false;
      function applyNavState() {
        reloadBtn.textContent = loading ? "\u2715" : "\u27F3";
        reloadBtn.title = loading ? "\uC815\uC9C0" : "\uC0C8\uB85C\uACE0\uCE68";
        progress.style.opacity = loading ? "1" : "0";
        progress.style.width = loading ? "70%" : "100%";
        backBtn.style.opacity = canBack ? "1" : "0.35";
        fwdBtn.style.opacity = canForward ? "1" : "0.35";
      }
      const teardown = () => {
        if (disposed) return;
        disposed = true;
        if (views.get(viewId) === entry) views.delete(viewId);
        if (activeViewId === viewId) activeViewId = null;
        stopInput?.();
        stopFollow?.();
        if (surfaceId != null) void send({ type: "close", id: surfaceId });
        surfaceId = null;
      };
      const entry = {
        viewId,
        surfaceId: null,
        getUrl: () => currentUrl,
        navigate: (u) => {
          url.value = u;
          currentUrl = u;
          if (surfaceId != null) void send({ type: "load", id: surfaceId, url: u });
        },
        teardown
      };
      views.set(viewId, entry);
      function setUrlBar(u) {
        currentUrl = u;
        url.value = u;
        star.textContent = bookmarks.has(u) ? "\u2605" : "\u2606";
        if (app.data && u && u !== "about:blank") void app.data.kv.set(`vurl:${viewId}`, u);
      }
      async function startUrl() {
        if (pendingUrl) {
          const u = pendingUrl;
          pendingUrl = null;
          return normalizeUrl(u);
        }
        if (app.data) {
          const saved = await app.data.kv.get(`vurl:${viewId}`);
          if (saved) return normalizeUrl(saved);
        }
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
          ro.disconnect();
          io.disconnect();
          window.removeEventListener("resize", arm);
          if (raf) cancelAnimationFrame(raf);
        };
      }
      const doNav = () => entry.navigate(normalizeUrl(url.value));
      const homeUrl = () => normalizeUrl(String(app.settings?.get("homeUrl") ?? "https://example.com"));
      go.addEventListener("click", doNav);
      url.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) {
          doNav();
          url.blur();
        }
      });
      backBtn.addEventListener("click", () => {
        if (canBack && surfaceId != null) void send({ type: "back", id: surfaceId });
      });
      fwdBtn.addEventListener("click", () => {
        if (canForward && surfaceId != null) void send({ type: "forward", id: surfaceId });
      });
      reloadBtn.addEventListener("click", () => {
        if (surfaceId != null) void send({ type: loading ? "stop" : "reload", id: surfaceId });
      });
      homeBtn.addEventListener("click", () => entry.navigate(homeUrl()));
      star.addEventListener("click", () => {
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
        star.textContent = bookmarks.has(currentUrl) ? "\u2605" : "\u2606";
      });
      void (async () => {
        const first = await startUrl();
        const r = measureRect(cell);
        const out = await send({ type: "create", mode: "offscreen", scale: window.devicePixelRatio || 1, x: r.x, y: r.y, w: r.w, h: r.h, url: first });
        const id = out && typeof out.id === "number" ? out.id : null;
        if (id == null) {
          cell.textContent = "\uC5D4\uC9C4 \uC11C\uD53C\uC2A4 \uC0DD\uC131 \uC2E4\uD328";
          return;
        }
        if (disposed || views.get(viewId) !== entry) {
          void send({ type: "close", id });
          return;
        }
        surfaceId = id;
        entry.surfaceId = id;
        setUrlBar(first);
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
        h.on("cursor", (p) => {
          if (p.id === id) cell.style.cursor = String(p.type ?? "default");
        });
        h.on("loading", (p) => {
          if (p.id !== id) return;
          loading = !!p.loading;
          canBack = !!p.canBack;
          canForward = !!p.canForward;
          applyNavState();
        });
        h.on("popup-url", (p) => {
          if (p.id !== id || typeof p.url !== "string") return;
          pendingUrl = p.url;
          void app.commands?.execute("view.open", { program: "browser-osr" }).then((o) => {
            if (!o?.ok) {
              pendingUrl = null;
              entry.navigate(normalizeUrl(p.url));
            }
          });
        });
      })();
      container.__osrCleanup = teardown;
    },
    unmount(container) {
      const c = container;
      c.__osrCleanup?.();
      c.__osrCleanup = void 0;
    }
  };
  ctx.subscriptions.push(app.ui.registerView("content", provider));
}
var plugin_entry_default = { activate };
export {
  activate,
  plugin_entry_default as default
};
