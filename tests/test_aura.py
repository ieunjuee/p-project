from datetime import date

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from backend.db import AutoClaim, MedClaim, Person, ScenarioLabel, database
from backend.generator import generate
from backend.settings import load_config
from backend.analysis import Analysis, overall


@pytest.fixture
def db():
    engine, factory = database("sqlite:///:memory:")
    with factory() as session:
        generate(session, load_config(), people=50)
        session.commit()
        yield session
    engine.dispose()


def test_seed_split_and_relationships(db):
    rows = [(x.id, x.person_id, x.service_date, x.actual_cost) for x in db.scalars(select(MedClaim).order_by(MedClaim.id))]
    assert len(rows) == 500
    assert db.scalar(select(func.count()).select_from(Person).where(Person.partition == "tuning")) == 30
    assert db.scalar(select(func.count()).select_from(ScenarioLabel)) == 50
    generate(db, load_config(), people=50)
    db.flush()
    assert rows == [(x.id, x.person_id, x.service_date, x.actual_cost) for x in db.scalars(select(MedClaim).order_by(MedClaim.id))]


def test_invalid_claim_owner_rejected(db):
    a = db.scalar(select(AutoClaim))
    bad = AutoClaim(id="BAD", person_id="P9999", accident_id=a.accident_id, service_date=date(2025, 1, 1), treatment_end=date(2025, 1, 1), hospital_id="H", component="repair", claimed_amount=1, paid_amount=1, actual_cost=1)
    db.add(bad)
    with pytest.raises(IntegrityError):
        db.flush()


def test_invalid_ratios_rejected(db):
    with pytest.raises(ValueError):
        generate(db, load_config(), ratios={"normal": 1})


def test_generation_api():
    from fastapi.testclient import TestClient
    from backend.api import create_app
    with TestClient(create_app("sqlite:///:memory:")) as client:
        assert client.get("/api/health").json()["dataset"] is None
        assert client.post("/api/data/generate", json={"people": 50, "seed": 42}).json()["med_claims"] == 500
        assert len(client.get("/api/people").json()) == 50
        assert client.get("/api/data/quality").json()["missing_payment_records"] == 0
        assert client.post("/api/data/generate", json={"people": 1}).status_code == 422


def test_overall_boundaries():
    assert overall(100, 100, 0) == 60
    assert overall(0, 0, 90) == 90
    assert overall(20, 40, 10) == 22
    for value in (-1, 101, float("nan")):
        with pytest.raises(ValueError):
            overall(value, 0, 0)


def test_domains_link_duplicate_split_and_hidden_labels(db):
    analysis = Analysis(db, load_config())
    labels = list(db.scalars(select(ScenarioLabel)))
    for label in labels:
        pid = label.person_id
        assert 0 <= analysis.signals(pid, "med")["score"] <= 100
        assert 0 <= analysis.signals(pid, "auto")["score"] <= 100
        result = analysis.duplicate(pid)
        if label.duplicate:
            assert result["confirmed"]
            assert result["D"] > 0
            assert analysis.link(pid)["count"] > 0
        if label.scenario == "normal_split":
            assert not result["confirmed"]
            assert any(m["status"] == "normal_split" for m in result["matches"])
        assert "scenario" not in str(analysis.profile(pid))
    pid = labels[0].person_id
    before = analysis.compute(pid)
    for label in labels:
        label.risky = not label.risky
        label.scenario = "tampered"
    db.flush()
    assert Analysis(db, load_config()).compute(pid) == before


def test_duplicate_matching_no_cartesian_double_count_and_unknown(db):
    label = db.scalar(select(ScenarioLabel).where(ScenarioLabel.scenario == "duplicate"))
    pid = label.person_id
    med = db.scalar(select(MedClaim).where(MedClaim.person_id == pid, MedClaim.id.like("%LINK")))
    original = Analysis(db, load_config()).duplicate(pid)
    fields = {k: v for k, v in vars(med).items() if not k.startswith("_")}
    fields["id"] = "COPY"
    fields["claimed_amount"] = med.claimed_amount
    fields["paid_amount"] = 0
    db.add(MedClaim(**fields))
    db.flush()
    assert Analysis(db, load_config()).duplicate(pid)["D"] == original["D"]
    med.paid_amount = None
    db.flush()
    result = Analysis(db, load_config()).duplicate(pid)
    assert result["unknown"] and not result["confirmed"]


def test_evaluation_values_do_not_fit_model(db):
    cfg = load_config()
    before = Analysis(db, cfg)
    baseline = before.med_baseline.copy()
    tuning = [pid for pid, p in before.people.items() if p.partition == "tuning"]
    expected = {pid: before.compute(pid) for pid in tuning}
    for pid, p in before.people.items():
        if p.partition == "evaluation":
            for row in before.med[pid]:
                row.actual_cost *= 100
    db.flush()
    after = Analysis(db, cfg)
    assert after.med_baseline == baseline
    assert {pid: after.compute(pid) for pid in tuning} == expected


def test_agent_workflow_verification_gate_and_failures(db):
    from backend.agent import Investigator, investigate, verify
    a = Analysis(db, load_config())
    pid = db.scalar(select(ScenarioLabel.person_id).where(ScenarioLabel.duplicate.is_(True)))
    result = investigate(db,a,pid)
    assert result["verification"]["passed"]
    assert result["gate"]["route"] == "detailed_review"
    assert not result["gate"]["payment_approved"]
    runner = Investigator(a,pid)
    report = runner.run()
    report["claims"][0]["text"] = "허위 금액 999999999"
    assert not verify(db,runner,report)["passed"]
    with pytest.raises(ValueError): runner.tool("approve_payment")
    class Broken:
        def complete(self,*args): raise ConnectionError()
    failed = investigate(db,a,pid,Broken())
    assert failed["gate"]["status"] == "needs_review"
    assert failed["error"] == "ConnectionError"


def test_safe_auto_close_and_tool_cache(db):
    from backend.agent import Investigator, investigate
    a = Analysis(db,load_config())
    results = [investigate(db,a,pid,persist=False) for pid in a.people]
    assert any(r["gate"]["status"] == "closed_auto" for r in results)
    runner = Investigator(a,next(iter(a.people)))
    runner.tool("get_profile"); runner.tool("get_profile")
    assert runner.logs[-1]["status"] == "cached"


def test_actual_tool_call_protocol_with_mock_provider(db):
    from backend.agent import Investigator, TOOLS, investigate
    a=Analysis(db,load_config()); pid=next(iter(a.people))
    report=Investigator(a,pid).run()
    class Mock:
        turns=0
        def complete(self,messages,tools):
            self.turns+=1
            assert len(tools)==7
            if self.turns==1:
                return {"calls":[{"id":str(i),"name":n,"args":{}} for i,n in enumerate(TOOLS[:6])],"output":[],"input_tokens":100}
            assert sum(m.get("type")=="function_call_output" for m in messages)==6
            return {"calls":[],"final":report,"input_tokens":200}
    result=investigate(db,a,pid,Mock())
    assert result["mode"]=="tool_calling" and result["verification"]["passed"]
    assert result["input_tokens"]==300
