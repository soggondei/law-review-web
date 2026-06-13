# Work Log — Claude Code × Codex 협업 기록

Codex 인계용. 작업 완료 시마다 아래에 항목 추가.

---

## [2026-06-13] 합필 시나리오 기능 추가
- 변경파일: `app/page.tsx`, `app/api/parcel-lookup/route.ts` (신규)
- 핵심변경: 분석 전 합필 모드 토글 → 인접 필지 주소 입력 → 용도지역 일치 확인 + 면적 자동조회 → 합산 면적으로 analyze API 호출
- 주의사항: `parcel-lookup` API는 fetchBuildingInfo + fetchLandUseInfo 병렬 호출. Codex는 이 파일 수정 금지.

## [2026-06-12] PR #16 good parts 수동 적용
- 변경파일: `lib/judge.ts`, `lib/api.ts`, `lib/data/parking-ordinances.json` (신규)
- 핵심변경: JSON 분리(Issue#15) + Confidence `"user_input"` + PARKING_REGION_ALIASES + ORDINANCES 17개 시도 + findOrdinanceRegion
- 주의사항: Codex `app/page.tsx` 수정 금지 위반으로 PR#16 Close. 이후 Codex PR에서 page.tsx 절대 포함 금지.

## [2026-06-12] 자가평가 기반 보완 4종
- 변경파일: `lib/api.ts`, `lib/judge.ts`, `app/api/analyze/route.ts`, `app/api/cadexport/route.ts`, `app/page.tsx`
- 핵심변경:
  - F: 건축물대장 필드 확장 (지하층수·세대수·높이·구조 추가) → 내화·피난 판단 정확도 향상
  - C: 오피스텔 전용면적 입력 UI 추가 → 주차대수 30㎡ 기준 자동 분기
  - E: CAD DXF에 북방향·스케일바·레이어범례·주소 어노테이션 추가
  - D: OSM 도로 데이터로 인접도로폭 자동 측정 → 접도 요건 항목 자동 판단 (⚠️→✅/❌)
- 주의사항: Codex는 `lib/judge.ts` 내 `인접도로폭` 파라미터 건드리지 말 것.

---

## [2026-06-12] CAD(DXF) 다운로드 기능 추가
- 변경파일: `app/api/cadexport/route.ts` (신규), `app/page.tsx`
- 핵심변경: Vworld LP_PA_CBND_BUBUN 30m 필지 + OSM 건물·도로 → DXF 생성, 헤더에 📐 CAD 버튼
- 주의사항: `LURIS_KEY` 환경변수로 Vworld 인증. Codex는 이 파일 건드리지 말 것.

---

## [2026-06-12] 3D 주변 건물/도로 미표시 수정
- 변경파일: `app/api/context/route.ts`, `app/page.tsx`
- 핵심변경: Overpass 3-호스트 폴백 + 좌표 오프셋 버그 수정 + 에러 시 빈 배열로 상태 해제
- 주의사항: `OVERPASS_HOSTS` 배열에 미러 추가 시 `route.ts` 수정. `app/page.tsx` 수정 금지.

## [2026-06-12] 2컬럼 레이아웃 복원
- 변경파일: `app/page.tsx`
- 핵심변경: Codex 머지로 단일컬럼 롤백된 것을 `4510e03` 기반으로 복원
- 주의사항: **`app/page.tsx` 절대 수정 금지.** Codex 허용 범위: `lib/judge.ts`, `lib/api.ts`, `docs/` 만.

## [2026-06-12] 정북일조제한 법규 수정 (§86)
- 변경파일: `components/BuildingViewer3D.tsx`, `lib/judge.ts`
- 핵심변경: 10m 이하 1.5m 수직, 10m 초과 높이/2 사선 — `topH <= 10 ? 1.5 : topH / 2`
- 주의사항: `judge.ts`의 일조제한 공식 건드리지 말 것.

## [2026-06-12] Confidence 타입 시스템 (#12)
- 변경파일: `lib/judge.ts`, `app/page.tsx`
- 핵심변경: `Confidence` 타입 + `resolveConf()` 헬퍼 + 층수추정 시 🟡 배지 표시
- 주의사항: 조례 데이터 추가 시 `PARKING_ORDINANCES`만 수정하면 confidence 자동 전파됨.

## [이전] Codex 브랜치 머지 (issues #1 #3 #6 #9)
- 변경파일: `lib/judge.ts`, `lib/api.ts`, `docs/parking-ordinance-study.md`
- 핵심변경: PARKING_ORDINANCES 16개 시도 확장, `parseStrctCode()`, 광주광역시 조례 추가
- 주의사항: 머지 시 `app/page.tsx` 절대 포함 금지 (레이아웃 롤백 전례).
