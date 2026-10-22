# InsureLens AURA 2.0

실손의료보험·자동차보험 합성 원장을 조사하는 FastAPI + 관계형 DB + JavaScript 관제 앱입니다. PDF(2026-10-22, 8쪽)의 지표·시나리오 비율·중복금액·Overall을 반영합니다. **실제 LLM 미연결 실행은 규칙 기반 조사이며 자율 Agent 실행으로 표시하지 않습니다.**

## 실행

```powershell
python -m pip install -r requirements.txt
python -m uvicorn backend.api:app --host 127.0.0.1 --port 8000
```

http://127.0.0.1:8000 에서 Administration → DB에 생성 → Control Center → 전체 자동 조사 시작 순서로 실행합니다. 데이터가 없으면 수치를 만들어 표시하지 않습니다. SQLite 파일은 `data/aura.sqlite3`에 보존되고 Git에서 제외됩니다.

PostgreSQL은 `DATABASE_URL=postgresql+psycopg://...`로 연결합니다. 신규 스키마는 시작 시 생성합니다. 기존 스키마 업그레이드 마이그레이션은 별도 작업이 필요합니다. Docker 환경은 `POSTGRES_PASSWORD`, `AURA_ADMIN_TOKEN`을 환경변수로 설정한 후 `docker compose up --build`로 실행합니다. PostgreSQL/Docker 실서버 검증은 아직 하지 않았습니다.

실제 LLM 사용은 서버 환경변수에 `OPENAI_API_KEY`, `AURA_LLM_MODEL`을 지정합니다. `AURA_LLM_BASE_URL` 기본값은 `https://api.openai.com/v1`이며 `/responses`와 function calling을 지원해야 합니다. 로컬 모델도 해당 프로토콜을 지원하는 게이트웨이가 필요합니다. 키를 저장소·브라우저에 넣지 마세요. `.env.example`은 변수 목록이며 Python 서버가 `.env`를 자동으로 읽지는 않습니다.

원격 변경은 `AURA_ADMIN_TOKEN`이 필수입니다. 프론트엔드 연결 화면의 토큰 입력은 탭 세션에만 보관합니다. 별도 출처의 프론트엔드는 `AURA_ALLOWED_ORIGINS`에 정확한 URL을 설정합니다. GitHub Pages에서는 Python/DB가 실행되지 않습니다. HTTPS 백엔드를 별도로 배포하고 Pages 연결 화면에 주소를 넣어야 합니다. 운영 배포와 main 병합은 수행하지 않았습니다.

## 구현과 경계

- `backend/db.py`, `generator.py`: 핵심 6개 테이블, seed, 기본 500명/5,000 의료청구/600 사고, 고객별 300/200 분리. 라벨은 생성·평가에서만 읽습니다.
- `backend/analysis.py`: 동일 질환 30일 횟수·평균 간격, 질환/진료유형별 비용 백분위, 반복 청구·기관 분산, 90일 사고 횟수·간격·유형·수리비·반복 상대방/정비소. 통계와 IF는 튜닝 고객으로만 학습합니다.
- 날짜와 손상 코드로 사고·진료 후보를 연결하며 같은 병원/기간 중복은 보조 근거입니다. 교차 검증은 비용 항목과 지급액을 대조하고, 매칭에 사용한 청구를 재사용하지 않습니다.
- PDF의 `D=sum(min(auto_paid,med_paid))`, `r_dup=D/사고 관련 의료 지급액 합`, `Overall=max(S_cross,.3*S_med+.3*S_auto+.4*S_cross)`를 코드로 계산합니다. 동일 영수증의 양쪽 실제 지급은 정밀 검토 대상이며 법적 사기 확정이 아닙니다.
- PDF에 숫자가 없는 영역별 가중치·IF 혼합비·교차 점수 변환은 `backend/config.json`의 실험 설정입니다. 최초 초안의 대체 D 산식은 PDF 수령 후 교체했습니다.
- `backend/agent.py`: 읽기 전용 도구 7개, 실제 Responses tool loop, 호출·반복 상한, 캐시, 주장별 evidence_ids, 숫자/날짜와 SQL 원장 재조회 검증, 별도 Safety Gate, 오류 예외 등록·감사 로그.
- 지급 승인/거절/보류 도구는 없습니다. 자동 종료는 추가 이상징후 조사 종료에 한정합니다. 고위험·결측·검증 실패·권한 위반은 담당자 검토로 보냅니다.
- `dist/aura.*`: 관제·예외·상세·관리 화면. 기존 JS 분석/차트는 `dist/legacy.html`에 보존했습니다.
- `backend/evaluation.py`: 동일 평가 고객의 A/B/C 실행, C 5회 비교, 목표 대비 결과, 블라인드 평가용 익명 순서 자료. LLM 미연결 A/C는 미실행입니다.

내부 필드 `id/service_date/kcd_code/receipt_id/actual_cost/claimed_amount/component`는 PDF의 `*_id/visit_date/disease_code/receipt_no/total_cost/claim_amount/claim_type`에 대응합니다. 진료비 항목은 component로 구분하며, 정식 영수증 항목 테이블은 없습니다.

## 검증 결과와 남은 작업

2026-10-22 seed 42 실측은 `docs/benchmark.json`에 보존했습니다. 500명 전체 조사에서 오류 0, 자동 종료 419명(83.8%), 검토 81명. 규칙 기반 실행 결과이며 실제 LLM 성능이 아닙니다.

평가 고객 200명의 B군: 중복 보상 재현율 100%, 헷갈리는 정상 정밀 검토 오탐율 0%, **위험 사례 신속 처리 오분류율 30.61%로 목표 2% 미달**. 단일 영역 위험이 Overall에서 낮아지는 사례를 추가 튜닝하고, 별도 새 평가 seed로 재검증해야 합니다. 현재 결과로 안전한 운영 성능을 주장할 수 없습니다.

실제 LLM A/C 비교와 입력 토큰 절감·설명 수치 정확도·인용률·5회 일관성·블라인드 2인 채점은 미측정입니다. 수치 검증은 명시된 facts와 숫자/날짜를 검사하며 자유 문장의 의미적 정확성을 보증하지 않습니다. A군 수치 자동 채점, 블라인드 점수 수집/집계, 실제 모델로 5회 조사 일관성을 검증하는 작업은 남아 있습니다. 운영 조사와 C 평가 모두 반복 결과 차이를 판단 불가로 처리합니다.

브라우저 연결 도구에 사용 가능한 브라우저가 없어 실제 화면 배치 검사는 못 했습니다. DOM 테스트는 별도 통과했습니다. PostgreSQL 실서버·외부 모델·클라우드 배포는 미검증입니다.

```powershell
npm ci --ignore-scripts
npm test
python -m pytest tests/test_aura.py tests/test_aura_api.py -q
```

기존 JS 테스트 25개, AURA DOM 2개, Python 13개 통과. FastAPI TestClient의 httpx 사용에 관한 의존성 폐기 예정 경고 1건이 있습니다. 실패 결과를 숨기지 않으며, 단계별 상태는 `IMPLEMENTATION_STATUS.md`에 기록합니다.
