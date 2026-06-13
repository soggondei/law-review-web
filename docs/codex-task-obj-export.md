# Codex Task: lib/objexport.ts 신규 작성

## 목적
OBJ(Wavefront) 포맷으로 건축 사이트 주변 지형 데이터를 내보내는 지오메트리 빌더.
SketchUp에서 직접 열 수 있는 `.obj` 파일을 생성한다.

## 허용 파일
- **신규 생성**: `lib/objexport.ts` 만 작성. 다른 파일 수정 금지.

## 타입 정의 (이 파일에 직접 선언)

```ts
export type ObjPolygon = [number, number][];      // 로컬 좌표 (미터), 닫힘점 미포함
export type ObjPolyline = [number, number][];     // 로컬 좌표, 열린 선

export type ObjGroup = {
  name: string;           // 예: "PARCEL", "BUILDINGS", "ROADS", "SIDEWALK"
  polygons?: ObjPolygon[];
  polylines?: ObjPolyline[];
  polylineWidth?: number; // 폴리라인을 띠(strip)로 렌더할 때 반 폭(m). 기본 1.5
};
```

## 내보낼 함수

```ts
export function buildObj(
  groups: ObjGroup[],
  meta: { addr: string; radius: number }
): string
```

### 출력 형식 규칙

1. **파일 헤더**: `# Wavefront OBJ — {addr} — 생성: {YYYY-MM-DD} — 범위: {radius}m`
2. **그룹별 섹션**: `g {name}` 으로 시작
3. **폴리곤 → 면(face)**
   - 각 꼭짓점을 `v x y 0` (z=0, 미터 단위)으로 emit
   - 부채꼴(fan) 삼각분할: 꼭짓점 N개 → N-2 삼각형 `f i0 i1 i2` (1-indexed, 전역 인덱스)
4. **폴리라인 → 사각 띠(quad strip)**
   - 각 세그먼트(p1→p2)에 수직 방향 벡터 계산 후 폭(`polylineWidth ?? 1.5`)으로 4꼭짓점 생성
   - 4꼭짓점을 삼각 2개(`f a b c`, `f a c d`)로 emit
   - 세그먼트 길이 < 0.01m 이면 건너뜀
5. 전역 버텍스 카운터를 함수 내에서 관리 (그룹 간 인덱스 연속)

### 예시 출력 (소규모)

```
# Wavefront OBJ — 서울시 강남구 — 생성: 2026-06-13 — 범위: 30m
g PARCEL
v -10.0000 -5.0000 0
v  10.0000 -5.0000 0
v  10.0000  5.0000 0
v -10.0000  5.0000 0
f 1 2 3
f 1 3 4
g ROADS
v ...
f ...
```

## 주의사항
- 순수 TypeScript. 외부 패키지 import 금지.
- `app/` 디렉토리 파일 절대 수정 금지.
- `app/page.tsx` 절대 수정 금지.
- 완료 후 `docs/work-log.md`에 항목 추가.
