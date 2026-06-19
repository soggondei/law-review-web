<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## 법령 정확도 규칙

법규 검토 시스템의 법령 수치·대상·완화 조건은 추정해서 작성하지 않는다.

- `confidence: "confirmed"`는 law.go.kr 원문을 직접 열람하고 조문·항·호·목 단위로 대조한 경우에만 사용한다.
- 법령 수치나 기준을 코드, JSON, 문서에 작성할 때는 조문 번호와 항·호·목을 함께 남긴다.
  - 예: `건축법 시행령 제41조 제1항 제1호 가목: 단독주택 0.9m`
- AI가 작성한 명세서, 요약문, 작업 지시서의 수치·기준은 공식 URL이 붙어 있어도 검증 완료로 보지 않는다.
- 원문 대조 전의 항목은 `estimated` 또는 `unverified`로 두고, UI에는 확인 필요 입력값을 남긴다.
- Claude Code나 Codex가 상대 에이전트의 `confirmed` 태그를 받아 구현할 때도 원문 확인 또는 사용자 확인을 먼저 거친다.
