# Codex Task: lib/collada.ts 신규 작성

## 목적
주변 건물 매스(실제 높이 포함)·지적 필지·도로를 Collada(`.dae`) 포맷으로 내보내는 XML 빌더.
SketchUp이 네이티브로 열 수 있는 파일을 생성한다.

## 허용 파일
- **신규 생성**: `lib/collada.ts` 만 작성. 다른 파일 수정 금지.

## 타입 정의 (이 파일에 직접 선언)

```ts
// 건물 — 돌출 대상
export type DaeBuilding = {
  pts: [number, number][]; // 평면 윤곽 (닫힘점 미포함), 로컬 좌표(m)
  height: number;          // 미터, 반드시 > 0
};

// 평면 폴리곤 (지적 필지 등)
export type DaePolygon = {
  pts: [number, number][]; // 로컬 좌표(m), 닫힘점 미포함
};

// 폴리라인 → 평면 띠(quad strip)
export type DaePolyline = {
  pts: [number, number][];
  width: number; // 띠 전체 폭(m)
};

export type DaeInput = {
  buildings:  DaeBuilding[];
  parcels:    DaePolygon[];
  roads:      DaePolyline[]; // width: 3
  sidewalks:  DaePolyline[]; // width: 1.5
  addr:       string;
  radius:     number;
};
```

## 내보낼 함수

```ts
export function buildDae(input: DaeInput): string
```

## 출력 형식 규칙

### Collada 뼈대

```xml
<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset>
    <created>{YYYY-MM-DD}</created>
    <unit name="meter" meter="1"/>
    <up_axis>Z_UP</up_axis>
  </asset>
  <library_geometries>
    <!-- 그룹별 geometry 항목 -->
  </library_geometries>
  <library_visual_scenes>
    <visual_scene id="Scene" name="Scene">
      <!-- 그룹별 node -->
    </visual_scene>
  </library_visual_scenes>
  <scene>
    <instance_visual_scene url="#Scene"/>
  </scene>
</COLLADA>
```

### geometry 생성 규칙

각 그룹(`BUILDINGS`, `PARCELS`, `ROADS`, `SIDEWALK`)별로 `<geometry id="geo-{name}">` 생성.

**geometry 내부 구조:**
```xml
<geometry id="geo-BUILDINGS" name="BUILDINGS">
  <mesh>
    <source id="geo-BUILDINGS-pos">
      <float_array id="geo-BUILDINGS-pos-arr" count="{3*N}">{x0} {y0} {z0} {x1} ...</float_array>
      <technique_common>
        <accessor source="#geo-BUILDINGS-pos-arr" count="{N}" stride="3">
          <param name="X" type="float"/>
          <param name="Y" type="float"/>
          <param name="Z" type="float"/>
        </accessor>
      </technique_common>
    </source>
    <vertices id="geo-BUILDINGS-vtx">
      <input semantic="POSITION" source="#geo-BUILDINGS-pos"/>
    </vertices>
    <triangles count="{T}">
      <input semantic="VERTEX" source="#geo-BUILDINGS-vtx" offset="0"/>
      <p>{i0} {i1} {i2} {i3} ...</p>
    </triangles>
  </mesh>
</geometry>
```

### 지오메트리 생성 방법

#### 건물(BUILDINGS) — 돌출(extrude)
각 건물 footprint(`pts`, `height`h)에 대해:
1. **바닥면**: z=0 에서 pts 부채꼴 삼각분할 (법선 아래 방향 → 시계 방향)
2. **지붕면**: z=h 에서 pts 부채꼴 삼각분할 (법선 위 방향 → 반시계 방향)
3. **측면**: 각 엣지(pts[i]→pts[i+1])마다 쿼드 2삼각형:
   - v0=(pts[i].x, pts[i].y, 0), v1=(pts[i+1].x, pts[i+1].y, 0)
   - v2=(pts[i+1].x, pts[i+1].y, h), v3=(pts[i].x, pts[i].y, h)
   - 삼각형: (v0,v1,v2), (v0,v2,v3)

#### 필지(PARCELS) — 평면 폴리곤
z=0 에서 pts 부채꼴 삼각분할.

#### 도로·보도(ROADS/SIDEWALK) — 평면 띠
폴리라인 각 세그먼트를 폭(`width`)으로 평면 쿼드로 변환(z=0).
수직 방향 벡터 계산: `nx = -dy/len * (width/2)`, `ny = dx/len * (width/2)`
쿼드 4꼭짓점 → 삼각형 2개. 세그먼트 길이 < 0.01m 건너뜀.

### visual_scene node 규칙
```xml
<node id="{NAME}" name="{NAME}" type="NODE">
  <instance_geometry url="#geo-{NAME}"/>
</node>
```
그룹에 지오메트리가 없으면(삼각형 0개) 해당 geometry/node 모두 생략.

## 주의사항
- 순수 TypeScript. 외부 패키지 import 금지.
- `app/` 디렉토리 파일 절대 수정 금지.
- `app/page.tsx` 절대 수정 금지.
- 숫자는 소수점 4자리(`toFixed(4)`)로 출력.
- 완료 후 `docs/work-log.md`에 항목 추가.
