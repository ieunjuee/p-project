# p-project · InsureLens

보험 청구 데이터를 분석하고, 근거 설명과 담당자의 검토를 돕는 JavaScript 웹페이지입니다.

**과제:** 데이터 기반 의사결정 + LLM 설명 지원 (보험사기 예방)

- 현재 접속 가능한 데모: https://insurelens-review.andy46780040.chatgpt.site (소유자 계정 접근)
- GitHub Pages 주소: https://ieunjuee.github.io/p-project/ (아래 Pages 설정 후 이용)

## 바로 열기

저장소를 다운로드한 뒤 `index.html` 또는 `InsureLens.html`을 더블클릭하세요. 기본 데모는 Python, Node.js, 패키지 설치 없이 실행됩니다.

샘플 2,000건으로 시작하며, **분석 개요 → 검토 대상 → 청구 상세·AI 설명 → 분석 보고서** 순서로 사용합니다.

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

<!-- [기존 문구 보존] 실제 LLM 연결에는 Node.js 22 이상과 API 키가 필요합니다. `.env.example`을 `.env`로 복사하고 `OPENAI_API_KEY`를 설정한 후 실행합니다. -->
실제 LLM 연결에는 Node.js 22 이상과 **이 PC에 내려받은 로컬 모델(Ollama의 Qwen3 14B)**이 필요합니다. 모델 파일은 저장소에 들어 있지 않으므로 각자의 PC에 한 번 내려받아야 합니다. 모델이 없거나 Ollama가 꺼져 있으면 화면은 데모 설명 모드로 동작합니다. API 키는 필요 없습니다.

### 로컬 LLM(Qwen3 14B) 준비 (처음 한 번만)

1. **Ollama 설치**: [ollama.com](https://ollama.com)에서 설치 파일을 받아 설치하거나, Windows 터미널에서 `winget install --id Ollama.Ollama -e`를 실행합니다. 설치하면 Ollama가 백그라운드에서 실행됩니다.
2. **모델 내려받기**: 터미널에서 `ollama pull qwen3:14b`를 실행합니다. 파일 크기는 약 9.3GB이고 인터넷 속도에 따라 시간이 걸리므로 디스크 여유 공간이 필요합니다.
3. **설치 확인**: `ollama list`를 실행해 `qwen3:14b`가 목록에 보이는지 확인합니다. 브라우저에서 `http://localhost:11434`를 열어 `Ollama is running`이 보이면 서버가 켜져 있는 것입니다.
4. **Node.js 확인**: `node --version`이 22 이상인지 확인합니다. 없으면 [nodejs.org](https://nodejs.org)에서 LTS 버전을 설치합니다.
5. **설정 파일 만들기**: 저장소 폴더에서 `.env.example`을 `.env`로 복사합니다. Windows 명령 프롬프트는 `copy .env.example .env`, PowerShell은 `Copy-Item .env.example .env`, macOS와 Linux는 `cp .env.example .env`입니다. 기본값이 로컬 모델이라 고칠 내용은 없습니다.
6. **서버 실행**: 아래 `node server.mjs`를 실행하고 `http://localhost:4177`을 엽니다. 상세 화면의 AI 검토 어시스턴트에 **로컬 LLM 연결**이 표시되면 준비가 끝난 것입니다.

**컴퓨터 사양**: `qwen3:14b`는 실행 중에 GPU 메모리를 약 9.6GB 사용합니다(이 프로젝트는 RTX 3080 Ti 12GB에서 확인했습니다). GPU 메모리가 부족하면 일부가 CPU로 처리되어 느려질 수 있으며, `ollama ps`로 확인할 수 있습니다. 더 작은 모델(예: `qwen3:8b`)을 받아 `.env`의 `OLLAMA_MODEL`을 바꿀 수도 있지만, 이 프로젝트에서 확인한 모델은 `qwen3:14b`뿐입니다.

```sh
node server.mjs
```

<!-- [기존 문구 보존] 브라우저에서 `http://localhost:4177`을 엽니다. 추가 패키지 설치는 없습니다. 키는 서버 환경변수에만 저장하며, `.env`는 Git에서 제외합니다. API 호출에는 고객 ID·의료기관 ID를 제외한 선택 청구의 분석 JSON을 전달합니다. 호출 실패 시 데모 설명으로 전환하고 분석은 유지합니다. -->
브라우저에서 `http://localhost:4177`을 엽니다. 추가 패키지 설치는 없습니다. `.env`는 Git에서 제외합니다. 설명 생성에는 고객 ID·의료기관 ID를 제외한 선택 청구의 분석 JSON만 이 PC의 Ollama에 전달하며 외부로 전송하지 않습니다. 호출 실패 시 데모 설명으로 전환하고 분석은 유지합니다.

<!-- [기존 문구 보존] 실제 API 호출은 키 미제공으로 검증하지 않았으며, 요청·응답 처리는 모의 API로 테스트합니다. -->
로컬 모델(Qwen3 14B)로는 서버와 화면에서 동작을 확인했습니다. OpenAI 방식은 키 미제공으로 실제 호출을 검증하지 않았고 모의 API로 테스트합니다.

### 로컬 모델 설정과 OpenAI 선택

기본값은 이 PC에서 돌아가는 로컬 모델(Ollama, Qwen3 14B)입니다. 분석 근거 JSON이 외부로 나가지 않고 이 PC 안에서만 처리됩니다. 모델과 주소는 `OLLAMA_MODEL`(기본 `qwen3:14b`), `OLLAMA_URL`(기본 `http://localhost:11434`)로 바꿉니다.

Qwen3의 생각 과정은 끄고(`think:false`), 응답은 서버가 정해진 JSON 스키마로 내도록 강제합니다. 첫 호출은 모델을 메모리에 올리느라 더 걸릴 수 있고, 화면은 30초 안에 응답이 없으면 데모 설명으로 전환합니다. Ollama가 꺼져 있거나 응답이 형식에 맞지 않으면 분석은 유지하고 데모 설명으로 전환합니다. 이전처럼 OpenAI를 쓰려면 `.env`에 `LLM_PROVIDER=openai`와 `OPENAI_API_KEY`를 설정합니다. (기존에는 OpenAI가 기본값이었고, 지금은 `LLM_PROVIDER`를 지정하지 않으면 로컬 모델을 씁니다.)

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
