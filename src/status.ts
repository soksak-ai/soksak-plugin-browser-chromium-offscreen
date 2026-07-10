// 뷰 status 축 보고(뷰 status 축 계약) — 이 offscreen 브라우저 뷰의 진짜 상태만 코어에 보고한다.
// 코어 닫기 가드는 STATUS_BLOCKING = dirty·busy·running code 만 발동한다(그 외 code 는 표시 전용).
// 브라우저 탭은 미저장 변경도, 잃으면 안 되는 백그라운드 작업도 없다 — 로딩·오류는 표시 전용이며
// 닫기를 막지 않는다(로딩 중 탭 닫기는 정상 동작). 준비(idle)는 보고할 상태가 없음 → null.
// windowed browser-chromium 과 동형(로딩·준비·오류).
export type BrowserPhase = "loading" | "ready" | "error";

// 사람표면 문자열 — 호스트 표시 언어(app.locale)로 해소. 알 수 없는 로케일은 영어 폴백.
const STRINGS: Record<Exclude<BrowserPhase, "ready">, { en: string; ko: string }> = {
  loading: { en: "Loading…", ko: "불러오는 중…" },
  error: { en: "Engine surface unavailable", ko: "엔진 서피스를 만들 수 없습니다" },
};

// phase → status 보고값(setStatus 인자). ready 는 보고할 상태 없음 → null.
// code 는 phase 문자열 그대로 — 둘 다 STATUS_BLOCKING 밖(표시 전용).
export function browserStatus(
  phase: BrowserPhase,
  lang: string,
): { code: string; message: string } | null {
  if (phase === "ready") return null;
  const s = STRINGS[phase];
  return { code: phase, message: lang === "ko" ? s.ko : s.en };
}
