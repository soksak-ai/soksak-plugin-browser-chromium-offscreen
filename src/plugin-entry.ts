// soksak-plugin-browser-osr — Chromium 엔진을 offscreen 모드(SIDECARS.md §8)로 구동하는 브라우저.
// windowed browser-chromium 플러그인과 같은 엔진·같은 프로토콜을 쓰되 mode:"offscreen" 으로 연다:
// 엔진이 창 없이 그려 공유 텍스처를 코어 소유 레이어에 present 하고, 이 뷰의 DOM 셀이 모든 입력을
// 받아 프로토콜(mouse/wheel/key/ime)로 포워딩한다. offscreen 호스팅 모드의 육안 측정용 참조 소비자.
//
// 결합은 매니페스트 sidecars[] 선언 + 메시지뿐(코어는 블라인드 릴레이) — 같은 스펙을 말하는 다른
// 엔진으로 교체 가능(약결합). eval 없음.
import { forwardInput } from "./input-forward";

// 코어 app.sidecar.open 반환(browser-chromium host 동형). 코어는 메시지 의미를 모른다(맹목 relay).
interface SidecarHandle {
  send: (msg: Record<string, unknown>) => Promise<Record<string, unknown>>;
  on: (event: string, cb: (payload: Record<string, unknown>) => void) => { dispose(): void };
  close: () => Promise<void>;
}
interface PluginApi {
  sidecar?: { open: (name: string) => Promise<SidecarHandle> };
  settings?: { get: (key: string) => unknown };
  ui: { registerView: (id: string, provider: ViewProvider) => { dispose(): void } };
}
interface ViewContext {
  viewId: string | null;
  setTitle?: (title: string) => void;
}
interface ViewProvider {
  mount(container: HTMLElement, ctx: ViewContext): void;
  unmount?(container: HTMLElement): void;
}
interface PluginContext {
  app: PluginApi;
  subscriptions: { push(d: { dispose(): void }): void };
}

// 통합 rect → 정수 스냅(네이티브 반올림 틈 방지). 같은 rect 면 skip(0 IPC).
function measureRect(el: HTMLElement): { x: number; y: number; w: number; h: number } {
  const r = el.getBoundingClientRect();
  const x = Math.ceil(r.left);
  const y = Math.ceil(r.top);
  return { x, y, w: Math.max(1, Math.floor(r.right) - x), h: Math.max(1, Math.floor(r.bottom) - y) };
}

function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return "about:blank";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith("about:")) return s;
  if (/^[^\s.]+\.[^\s]+/.test(s)) return `https://${s}`; // 도메인처럼 보이면 https 보정.
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`; // 아니면 검색.
}

function activate(ctx: PluginContext): void {
  const { app } = ctx;

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

  const provider: ViewProvider = {
    mount(container, vctx) {
      const viewId = vctx.viewId;
      if (!viewId) return;
      container.style.position = "absolute";
      container.style.inset = "0";
      container.style.display = "flex";
      container.style.flexDirection = "column";
      // 컨테이너는 투명해야 한다 — 셀(홀)이 메인 webview 아래 엔진 레이어를 비추려면 셀부터 webview
      // 루트까지 모든 DOM 층이 투명이어야 한다(불투명 배경을 두면 홀이 그 배경을 비춘다). 툴바만 자기
      // 불투명 배경을 갖는다.
      container.style.background = "transparent";

      // 툴바(URL 바 + 이동). 코어 CSS 변수로 테마 상속(하드코딩 금지 — A10).
      const bar = document.createElement("div");
      bar.style.cssText =
        "display:flex;gap:6px;padding:6px;flex:0 0 auto;background:var(--color-background-soft,#222)";
      const url = document.createElement("input");
      url.setAttribute("data-node", "urlbar");
      url.type = "text";
      url.placeholder = "URL 또는 검색어";
      url.style.cssText =
        "flex:1;padding:6px 10px;border-radius:6px;border:1px solid var(--color-border,#444);background:var(--color-background,#111);color:var(--color-text,#eee);font:13px system-ui";
      const go = document.createElement("button");
      go.setAttribute("data-node", "go");
      go.textContent = "이동";
      go.style.cssText =
        "padding:6px 12px;border-radius:6px;border:0;background:var(--color-accent,#3b82f6);color:#fff;font:13px system-ui;cursor:pointer";
      bar.append(url, go);

      // 투명 홀 셀 — 엔진 소유 레이어가 이 rect 뒤에서 비친다(매니페스트 transparent:true 와 짝).
      const cell = document.createElement("div");
      cell.setAttribute("data-node", "osr-cell");
      cell.style.cssText = "flex:1 1 auto;position:relative;overflow:hidden;background:transparent";
      container.append(bar, cell);

      const homeUrl = String(app.settings?.get("homeUrl") ?? "https://example.com");
      url.value = homeUrl;

      let surfaceId: number | null = null;
      let stopInput: (() => void) | null = null;
      let stopFollow: (() => void) | null = null;

      // bounds-follow — 셀 rect 를 엔진 서피스에 동기화(자기종료 rAF settle 루프).
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
          if (frames < STABLE) raf = requestAnimationFrame(tick);
          else raf = 0;
        };
        const arm = (): void => {
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

      function navigate(): void {
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
          x: r.x, y: r.y, w: r.w, h: r.h,
          url: normalizeUrl(homeUrl),
        });
        const id = out && typeof out.id === "number" ? (out.id as number) : null;
        if (id == null) {
          cell.textContent = "엔진 서피스 생성 실패";
          return;
        }
        surfaceId = id;
        stopFollow = follow(id);
        stopInput = forwardInput(cell, (m) => void send({ ...m, id }));
        // 엔진 이벤트 → UI 반영(주소·제목·커서). id 로 자기 것만 소비.
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

      // 언마운트 정리 — 뷰 컨테이너에 정리자를 매단다.
      (container as unknown as { __osrCleanup?: () => void }).__osrCleanup = () => {
        stopInput?.();
        stopFollow?.();
        if (surfaceId != null) void send({ type: "close", id: surfaceId });
      };
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
