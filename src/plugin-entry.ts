// soksak-plugin-browser-osr — Chromium 엔진을 offscreen 모드(SIDECARS.md §8)로 구동하는 브라우저.
// windowed browser-chromium 과 같은 엔진(browser-chromium 사이드카)·같은 프로토콜을 쓰되
// mode:"offscreen" 으로 연다: 엔진이 창 없이 그려 공유 텍스처를 코어 소유 레이어에 present 하고,
// 이 뷰의 DOM 셀이 모든 입력을 받아 프로토콜(mouse/wheel/key/ime)로 포워딩한다. 코어는 메시지 의미를
// 모른다(맹목 relay) — 결합은 매니페스트 sidecars[] + 메시지뿐(약결합). eval 없음.
import { forwardInput } from "./input-forward";

// ── 앱 API 표면(코어 PluginApi 부분집합) ────────────────────────────────────────────────────
interface SidecarHandle {
  send: (msg: Record<string, unknown>) => Promise<Record<string, unknown>>;
  on: (event: string, cb: (payload: Record<string, unknown>) => void) => { dispose(): void };
  close: () => Promise<void>;
}
interface Disposable { dispose(): void }
interface ParamSpec { type: string; description?: string; required?: boolean }
interface CommandSpec {
  description?: string;
  triggers?: Record<string, string>;
  params?: Record<string, ParamSpec>;
  message?: (data: Record<string, unknown>) => string;
  handler: (params: Record<string, unknown>) => Promise<object> | object;
}
interface KvApi {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
  delete: (key: string) => Promise<boolean>;
  keys: (prefix?: string) => Promise<string[]>;
  watch: (cb: (key: string | null) => void) => Disposable;
}
interface PluginApi {
  pluginId: string;
  sidecar?: { open: (name: string) => Promise<SidecarHandle> };
  settings?: { get: (key: string) => unknown };
  ui: { registerView: (id: string, provider: ViewProvider) => Disposable };
  commands?: {
    register: (name: string, spec: CommandSpec) => Disposable;
    execute: (name: string, params?: Record<string, unknown>) => Promise<{ ok: boolean; [k: string]: unknown }>;
  };
  events: { on: (event: string, cb: (p: unknown) => void) => Disposable; progress?: (cmd: string, delta: unknown) => void };
  data?: { kv: KvApi };
}
interface ViewContext { viewId: string | null; setTitle?: (title: string) => void }
interface ViewProvider { mount(container: HTMLElement, ctx: ViewContext): void; unmount?(container: HTMLElement): void }
interface PluginContext { app: PluginApi; subscriptions: { push(d: Disposable): void } }

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────────────────────
function measureRect(el: HTMLElement): { x: number; y: number; w: number; h: number } {
  const r = el.getBoundingClientRect();
  const x = Math.ceil(r.left);
  const y = Math.ceil(r.top);
  return { x, y, w: Math.max(1, Math.floor(r.right) - x), h: Math.max(1, Math.floor(r.bottom) - y) };
}
function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return "about:blank";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith("about:") || s.startsWith("data:")) return s;
  if (/^[^\s.]+\.[^\s]+/.test(s)) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

// ── 뷰 레지스트리(커맨드가 활성/지정 뷰의 서피스에 접근) ────────────────────────────────────
interface ViewEntry {
  viewId: string;
  surfaceId: number | null;
  getUrl: () => string;
  navigate: (url: string) => void;
  teardown: () => void; // 서피스 close + 옵서버 해제 — 재mount/unmount 에서 멱등 호출
}
const views = new Map<string, ViewEntry>();
let activeViewId: string | null = null;
let lastMountedViewId: string | null = null;
function resolveEntry(viewId?: string): ViewEntry | null {
  if (viewId && views.has(viewId)) return views.get(viewId)!;
  if (activeViewId && views.has(activeViewId)) return views.get(activeViewId)!;
  if (lastMountedViewId && views.has(lastMountedViewId)) return views.get(lastMountedViewId)!;
  const first = views.values().next();
  return first.done ? null : first.value;
}

// 새 탭이 열 URL(open 커맨드 / popup-url 이 set → 다음 mount 가 1회 소비).
let pendingUrl: string | null = null;

