// soksak-plugin-browser-chromium-offscreen — Chromium 엔진을 offscreen 모드(SIDECARS.md §8)로 구동하는 브라우저.
// windowed browser-chromium 과 같은 엔진(browser-chromium 사이드카)·같은 프로토콜을 쓰되
// mode:"offscreen" 으로 연다: 엔진이 창 없이 그려 공유 텍스처를 코어 소유 레이어에 present 하고,
// 이 뷰의 DOM 셀이 모든 입력을 받아 프로토콜(mouse/wheel/key/ime)로 포워딩한다. 코어는 메시지 의미를
// 모른다(맹목 relay) — 결합은 매니페스트 sidecars[] + 메시지뿐(약결합). eval 없음.
import {
  forwardInput,
  normalizeUrl,
  createLifecycle,
  reclaimTargets,
  createBrowserToolbar,
  domTextBody,
  domHtmlBody,
  domQueryBody,
  domClickBody,
  domFillBody,
  domSubmitBody,
  domWaitForBody,
} from "soksak-kit-browser-common";
import { browserStatus, type BrowserPhase } from "./status";

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
  // 호스트 표시 언어("ko" | "en") — 사람표면 문자열(status message) 해소용.
  locale?: () => string;
  ui: { registerView: (id: string, provider: ViewProvider) => Disposable };
  commands?: {
    register: (name: string, spec: CommandSpec) => Disposable;
    execute: (name: string, params?: Record<string, unknown>) => Promise<{ ok: boolean; [k: string]: unknown }>;
  };
  events: { on: (event: string, cb: (p: unknown) => void) => Disposable; progress?: (cmd: string, delta: unknown) => void };
  data?: { kv: KvApi };
}
interface ViewContext {
  viewId: string | null;
  setTitle?: (title: string) => void;
  // 탭 아이콘(콘텐츠 사실 — 파비콘 URL). 빈 값 = 해제(매니페스트 아이콘 폴백).
  setIcon?: (icon: string) => void;
  // 복원 seam(B3) — 복원 마운트면 setRestoreState 로 기록했던 상태. 새 뷰는 null.
  restore?: { cwd: string | null; state: unknown } | null;
  // 관찰 상태 보고(B3) — 뷰 레코드 영속. kv 에 viewId 키 영속 금지(재사용 충돌).
  setRestoreState?: (state: unknown) => void;
  // 뷰 status 축 보고 — {code,message} 또는 상태 없음(null). 사이드바 배치면 no-op(viewId null).
  setStatus?: (status: { code: string; message?: string } | null) => void;
}
interface ViewProvider {
  mount(container: HTMLElement, ctx: ViewContext): void;
  unmount?(container: HTMLElement): void;
  /** 줌 인텐트(코어 PLUGIN-CONTRACT §Zoom, 선택) — 페이지 줌으로 응답. */
  zoom?(container: HTMLElement, ctx: ViewContext, action: "in" | "out" | "reset"): void;
}
interface PluginContext { app: PluginApi; subscriptions: { push(d: Disposable): void } }

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────────────────────
function measureRect(el: HTMLElement): { x: number; y: number; w: number; h: number } {
  const r = el.getBoundingClientRect();
  const x = Math.ceil(r.left);
  const y = Math.ceil(r.top);
  return { x, y, w: Math.max(1, Math.floor(r.right) - x), h: Math.max(1, Math.floor(r.bottom) - y) };
}
// normalizeUrl 은 soksak-kit-browser-common 이 단일 진실(세 브라우저 공유).

// ── 뷰 레지스트리(커맨드가 활성/지정 뷰의 서피스에 접근) ────────────────────────────────────
interface ViewEntry {
  viewId: string;
  surfaceId: number | null;
  getUrl: () => string;
  navigate: (url: string) => void;
  teardown: () => void; // 서피스 close + 옵서버 해제 — 재mount/unmount 에서 멱등 호출
}
const views = new Map<string, ViewEntry>();
// 줌 합성 상태(§Zoom) — 창 배율(window.zoom 이벤트 캐시) × 뷰 배율. 유효 배율은 사이드카 zoom op 소비.
const pageZoom = new Map<string, number>();
let windowZoomFactor = 1;
// mount 재부착 판정 기록(진단 — stats 로 노출). 재부착 실패 원인 계측용.
const MOUNT_DECISIONS: Array<{ viewId: string; prior: number | null; alive: number[]; aliveOk: boolean }> = [];
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
const PLUGIN_ID = "soksak-plugin-browser-chromium-offscreen";
let pendingUrl: string | null = null;

