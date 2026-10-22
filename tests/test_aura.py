from datetime import date

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from backend.db import AutoClaim, MedClaim, Person, ScenarioLabel, database
from backend.generator import generate
from backend.settings import load_config


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
