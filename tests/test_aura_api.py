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


def test_github_pages_cors_and_admin_auth(monkeypatch):
    monkeypatch.setenv("AURA_ALLOWED_ORIGINS", "https://ieunjuee.github.io")
    monkeypatch.setenv("AURA_ADMIN_TOKEN", "test-secret")
    with TestClient(create_app("sqlite:///:memory:")) as client:
        headers={"Origin":"https://ieunjuee.github.io"}
        health=client.get("/api/health",headers=headers)
        assert health.headers["access-control-allow-origin"] == headers["Origin"]
        preflight=client.options("/api/data/generate",headers={**headers,"Access-Control-Request-Method":"POST","Access-Control-Request-Headers":"content-type,x-aura-token"})
        assert preflight.status_code == 200
        assert client.post("/api/data/generate",json={"people":50},headers=headers).status_code == 403
        assert client.post("/api/data/generate",json={"people":50},headers={**headers,"X-Aura-Token":"test-secret"}).status_code == 200


def test_bootstrap_only_initializes_an_empty_database(monkeypatch,tmp_path):
    from backend.settings import load_config
    monkeypatch.setenv("AURA_BOOTSTRAP_DEMO","true")
    config=load_config()
    config["generation"].update(people=10,med_claims=100,accidents=12)
    url="sqlite:///"+(tmp_path/"demo.sqlite3").as_posix()
    with TestClient(create_app(url,config)) as client:
        assert client.get("/api/control").json()["total"] == 10
        audit=client.get("/api/admin").json()["audit"]
    with TestClient(create_app(url,config)) as client:
        assert client.get("/api/control").json()["total"] == 10
        assert client.get("/api/admin").json()["audit"] == audit


def test_managed_postgres_urls_choose_installed_psycopg_driver(monkeypatch):
    import pytest
    import backend.db as db
    captured=[]
    def capture(url,**options):
        captured.append(url)
        raise RuntimeError("connection not attempted")
    monkeypatch.setattr(db,"create_engine",capture)
    for scheme in ("postgres://","postgresql://","postgresql+psycopg://"):
        with pytest.raises(RuntimeError,match="not attempted"):
            db.database(scheme+"user:example@db.invalid/aura")
    assert all(url.startswith("postgresql+psycopg://") for url in captured)
