from fastapi.testclient import TestClient
from backend.api import create_app


def test_end_to_end_control_queue_detail_and_evaluation():
    with TestClient(create_app("sqlite:///:memory:")) as client:
        assert client.post("/api/data/generate",json={"people":50}).status_code == 200
        result=client.post("/api/investigate",json={})
        assert result.status_code == 200, result.text
        assert result.json()["count"] == 50
        control=client.get("/api/control").json()
        assert control["total"] == 50 and control["closed_auto"] > 0
        queue=client.get("/api/investigations?queue=true").json()
        assert queue and all(r["status"] == "needs_review" for r in queue)
        pid=queue[0]["person_id"]
        detail=client.get("/api/investigations/"+pid).json()
        assert detail["verification"]["passed"] and detail["timeline"]
        assert client.post("/api/review/"+pid,json={"note":"영수증 대조 요청"}).json()["saved"]
        ev=client.post("/api/evaluate",json={"limit":20}).json()
        assert ev["groups"]["A"]["status"] == "not_run"
        assert ev["groups"]["B"]["n"] == 20
        assert ev["groups"]["C"]["status"] == "not_run"
        assert client.get("/").status_code == 200
        assert client.post("/api/data/generate",json={"people":50},headers={"Origin":"https://evil.test"}).status_code == 403


def test_admin_token(monkeypatch):
    monkeypatch.setenv("AURA_ADMIN_TOKEN","test-secret")
    with TestClient(create_app("sqlite:///:memory:")) as client:
        assert client.post("/api/data/generate",json={"people":50}).status_code == 403
        assert client.post("/api/data/generate",json={"people":50},headers={"X-Aura-Token":"test-secret"}).status_code == 200
