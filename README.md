# p-project · InsureLens

보험 청구 데이터를 분석하고, 근거 설명과 담당자의 검토를 돕는 JavaScript 웹페이지입니다.

**과제:** 데이터 기반 의사결정 + LLM 설명 지원 (보험사기 예방)

- 현재 접속 가능한 데모: https://insurelens-review.andy46780040.chatgpt.site (소유자 계정 접근)
- GitHub Pages 주소: https://ieunjuee.github.io/p-project/ (아래 Pages 설정 후 이용)

## 보험 이력 확인: 사람 기준 화면 (2026-10 추가)

기존 데모는 청구 한 건씩 점수를 매깁니다. 새로 추가한 `dist/person.html`은 **한 사람의 자동차보험 이력과 의료보험 이력을 함께** 보고, 같은 비용을 두 번 받았는지까지 확인합니다.

| 파일 | 역할 |
| --- | --- |
| `data/schema.sql` | SQLite 6개 테이블 (person, kcd_master, med_claim, auto_accident, auto_claim, scenario_label) |
| `data/build_db.py` | 모의 데이터 생성 (500명, 8개 시나리오) → `data/insure.db`, `dist/data/mock.json`, `dist/data/labels.json`(검증 탭 전용 정답표) |
| `dist/person-sql.js` | **화면이 쓰는 계산.** 의료 지표 5개, 자동차 지표 5개, 사고-진료 교차 판정을 SQLite 쿼리(sql.js)로 계산 |
| `dist/person-engine.js` | 점수, 위험도, 결과 제안을 정하는 부분과 LLM 근거 만들기. 같은 지표를 JS로도 계산해 SQL 결과와 대조하는 기준이자, SQLite를 못 불러올 때의 대체 계산 |
| `dist/data/insure.db` | 화면용 SQLite DB (정답표 테이블 제외). `dist/vendor/sql-wasm.*`로 브라우저에서 엽니다 |
| `dist/person-app.js` | 화면 5개: 분석 개요, 확인 대상 목록, 사람 조회, 분석 보고서, 검증 결과 |
| `person-llm.mjs` | LLM 설명 요청. 점수에는 관여하지 않고 설명만 만듭니다 |
| `tools/evaluate.mjs` | 정답표와 비교한 성능 출력 |
| `tools/verify_sql.py` | 엔진 계산값을 SQL로 다시 계산해 대조 |

```bash
python3 data/build_db.py     # 모의 데이터 생성 (최초 1회)
npm start                    # http://localhost:4177/person.html
node tools/evaluate.mjs      # 성능 확인
python3 tools/verify_sql.py  # SQL 교차 검증
npm test                     # 단위 테스트
```

`dist/person.html`은 `data/insure.db`와 `data/mock.json`을 fetch 하므로 파일을 직접 열면 동작하지 않습니다. `npm start` 또는 정적 서버로 여세요.

### 계산 방식

- 지표와 교차 판정은 브라우저 안의 SQLite(sql.js, WASM)에서 SQL로 계산합니다. 서버 없이 정적 파일만으로 동작하며, 서버는 LLM 호출에만 필요합니다.
- `npm test`의 `person-sql.test.cjs`가 SQL 결과와 JS 계산 결과가 500명 전원에게 같은지 확인합니다. 화면 상단의 `계산: SQLite 쿼리` 배지로 어느 방식으로 계산했는지 볼 수 있고, SQLite를 불러오지 못하면 `계산: JS 대체`로 표시됩니다.

- 의료 점수 = 걸린 의료 지표 수 ÷ 5 × 100, 자동차 점수도 같은 방식
- 종합 점수 = 두 점수 중 큰 값
- 위험도: 30점 미만 낮음, 30~60점 보통, 60점 이상 높음. **중복 확실은 점수와 무관하게 높음**
- 중복 의심, 고지 확인, 기왕증이 있으면 최소 보통
- 영수증 번호가 양쪽 모두 비어 중복 여부를 확인할 수 없으면 판단 불가
- 기준값(8회, 3일, 상위 5%, 30점, 60점)은 **초안**이며 팀 합의와 재조정이 필요합니다

### 담당자를 돕는 LLM 기능 3가지 (사람 조회 화면)

