import os
from datetime import datetime, timezone

from sqlalchemy import (JSON, Boolean, CheckConstraint, Date, DateTime, ForeignKey,
                        ForeignKeyConstraint, Integer, String, UniqueConstraint, create_engine, event)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker
from sqlalchemy.pool import StaticPool

from .settings import ROOT


def now():
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Person(Base):
    __tablename__ = "person"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    partition: Mapped[str] = mapped_column(String(12), index=True)
    age: Mapped[int] = mapped_column(Integer)
    policy_start: Mapped[object] = mapped_column(Date)
    declared_conditions: Mapped[list] = mapped_column(JSON, default=list)
    __table_args__ = (CheckConstraint("partition IN ('tuning','evaluation')"), CheckConstraint("age BETWEEN 18 AND 100"))


class KCD(Base):
    __tablename__ = "kcd_master"
    code: Mapped[str] = mapped_column(String(12), primary_key=True)
    description: Mapped[str] = mapped_column(String(100))
    injury: Mapped[bool] = mapped_column(Boolean)


class MedClaim(Base):
    __tablename__ = "med_claim"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    person_id: Mapped[str] = mapped_column(ForeignKey("person.id"), index=True)
    service_date: Mapped[object] = mapped_column(Date)
    treatment_end: Mapped[object] = mapped_column(Date)
    hospital_id: Mapped[str] = mapped_column(String(32))
    receipt_id: Mapped[str | None] = mapped_column(String(64))
    component: Mapped[str] = mapped_column(String(24), default="treatment")
    kcd_code: Mapped[str] = mapped_column(ForeignKey("kcd_master.code"))
    actual_cost: Mapped[int | None] = mapped_column(Integer)
    claimed_amount: Mapped[int] = mapped_column(Integer)
    paid_amount: Mapped[int | None] = mapped_column(Integer)
    __table_args__ = (CheckConstraint("actual_cost >= 0"), CheckConstraint("claimed_amount >= 0"), CheckConstraint("paid_amount >= 0 AND paid_amount <= claimed_amount"), CheckConstraint("treatment_end >= service_date"))


class AutoAccident(Base):
    __tablename__ = "auto_accident"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    person_id: Mapped[str] = mapped_column(ForeignKey("person.id"), index=True)
    accident_date: Mapped[object] = mapped_column(Date)
    accident_type: Mapped[str] = mapped_column(String(24))
    severity: Mapped[str] = mapped_column(String(12))
    __table_args__ = (UniqueConstraint("id", "person_id"),)


class AutoClaim(Base):
    __tablename__ = "auto_claim"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    person_id: Mapped[str] = mapped_column(ForeignKey("person.id"), index=True)
    accident_id: Mapped[str] = mapped_column(String(32), index=True)
    service_date: Mapped[object] = mapped_column(Date)
    treatment_end: Mapped[object] = mapped_column(Date)
    hospital_id: Mapped[str] = mapped_column(String(32))
    receipt_id: Mapped[str | None] = mapped_column(String(64))
    component: Mapped[str] = mapped_column(String(24))
    kcd_code: Mapped[str | None] = mapped_column(ForeignKey("kcd_master.code"))
    actual_cost: Mapped[int | None] = mapped_column(Integer)
    claimed_amount: Mapped[int] = mapped_column(Integer)
    paid_amount: Mapped[int | None] = mapped_column(Integer)
    __table_args__ = (ForeignKeyConstraint(["accident_id", "person_id"], ["auto_accident.id", "auto_accident.person_id"]), CheckConstraint("actual_cost >= 0"), CheckConstraint("claimed_amount >= 0"), CheckConstraint("paid_amount >= 0 AND paid_amount <= claimed_amount"), CheckConstraint("treatment_end >= service_date"))


class ScenarioLabel(Base):
    __tablename__ = "scenario_label"
    person_id: Mapped[str] = mapped_column(ForeignKey("person.id"), primary_key=True)
    scenario: Mapped[str] = mapped_column(String(32))
    risky: Mapped[bool] = mapped_column(Boolean)
    duplicate: Mapped[bool] = mapped_column(Boolean)
    confusing_normal: Mapped[bool] = mapped_column(Boolean)


class Dataset(Base):
    __tablename__ = "dataset"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[object] = mapped_column(DateTime(timezone=True), default=now)
    seed: Mapped[int] = mapped_column(Integer)
    summary: Mapped[dict] = mapped_column(JSON)


class Investigation(Base):
    __tablename__ = "investigation"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    person_id: Mapped[str] = mapped_column(ForeignKey("person.id"), index=True)
    created_at: Mapped[object] = mapped_column(DateTime(timezone=True), default=now)
    route: Mapped[str] = mapped_column(String(32), index=True)
    status: Mapped[str] = mapped_column(String(24), index=True)
    result: Mapped[dict] = mapped_column(JSON)
    duration_ms: Mapped[int] = mapped_column(Integer)


class Audit(Base):
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[object] = mapped_column(DateTime(timezone=True), default=now)
    event: Mapped[str] = mapped_column(String(64), index=True)
    person_id: Mapped[str | None] = mapped_column(String(32))
    payload: Mapped[dict] = mapped_column(JSON)


class Evaluation(Base):
    __tablename__ = "evaluation"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[object] = mapped_column(DateTime(timezone=True), default=now)
    result: Mapped[dict] = mapped_column(JSON)


def database(url=None):
    (ROOT / "data").mkdir(exist_ok=True)
    url = url or os.getenv("DATABASE_URL", "sqlite:///" + (ROOT / "data/aura.sqlite3").as_posix())
    options = {}
    if url.startswith("sqlite"):
        options["connect_args"] = {"check_same_thread": False}
        if ":memory:" in url:
            options["poolclass"] = StaticPool
    engine = create_engine(url, **options)
    if url.startswith("sqlite"):
        @event.listens_for(engine, "connect")
        def enable_foreign_keys(conn, _):
            conn.execute("PRAGMA foreign_keys=ON")
    Base.metadata.create_all(engine)
    return engine, sessionmaker(engine, expire_on_commit=False)


def audit(session, event_name, payload, person_id=None):
    session.add(Audit(event=event_name, payload=payload, person_id=person_id))
