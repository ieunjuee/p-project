import os
import secrets
import threading
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError

from .db import AutoAccident, AutoClaim, Dataset, MedClaim, Person, database
from .generator import generate
from .settings import load_config
from .analysis import Analysis
from .agent import configured_provider, investigate
from .db import Audit, Evaluation, Investigation, audit
from .evaluation import evaluate, blind_packet
from fastapi.staticfiles import StaticFiles
from .settings import ROOT


class GenerateRequest(BaseModel):
    seed: int = Field(default=42, ge=0, le=2**31 - 1)
    people: int = Field(default=500, ge=10, le=5000)
    ratios: dict[str, float] | None = None


def create_app(url=None, config=None, provider=None):
    config = config or load_config()

    @asynccontextmanager
    async def lifespan(app):
        engine, factory = database(url)
        app.state.engine, app.state.factory = engine, factory
        app.state.lock = threading.Lock()
        app.state.config, app.state.provider = config, provider or configured_provider()
        # Explicit opt-in: seed a new demo database once; preserve existing data.
        # Bootstrap uses the deterministic workflow and never incurs LLM calls.
        if os.getenv("AURA_BOOTSTRAP_DEMO", "").lower() == "true":
            with factory() as db:
                if db.scalar(select(Person.id).limit(1)) is None:
                    generate(db, config)
                    analysis = Analysis(db, config)
                    for pid in sorted(analysis.people):
                        investigate(db, analysis, pid)
                    db.commit()
        yield
        engine.dispose()

    app = FastAPI(title="InsureLens AURA 2.0", lifespan=lifespan)
    origins = [x.strip() for x in os.getenv("AURA_ALLOWED_ORIGINS", "").split(",") if x.strip()]
    if origins:
        app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST"], allow_headers=["Content-Type", "X-Aura-Token"])

    def session():
        with app.state.factory() as db:
            yield db

    def mutate(request: Request):
        origin = request.headers.get("origin")
        if origin and origin not in origins and origin != str(request.base_url).rstrip("/"):
            raise HTTPException(403, "허용되지 않은 출처입니다.")
        expected = os.getenv("AURA_ADMIN_TOKEN", "")
        if expected:
            if not secrets.compare_digest(request.headers.get("X-Aura-Token", ""), expected):
                raise HTTPException(403, "관리자 토큰이 필요합니다.")
        elif request.client and request.client.host not in {"127.0.0.1", "::1", "testclient"}:
            raise HTTPException(403, "원격 변경에는 AURA_ADMIN_TOKEN 설정이 필요합니다.")

    @app.exception_handler(SQLAlchemyError)
    async def db_error(_, exc):
        return JSONResponse(status_code=503, content={"detail": "DB 요청에 실패했습니다. 트랜잭션은 저장되지 않았습니다."})

    @app.get("/api/health")
    def health(db=Depends(session)):
        db.execute(select(1))
        dataset = db.scalar(select(Dataset).order_by(Dataset.id.desc()))
        return {"status": "ready", "spec_status": config["spec_status"], "spec_note": config["spec_note"], "dataset": dataset.summary if dataset else None, "llm_configured": bool(os.getenv("AURA_LLM_MODEL")), "synthetic_only": True}

    @app.post("/api/data/generate", dependencies=[Depends(mutate)])
    def generate_data(body: GenerateRequest, db=Depends(session)):
        if not app.state.lock.acquire(blocking=False):
            raise HTTPException(409, "다른 데이터 변경 또는 조사 작업이 실행 중입니다.")
        try:
            try:
                result = generate(db, config, body.seed, body.people, body.ratios)
                db.commit()
                return result
            except ValueError as error:
                raise HTTPException(422, str(error)) from error
        finally:
            app.state.lock.release()

    @app.get("/api/people")
    def people(db=Depends(session)):
        return [{"id": p.id, "partition": p.partition} for p in db.scalars(select(Person).order_by(Person.id))]

    @app.get("/api/data/quality")
    def quality(db=Depends(session)):
        counts = {model.__tablename__: db.scalar(select(func.count()).select_from(model)) for model in (Person, MedClaim, AutoAccident, AutoClaim)}
        missing = db.scalar(select(func.count()).select_from(MedClaim).where(MedClaim.paid_amount.is_(None))) + db.scalar(select(func.count()).select_from(AutoClaim).where(AutoClaim.paid_amount.is_(None)))
        return {"counts": counts, "missing_payment_records": missing, "foreign_keys_enforced": True}

    def latest(db):
        rows = db.scalars(select(Investigation).order_by(Investigation.id)).all()
        return list({r.person_id:r for r in rows}.values())

    @app.get("/api/control")
    def control(db=Depends(session)):
        rows = latest(db)
        closed = sum(r.status == "closed_auto" for r in rows)
        return {"total":len(rows),"closed_auto":closed,"needs_review":sum(r.status == "needs_review" for r in rows),"running":int(app.state.lock.locked()),"automation_rate":closed/len(rows) if rows else None,"errors":sum(bool(r.result.get("error")) for r in rows),"average_ms":sum(r.duration_ms for r in rows)/len(rows) if rows else None,"safety_blocks":sum("forbidden_action_blocked" in r.result["gate"]["reasons"] for r in rows),"routes":{route:sum(r.route==route for r in rows) for route in {r.route for r in rows}}}

    @app.get("/api/investigations")
    def investigations(queue: bool=False, domain: str="all", reason: str="", db=Depends(session)):
        rows=latest(db)
        return [{"id":r.id,"person_id":r.person_id,"route":r.route,"status":r.status,"scores":r.result["scores"],"reasons":r.result["gate"]["reasons"],"duration_ms":r.duration_ms} for r in rows if (not queue or r.status=="needs_review") and (not reason or reason in r.result["gate"]["reasons"]) and (domain=="all" or r.result["scores"]["S_"+domain]>0)]

    @app.post("/api/investigate", dependencies=[Depends(mutate)])
    def run(body: dict, db=Depends(session)):
        if not app.state.lock.acquire(blocking=False): raise HTTPException(409,"조사 작업 실행 중")
        try:
            a=Analysis(db,config)
            ids=[body["person_id"]] if body.get("person_id") else sorted(a.people)
            if any(pid not in a.people for pid in ids): raise HTTPException(404,"고객 없음")
            results=[investigate(db,a,pid,app.state.provider) for pid in ids]
            db.commit()
            return {"count":len(results),"results":results if len(ids)==1 else []}
        finally: app.state.lock.release()

    @app.get("/api/investigations/{pid}")
    def detail(pid: str, db=Depends(session)):
        row=db.scalar(select(Investigation).where(Investigation.person_id==pid).order_by(Investigation.id.desc()))
        if not row: raise HTTPException(404,"조사 결과 없음")
        a=Analysis(db,config)
        return {**row.result,"medical":a.signals(pid,"med"),"auto":a.signals(pid,"auto"),"links":a.link(pid),"timeline":[{"kind":kind,**r} for kind in ("med","auto","accident") for r in a.claims(pid,kind,limit=10000)["rows"]]}

    @app.post("/api/review/{pid}",dependencies=[Depends(mutate)])
    def review(pid: str, body: dict, db=Depends(session)):
        if not db.get(Person,pid): raise HTTPException(404,"고객 없음")
        note=str(body.get("note",""))[:4000].strip()
        if not note: raise HTTPException(422,"검토 메모 필요")
        audit(db,"human_review_note",{"note":note,"payment_action":False},pid); db.commit()
        return {"saved":True}

    @app.get("/api/admin")
    def admin(db=Depends(session)):
        ev=db.scalar(select(Evaluation).order_by(Evaluation.id.desc()))
        return {"config":config,"evaluation":ev.result if ev else None,"audit":[{"id":r.id,"at":r.created_at.isoformat(),"event":r.event,"person_id":r.person_id,"payload":r.payload} for r in db.scalars(select(Audit).order_by(Audit.id.desc()).limit(100))]}

    @app.post("/api/evaluate",dependencies=[Depends(mutate)])
    def evaluation(body: dict, db=Depends(session)):
        if not app.state.lock.acquire(blocking=False): raise HTTPException(409,"작업 실행 중")
        try:
            result=evaluate(db,Analysis(db,config),app.state.provider,min(200,max(1,int(body.get("limit",200)))))
            db.commit(); return result
        finally: app.state.lock.release()

    @app.get("/api/evaluation/blind")
    def blind(db=Depends(session)):
        ev=db.scalar(select(Evaluation).order_by(Evaluation.id.desc()))
        return {"entries":blind_packet(ev.result) if ev else [],"reviewers":2,"scale":"1~5","target_cases":20}

    app.mount("/",StaticFiles(directory=ROOT / "dist",html=True),name="frontend")

    return app


app = create_app()
