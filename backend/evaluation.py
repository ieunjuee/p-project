"""Labels are accessible only here and in the generator; never in Agent tools."""
import json
import random
from time import perf_counter

from sqlalchemy import select

from .agent import investigate, safety_gate
from .db import Evaluation, ScenarioLabel, audit


def evaluate(session, analysis, provider=None, limit=200):
    ids = sorted(pid for pid,p in analysis.people.items() if p.partition == "evaluation")[:limit]
    labels = {l.person_id:l for l in session.scalars(select(ScenarioLabel))}
    groups = {}
    for name in ("A", "B", "C"):
        if name in {"A","C"} and provider is None:
            groups[name] = {"status":"not_run", "reason":"실제 LLM 미연결"}
            continue
        rows = []
        for pid in ids:
            started = perf_counter()
            try:
                if name == "A":
                    raw = {k:analysis.claims(pid,k,limit=10000)["rows"] for k in ("med","auto","accident")}
                    reply = provider.complete([{"role":"user","content":"도구 없이 전체 원시 청구를 판단하라. JSON {route: fast_candidate/general_review/detailed_review/unable_to_determine, claims: [], duplicate: boolean}.\n"+json.dumps(raw,ensure_ascii=False)}],[])
                    final = reply["final"]
                    if final.get("route") not in {"fast_candidate","general_review","detailed_review","unable_to_determine"}: raise ValueError("route")
                    row = {"pid":pid,"route":final["route"],"report":final,"input_tokens":reply.get("input_tokens"),"verified":None,"citation":None,"consistent":None}
                elif name == "B":
                    scores,dup=analysis.compute(pid),analysis.duplicate(pid)
                    gate=safety_gate(scores,dup,True,config=analysis.config)
                    row={"pid":pid,**gate,"input_tokens":0,"verified":None,"citation":None,"consistent":None}
                else:
                    runs=[investigate(session,analysis,pid,provider,persist=False) for _ in range(5)]
                    signatures=[(r["gate"]["route"],tuple(sorted(set(e for c in r["report"].get("claims",[]) for e in c.get("evidence_ids",[]))))) for r in runs]
                    r=runs[0]
                    row={"pid":pid,"route":r["gate"]["route"],"report":r["report"],"input_tokens":r["input_tokens"],"verified":r["verification"]["passed"],"citation":sum(bool(c.get("evidence_ids")) for c in r["report"].get("claims",[]))/max(1,len(r["report"].get("claims",[]))),"consistent":len(set(signatures)) == 1}
                    if not row["consistent"]: row["route"]="unable_to_determine"
                row["seconds"]=(perf_counter()-started)/(5 if name == "C" else 1)
            except Exception as exc:
                row={"pid":pid,"route":"unable_to_determine","error":type(exc).__name__,"seconds":perf_counter()-started}
            rows.append(row)
        ratio=lambda selected,pred: sum(pred(r) for r in rows if selected(labels[r["pid"]]))/sum(selected(labels[r["pid"]]) for r in rows) if any(selected(labels[r["pid"]]) for r in rows) else None
        groups[name]={"status":"completed","n":len(rows),"metrics":{"duplicate_recall":ratio(lambda l:l.duplicate,lambda r:r["route"]=="detailed_review"),"risky_fast_rate":ratio(lambda l:l.risky,lambda r:r["route"]=="fast_candidate"),"confusing_normal_false_positive":ratio(lambda l:l.confusing_normal,lambda r:r["route"]=="detailed_review"),"seconds_per_person":sum(r["seconds"] for r in rows)/max(1,len(rows))},"rows":rows}
        for key,field in [("numeric_accuracy","verified"),("citation_rate","citation"),("repeat_consistency","consistent"),("input_tokens","input_tokens")]:
            values=[r[field] for r in rows if r.get(field) is not None]
            groups[name]["metrics"][key]=sum(values)/len(values) if values else None
        groups[name]["target_results"]={key:None if value is None else value <= analysis.config["targets"][key] if key in {"risky_fast_rate","confusing_normal_false_positive","seconds_per_person"} else value >= analysis.config["targets"][key] for key,value in groups[name]["metrics"].items() if key in analysis.config["targets"]}
    result={"partition":"evaluation","people":ids,"groups":groups,"targets":analysis.config["targets"],"note":"목표는 PDF 초안. A/C 미실행은 성능 0 또는 달성으로 표시하지 않음. 수치 정확도는 C의 검증 통과 보고서 비율."}
    session.add(Evaluation(result=result));audit(session,"evaluation_completed",{"n":len(ids),"groups":{k:v["status"] for k,v in groups.items()}})
    return result


def blind_packet(result):
    entries=[]
    for group in ("A","C"):
        for r in result.get("groups",{}).get(group,{}).get("rows",[])[:20]:
            entries.append({"case_id":r["pid"],"report":r,"reviewer_1_score":None,"reviewer_2_score":None,"scale":[1,2,3,4,5]})
    random.Random(42).shuffle(entries)
    return entries