| 기능 | 하는 일 | 데모 모드 |
| --- | --- | --- |
| 담당자 질문 | "왜 보류인가요?" 같은 질문에 근거 번호를 달아 답함 | 질문의 단어로 종류를 나눠 정해진 문장으로 답함 |
| 증빙 요청서 초안 | 보류와 정지 권고 건에 고객에게 요청할 서류와 안내 문장을 작성 (담당자가 확인 후 직접 발송, 시스템은 보내지 않음) | 지표와 판정별 서류 목록으로 작성 |
| 판단 불가 보완 | 영수증이 비어 판단 불가인 건에서 무엇을 확인하면 판단되는지 정리 | 비어 있는 청구와 확인 방법을 정리 |

`/api/person-assist`는 로컬 LLM(기본 Qwen3 14B)으로 답을 만들고, 연결이 안 되면 데모 응답을 돌려줍니다. LLM 응답 속 응답 속 숫자와 번호는 `verifyExplanation`이 코드 계산 결과와 대조하고, 다르면 데모 응답으로 대체합니다. 결과 제안(지급, 지급 보류, 지급 정지 권고)은 코드가 정하며, 낮음은 지급, 중복 확실은 정지 권고, 나머지는 보류입니다. 최종 결정은 담당자가 합니다.

### 역할 구분

점수와 위험도는 코드만 정합니다. LLM은 코드가 만든 근거 JSON을 받아 설명만 하고, 설명에 나온 숫자와 청구 번호는 `verifyExplanation`이 코드 계산 결과와 대조해 다르면 그 설명을 무효 처리합니다. 지급 여부는 담당자가 결정합니다.

## 바로 열기

저장소를 다운로드한 뒤 `index.html` 또는 `InsureLens.html`을 더블클릭하세요. 기본 데모는 Python, Node.js, 패키지 설치 없이 실행됩니다.

샘플 2,000건으로 시작하며, **분석 개요 → 검토 대상 → 청구 상세·AI 설명 → 분석 보고서** 순서로 사용합니다.

## GitHub Pages 게시

저장소 소유자 또는 Pages 관리 권한이 있는 계정으로 다음 항목을 설정합니다.

1. 저장소 **Settings → Pages**를 엽니다.
2. **Source**에서 **Deploy from a branch**를 선택합니다.
3. **Branch**는 `main`, 폴더는 `/(root)`로 선택하고 **Save**를 누릅니다.

게시 완료 후 https://ieunjuee.github.io/p-project/ 로 접속합니다. 이후 `main` 브랜치에 변경 사항을 올리면 갱신됩니다. 루트 `index.html`이 실제 앱인 `dist/index.html`을 엽니다.

## 구현 기능

- UTF-8 CSV 업로드, 필수 열·날짜·금액·중복 검증과 제외 사유 표시
- 과거 시점 기준 특징 추출, 규칙 분석과 JavaScript Isolation Forest
- 조정 가능한 탐지 기준·가중치, 변경 전후 결과 비교
- 청구별 근거, 설명·질문 응답, 담당자 검토 메모
- 분석 결과 CSV, 인쇄 창을 통한 PDF 저장
- 과제 요구사항과 구현 기능을 비교하는 ‘과제 적합성’ 화면
- 금액·검토점수 히스토그램, 원형·도넛 구성비, 규칙별 탐지 막대, 월별 건수·금액 추이
- 차트 구간을 눌러 청구 목록 필터링, 선택 조건 해제, 필터 결과 CSV 내보내기

차트의 범례와 조각은 실제 건수·비율을 표시합니다. 금액 히스토그램은 동일 간격 또는 로그 간격으로 전환할 수 있고, 큰 금액도 제외하지 않습니다. ‘수치 표로 보기’에서 차트 집계값을 표로 확인할 수 있습니다. 검토 대상 화면에서는 표와 차트가 같은 필터 조건을 사용합니다.

## 설명 모드와 실제 LLM 연결

GitHub Pages와 기본 정적 페이지는 **데모 설명 모드**입니다. 검증된 수치를 정해진 문장으로 설명하며 실제 LLM 출력으로 표시하지 않습니다. GitHub Pages는 이 프로젝트의 Node.js 서버를 실행하지 않습니다.

사람 단위 화면(`person.html`)의 LLM은 **내 컴퓨터에서 실행하는 로컬 모델**을 OpenAI 호환 주소로 호출합니다. 기본값은 Ollama의 Qwen3 14B입니다.

