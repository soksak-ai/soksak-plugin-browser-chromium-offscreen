// 입력 포워딩(SIDECARS.md §8 offscreen) — offscreen 셀은 코어 hitTest 에 뚫리지 않으므로 DOM 이
// 모든 입력을 소유하고, 이 모듈이 그것을 프로토콜 메시지(mouse/wheel/key/ime/focus)로 변환한다.
// 좌표는 표면-로컬 CSS px(엔진 DIP 와 동일 단위). 키보드·한글 조합은 투명 편집 프록시가 받는다 —
// 앱 웹뷰의 네이티브 IME(NSTextInputClient)가 조합을 만든다. WKWebView 는 한글을 composition 이벤트가
// 아니라 input(insertReplacementText/insertText) 으로 내므로(WebKit bug 274700) 그 경로를 잡아 ime
// 메시지로 브리지한다(합성 키 이벤트로 조합을 흉내내는 것 금지 — 스펙 §8).
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
  // 실제로 렌더되되 눈엔 안 보이게(투명 글자·캐럿·배경) — opacity:0/1px 은 WKWebView 가 "렌더 안 됨"으로
  // 보고 IME 조합(compositionstart/update)을 아예 안 엮는다(실측: keydown 229 만 오고 composition 0).
  // 뷰포트 안 실크기 요소라야 macOS IME 가 조합을 건다. caret 위치로 이동시켜 후보창을 텍스트 옆에 띄운다.
  proxy.style.cssText =
    "position:absolute;left:0;top:0;width:2em;height:1.4em;border:0;padding:0;margin:0;" +
    "background:transparent;color:transparent;caret-color:transparent;outline:none;pointer-events:none;";
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

  // ── 한글/CJK IME 브리지 (WebKit bug 274700 — src/vendor/xterm-addon-webkit-ime 확인) ──
  // WKWebView 는 한글 IME 를 두 경로로 낸다:
  //   표준   : compositionstart/update/end 발화.
  //   비표준 : composition 이벤트 없음. input(insertReplacementText=조합 갱신, insertText Hangul=음절)로 온다.
  // 실측상 이 프록시는 비표준 경로다(로그: keydown 229 만 오고 composition 0). 두 경로 모두 pending
  // 음절을 추적해 CEF ime_set(조합 preedit)/ime_commit(확정)으로 브리지한다.
  let composing = false;
  let pending = "";
  const isHangul = (s: string): boolean => {
    const cp = s ? (s.codePointAt(0) ?? 0) : 0;
    return (
      (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x3130 && cp <= 0x318f) ||
      (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0xa960 && cp <= 0xa97f) || (cp >= 0xd7b0 && cp <= 0xd7ff)
    );
  };
  const setPreedit = (text: string): void => {
    // 조합 시작 시 브라우저 포커스를 재확인한다 — CEF OSR 은 ime_set_composition 이 먹으려면 SetFocus(1)
    // 로 IME 컨텍스트가 켜져 있어야 한다(imetest 직접 주입은 focus 를 먼저 보내 성공했으나, 실제 흐름은
    // 클릭 때만 보내 조합 시점엔 꺼져 있었다 — ASCII 는 send_key_event 라 무관하게 들어갔다).
    if (!composing && text.length > 0) send({ type: "focus" });
    composing = text.length > 0;
    pending = text;
    send({ type: "ime", kind: "set", text, caret: text.length });
  };
  const commitPending = (): void => {
    if (!composing) return;
    const t = pending;
    composing = false;
    pending = "";
    if (t) send({ type: "ime", kind: "commit", text: t });
  };
  const clearComposition = (): void => {
    composing = false;
    pending = "";
    send({ type: "ime", kind: "set", text: "", caret: 0 });
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    // 조합 중 비-IME 키(스페이스·엔터·ASCII 등)는 pending 을 먼저 확정한 뒤 그 키를 포워딩한다.
    if (composing && !e.isComposing && e.keyCode !== 229) commitPending();
    if (e.isComposing || e.keyCode === 229) return; // IME 키 — input 이벤트가 담당
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
  // 비표준 WKWebView 조합 — input 으로 온다(composition 이벤트 없음).
  const onInput = (e: Event): void => {
    const ie = e as InputEvent;
    const data = ie.data ?? "";
    if (ie.inputType === "insertReplacementText") {
      if (data) setPreedit(data);
      else clearComposition();
      return;
    }
    if (ie.inputType === "insertText" && data && isHangul(data)) {
      if (composing) commitPending(); // 새 음절 시작 → 이전 음절 확정
      setPreedit(data);
      return;
    }
    if (ie.inputType === "deleteContentBackward" && composing) {
      clearComposition();
      return;
    }
  };
  // 표준 경로(비-WKWebView 엔진) — 발화하면 그대로 브리지. WKWebView 에선 안 온다.
  const onCompUpdate = (e: CompositionEvent): void => {
    setPreedit(e.data ?? "");
  };
  const onCompEnd = (e: CompositionEvent): void => {
    const text = e.data ?? "";
    composing = false;
    pending = "";
    proxy.value = "";
    if (text) send({ type: "ime", kind: "commit", text });
    else send({ type: "ime", kind: "cancel" });
  };
  const onBlur = (): void => {
    commitPending(); // 미완 조합 확정
    proxy.value = ""; // 다음 조합의 오염 방지
    send({ type: "ime", kind: "finish" });
  };

  container.addEventListener("mousemove", onMove);
  container.addEventListener("mousedown", onDown);
  container.addEventListener("mouseup", onUp);
  container.addEventListener("wheel", onWheel, { passive: false });
  container.addEventListener("contextmenu", onContext);
  proxy.addEventListener("keydown", onKeyDown);
  proxy.addEventListener("keyup", onKeyUp);
  proxy.addEventListener("input", onInput); // 비표준 WKWebView 조합 경로(핵심)
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
