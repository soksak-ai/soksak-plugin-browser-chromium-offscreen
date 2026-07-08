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
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith("about:")) return s;
  if (/^[^\s.]+\.[^\s]+/.test(s)) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}
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
  const provider = {
    mount(container, vctx) {
      const viewId = vctx.viewId;
      if (!viewId) return;
      container.style.position = "absolute";
      container.style.inset = "0";
      container.style.display = "flex";
      container.style.flexDirection = "column";
      container.style.background = "transparent";
      const bar = document.createElement("div");
      bar.style.cssText = "display:flex;gap:6px;padding:6px;flex:0 0 auto;background:var(--color-background-soft,#222)";
      const url = document.createElement("input");
      url.setAttribute("data-node", "urlbar");
      url.type = "text";
      url.placeholder = "URL \uB610\uB294 \uAC80\uC0C9\uC5B4";
      url.style.cssText = "flex:1;padding:6px 10px;border-radius:6px;border:1px solid var(--color-border,#444);background:var(--color-background,#111);color:var(--color-text,#eee);font:13px system-ui";
      const go = document.createElement("button");
      go.setAttribute("data-node", "go");
      go.textContent = "\uC774\uB3D9";
      go.style.cssText = "padding:6px 12px;border-radius:6px;border:0;background:var(--color-accent,#3b82f6);color:#fff;font:13px system-ui;cursor:pointer";
      bar.append(url, go);
      const cell = document.createElement("div");
      cell.setAttribute("data-node", "osr-cell");
      cell.style.cssText = "flex:1 1 auto;position:relative;overflow:hidden;background:transparent";
      container.append(bar, cell);
      const homeUrl = String(app.settings?.get("homeUrl") ?? "https://example.com");
      url.value = homeUrl;
      let surfaceId = null;
      let stopInput = null;
      let stopFollow = null;
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
        arm();
        return () => {
          ro.disconnect();
          window.removeEventListener("resize", arm);
          if (raf) cancelAnimationFrame(raf);
        };
      }
      function navigate() {
        const target = normalizeUrl(url.value);
        url.value = target;
        if (surfaceId != null) void send({ type: "load", id: surfaceId, url: target });
      }
      go.addEventListener("click", navigate);
      url.addEventListener("keydown", (e) => {
        if (e.key === "Enter") navigate();
      });
      void (async () => {
        const r = measureRect(cell);
        const out = await send({
          type: "create",
          mode: "offscreen",
          scale: window.devicePixelRatio || 1,
          x: r.x,
          y: r.y,
          w: r.w,
          h: r.h,
          url: normalizeUrl(homeUrl)
        });
        const id = out && typeof out.id === "number" ? out.id : null;
        if (id == null) {
          cell.textContent = "\uC5D4\uC9C4 \uC11C\uD53C\uC2A4 \uC0DD\uC131 \uC2E4\uD328";
          return;
        }
        surfaceId = id;
        stopFollow = follow(id);
        stopInput = forwardInput(cell, (m) => void send({ ...m, id }));
        const h = await engine();
        h.on("nav", (p) => {
          if (p.id === id && typeof p.url === "string") url.value = p.url;
        });
        h.on("title", (p) => {
          if (p.id === id && typeof p.title === "string") vctx.setTitle?.(p.title);
        });
        h.on("cursor", (p) => {
          if (p.id === id) cell.style.cursor = String(p.type ?? "default");
        });
      })();
      container.__osrCleanup = () => {
        stopInput?.();
        stopFollow?.();
        if (surfaceId != null) void send({ type: "close", id: surfaceId });
      };
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
  plugin_entry_default as default
};
