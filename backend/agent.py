import json
import os
import re
from time import perf_counter

import httpx
from sqlalchemy import func, select

from .analysis import Analysis, overall, record
from .db import AutoAccident, AutoClaim, Investigation, MedClaim, audit

TOOLS = ["get_profile", "get_med_signals", "get_auto_signals", "link_accident_treatment", "check_duplicate", "compute_overall", "get_claims"]
INSTRUCTIONS = '''보험 조사 도구를 선택해 조사하라. 첫 6개 도구는 모두 조회하고 필요하면 get_claims를 호출한다.
고객은 서버에서 고정한다. 지급 승인/거절/보류 및 정책 변경 권한이 없다.
최종 응답은 JSON {"claims":[{"text":"설명", "evidence_ids":["도구명"], "facts":[{"tool":"도구명","field":"최상위 숫자/날짜 필드명","value":값}]}],"proposed_actions":[]}.
모든 주요 주장에 evidence_ids를 붙이고 숫자와 날짜는 facts로 도구 결과의 정확한 값을 인용한다. 점수를 바꾸지 않는다.
법적 사기 확정 표현을 쓰지 않는다. 확인된 양쪽 지급은 정밀 검토 대상으로 설명한다.'''


class Provider:
    """Responses API, with an explicit model; no silent model substitution."""
    def __init__(self):
        self.model = os.getenv("AURA_LLM_MODEL", "")
        self.base = os.getenv("AURA_LLM_BASE_URL", "https://api.openai.com/v1").rstrip("/")
        self.key = os.getenv("OPENAI_API_KEY", "")

    def complete(self, messages, tools):
        with httpx.Client(timeout=30) as client:
            response = client.post(self.base + "/responses", headers={"Authorization": "Bearer " + self.key}, json={"model": self.model, "instructions": INSTRUCTIONS if tools else "Return only the user requested raw-baseline JSON. Do not execute decisions.", "input": messages, "tools": tools, "store": False})
            response.raise_for_status()
            data = response.json()
        calls = [{"id": r["call_id"], "name": r["name"], "args": json.loads(r["arguments"])} for r in data.get("output", []) if r["type"] == "function_call"]
        content = "".join(c.get("text", "") for r in data.get("output", []) if r["type"] == "message" for c in r.get("content", []))
        return {"calls": calls, "output": data.get("output", []), "final": json.loads(content) if content and not calls else None, "input_tokens": data.get("usage", {}).get("input_tokens")}


def configured_provider():
    return Provider() if os.getenv("AURA_LLM_MODEL") else None


def safety_gate(scores, duplicate, verified, missing=False, error=False, forbidden=False, conflict=False, config=None):
    reasons = []
    if error: reasons.append("investigation_failed")
    if not verified: reasons.append("evidence_verification_failed")
    if missing: reasons.append("missing_core_data")
    if conflict: reasons.append("unresolved_conflict")
    if forbidden: reasons.append("forbidden_action_blocked")
    route = "unable_to_determine" if reasons else "detailed_review" if duplicate["confirmed"] or scores["S_overall"] >= config["routing"]["review_at"] else "general_review" if scores["S_overall"] >= config["routing"]["fast_below"] else "fast_candidate"
    if duplicate["confirmed"]:
        reasons.append("confirmed_payment_overlap")
        if not (missing or error or not verified or conflict): route = "detailed_review"
    if duplicate.get("concerns"): reasons.extend(duplicate["concerns"])
    if route == "detailed_review": reasons.append("high_risk")
    if route == "general_review": reasons.append("general_review_required")
    return {"route": route, "status": "needs_review" if reasons else "closed_auto", "reasons": sorted(set(reasons)), "payment_approved": False, "action": "investigation_only"}


class Investigator:
    def __init__(self, analysis, pid, provider=None):
        self.a, self.pid, self.provider = analysis, pid, provider
        self.outputs, self.logs, self.calls, self.blocked = {}, [], 0, False
        self.tokens = 0 if provider else None
        self.source_rows = {cls.__tablename__: [record(r) for r in rows] for cls,rows in [(MedClaim,analysis.med[pid]),(AutoClaim,analysis.auto[pid]),(AutoAccident,analysis.accidents[pid])]}

    def tool(self, name, args=None):
        args = args or {}
        self.calls += 1
        if self.calls > self.a.config["agent"]["max_tool_calls"]:
            raise ValueError("tool_call_limit")
        if name not in TOOLS or args:
            self.blocked = True
            self.logs.append({"tool": name, "status": "blocked"})
            raise ValueError("forbidden_tool_or_arguments")
        if name in self.outputs:
            self.logs.append({"tool": name, "status": "cached"})
            return self.outputs[name]
        functions = {
            "get_profile": lambda: self.a.profile(self.pid),
            "get_med_signals": lambda: self.a.signals(self.pid, "med"),
            "get_auto_signals": lambda: self.a.signals(self.pid, "auto"),
            "link_accident_treatment": lambda: self.a.link(self.pid),
            "check_duplicate": lambda: self.a.duplicate(self.pid),
            "compute_overall": lambda: self.a.compute(self.pid),
            "get_claims": lambda: self.a.claims(self.pid, limit=self.a.config["agent"]["claims_limit"]),
        }
        data = functions[name]()
        # Compact aggregate evidence; underlying row IDs remain available in the workspace.
        self.outputs[name] = data
        self.logs.append({"tool": name, "status": "executed"})
        return data

    def compact(self, name, data):
        result = {k:v for k,v in data.items() if k not in {"evidence_ids", "baseline", "person"}}
        result["evidence_ids"] = [name]
        if name == "get_profile": result.pop("undeclared_prior_codes", None)
        return result

    def run(self):
        if not self.provider:
            for name in TOOLS[:6]: self.tool(name)
            claims = []
            for tool, field, label in [("get_profile","med_count","의료 청구 건수"),("compute_overall","S_med","의료 점수"),("compute_overall","S_auto","자동차 점수"),("compute_overall","S_overall","Overall 점수"),("check_duplicate","D","중복 보상 검토 금액")]:
                value = self.outputs[tool][field]
                claims.append({"text": f"{label}: {value}", "evidence_ids": [tool], "facts": [{"tool":tool,"field":field,"value":value}]})
            return {"claims": claims, "proposed_actions": []}
        messages = [{"role":"user","content":"현재 고객의 보험 이력을 조사하고 근거가 있는 결과를 작성하라."}]
        schema = [{"type":"function","name":name,"description":name + ": 현재 고객의 읽기 전용 조사", "parameters":{"type":"object","properties":{},"required":[],"additionalProperties":False},"strict":True} for name in TOOLS]
        for _ in range(self.a.config["agent"]["max_rounds"]):
            reply = self.provider.complete(messages, schema)
            if reply.get("input_tokens") is None: self.tokens = None
            elif self.tokens is not None: self.tokens += reply["input_tokens"]
            messages.extend(reply.get("output", []))
            if reply.get("final") is not None:
                return reply["final"]
            for call in reply.get("calls", []):
                data = self.tool(call["name"], call.get("args"))
                messages.append({"type":"function_call_output","call_id":call["id"],"output":json.dumps(self.compact(call["name"],data),ensure_ascii=False)})
        raise ValueError("agent_round_limit")


