# Work Log — Claude Code × Codex 협업 기록

이 파일은 Claude Code(메인)와 Codex(서브) 간 작업 인계를 위한 로그입니다.
작업 완료 시마다 아래에 항목을 추가합니다.

---

## [2026-06-12] #12 신뢰도 골격 구현 — Claude Code

### 작업 범위
`lib/judge.ts` + `app/page.tsx`에 Confidence 타입 시스템 추가

### 변경 내용

**`lib/judge.ts`**
- `Confidence` 타입 (`"confirmed" | "estimated" | "unverified"`) → `export` 추가
- `resolveConf(item)` 헬퍼: `해당여부` 문자열에서 자동 confidence 결정
  - `⚠️` 또는 `판단불가` 포함 → `"unverified"`
  - `❌` 또는 `— ` 시작 → `"confirmed"`
  - 그 외 → `item.confidence ?? "confirmed"`
- `judgeDesignItems`: 층수 의존 항목 6종에 `confidence: cf층수` 추가
  - 직통계단, 피난계단, 특별피난계단, 방화구획, 스프링클러, 승강기(승용/비상용/피난용)
  - `cf층수 = 층수추정 ? "estimated" : "confirmed"`
  - return을 `items.map(item => ({ ...item, confidence: resolveConf(item) }))` 으로 변경
- `judgePermitItems`: `층수추정?: boolean` 파라미터 추가, return에 `resolveConf` 적용

**`app/page.tsx`**
- `Item` 타입에 `confidence?: Confidence` 추가
- `editParams`에 `층수직접입력: boolean` 추가 (기본값 `false`)
  - 층수 +/- 버튼 클릭 시 `true` 전환
  - 초기화(reset) 시 `false` 복원
  - API 응답 수신 시 `false`로 초기화
- `judgeDesignItems` / `judgePermitItems` 호출에 `층수추정: !editParams.층수직접입력` 전달
- `ItemTable`: 해당여부 셀에 confidence 배지 추가
  - `"estimated"` → 🟡 추정값 (amber)
  - `"unverified"` → 🔴 미확인 (red)
  - `"confirmed"` → 배지 없음 (기본)

### 배포
- main push → Vercel 자동배포 완료 (3분 소요)
- 프로덕션: https://law-review-web.vercel.app
- 이슈 #12 close 완료

### Codex에게
- 이번 작업은 UI·로직 레이어. 데이터 레이어(#4 조례 DB 확장)와 충돌 없음.
- `judgeScaleItems`의 건폐율·용적률 항목은 이미 `조례확인` 파라미터 기반 confidence 적용 중 — 건드리지 말 것.
- 향후 조례 데이터 추가 시: `PARKING_ORDINANCES`에 지역 추가하면 자동으로 `"confirmed"` confidence 전파됨. 별도 작업 불필요.

---

## [이전] Codex 브랜치 머지 — Claude Code

### 작업 범위
`codex/issues-1-3-6-9` 브랜치를 main에 통합

### 변경 내용
- `PARKING_ORDINANCES` 16개 시도 확장 (서울·부산 조례 확인, 14개 시도 nationalLawArea 폴백)
- `nationalLawArea()` 헬퍼 추가로 중복 제거
- 광주광역시 조례 데이터 추가 (`lib/api.ts`)
- `parseStrctCode()` 헬퍼, `fetchBuildingInfo()` 반환값 확장 (지하층수·세대수·구조)
- `densityRuleStatus` 필드 추가 (조례 기준 적용 상태 명시)
- `docs/parking-ordinance-study.md` 신규 작성 (Codex 작업)
- 정북사선(북측이격) 계산 복원 + `app/page.tsx` UI 추가

### 배포
- 이슈 #1 #3 #6 관련 내용 포함
- Codex 브랜치 머지 후 삭제 완료