export function activate(ctx: PluginContext): void {
  const { app } = ctx;

  // ── 사이드카 채널(지연 단일 open) ──
  let handleP: Promise<SidecarHandle> | null = null;
  function engine(): Promise<SidecarHandle> {
    if (!app.sidecar) return Promise.reject(new Error("sidecar 권한/선언 없음"));
    if (!handleP) {
      handleP = app.sidecar.open("browser-chromium").catch((e) => {
        handleP = null;
        throw e;
      });
    }
    return handleP;
  }
  async function send(msg: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    try {
      return await (await engine()).send(msg);
    } catch (e) {
      console.warn("[browser-osr] sidecar send 실패:", e);
      return null;
    }
  }

  // ── 활성 뷰 추종 ──
  ctx.subscriptions.push(
    app.events.on("view.activated", (p) => {
      const id = (p as { viewId?: string })?.viewId;
      if (typeof id === "string") activeViewId = id;
    }),
  );

  // ── 커맨드 등록(CLI/MCP — chromium 과 동형) ──
  if (app.commands) {
    const reg = (name: string, spec: CommandSpec) => ctx.subscriptions.push(app.commands!.register(name, spec));
    reg("ping", {
      description: "Load/version check — returns the plugin id and engine (E2E).",
      message: (d) => `${d.engine} 엔진(offscreen)이 응답합니다.`,
      handler: () => ({ ok: true, plugin: app.pluginId, engine: "chromium", mode: "offscreen" }),
    });
    reg("navigate", {
      description: "Navigate the active (or specified) OSR browser view to a URL.",
      triggers: { ko: "이동 주소 열기 navigate osr" },
      params: { viewId: { type: "string" }, url: { type: "string", description: "URL or search terms", required: true } },
      message: () => "페이지로 이동했습니다.",
      handler: (p) => {
        const e = resolveEntry(p.viewId as string | undefined);
        if (!e) return { ok: false, code: "NO_TARGET", message: "no active OSR browser view" };
        const url = normalizeUrl(String(p.url ?? ""));
        app.events.progress?.("navigate", url);
        e.navigate(url);
        return { ok: true, viewId: e.viewId, url };
      },
    });
    const historyCmd = (name: string, msg: string) =>
      reg(name, {
        description: `Go ${name} in the active (or specified) OSR view's session history.`,
        params: { viewId: { type: "string" } },
        message: () => msg,
        handler: (p) => {
          const e = resolveEntry(p.viewId as string | undefined);
          if (!e || e.surfaceId == null) return { ok: false, code: "NO_TARGET", message: "no active OSR browser view" };
          void send({ type: name, id: e.surfaceId });
          return { ok: true, viewId: e.viewId };
        },
      });
    historyCmd("back", "뒤로 이동했습니다.");
    historyCmd("forward", "앞으로 이동했습니다.");
    reg("reload", {
      description: "Reload the current page of the active (or specified) OSR view.",
      params: { viewId: { type: "string" }, ignoreCache: { type: "boolean" } },
      message: () => "새로고침했습니다.",
      handler: (p) => {
        const e = resolveEntry(p.viewId as string | undefined);
        if (!e || e.surfaceId == null) return { ok: false, code: "NO_TARGET", message: "no active OSR browser view" };
        void send({ type: "reload", id: e.surfaceId, ignoreCache: !!p.ignoreCache });
        return { ok: true, viewId: e.viewId };
      },
    });
    reg("stop", {
      description: "Stop loading the active (or specified) OSR view.",
      params: { viewId: { type: "string" } },
      message: () => "로딩을 정지했습니다.",
      handler: (p) => {
        const e = resolveEntry(p.viewId as string | undefined);
        if (!e || e.surfaceId == null) return { ok: false, code: "NO_TARGET", message: "no active OSR browser view" };
        void send({ type: "stop", id: e.surfaceId });
        return { ok: true, viewId: e.viewId };
      },
    });
    reg("home", {
      description: "Navigate the active (or specified) OSR view to the configured home URL.",
      params: { viewId: { type: "string" } },
      message: () => "홈으로 이동했습니다.",
      handler: (p) => {
        const e = resolveEntry(p.viewId as string | undefined);
        if (!e) return { ok: false, code: "NO_TARGET", message: "no active OSR browser view" };
        const url = normalizeUrl(String(app.settings?.get("homeUrl") ?? "https://example.com"));
        e.navigate(url);
        return { ok: true, viewId: e.viewId, url };
      },
    });
    reg("open", {
      description: "Open a new OSR browser tab (optionally at a URL).",
      params: { url: { type: "string" } },
      message: () => "새 OSR 브라우저 탭을 열었습니다.",
      handler: async (p) => {
        if (p.url) pendingUrl = normalizeUrl(String(p.url));
        app.events.progress?.("open", pendingUrl ?? "");
        const out = await app.commands!.execute("view.open", { program: "browser-osr" });
        return { ok: !!out.ok, viewId: (out as { viewId?: string }).viewId };
      },
    });
    reg("stats", {
      description: "OSR view surface ids + engine dbg (framesPresented — proves the shared-texture present path is alive).",
      message: (d) => `OSR 서피스 ${(d.ids as unknown[] | undefined)?.length ?? 0}개, present ${(d.engine as { dbg?: { framesPresented?: number } } | undefined)?.dbg?.framesPresented ?? "?"}프레임.`,
      handler: async () => ({
        ok: true,
        ids: [...views.values()].map((v) => ({ viewId: v.viewId, surfaceId: v.surfaceId, url: v.getUrl() })),
        engine: await send({ type: "stats" }),
      }),
    });
  }

  // ── 북마크(app.data.kv, key `bm:<url>`) — chromium/native 동형 ──
  const bookmarks = new Map<string, { url: string; title: string }>();
  async function loadBookmarks(): Promise<void> {
    if (!app.data) return;
    const keys = await app.data.kv.keys("bm:");
    bookmarks.clear();
    for (const k of keys) {
      const v = (await app.data.kv.get(k)) as { url: string; title: string } | null;
      if (v?.url) bookmarks.set(v.url, v);
    }
  }
  if (app.data) {
    void loadBookmarks();
    ctx.subscriptions.push(app.data.kv.watch((k) => { if (k == null || k.startsWith("bm:")) void loadBookmarks(); }));
  }

  const newWindowMode = (): boolean => String(app.settings?.get("browserNewWindow") ?? "tab") === "window";

  const provider: ViewProvider = {
    mount(container, vctx) {
      const viewId = vctx.viewId;
      if (!viewId) return;
      lastMountedViewId = viewId;

      // 멱등 mount — 호스트는 같은 뷰를 재부모/재활성 시 다시 mount 할 수 있다. 이전 서피스를 먼저 닫지
      // 않으면 offscreen NSView 들이 창 content view 아래 스택으로 쌓여(같은 부모·겹친 bounds) 옛 프레임이
      // 활성 셀을 가린다(실측: 활성 탭에 옛 페이지가 남는 stale). 재mount 전 이전 뷰를 확실히 회수한다.
      views.get(viewId)?.teardown();
      container.replaceChildren();

      container.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;background:transparent";

      // ── 툴바 ──
      const bar = document.createElement("div");
      bar.style.cssText = "display:flex;gap:4px;padding:6px;flex:0 0 auto;align-items:center;background:var(--color-background-soft,#222)";
      const mkBtn = (node: string, label: string, title: string): HTMLButtonElement => {
        const b = document.createElement("button");
        b.setAttribute("data-node", node);
        b.textContent = label;
        b.title = title;
        b.style.cssText = "flex:0 0 auto;width:30px;height:30px;border-radius:6px;border:0;background:var(--color-background,#111);color:var(--color-text,#eee);font:15px system-ui;cursor:pointer";
        return b;
      };
      bar.style.position = "relative"; // 진행 바 앵커
      const backBtn = mkBtn("back", "‹", "뒤로");
      const fwdBtn = mkBtn("forward", "›", "앞으로");
      const reloadBtn = mkBtn("reload", "⟳", "새로고침"); // 로딩 중 ✕(정지)로 토글
      const homeBtn = mkBtn("home", "⌂", "홈");
      const url = document.createElement("input");
      url.setAttribute("data-node", "urlbar");
      url.type = "text";
      url.placeholder = "URL 또는 검색어";
      url.style.cssText = "flex:1 1 auto;padding:6px 10px;border-radius:6px;border:1px solid var(--color-border,#444);background:var(--color-background,#111);color:var(--color-text,#eee);font:13px system-ui";
      const go = mkBtn("go", "↵", "이동");
      go.style.background = "var(--color-accent,#3b82f6)";
      go.style.color = "#fff";
      const star = mkBtn("bookmark", "☆", "북마크");
      bar.append(backBtn, fwdBtn, reloadBtn, homeBtn, url, go, star);
      // 로딩 진행 바(불확정) — 툴바 하단. 엔진 loading 이벤트로 표시/숨김.
      const progress = document.createElement("div");
      progress.setAttribute("data-node", "progress");
      progress.style.cssText = "position:absolute;left:0;bottom:0;height:2px;width:0;background:var(--color-accent,#3b82f6);transition:width .25s ease-out;opacity:0";
      bar.appendChild(progress);

      // ── 투명 홀 셀 ──
      const cell = document.createElement("div");
      cell.setAttribute("data-node", "osr-cell");
      cell.style.cssText = "flex:1 1 auto;position:relative;overflow:hidden;background:transparent";
      container.append(bar, cell);

      let surfaceId: number | null = null;
      let currentUrl = "about:blank";
      let stopInput: (() => void) | null = null;
      let stopFollow: (() => void) | null = null;
      let disposed = false;
      let loading = false;
      let canBack = false;
      let canForward = false;
      // 엔진 loading 이벤트가 갱신하는 툴바 상태 — reload↔stop 토글, 진행 바, 뒤로/앞으로 활성.
      function applyNavState(): void {
        reloadBtn.textContent = loading ? "✕" : "⟳";
        reloadBtn.title = loading ? "정지" : "새로고침";
        progress.style.opacity = loading ? "1" : "0";
        progress.style.width = loading ? "70%" : "100%"; // 로딩 중 70%, 완료 시 꽉 채우고 페이드아웃
        backBtn.style.opacity = canBack ? "1" : "0.35";
        fwdBtn.style.opacity = canForward ? "1" : "0.35";
      }

      const teardown = (): void => {
        if (disposed) return;
        disposed = true;
        if (views.get(viewId) === entry) views.delete(viewId);
        if (activeViewId === viewId) activeViewId = null;
        stopInput?.();
        stopFollow?.();
        if (surfaceId != null) void send({ type: "close", id: surfaceId });
        surfaceId = null;
      };
      const entry: ViewEntry = {
        viewId,
        surfaceId: null,
        getUrl: () => currentUrl,
        navigate: (u) => { url.value = u; currentUrl = u; if (surfaceId != null) void send({ type: "load", id: surfaceId, url: u }); },
        teardown,
      };
      views.set(viewId, entry);

      function setUrlBar(u: string): void {
        currentUrl = u;
        url.value = u;
        star.textContent = bookmarks.has(u) ? "★" : "☆";
        if (app.data && u && u !== "about:blank") void app.data.kv.set(`vurl:${viewId}`, u);
      }

      // ── 시작 URL 우선순위: pending → 복원(vurl) → homeUrl → about:blank ──
      async function startUrl(): Promise<string> {
        if (pendingUrl) { const u = pendingUrl; pendingUrl = null; return normalizeUrl(u); }
        if (app.data) {
          const saved = (await app.data.kv.get(`vurl:${viewId}`)) as string | null;
          if (saved) return normalizeUrl(saved);
        }
        return normalizeUrl(String(app.settings?.get("homeUrl") ?? "https://example.com"));
      }

      // ── bounds-follow + 가시성(파킹 시 hidden) ──
      function follow(id: number): () => void {
        let lastKey = "";
        let raf = 0;
        let frames = 0;
        const STABLE = 4;
        const sync = (): void => {
          const r = measureRect(cell);
          const key = `${r.x},${r.y},${r.w},${r.h}`;
          if (key === lastKey) return;
          lastKey = key;
          void send({ type: "bounds", id, x: r.x, y: r.y, w: r.w, h: r.h });
        };
        const tick = (): void => {
          const before = lastKey;
          sync();
          frames = before === lastKey ? frames + 1 : 0;
          if (frames < STABLE) raf = requestAnimationFrame(tick); else raf = 0;
        };
        const arm = (): void => { frames = 0; if (!raf) raf = requestAnimationFrame(tick); };
        const ro = new ResizeObserver(arm);
        ro.observe(cell);
        window.addEventListener("resize", arm);
        // 탭 파킹 시 offscreen 레이어를 숨긴다(코어는 native webview 만 숨김) — 안 하면 다른 탭 위로 비침.
        const io = new IntersectionObserver((entries) => {
          const visible = entries.some((e) => e.isIntersecting);
          void send({ type: "hidden", id, hidden: !visible });
          if (visible) { lastKey = ""; arm(); }
        });
        io.observe(cell);
        arm();
        return () => { ro.disconnect(); io.disconnect(); window.removeEventListener("resize", arm); if (raf) cancelAnimationFrame(raf); };
      }

      // ── 툴바 배선 ──
      const doNav = (): void => entry.navigate(normalizeUrl(url.value));
      const homeUrl = (): string => normalizeUrl(String(app.settings?.get("homeUrl") ?? "https://example.com"));
      go.addEventListener("click", doNav);
      url.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { doNav(); url.blur(); } });
      backBtn.addEventListener("click", () => { if (canBack && surfaceId != null) void send({ type: "back", id: surfaceId }); });
      fwdBtn.addEventListener("click", () => { if (canForward && surfaceId != null) void send({ type: "forward", id: surfaceId }); });
      // reload 버튼은 로딩 중이면 정지(stop), 아니면 새로고침 — 표준 브라우저 토글.
      reloadBtn.addEventListener("click", () => { if (surfaceId != null) void send({ type: loading ? "stop" : "reload", id: surfaceId }); });
      homeBtn.addEventListener("click", () => entry.navigate(homeUrl()));
      star.addEventListener("click", () => {
        if (!app.data || !currentUrl || currentUrl === "about:blank") return;
        // 낙관적 즉시 반영 — 공유 map·글리프를 지금 갱신하고 kv 는 비동기로 뒤따른다. kv.watch 의
        // loadBookmarks 가 나중에 재조정해도 멱등(같은 결과)이라 깜빡임 없다.
        if (bookmarks.has(currentUrl)) { bookmarks.delete(currentUrl); void app.data.kv.delete(`bm:${currentUrl}`); }
        else { const b = { url: currentUrl, title: (() => { try { return new URL(currentUrl).host; } catch { return currentUrl; } })() }; bookmarks.set(currentUrl, b); void app.data.kv.set(`bm:${currentUrl}`, b); }
        star.textContent = bookmarks.has(currentUrl) ? "★" : "☆";
      });

      // ── 서피스 생성 + 이벤트 배선 ──
      void (async () => {
        const first = await startUrl();
        const r = measureRect(cell);
        const out = await send({ type: "create", mode: "offscreen", scale: window.devicePixelRatio || 1, x: r.x, y: r.y, w: r.w, h: r.h, url: first });
        const id = out && typeof out.id === "number" ? (out.id as number) : null;
        if (id == null) { cell.textContent = "엔진 서피스 생성 실패"; return; }
        // 생성 중 unmount(disposed) 또는 더 새 mount 가 이 뷰를 넘겨받음(map 정체성 불일치) → 즉시 닫기.
        // 이 가드가 뷰당 서피스 1개를 보장해 스택 가림을 원천 차단한다.
        if (disposed || views.get(viewId) !== entry) { void send({ type: "close", id }); return; }
        surfaceId = id;
        entry.surfaceId = id;
        setUrlBar(first);
        // 새 링크 라우팅 정책을 엔진에 통지(tab=팝업 취소+popup-url 이벤트 / window=엔진 네이티브 팝업).
        void send({ type: "popup-mode", asWindow: newWindowMode() });
        stopFollow = follow(id);
        stopInput = forwardInput(cell, (m) => void send({ ...m, id }));
        const h = await engine();
        h.on("nav", (p) => { if (p.id === id && typeof p.url === "string") setUrlBar(p.url); });
        h.on("title", (p) => { if (p.id === id && typeof p.title === "string") vctx.setTitle?.(p.title); });
        h.on("cursor", (p) => { if (p.id === id) cell.style.cursor = String(p.type ?? "default"); });
        h.on("loading", (p) => {
          if (p.id !== id) return;
          loading = !!p.loading;
          canBack = !!p.canBack;
          canForward = !!p.canForward;
          applyNavState();
        });
        // 새 링크(target=_blank/window.open) — tab 모드에서 엔진이 popup-url 로 배달. 새 OSR 탭으로 연다.
        h.on("popup-url", (p) => {
          if (p.id !== id || typeof p.url !== "string") return;
          pendingUrl = p.url;
          void app.commands?.execute("view.open", { program: "browser-osr" }).then((o) => {
            if (!o?.ok) { pendingUrl = null; entry.navigate(normalizeUrl(p.url as string)); } // 실패 시 현재 뷰에서 이동(URL 유실 방지)
          });
        });
      })();

      (container as unknown as { __osrCleanup?: () => void }).__osrCleanup = teardown;
    },
    unmount(container) {
      const c = container as unknown as { __osrCleanup?: () => void };
      c.__osrCleanup?.();
      c.__osrCleanup = undefined;
    },
  };

  ctx.subscriptions.push(app.ui.registerView("content", provider));
}

export default { activate };