```sh
ollama pull qwen3:14b
OLLAMA_CONTEXT_LENGTH=8192 ollama serve   # 기본 문맥 길이(4096)는 근거 JSON이 긴 사람에게 모자랄 수 있습니다
cp .env.example .env                      # 주소와 모델 이름을 바꿀 때만 수정
node server.mjs                           # http://localhost:4177/person.html
```

| 환경변수 | 기본값 | 설명 |
| --- | --- | --- |
| `LLM_BASE_URL` | `http://localhost:11434/v1` | LM Studio, vLLM 등 OpenAI 호환 서버면 주소만 바꿉니다 |
| `LLM_MODEL` | `qwen3:14b` | 다른 오픈소스 모델 비교 시 이름만 바꿉니다 |
| `LLM_API_KEY` | 비움 | 로컬 모델은 필요 없습니다 |
| `LLM_TIMEOUT_MS` | `120000` | 14B 모델의 첫 응답이 느릴 수 있어 길게 둡니다 |
| `LLM_MODE=demo` | 없음 | LLM을 부르지 않고 데모 설명만 씁니다 |

요청은 `temperature 0`, 구조화 JSON 형식, Qwen3의 생각 단계 끄기(`/no_think`)로 보내고, 응답에 `<think>` 구간이 섞여도 무시합니다. 호출에는 고객 ID와 의료기관 ID를 제외한 분석 JSON만 전달합니다. 연결이 안 되거나 응답이 틀리면 데모 설명으로 바뀌고 분석은 유지됩니다. 기존 청구 단위 화면(`index.html`)의 `/api/explain`만 아직 `OPENAI_API_KEY`를 씁니다.

**검증 상태:** 실제 Qwen3 14B 호출은 시험하지 못했습니다. 요청 형식, 응답 처리, 연결 실패 시 데모 전환은 가짜 로컬 서버와 모의 fetch로 확인했습니다. 실제 모델의 출력 품질과 JSON 형식 준수는 직접 돌려 확인해야 합니다.

## 데이터와 분석 범위

필수 열: `claim_id,customer_id,claim_date,amount,insurance_type,hospital_id,treatment_type`. 날짜는 `YYYY-MM-DD`, 금액은 양수입니다. 업로드 데이터와 검토 메모는 현재 탭의 메모리에 유지되며, 새로고침하면 사라집니다. 분석 기준만 브라우저에 저장합니다.

시간 특징은 청구 날짜 이전의 관측 이력만 사용하고, 같은 날짜의 청구끼리는 서로 참조하지 않습니다. 날짜 기준 최초 약 70%로 모델·결측 대체값·점수 비교 분포를 학습하고 이후 구간에서 가상 패턴을 평가합니다. 학습 구간의 점수는 후향적 점수입니다. 학습 표본이 부족하면 규칙 점수만 사용합니다.

모델은 JavaScript로 구현한 48개 무작위 분할 트리와 최대 128건 부분 표본, 고정 시드를 사용합니다. scikit-learn 구현과 결과가 같다고 주장하지 않습니다. 가상 패턴 레이블은 특징과 모델 입력에서 제외합니다.

**점수는 검토 우선순위이며 사기 확률이나 지급 결정이 아닙니다.** 초기 임계값과 가중치는 실험 설정이고, 가상 패턴 성능을 실제 보험사기 탐지 성능으로 해석할 수 없습니다. 최종 확인은 담당자가 합니다.

## 파일 구조와 테스트

- `dist/`: 브라우저에서 실행되는 HTML·CSS·JavaScript
- `dist/charts.js`, `dist/charts.css`: 차트 집계·표시·상호작용·반응형 스타일
- `server.mjs`, `llm.mjs`: 선택적인 LLM 서버 연동
- `tests/engine.test.cjs`, `tests/charts.test.cjs`, `tests/ui.test.cjs`: 분석, 집계 경계값, 화면 상태 전환 검증
- `.github/workflows/check.yml`: 커밋·PR 자동 검사

```sh
npm ci --ignore-scripts
npm test
```

테스트용 DOM 환경에만 개발 의존성(jsdom)을 사용합니다. 페이지를 열거나 기본 분석·선택적 LLM 서버를 실행할 때에는 패키지 설치가 필요 없습니다. DOM 테스트는 실제 브라우저의 화면 배치 검증을 대신하지 않습니다.
