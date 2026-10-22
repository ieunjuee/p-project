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
        app.state.config, app.state.provider = config, provider
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

    return app


app = create_app()
