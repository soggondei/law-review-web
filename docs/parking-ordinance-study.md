# Parking Ordinance Study

부설주차장 산정은 `주차장법 시행령` 기본표보다 해당 지자체 조례가 우선입니다.
이 프로젝트에서는 공식 조례 기준이 확인된 지역만 자동 산정하고, 미등록 지역은 `판단불가`로 표시합니다.

## Implemented

| Region | Ordinance source | Implemented scope |
| --- | --- | --- |
| 서울특별시 | 서울특별시 주차장 설치 및 관리 조례 별표2 | 주요 면적기준 용도, 공동주택 세대기준, 0.5 반올림, 장애인 주차 기준 placeholder |
| 부산광역시 | 부산광역시 주차장 설치 및 관리 조례 별표7 | 주요 면적기준 용도, 공동주택 세대기준, 0.5 반올림, 장애인 10대 이상 3% |

## Current Policy

- If a region has no ordinance DB entry, do not fall back silently to the national enforcement decree.
- Return `판단불가` with `지자체 주차장 설치 및 관리 조례 확인 필요`.
- For area-based parking standards, use the ordinance rounding rule. 부산 실무 기준은 0.5 이상 반올림, 0.5 미만 버림으로 반영.
- For mixed-use projects, calculate each use separately with the same regional ordinance, then sum the result.

## Next Regions To Study

1. 인천광역시 and individual 구 조례 delegation rules
2. 대구광역시
3. 대전광역시
4. 광주광역시
5. 울산광역시
6. 세종특별자치시
7. 경기도 major cities, because many parking rules are city-level rather than province-level

## Claude Handoff

Recommended UI work:

- Add a badge near the parking row: `서울 조례 적용`, `부산 조례 적용`, or `조례 DB 미등록`.
- Show the rounding rule in the row detail, especially when raw calculation is not an integer.
- For `조례 DB 미등록`, show a short input/verification task instead of a numeric result.
- Add a data maintenance panel or admin JSON editor later so ordinance rules can be updated without touching judge logic.
