# AURA 2.0 구현 상태 (2026-10-22)

- 브랜치: feature/aura-pdf-implementation. 시작 시 작업 트리 clean. main 변경 없음.
- 기준 PDF: 사용자 제공 8쪽 원문/4쪽 렌더 확인. 3쪽 지표, 4쪽 D·분모, 5쪽 Overall, 6~7쪽 비율 반영. 최초 대체 설정은 교체됨.
- Phase 1~2: 관계형 DB·합성 원장·라벨 격리·고객 300/200 분리·영역별5지표·IF·사고/진료 연결·지급 대조 구현.
- Phase 3~4: Responses 도구 호출·호출 제한/캐시·근거/SQL 검증·Safety Gate·자동 종료/예외·감사 로그 구현. 모의 성공 및 연결 오류 검증. 실제 모델 미연결. 운영 모델 경로는 5회 독립 조사 후 요인 충돌을 판단 불가 처리.
- Phase 5: 관제/예외/조사/관리 UI 구현. 기존 분석·차트 legacy.html 보존. DOM2+기존25 통과. 브라우저 도구 inventory 빈 상태여서 화면 배치 미확인.
- Phase 6: B 200명 실측, A/C 실행 경로 및 미연결 skip, C5회 비교, 블라인드 자료, Docker/PostgreSQL 구성, CI 추가.
- 실측(seed42): 500명/의료5000/사고600/자동차청구1200. 자동 종료419, 검토81, 오류0. B 중복재현율1.0, 헷갈리는정상오탐0, 위험신속오분류0.3061(목표 미달). docs/benchmark.json 참조.
- Python13 + JS27 통과. httpx TestClient 폐기 예정 경고1.
- 미완료: 위험 신속 오분류 개선(새 holdout 필요), 실제 A/C 및 토큰·숫자·인용·일관성 측정, A 자동 수치 채점, 블라인드 점수 수집, PostgreSQL/외부LLM/클라우드 배포 검증. 배포·main 병합 안 함.
- 다음 세션: README의 미완료 경계 확인 후 작업을 이어간다. 평가 데이터 결과를 보고 튜닝했다면 같은 평가 결과를 최종 성능으로 재사용하지 않는다.

## 2026-10-23 백엔드 연결 준비

- Render 플러그인 탐색 및 연결 제안. 계정 미연결 상태로 서버/DB 생성은 아직 불가.
- 임시 공개 HTTPS 터널 실행 명령은 자동 승인 검토에서 정책 차단됨. 실행/터널 생성 없이 중단했으며 우회 안 함.
- render.yaml: 무료 Python API/내부 PostgreSQL, 생성형 관리자 토큰, GitHub Pages CORS, 빈 DB에만 합성 데이터/규칙 조사 결과 초기화.
- 관리형 Postgres URL에 psycopg3 드라이버 명시. 정적 프론트엔드 공용 API 설정 파일과 항상 접근 가능한 연결 설정 추가. 토큰은 공용 설정에 저장하지 않음.
- 테스트: Python16 + JS28 통과. 실제 Render 배포/DB 접속/HTTPS 연결은 계정 연결 후 이어서 수행.
- 다음 작업: Render 연결 확인 → 서비스 생성/배포 → health/CORS/인증/조사 확인 → 검증된 URL을 aura-config.js에 기록 → GitHub 반영 → Pages에서 실제 API 조회 확인.