def verify(session, investigator, report):
    checks = []
    for cls in (MedClaim,AutoClaim,AutoAccident):
        actual = [dict(r) for r in session.execute(select(*cls.__table__.columns).where(cls.person_id == investigator.pid).order_by(cls.id)).mappings()]
        actual = [{k:v.isoformat() if hasattr(v,"isoformat") else v for k,v in r.items()} for r in actual]
        checks.append({"check":"SQL source rows: " + cls.__tablename__,"passed":actual == investigator.source_rows[cls.__tablename__]})
    required = all(name in investigator.outputs for name in TOOLS[:6])
    checks.append({"check":"required_tools", "passed":required})
    profile = investigator.outputs.get("get_profile", {})
    count = session.scalar(select(func.count()).select_from(MedClaim).where(MedClaim.person_id == investigator.pid))
    checks.append({"check":"SQL med_claim COUNT", "expected":profile.get("med_count"),"actual":count,"passed":profile.get("med_count") == count})
    for claim in report.get("claims", []):
        citations = claim.get("evidence_ids", [])
        valid = bool(citations) and all(x in investigator.outputs for x in citations)
        allowed = []
        for fact in claim.get("facts", []):
            value = investigator.outputs.get(fact.get("tool"), {}).get(fact.get("field"))
            valid &= fact.get("tool") in citations and value is not None and value == fact.get("value")
            allowed.extend(re.findall(r"\d{4}-\d{2}-\d{2}|\d+(?:\.\d+)?",str(value)))
        numbers = re.findall(r"\d{4}-\d{2}-\d{2}|\d+(?:\.\d+)?",claim.get("text", ""))
        valid &= all(n in allowed for n in numbers)
        checks.append({"check":"claim_facts_and_citations", "passed": bool(valid)})
    scores = investigator.outputs.get("compute_overall", {})
    if scores:
        checks.append({"check":"Overall recompute", "passed":scores["S_overall"] == overall(scores["S_med"],scores["S_auto"],scores["S_cross"])})
    return {"passed":bool(report.get("claims")) and all(c["passed"] for c in checks),"checks":checks}


def investigate(session, analysis, pid, provider=None, persist=True):
    started = perf_counter()
    runner = Investigator(analysis, pid, provider)
    error = None
    report = {"claims":[],"proposed_actions":[]}
    try:
        report = runner.run()
        validation = verify(session, runner, report)
    except Exception as exc:
        error = type(exc).__name__
        validation = {"passed":False,"checks":[{"check":"investigation_error","passed":False,"error_type":error}]}
    scores, duplicate = analysis.compute(pid), analysis.duplicate(pid)
    rows = analysis.med[pid] + analysis.auto[pid]
    missing = any(r.paid_amount is None or r.actual_cost is None or not r.receipt_id for r in rows) or duplicate["unknown"]
    forbidden = runner.blocked or bool(report.get("proposed_actions")) or any(re.search("지급.*(?:승인|거절|보류)|사기 확정",c.get("text", "")) for c in report.get("claims", []))
    gate = safety_gate(scores, duplicate, validation["passed"], missing, bool(error), forbidden, config=analysis.config)
    result = {"person_id":pid,"mode":"tool_calling" if provider else "deterministic_workflow", "scores":scores,"duplicate":duplicate,"report":report,"verification":validation,"gate":gate,"logs":runner.logs,"input_tokens":runner.tokens,"error":error,"spec_status":analysis.config["spec_status"]}
    if persist:
        row = Investigation(person_id=pid,route=gate["route"],status=gate["status"],result=result,duration_ms=round((perf_counter()-started)*1000))
        session.add(row)
        for log in runner.logs: audit(session,"agent_tool",log,pid)
        audit(session,"safety_gate",gate,pid)
        session.flush()
        result["investigation_id"] = row.id
    return result
