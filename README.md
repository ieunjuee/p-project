# p-project · InsureLens

보험 청구 데이터를 분석하고, 근거 설명과 담당자의 검토를 돕는 JavaScript 웹페이지입니다.

**과제:** 데이터 기반 의사결정 + LLM 설명 지원 (보험사기 예방)

- 현재 접속 가능한 데모: https://insurelens-review.andy46780040.chatgpt.site (소유자 계정 접근)
- GitHub Pages 주소: https://ieunjuee.github.io/p-project/ (아래 Pages 설정 후 이용)

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

## 설명 모드와 실제 LLM 연결

GitHub Pages와 기본 정적 페이지는 **데모 설명 모드**입니다. 검증된 수치를 정해진 문장으로 설명하며 실제 LLM 출력으로 표시하지 않습니다. GitHub Pages는 이 프로젝트의 Node.js 서버를 실행하지 않습니다.

실제 LLM 연결에는 Node.js 22 이상과 API 키가 필요합니다. `.env.example`을 `.env`로 복사하고 `OPENAI_API_KEY`를 설정한 후 실행합니다.

```sh
node server.mjs
```

브라우저에서 `http://localhost:4177`을 엽니다. 추가 패키지 설치는 없습니다. 키는 서버 환경변수에만 저장하며, `.env`는 Git에서 제외합니다. API 호출에는 고객 ID·의료기관 ID를 제외한 선택 청구의 분석 JSON을 전달합니다. 호출 실패 시 데모 설명으로 전환하고 분석은 유지합니다.

실제 API 호출은 키 미제공으로 검증하지 않았으며, 요청·응답 처리는 모의 API로 테스트합니다.

## 데이터와 분석 범위

필수 열: `claim_id,customer_id,claim_date,amount,insurance_type,hospital_id,treatment_type`. 날짜는 `YYYY-MM-DD`, 금액은 양수입니다. 업로드 데이터와 검토 메모는 현재 탭의 메모리에 유지되며, 새로고침하면 사라집니다. 분석 기준만 브라우저에 저장합니다.

시간 특징은 청구 날짜 이전의 관측 이력만 사용하고, 같은 날짜의 청구끼리는 서로 참조하지 않습니다. 날짜 기준 최초 약 70%로 모델·결측 대체값·점수 비교 분포를 학습하고 이후 구간에서 가상 패턴을 평가합니다. 학습 구간의 점수는 후향적 점수입니다. 학습 표본이 부족하면 규칙 점수만 사용합니다.

모델은 JavaScript로 구현한 48개 무작위 분할 트리와 최대 128건 부분 표본, 고정 시드를 사용합니다. scikit-learn 구현과 결과가 같다고 주장하지 않습니다. 가상 패턴 레이블은 특징과 모델 입력에서 제외합니다.

**점수는 검토 우선순위이며 사기 확률이나 지급 결정이 아닙니다.** 초기 임계값과 가중치는 실험 설정이고, 가상 패턴 성능을 실제 보험사기 탐지 성능으로 해석할 수 없습니다. 최종 확인은 담당자가 합니다.

## 파일 구조와 테스트

- `dist/`: 브라우저에서 실행되는 HTML·CSS·JavaScript
- `server.mjs`, `llm.mjs`: 선택적인 LLM 서버 연동
- `tests/engine.test.cjs`: 누출 방지·재현성·점수·CSV·API 전달 검증
- `.github/workflows/check.yml`: 커밋·PR 자동 검사

```sh
node --test tests/engine.test.cjs
```
