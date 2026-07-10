import { describe, it, expect } from "vitest";
import { browserStatus } from "./status";

// 코어 닫기 가드 계약(closeGuard STATUS_BLOCKING) — 이 code 만 닫기 가드를 발동한다.
// 그 외 code 는 표시 전용. 브라우저 뷰는 미저장·백그라운드 작업이 없다 — 상태는 표시 전용뿐.
const STATUS_BLOCKING = ["dirty", "busy", "running"];

describe("browserStatus — offscreen 브라우저 뷰 status 축 보고", () => {
  it("로딩 = code loading + 사람표면 message(i18n 해소)", () => {
    expect(browserStatus("loading", "en")).toEqual({ code: "loading", message: "Loading…" });
    expect(browserStatus("loading", "ko")).toEqual({ code: "loading", message: "불러오는 중…" });
  });

  it("준비(idle) = 보고할 상태 없음 → null", () => {
    expect(browserStatus("ready", "en")).toBeNull();
    expect(browserStatus("ready", "ko")).toBeNull();
  });

  it("오류 = code error + 사람표면 message(i18n 해소)", () => {
    expect(browserStatus("error", "en")).toEqual({ code: "error", message: "Engine surface unavailable" });
    expect(browserStatus("error", "ko")).toEqual({ code: "error", message: "엔진 서피스를 만들 수 없습니다" });
  });

  it("로딩·오류는 닫기 가드 대상 아님(표시 전용) — 브라우저 탭은 로딩 중에도 자유롭게 닫힌다", () => {
    expect(STATUS_BLOCKING).not.toContain(browserStatus("loading", "en")!.code);
    expect(STATUS_BLOCKING).not.toContain(browserStatus("error", "en")!.code);
  });

  it("알 수 없는 로케일 = 영어 폴백", () => {
    expect(browserStatus("loading", "fr")).toEqual({ code: "loading", message: "Loading…" });
  });
});
