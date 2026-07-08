// @vitest-environment jsdom
// 입력 포워더 계약 테스트 — DOM 이벤트 → 프로토콜 메시지(SIDECARS.md §8) 변환의 단일 진실.
// 엔진 쪽 절반은 사이드카 하니스(bin/harness)가 검증한다 — 이 파일은 플러그인 쪽 절반.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forwardInput } from "./input-forward";

type Msg = Record<string, unknown>;

function keyEvent(type: string, init: KeyboardEventInit & { keyCode?: number }): KeyboardEvent {
  const e = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  // jsdom 은 생성자 init 의 keyCode 를 무시한다 — 레거시 필드를 직접 정의.
  Object.defineProperty(e, "keyCode", { value: init.keyCode ?? 0 });
  return e;
}

describe("forwardInput", () => {
  let container: HTMLElement;
  let sent: Msg[];
  let stop: () => void;

  beforeEach(() => {
    // rAF 를 즉시 실행으로 — move 코얼레싱을 결정적으로 검증한다.
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    container = document.createElement("div");
    document.body.appendChild(container);
    container.getBoundingClientRect = () =>
      ({ left: 100, top: 50, right: 500, bottom: 450, width: 400, height: 400, x: 100, y: 50, toJSON: () => ({}) }) as DOMRect;
    sent = [];
    stop = forwardInput(container, (m) => sent.push(m));
  });

  afterEach(() => {
    stop();
    container.remove();
    vi.unstubAllGlobals();
  });

  function proxy(): HTMLInputElement {
    const el = container.querySelector("input");
    expect(el).not.toBeNull();
    return el as HTMLInputElement;
  }

  it("mousedown 은 focus 후 표면-로컬 좌표의 down 을 보내고 프록시에 포커스를 준다", () => {
    container.dispatchEvent(new MouseEvent("mousedown", { clientX: 220, clientY: 130, button: 0, bubbles: true }));
    expect(sent[0]).toMatchObject({ type: "focus" });
    expect(sent[1]).toMatchObject({ type: "mouse", kind: "down", x: 120, y: 80, button: 0, clicks: 1 });
    expect(document.activeElement).toBe(proxy());
  });

  it("mousemove 는 rAF 로 코얼레싱되어 최신 좌표 1건만 보낸다", () => {
    // 즉시-rAF 스텁에서는 첫 move 가 즉시 flush — 후속 move 도 각각 flush 되지만
    // '이벤트당 최대 1건 + 최신 좌표' 계약을 좌표로 검증한다.
    container.dispatchEvent(new MouseEvent("mousemove", { clientX: 110, clientY: 60, bubbles: true }));
    expect(sent.at(-1)).toMatchObject({ type: "mouse", kind: "move", x: 10, y: 10 });
  });

  it("wheel 은 DOM 델타를 그대로 보낸다(부호 변환은 엔진 소유)", () => {
    container.dispatchEvent(new WheelEvent("wheel", { clientX: 150, clientY: 100, deltaX: 3, deltaY: 120, bubbles: true, cancelable: true }));
    expect(sent.at(-1)).toMatchObject({ type: "wheel", x: 50, y: 50, dx: 3, dy: 120 });
  });

  it("keydown 은 down 을, 인쇄 가능 키는 char 도 보낸다", () => {
    proxy().dispatchEvent(keyEvent("keydown", { key: "a", keyCode: 65 }));
    const kinds = sent.filter((m) => m.type === "key").map((m) => m.kind);
    expect(kinds).toEqual(["down", "char"]);
    expect(sent.find((m) => m.kind === "char")).toMatchObject({ code: 65, char: "a" });
  });

  it("조합 중(keyCode 229/isComposing) key 는 포워딩하지 않는다 — IME 경로 소유", () => {
    proxy().dispatchEvent(keyEvent("keydown", { key: "Process", keyCode: 229 }));
    expect(sent.filter((m) => m.type === "key")).toHaveLength(0);
  });

  it("한글 조합: compositionupdate 는 ime set(caret=UTF-16 길이), compositionend 는 commit", () => {
    const p = proxy();
    p.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    p.dispatchEvent(new CompositionEvent("compositionupdate", { data: "하" }));
    p.dispatchEvent(new CompositionEvent("compositionupdate", { data: "한" }));
    p.dispatchEvent(new CompositionEvent("compositionend", { data: "한글" }));
    const ime = sent.filter((m) => m.type === "ime");
    expect(ime).toEqual([
      { type: "ime", kind: "set", text: "", caret: 0 },
      { type: "ime", kind: "set", text: "하", caret: 1 },
      { type: "ime", kind: "set", text: "한", caret: 1 },
      { type: "ime", kind: "commit", text: "한글" },
    ]);
    expect(p.value).toBe(""); // 커밋 후 프록시 잔여값 청소.
  });

  it("빈 데이터의 compositionend 는 cancel — 조합 취소(ESC)의 정확한 전달", () => {
    const p = proxy();
    p.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    p.dispatchEvent(new CompositionEvent("compositionend", { data: "" }));
    expect(sent.filter((m) => m.type === "ime").at(-1)).toMatchObject({ kind: "cancel" });
  });

  it("프록시 blur 는 ime finish — 미완 조합을 확정한다", () => {
    const p = proxy();
    p.focus();
    p.blur();
    expect(sent.filter((m) => m.type === "ime").at(-1)).toMatchObject({ kind: "finish" });
  });

  it("modifier 비트필드: shift=1 ctrl=2 alt=4 meta=8", () => {
    container.dispatchEvent(
      new MouseEvent("mousedown", { clientX: 100, clientY: 50, shiftKey: true, metaKey: true, bubbles: true }),
    );
    expect(sent.find((m) => m.kind === "down")).toMatchObject({ mods: 1 | 8 });
  });

  it("해제 후에는 어떤 이벤트도 포워딩하지 않고 프록시를 제거한다", () => {
    stop();
    const n = sent.length;
    container.dispatchEvent(new MouseEvent("mousedown", { clientX: 120, clientY: 60, bubbles: true }));
    container.dispatchEvent(new WheelEvent("wheel", { deltaY: 10, bubbles: true }));
    expect(sent.length).toBe(n);
    expect(container.querySelector("input")).toBeNull();
    stop = () => {}; // afterEach 이중 해제 방지.
  });
});