// ── 재적재 생존 수명주기 — soksak-kit-browser-common 이 단일 진실(규칙·근거는 kit lifecycle 모듈 주석).
const lc = createLifecycle({ storagePrefix: "soksak-offscreen" });

export function activate(ctx: PluginContext): void {
  const { app } = ctx;

  // 레거시 vurl 원장 제거 — B3 restore.state 로 이관 완료. 원장은 죽은 뷰의 잔재를 남겨
  // 재사용 viewId 와 충돌했으므로(실측: 새 탭이 유령 URL 로 시작) 흡수 없이 폐기한다.
  if (app.data) {
    void app.data.kv
      .keys("vurl:")
      .then((ks) => { for (const k of ks) void app.data!.kv.delete(k); })
      .catch(() => {});
  }

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
      console.warn("[chromium-offscreen] sidecar send 실패:", e);
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

  // ── 유령 회수(reconcile) — 장부에 있고 엔진에 살아있는데 아무도 안 잡은 id 만 회수한다.
  // "잡음" = 이번 인스턴스의 뷰가 소유 / 재부착 지도에 대기(remount 가 곧 재부착) / close 디바운스 중.
  // grace 는 복원 remount 의 비동기 재부착이 끝날 시간(너무 일찍 회수하면 살아있는 서피스를 잘못 닫는다).
  const RECONCILE_GRACE_MS = 4000;
  const reconcileTimer = setTimeout(() => {
    void (async () => {
      const stats = await send({ type: "stats" });
      const alive = new Set(((stats?.ids as number[] | undefined) ?? []).map(Number));
      const claimed = new Set<number>([
        ...[...views.values()].map((v) => v.surfaceId).filter((x): x is number => x != null),
        ...lc.byviewValues(),
        ...lc.pendingCloseIds(),
      ]);
      // 회수 근거는 엔진의 소유 기록(stats.surfaces.owner) — 로컬 장부는 유실될 수 있어 근거가
      // 못 된다(실측: 장부 밖 언데드 서피스 잔존). 내 소유이면서 아무도 점유하지 않은 id 만 닫는다.
      const surfaces = stats?.surfaces as Array<{ id: number; owner: string }> | undefined;
      const reapPool = surfaces
        ? surfaces.filter((x) => x.owner === PLUGIN_ID).map((x) => x.id)
        : lc.ledgerRead(); // 구 엔진 폴백(owner 미지원) — 장부 기반, 장부 밖 언데드는 회수 불가
      if (!surfaces) console.warn("[chromium-offscreen] 엔진이 owner 를 모른다(구 dylib) — 장부 폴백 회수");
      for (const id of reapPool) {
        if (!alive.has(id)) { lc.ledgerRemove(id); continue; } // 엔진에 이미 없음 — 장부만 청소
        if (claimed.has(id)) continue;
        console.warn(`[chromium-offscreen] 유령 서피스 회수: id=${id}`);
        void send({ type: "close", id }).then((r) => { if (r && (r as { ok?: boolean }).ok) { lc.ledgerRemove(id); lc.claimRelease(id); } });
      }
    })();
  }, RECONCILE_GRACE_MS);
  ctx.subscriptions.push({ dispose: () => clearTimeout(reconcileTimer) });

  // ── 커맨드 등록(CLI/MCP — chromium 과 동형) ──
  if (app.commands) {
    const reg = (name: string, spec: CommandSpec) => ctx.subscriptions.push(app.commands!.register(name, spec));
    reg("ping", {
      description: "Load/version check — returns the plugin id and engine (E2E).",
      message: (d) => `${d.engine} 엔진(offscreen)이 응답합니다.`,
      handler: () => ({ ok: true, plugin: app.pluginId, engine: "chromium", mode: "offscreen" }),
    });
    reg("navigate", {
      description: "Navigate the active (or specified) offscreen browser view to a URL.",
      triggers: { ko: "이동 주소 열기 navigate chromium offscreen" },
      params: { viewId: { type: "string" }, url: { type: "string", description: "URL or search terms", required: true } },
      message: () => "페이지로 이동했습니다.",
      handler: (p) => {
        const e = resolveEntry(p.viewId as string | undefined);
        if (!e) return { ok: false, code: "NO_VIEW", message: "no browser view to act on" };
        const url = normalizeUrl(String(p.url ?? ""));
        app.events.progress?.("navigate", url);
        e.navigate(url);
        return { ok: true, viewId: e.viewId, url };
      },
    });
    const historyCmd = (name: string, msg: string) =>
      reg(name, {
        description: `Go ${name} in the active (or specified) offscreen view's session history.`,
        params: { viewId: { type: "string" } },
        message: () => msg,
        handler: (p) => {
          const e = resolveEntry(p.viewId as string | undefined);
          if (!e || e.surfaceId == null) return { ok: false, code: "NO_VIEW", message: "no browser view to act on" };
          void send({ type: name, id: e.surfaceId });
          return { ok: true, viewId: e.viewId };
        },
      });
    historyCmd("back", "뒤로 이동했습니다.");
    historyCmd("forward", "앞으로 이동했습니다.");
    reg("reload", {
      description: "Reload the current page of the active (or specified) offscreen view.",
      params: { viewId: { type: "string" }, ignoreCache: { type: "boolean" } },
      message: () => "새로고침했습니다.",
      handler: (p) => {
        const e = resolveEntry(p.viewId as string | undefined);
        if (!e || e.surfaceId == null) return { ok: false, code: "NO_VIEW", message: "no browser view to act on" };
        void send({ type: "reload", id: e.surfaceId, ignoreCache: !!p.ignoreCache });
        return { ok: true, viewId: e.viewId };
      },
    });
    reg("stop", {
      description: "Stop loading the active (or specified) offscreen view.",
      params: { viewId: { type: "string" } },
      message: () => "로딩을 정지했습니다.",
      handler: (p) => {
        const e = resolveEntry(p.viewId as string | undefined);
        if (!e || e.surfaceId == null) return { ok: false, code: "NO_VIEW", message: "no browser view to act on" };
        void send({ type: "stop", id: e.surfaceId });
        return { ok: true, viewId: e.viewId };
      },
    });
    reg("home", {
      description: "Navigate the active (or specified) offscreen view to the configured home URL.",
      params: { viewId: { type: "string" } },
      message: () => "홈으로 이동했습니다.",
      handler: (p) => {
        const e = resolveEntry(p.viewId as string | undefined);
        if (!e) return { ok: false, code: "NO_VIEW", message: "no browser view to act on" };
        const url = normalizeUrl(String(app.settings?.get("homeUrl") ?? "https://example.com"));
        e.navigate(url);
        return { ok: true, viewId: e.viewId, url };
      },
    });
    reg("open", {
      description: "Open a new offscreen browser tab (optionally at a URL).",
      params: { url: { type: "string" } },
      message: () => "새 offscreen 브라우저 탭을 열었습니다.",
      handler: async (p) => {
        if (p.url) pendingUrl = normalizeUrl(String(p.url));
        app.events.progress?.("open", pendingUrl ?? "");
        const out = await app.commands!.execute("view.open", { program: "browser-chromium-offscreen" });
        if (!out.ok) return { ok: false, code: "VIEW_OPEN_FAILED", message: "view.open 실패" };
        // 코어 명령의 답은 봉투다 — 사실은 data 안에 있다(MESSAGE-PROTOCOL). 평면으로 읽으면 뷰는
        // 열리는데 그 뷰의 id 를 아무도 못 받고, 소비자가 그 뷰를 다시 가리킬 방법이 사라진다.
        const opened = ((out.data ?? out) as { viewId?: string }).viewId;
        return { ok: true, viewId: opened };
      },
    });
    // ── eval/dom.* — 엔진 eval verb(스펙 §8) 소비. 결과는 eval-result 이벤트(비동기)로 회수한다.
    // 스니펫 본문은 kit 단일 소스 — 세 브라우저의 dom 커맨드 행동(AI/E2E 계약)이 동일해진다.
    const pendingEvals = new Map<number, (r: { ok: boolean; value: unknown }) => void>();
    let evalWired = false;
    async function evalOnEntry(
      e: { surfaceId: number | null; viewId: string },
      body: string,
      timeoutMs = 10000,
    ): Promise<{ ok: boolean; value: unknown; notReady?: boolean; engineError?: boolean }> {
      // 뷰는 있는데 그릴 문서가 아직 없다 — 페이지의 예외와 다른 사실이므로 다른 코드다.
      if (e.surfaceId == null) return { ok: false, notReady: true, value: "서피스 생성 중" };
      const h = await engine();
      if (!evalWired) {
        evalWired = true;
        h.on("eval-result", (p) => {
          const cb = typeof p.evalId === "number" ? pendingEvals.get(p.evalId as number) : undefined;
          if (cb) cb({ ok: !!p.ok, value: p.value });
        });
      }
      // 엔진이 답하지 않거나 이 verb 를 모를 수 있다. 그것은 던질 일이 아니라 답할 일이다 —
      // 계약은 모든 명령이 봉투로 답하기를 요구한다(§4). 여기서 던지면 소비자는 INTERNAL 만 본다.
      const out = (await send({ type: "eval", id: e.surfaceId, js: body }).catch(() => null)) as
        | { evalId?: number; error?: string }
        | null;
      const evalId = out?.evalId;
      if (typeof evalId !== "number") {
        return { ok: false, engineError: true, value: String(out?.error ?? "엔진이 eval 에 답하지 않았다") };
      }
      return await new Promise((resolve) => {
        const t = setTimeout(() => {
          pendingEvals.delete(evalId);
          resolve({ ok: false, value: "eval 응답 시간 초과" });
        }, timeoutMs);
        pendingEvals.set(evalId, (r) => {
          clearTimeout(t);
          pendingEvals.delete(evalId);
          resolve(r);
        });
      });
    }
    // dom.* 공통 실행기 — 타겟 해석 + eval + {ok, ...결과} 포장(native 와 동일 반환 형태).
    async function runDom(
      p: Record<string, unknown>,
      body: string,
      timeoutMs?: number,
      key = "value",
    ): Promise<Record<string, unknown>> {
      const e = resolveEntry(p.viewId as string | undefined);
      if (!e) return { ok: false, code: "NO_VIEW", message: "no browser view to act on" };
      const r = await evalOnEntry(e, body, timeoutMs);
      if (!r.ok) return pageFailure(r, e.viewId);
      const v = r.value;
      if (v && typeof v === "object" && !Array.isArray(v)) return { ok: true, ...(v as object), viewId: e.viewId };
      return { ok: true, [key]: v, viewId: e.viewId };
    }

    // 페이지 쪽 실패의 세 얼굴을 하나로 뭉개지 않는다: 문서가 아직 없다 / 페이지가 던졌다.
    // 페이지의 원문은 data.detail 로 가고, message 는 사람이 읽을 문장으로 남는다.
    function pageFailure(
      r: { value: unknown; notReady?: boolean; engineError?: boolean },
      viewId: string,
    ): Record<string, unknown> {
      // 엔진이 이 능력을 내주지 못하는 것은 페이지의 잘못이 아니다 — 페이지의 예외와 다른 사실이다.
      if (r.engineError) {
        return { ok: false, code: "ENGINE_ERROR", message: "브라우저 엔진이 이 요청을 처리하지 못했습니다.", data: { detail: String(r.value), viewId } };
      }
      if (r.notReady) {
        return { ok: false, code: "NOT_READY", message: "페이지가 아직 준비되지 않았습니다.", data: { detail: String(r.value), viewId } };
      }
      return { ok: false, code: "SCRIPT_ERROR", message: "페이지가 스크립트를 거부했습니다.", data: { detail: String(r.value), viewId } };
    }

    reg("eval", {
      description:
        "Run JavaScript in the page (async function body; return a JSON-serializable value).",
      triggers: { ko: "자바스크립트 실행 페이지 스크립트 eval" },
      params: {
        js: { type: "string", description: "JS body — must return a JSON-serializable value", required: true },
        viewId: { type: "string" },
      },
      handler: async (p) => {
        const e = resolveEntry(p.viewId as string | undefined);
        if (!e) return { ok: false, code: "NO_VIEW", message: "no browser view to act on" };
        const r = await evalOnEntry(e, String(p.js ?? ""));
        return r.ok ? { ok: true, value: r.value, viewId: e.viewId } : pageFailure(r, e.viewId);
      },
    });
    reg("dom.text", {
      description: "Get the visible text of the page or a specific selector element.",
      triggers: { ko: "DOM 텍스트 읽기 페이지 텍스트 선택자 텍스트" },
      params: {
        selector: { type: "string", description: "CSS selector (omit = entire body)" },
        maxLength: { type: "number", description: "Max character length" },
        viewId: { type: "string" },
      },
      handler: (p) =>
        runDom(p, domTextBody(p.selector ? String(p.selector) : undefined, typeof p.maxLength === "number" ? p.maxLength : 20000), undefined, "text"),
    });
    reg("dom.html", {
      description: "Get the HTML of the page or a specific selector element.",
      triggers: { ko: "DOM HTML 읽기 페이지 소스" },
      params: {
        selector: { type: "string", description: "CSS selector (omit = entire document)" },
        maxLength: { type: "number", description: "Max character length" },
        viewId: { type: "string" },
      },
      handler: (p) =>
        runDom(p, domHtmlBody(p.selector ? String(p.selector) : undefined, typeof p.maxLength === "number" ? p.maxLength : 20000), undefined, "html"),
    });
    reg("dom.query", {
      description:
        "Summarize matching elements (tag / text / attributes) for a CSS selector — use to understand page structure.",
      triggers: { ko: "DOM 요소 조회 선택자 매칭 구조 파악" },
      params: {
        selector: { type: "string", description: "CSS selector", required: true },
        limit: { type: "number", description: "Max element count" },
        viewId: { type: "string" },
      },
      handler: (p) =>
        runDom(p, domQueryBody(String(p.selector), typeof p.limit === "number" ? p.limit : 20)),
    });
    reg("dom.click", {
      description: "Click the first element matching a CSS selector.",
      triggers: { ko: "DOM 클릭 버튼 클릭 링크 클릭 페이지 클릭" },
      params: { selector: { type: "string", description: "CSS selector", required: true }, viewId: { type: "string" } },
      handler: (p) => runDom(p, domClickBody(String(p.selector))),
    });
    reg("dom.fill", {
      description:
        "Fill an input element with a value (fires input/change events — React form compatible).",
      triggers: { ko: "DOM 입력 채우기 폼 입력 텍스트 입력 필드 채우기" },
      params: {
        selector: { type: "string", description: "CSS selector", required: true },
        value: { type: "string", description: "Value to enter" },
        // 폼 컨트롤에 넣는 것의 이름은 value 다. text 는 옛 이름이고, 그 이름으로 부르던 호출자를
        // 깨지 않기 위해 받아만 준다. 하나는 반드시 와야 한다.
        text: { type: "string", description: "Value to enter (alias of value)" },
        viewId: { type: "string" },
      },
      handler: (p) => {
        const given = typeof p.value === "string" ? p.value : typeof p.text === "string" ? p.text : null;
        if (given === null) {
          return Promise.resolve({ ok: false, code: "INVALID_PARAMS", message: "채울 값이 없습니다(value)." });
        }
        return runDom(p, domFillBody(String(p.selector), given));
      },
    });
    reg("dom.submit", {
      description: "Submit a form (selector can be the form element or any element inside it).",
      triggers: { ko: "폼 제출 submit 전송 양식 제출" },
      params: { selector: { type: "string", description: "CSS selector", required: true }, viewId: { type: "string" } },
      handler: (p) => runDom(p, domSubmitBody(String(p.selector))),
    });
    reg("dom.wait-for", {
      description: "Wait until a selector appears on the page (dynamic pages — uses MutationObserver).",
      triggers: { ko: "요소 대기 나타날 때까지 기다리기 동적 로딩 대기" },
      params: {
        selector: { type: "string", description: "CSS selector", required: true },
        timeoutMs: { type: "number", description: "Max wait time (ms)" },
        viewId: { type: "string" },
      },
      handler: (p) => {
        const t = typeof p.timeoutMs === "number" ? p.timeoutMs : 5000;
        return runDom(p, domWaitForBody(String(p.selector), t), t + 5000);
      },
    });

    reg("surface.close", {
      description: "Close one engine surface by id (diagnostics). Cleans the ledger and the reattach map entry that points to it. The owning view recreates its surface on next remount.",
      params: { id: { type: "number", required: true, description: "engine surface id (see stats)" } },
      handler: async (p) => {
        const id = Number((p as { id?: unknown }).id);
        if (!Number.isFinite(id)) return { ok: false, error: "id 필요" };
        const r = await send({ type: "close", id });
        if (r && (r as { ok?: boolean }).ok) { lc.ledgerRemove(id); lc.claimRelease(id); }
        for (const [vid, sid] of [...views.entries()].map((e) => [e[0], e[1].surfaceId] as const)) {
          if (sid === id) views.get(vid)!.surfaceId = null;
        }
        for (const [vid, sid] of lc.byviewEntries()) {
          if (sid === id) lc.byviewDelete(vid);
        }
        return { ok: true, closed: id };
      },
    });
    reg("stats", {
      description: "offscreen view surface ids + engine dbg (framesPresented — proves the shared-texture present path is alive).",
      message: (d) => `offscreen 서피스 ${(d.ids as unknown[] | undefined)?.length ?? 0}개, present ${(d.engine as { dbg?: { framesPresented?: number } } | undefined)?.dbg?.framesPresented ?? "?"}프레임.`,
      handler: async () => ({
        ok: true,
        ids: [...views.values()].map((v) => ({ viewId: v.viewId, surfaceId: v.surfaceId, url: v.getUrl() })),
        ledger: lc.ledgerRead(), // 유령 방지 장부 스냅샷 — chromium 어댑터 stats 와 동형 진단
        mountDecisions: MOUNT_DECISIONS.slice(-10), // 재부착 판정 기록(진단)
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

      // 뷰 status 축 보고 — 이 뷰의 진짜 상태(로딩·준비·오류)만. message 는 호스트 언어로 해소.
      const reportStatus = (phase: BrowserPhase): void =>
        vctx.setStatus?.(browserStatus(phase, app.locale?.() ?? "en"));

      // 멱등 mount — 호스트는 같은 뷰를 재부모/재활성 시 다시 mount 할 수 있다. 이전 서피스를 먼저 닫지
      // 않으면 offscreen NSView 들이 창 content view 아래 스택으로 쌓여(같은 부모·겹친 bounds) 옛 프레임이
      // 활성 셀을 가린다(실측: 활성 탭에 옛 페이지가 남는 stale). 재mount 전 이전 뷰를 확실히 회수한다.
      views.get(viewId)?.teardown();
      container.replaceChildren();

      container.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;background:transparent";

      const homeUrl = (): string => normalizeUrl(String(app.settings?.get("homeUrl") ?? "https://example.com"));
      // ── 툴바 — 공용 구현(soksak-kit-browser-common createBrowserToolbar): 세 브라우저 동일 DOM·노드·외형 ──
      const tb = createBrowserToolbar(container, {
        onNavigate: (raw) => entry.navigate(normalizeUrl(raw)),
        onBack: () => { if (surfaceId != null) void send({ type: "back", id: surfaceId }); },
        onForward: () => { if (surfaceId != null) void send({ type: "forward", id: surfaceId }); },
        onReload: () => { if (surfaceId != null) void send({ type: "reload", id: surfaceId }); },
        onStop: () => { if (surfaceId != null) void send({ type: "stop", id: surfaceId }); },
        onHome: () => entry.navigate(homeUrl()),
        onBookmarkToggle: () => {
          if (!app.data || !currentUrl || currentUrl === "about:blank") return;
          // 낙관적 즉시 반영 — 공유 map·글리프를 지금 갱신하고 kv 는 비동기로 뒤따른다(kv.watch 재조정은 멱등).
          if (bookmarks.has(currentUrl)) { bookmarks.delete(currentUrl); void app.data.kv.delete(`bm:${currentUrl}`); }
          else { const b = { url: currentUrl, title: (() => { try { return new URL(currentUrl).host; } catch { return currentUrl; } })() }; bookmarks.set(currentUrl, b); void app.data.kv.set(`bm:${currentUrl}`, b); }
          tb.setBookmarked(bookmarks.has(currentUrl));
        },
      });

      // ── 투명 홀 셀 ──
      const cell = document.createElement("div");
      cell.setAttribute("data-node", "offscreen-cell");
      cell.style.cssText = "flex:1 1 auto;position:relative;overflow:hidden;background:transparent";
      container.append(cell);

      let surfaceId: number | null = null;
      let currentUrl = "about:blank";
      let stopInput: (() => void) | null = null;
      let stopFollow: (() => void) | null = null;
      let disposed = false;


      const teardown = (): void => {
        if (disposed) return;
        disposed = true;
        if (views.get(viewId) === entry) views.delete(viewId);
        if (activeViewId === viewId) activeViewId = null;
        stopInput?.();
        stopFollow?.();
        if (surfaceId != null) {
          const id = surfaceId;
          // 즉시 숨김(탭은 닫힌 확정 상태 — 서피스가 화면에 남으면 안 된다) 후 close 는 디바운스:
          // remount(재부모화·재적재 재부착)가 취소하고 재사용한다. 장부는 close 가 확인된 때에만 지운다.
          void send({ type: "hidden", id, hidden: true });
          lc.scheduleClose(id, () => {
            // 지도 삭제는 "여전히 이 id 를 가리킬 때만" — 새 인스턴스가 같은 viewId 에 새 서피스를
            // 매핑한 뒤라면 그 매핑을 지우면 안 된다(실측: 무조건 삭제가 매 라운드 지도를 증발시켜
            // 재부착이 영원히 불가능한 create 루프를 만들었다).
            if (lc.byviewGet(viewId) === id) lc.byviewDelete(viewId);
            void send({ type: "close", id }).then((r) => { if (r && (r as { ok?: boolean }).ok) { lc.ledgerRemove(id); lc.claimRelease(id); } });
          });
        }
        surfaceId = null;
      };
      const entry: ViewEntry = {
        viewId,
        surfaceId: null,
        getUrl: () => currentUrl,
        navigate: (u) => { tb.setUrl(u); currentUrl = u; if (surfaceId != null) void send({ type: "load", id: surfaceId, url: u }); },
        teardown,
      };
      views.set(viewId, entry);

      function setUrlBar(u: string): void {
        currentUrl = u;
        tb.setUrl(u);
        tb.setBookmarked(bookmarks.has(u));
        // 복원용 URL 영속(B3 restore.state) — 뷰 레코드에 실려 뷰와 수명을 같이한다.
        // 플러그인 kv(vurl:viewId) 영속은 폐기 — viewId 재사용이 죽은 뷰의 잔재를 유입시킨다.
        if (u && u !== "about:blank") vctx.setRestoreState?.({ url: u });
      }

      // ── 시작 URL 우선순위: pending → 복원(B3 restore.state) → homeUrl → about:blank ──
      function startUrl(): string {
        if (pendingUrl) { const u = pendingUrl; pendingUrl = null; return normalizeUrl(u); }
        const rs = vctx.restore?.state as { url?: string } | null | undefined;
        if (typeof rs?.url === "string" && rs.url) return normalizeUrl(rs.url);
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
        // 탭/시트 파킹 — 1차 신호는 코어 view.parked(유효 가시성의 단일 소유). IO 는 안전망
        // (코어 신호가 못 덮는 레이아웃 변화·초기 상태)으로 유지한다. 둘 다 멱등(hidden 토글).
        const offPark = app.events.on("view.parked", (p) => {
          const q = p as { viewId?: string; parked?: boolean };
          if (q.viewId !== viewId) return;
          void send({ type: "hidden", id, hidden: !!q.parked });
          if (!q.parked) { lastKey = ""; arm(); }
        });
        const io = new IntersectionObserver((entries) => {
          const visible = entries.some((e) => e.isIntersecting);
          void send({ type: "hidden", id, hidden: !visible });
          if (visible) { lastKey = ""; arm(); }
        });
        io.observe(cell);
        arm();
        return () => { offPark.dispose(); ro.disconnect(); io.disconnect(); window.removeEventListener("resize", arm); if (raf) cancelAnimationFrame(raf); };
      }

      // ── 재부착 후보 — 이전 인스턴스/이전 mount 가 이 viewId 로 만든 서피스(페이지 상태 보존).
      // 디바운스 중인 close 가 있으면 취소하고 재사용한다(remount = 재부모화·재적재).
      const priorId = lc.byviewGet(viewId);
      if (priorId != null) lc.reattach(priorId); // 디바운스 중이면 취소하고 재사용

      // ── 서피스 재부착 또는 생성 + 이벤트 배선 ──
      void (async () => {
        let id: number;
        // 재부착 대상 생존 검증 — 옛 인스턴스의 디바운스 close 가 이겨 이미 죽었을 수 있다
        // (claim 도입 전 잔재 + 만일의 leak). 죽은 id 재부착은 빈 화면 좀비를 만든다(실측).
        let prior: number | null = priorId ?? null;
        if (prior != null) {
          const st = await send({ type: "stats" });
          const alive = new Set((((st as { ids?: number[] }).ids) ?? []).map(Number));
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
          // 재부착 — 엔진 child 는 살아있음을 위에서 확인했다. create 없이 재부착만 한다.
          id = prior;
          const rs = vctx.restore?.state as { url?: string } | null | undefined;
          if (typeof rs?.url === "string" && rs.url) { currentUrl = rs.url; tb.setUrl(rs.url); }
        } else {
          const first = startUrl();
          const r = measureRect(cell);
          const out = await send({ type: "create", mode: "offscreen", owner: PLUGIN_ID, scale: window.devicePixelRatio || 1, x: r.x, y: r.y, w: r.w, h: r.h, url: first });
          const created = out && typeof out.id === "number" ? (out.id as number) : null;
          if (created == null) { cell.textContent = "엔진 서피스 생성 실패"; reportStatus("error"); return; }
          id = created;
          lc.ledgerAdd(id); // 생성 장부 — close 확인 시 지워지고, reconcile 이 잔여를 회수
          lc.byviewSet(viewId, id); // 재부착 지도 — 재적재 후 이 뷰가 같은 서피스를 되찾는다
          lc.claim(id); // 소유 기록 — 인스턴스 경계의 close 경합 방벽(발화 시점 재확인용)
          setUrlBar(first);
        }
        // 생성/재부착 중 unmount(disposed) 또는 더 새 mount 가 이 뷰를 넘겨받음(map 정체성 불일치) →
        // 소유하지 않는다. 이 가드가 뷰당 서피스 1개를 보장해 스택 가림을 원천 차단한다.
        if (disposed || views.get(viewId) !== entry) {
          if (prior == null) {
            void send({ type: "close", id }).then((r2) => { if (r2 && (r2 as { ok?: boolean }).ok) { lc.ledgerRemove(id); lc.claimRelease(id); } });
            if (lc.byviewGet(viewId) === id) lc.byviewDelete(viewId); // 같은 가드 — 이긴 mount 의 매핑 보호
          }
          return;
        }
        surfaceId = id;
        entry.surfaceId = id;
        // 초기 status — 새로 만든 서피스는 시작 URL 로딩 중, 재부착 서피스는 이미 로드된 idle(준비).
        // 이후 전이는 loading 이벤트가 단일 소스로 동기화한다. 재부착 시 이전 mount 의 stale 로딩도 이때 해소.
        reportStatus(prior != null ? "ready" : "loading");
        // 재부착된 서피스는 teardown 이 숨겨놨을 수 있다 — 재부착 시 다시 보이게.
        if (prior != null) void send({ type: "hidden", id, hidden: false });
        // 새 링크 라우팅 정책을 엔진에 통지(tab=팝업 취소+popup-url 이벤트 / window=엔진 네이티브 팝업).
        void send({ type: "popup-mode", asWindow: newWindowMode() });
        stopFollow = follow(id);
        stopInput = forwardInput(cell, (m) => void send({ ...m, id }));
        const h = await engine();
        h.on("nav", (p) => { if (p.id === id && typeof p.url === "string") setUrlBar(p.url); });
        h.on("title", (p) => { if (p.id === id && typeof p.title === "string") vctx.setTitle?.(p.title); });
        // 파비콘 — title 동형의 콘텐츠 사실. 빈 url(파비콘 없는 페이지)도 그대로 보고해 이전
        // 페이지의 stale 아이콘이 남지 않게 한다(해제).
        h.on("favicon", (p) => {
          if (p.id !== id || typeof p.url !== "string") return;
          // CEF 는 파비콘 없는 페이지에 "data:," 를 준다 — 사실은 "없음"이므로 해제로 정규화.
          vctx.setIcon?.(p.url === "data:," ? "" : p.url);
        });
        h.on("cursor", (p) => { if (p.id === id) cell.style.cursor = String(p.type ?? "default"); });
        h.on("loading", (p) => {
          if (p.id !== id) return;
          tb.setNavState({ loading: !!p.loading, canBack: !!p.canBack, canForward: !!p.canForward });
          // loading 이벤트 = 로딩·준비 전이의 단일 소스. 로딩 중 = code loading(표시 전용), 끝 = 상태 없음(null).
          reportStatus(p.loading ? "loading" : "ready");
        });
        // 새 링크(target=_blank/window.open) — tab 모드에서 엔진이 popup-url 로 배달. 새 offscreen 탭으로 연다.
        h.on("popup-url", (p) => {
          if (p.id !== id || typeof p.url !== "string") return;
          pendingUrl = p.url;
          void app.commands?.execute("view.open", { program: "browser-chromium-offscreen" }).then((o) => {
            if (!o?.ok) { pendingUrl = null; entry.navigate(normalizeUrl(p.url as string)); } // 실패 시 현재 뷰에서 이동(URL 유실 방지)
          });
        });
      })();

      (container as unknown as { __offscreenCleanup?: () => void }).__offscreenCleanup = teardown;
    },
    zoom(_container, vctx, action) {
      const viewId = vctx.viewId;
      if (!viewId) return;
      const e = views.get(viewId);
      if (!e || e.surfaceId == null) return;
      const cur = pageZoom.get(viewId) ?? 1;
      const next =
        action === "reset"
          ? 1
          : Math.max(0.25, Math.min(4, Math.round((cur + (action === "in" ? 0.1 : -0.1)) * 100) / 100));
      pageZoom.set(viewId, next);
      void send({ type: "zoom", id: e.surfaceId, factor: windowZoomFactor * next });
    },
    unmount(container) {
      const c = container as unknown as { __offscreenCleanup?: () => void };
      c.__offscreenCleanup?.();
      c.__offscreenCleanup = undefined;
    },
  };

  ctx.subscriptions.push(app.ui.registerView("content", provider));
  // 창 줌 방송 소비 — 전 라이브 서피스에 합성 배율 재적용(§Zoom).
  ctx.subscriptions.push(
    app.events.on("window.zoom", (p) => {
      windowZoomFactor = Number((p as { factor?: number }).factor ?? 1) || 1;
      for (const [viewId, e] of views) {
        if (e.surfaceId == null) continue;
        void send({ type: "zoom", id: e.surfaceId, factor: windowZoomFactor * (pageZoom.get(viewId) ?? 1) });
      }
    }),
  );
}

export default { activate };
