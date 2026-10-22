# AURA 2.0 구현 상태

- 작업 브랜치: `feature/aura-pdf-implementation`
- 기준 PDF 미첨부: 사용자 프롬프트에 명시된 공식·처리 경로 구현. PDF의 상세 스키마, 10개 지표 임계값, D/비율 산식, 시나리오 비율, 블라인드 평가표는 대조 전이며 실험용 대체값을 명시한다.
- Phase 1: SQLAlchemy 관계형 스키마(PostgreSQL/SQLite), seed 합성 원장, 고객 단위 튜닝/평가 분리, 별도 평가 라벨.
- Phase 2: 의료/자동차 5개 지표, 튜닝 고객만 학습하는 Isolation Forest, 사고·진료 연결, 비용 묶음 단위 지급 대조, 결정론적 Overall 구현. D/비율은 PDF 미대조 대체식으로 명시.
- 검증: Phase 1의 생성/API/무결성 4개 통과. Phase 2는 중복 재집계·정상 분리·지급 미상·라벨 비노출·평가 누수 회귀 검증 포함.
- 기존 변경사항: 시작 시 git clean, 기존 JS 분석 엔진·차트 보존.
- 검증/후속 Phase는 각 커밋에서 갱신.
