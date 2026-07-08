// 입력 포워딩(SIDECARS.md §8 offscreen) — offscreen 셀은 코어 hitTest 에 뚫리지 않으므로 DOM 이
// 모든 입력을 소유하고, 이 모듈이 그것을 프로토콜 메시지(mouse/wheel/key/ime/focus)로 변환한다.
// 좌표는 표면-로컬 CSS px(엔진 DIP 와 동일 단위). 키보드·한글 조합은 숨김 편집 프록시가 받는다 —
// 앱 웹뷰의 네이티브 IME(NSTextInputClient)가 조합을 만들고 composition 이벤트를 ime 메시지로
// 브리지한다(합성 키 이벤트로 조합을 흉내내는 것 금지 — 스펙 §8).
//
// send 는 표면 id 가 이미 바인딩된 전송자 — 이 모듈은 {type, ...} 만 만든다(테스트 가능 경계).

export type SendInput = (msg: Record<string, unknown>) => void;

function modsOf(e: MouseEvent | KeyboardEvent): number {
  return (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
}

export function forwardInput(container: HTMLElement, send: SendInput): () => void {
  const pt = (e: MouseEvent): { x: number; y: number } => {
    const r = container.getBoundingClientRect();
    return { x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top) };
  };

  // 숨김 편집 프록시 — 키보드·조합의 수신처(포커스는 mousedown 이 확보).
  const proxy = document.createElement("input");
  proxy.type = "text";
  proxy.setAttribute("aria-hidden", "true");
  proxy.style.cssText =
    "position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;border:0;padding:0;pointer-events:none;";
  container.appendChild(proxy);

  // mousemove 코얼레싱 — 이벤트 레이트(120Hz+)를 프레임당 1회로 줄인다(최신만 유효).
  let moveRaf = 0;
  let lastMove: { x: number; y: number; mods: number } | null = null;
  const flushMove = (): void => {
    moveRaf = 0;
    if (!lastMove) return;
    const m = lastMove;
    lastMove = null;
    send({ type: "mouse", kind: "move", x: m.x, y: m.y, mods: m.mods });
  };
  const onMove = (e: MouseEvent): void => {
    lastMove = { ...pt(e), mods: modsOf(e) };
    if (!moveRaf) moveRaf = requestAnimationFrame(flushMove);
  };
  const onDown = (e: MouseEvent): void => {
    e.preventDefault(); // 앱 웹뷰의 텍스트 선택/포커스 이동 차단 — 입력의 주인은 표면.
    proxy.focus({ preventScroll: true }); // 키보드·조합 수신처 확보.
    const p = pt(e);
    send({ type: "focus" });
    send({
      type: "mouse", kind: "down", x: p.x, y: p.y,
      button: e.button === 1 ? 1 : e.button === 2 ? 2 : 0,
      clicks: Math.max(1, e.detail), mods: modsOf(e),
    });
  };
  const onUp = (e: MouseEvent): void => {
    const p = pt(e);
    send({
      type: "mouse", kind: "up", x: p.x, y: p.y,
      button: e.button === 1 ? 1 : e.button === 2 ? 2 : 0,
      clicks: Math.max(1, e.detail), mods: modsOf(e),
    });
  };
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault(); // 앱 웹뷰 스크롤 차단 — 델타는 표면으로(부호 변환은 엔진 소유).
    const p = pt(e);
    send({ type: "wheel", x: p.x, y: p.y, dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) });
  };
  const onContext = (e: MouseEvent): void => e.preventDefault();

  // 키보드 — 조합 중(229/isComposing)은 IME 경로가 소유하므로 key 포워딩을 건너뛴다.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    const mods = modsOf(e);
    send({ type: "key", kind: "down", code: e.keyCode, mods });
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      send({ type: "key", kind: "char", code: e.keyCode, char: e.key, mods });
    }
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.isComposing || e.keyCode === 229) return;
    send({ type: "key", kind: "up", code: e.keyCode, mods: modsOf(e) });
  };
  // 한글 조합 브리지 — 조합 중 백스페이스·재조합은 compositionupdate 의 짧아진 text 로 자연 반영된다.
  // caret 은 JS 문자열 인덱스(UTF-16) = 엔진 범위 단위와 동일.
  const onCompStart = (): void => {
    send({ type: "ime", kind: "set", text: "", caret: 0 });
  };
  const onCompUpdate = (e: CompositionEvent): void => {
    const text = e.data ?? "";
    send({ type: "ime", kind: "set", text, caret: text.length });
  };
  const onCompEnd = (e: CompositionEvent): void => {
    const text = e.data ?? "";
    proxy.value = ""; // 프록시 잔여값 청소 — 다음 조합의 오염 방지.
    if (text) send({ type: "ime", kind: "commit", text });
    else send({ type: "ime", kind: "cancel" });
  };
  const onBlur = (): void => {
    send({ type: "ime", kind: "finish" }); // 포커스 이탈 — 미완 조합을 확정.
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
