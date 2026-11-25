import copy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_config():
    config = json.loads((ROOT / "backend/config.json").read_text(encoding="utf-8"))
    validate_config(config)
    return copy.deepcopy(config)


def validate_config(c):
    assert c["spec_status"] == "PDF_REVIEWED", "PDF 검증 상태는 코드 검토로만 변경합니다."
    for domain in ("medical", "auto"):
        assert len(c[domain]["weights"]) == 5 and sum(c[domain]["weights"]) == 100
        assert all(v >= 0 for v in c[domain]["weights"])
    assert c["routing"]["weights"] == [0.3, 0.3, 0.4], "명시된 Overall 가중치는 고정입니다."
    assert 0 <= c["routing"]["fast_below"] < c["routing"]["review_at"] <= 100
    assert abs(sum(c["generation"]["scenarios"].values()) - 1) < 1e-9
