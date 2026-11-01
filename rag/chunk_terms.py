"""표준약관 발췌 PDF -> 조항 단위 청크(JSONL). terms-rag.mjs가 이 결과를 읽습니다.
사용 (레포 루트에서):
  pip install -r rag/requirements.txt
  python rag/chunk_terms.py rag/source/terms_auto_silson_excerpt.pdf rag/terms_chunks.jsonl
"""
import bisect, json, re, sys
from collections import Counter
import pymupdf

MAX_CHARS = 1500  # 긴 조항/별표는 이 길이 근처에서 줄 단위로 나눔
DOC_MARKERS = [  # (줄 시작 패턴, 약관명)
    (re.compile(r"^<\s*자동차보험\s*>"), "자동차보험 표준약관"),
    (re.compile(r"^□\s*기본형 실손의료보험"), "실손의료보험 표준약관(기본형)"),
    (re.compile(r"^□\s*실손의료보험 특별약관1"), "실손의료보험 특별약관1(중증 비급여)"),
    (re.compile(r"^□\s*실손의료보험 특별약관2"), "실손의료보험 특별약관2(비중증 비급여)"),
]
ARTICLE = re.compile(r"^제\s*(\d+)\s*조(?:의\s*(\d+))?\s*(?:\[([^\]]{1,80})\]?|\(([^)\[]{1,60})\)?)")
APPENDIX_HEAD = re.compile(r"^<\s*(별표\s*\d+|붙임\s*\d+|부표)\s*>")
PART = re.compile(r"^제\s*\d+\s*[편관]\s*\S.*")
FOOTER = re.compile(r"^-\s*(\d+)\s*-$")
CITED = re.compile(r"^(에서|에|의|과|와|를|을|로|중|및|이|가)")  # 괄호 바로 뒤 조사 = 본문 속 인용("제5조(...)에서 정한")
# 줄을 합치지 않고 새 줄로 두는 시작: 항(①), 호(1.), 목(가.), (1), ※, ◦, -, <, [, 제○조
ITEM = re.compile(r"^([①-⑳]|\d{1,2}\.(?!\d)|[가-하]\.\s|\(\d{1,2}\)|※|◦|-\s|<|\[|제\s*\d+\s*조)")
SENTENCE_END = re.compile(r"[.:>]$")
# 실손 약관 표의 왼쪽 칸(조항: 보장종목·(1)·상해급여, 붙임: 용어 이름)은 세로선 x 145 왼쪽. 본문은 x 137 이후에서 시작
SIDE_X = 145
SIDE = lambda info: info["x1"] < SIDE_X
# 오른쪽 여백의 개정 표기가 두 줄로 쪼개져 본문 사이에 끼는 조각("<신설", "2015.11.30.,", "2026.5.6.>")
NOTE_PIECE = re.compile(r"^(<\s*(신설|개정)[\d.,\s]*>?|(\d{4}\.\d{1,2}\.\d{1,2}\.,?\s*)+>?)$")
NOTE_TAIL = re.compile(r"\s*<\s*(신설|개정)\s*$")  # 본문 줄 끝에 걸친 "<개정"
TABLE_HEAD = {"보장종목", "보상하는사항", "보상하지않는사항", "용어"}  # 실손 약관 표의 머리글


def heading(pattern, line):
    m = pattern.match(line)
    return m if m and not CITED.match(line[m.end():]) else None


def line_text(line, keep=lambda ch: True):
    """글자 간격으로 띄어쓰기 복원 (양쪽정렬 PDF라 공백 문자가 대부분 빠져 있음). keep으로 일부 글자만 쓸 수 있습니다."""
    out, prev = [], None
    for span in line["spans"]:
        gap_min = span["size"] * 0.25
        for ch in span["chars"]:
            if not keep(ch):
                continue
            c = ch["c"]
            if prev is not None and c != " " and out and out[-1] != " " and ch["bbox"][0] - prev > gap_min:
                out.append(" ")
            out.append(c)
            prev = ch["bbox"][2]
    return re.sub(r"\s+", " ", "".join(out)).strip()


def raw_text(line):
    return "".join(ch["c"] for span in line["spans"] for ch in span["chars"])


def table_rules(page):
    """표의 가로 테두리선 y 좌표(쪽 너비의 대부분을 가로지르는 선)와 세로선 x 좌표."""
    ys, xs = set(), set()
    for d in page.get_drawings():
        for it in d["items"]:
            if it[0] == "l" and abs(it[1].y - it[2].y) < 1 and abs(it[1].x - it[2].x) > 400:
                ys.add(round(it[1].y))
            elif it[0] == "re" and it[1].height < 2 and it[1].width > 400:
                ys.add(round(it[1].y0))
            elif it[0] == "l" and abs(it[1].x - it[2].x) < 1 and abs(it[1].y - it[2].y) > 10:
                xs.add(round(it[1].x))
            elif it[0] == "re" and it[1].width < 2 and it[1].height > 10:
                xs.add(round(it[1].x0))
    return sorted(ys), sorted(xs)


def pdf_lines(path):
    """(원본 별표15 쪽, 발췌본 쪽, 줄, 줄 정보) 순서대로.
    줄 정보 x0/x1/y: 줄 위치, spaced: 원문에 공백 문자가 있는 줄(자동차 약관), tail_space: 원문 줄 끝이 공백(= 단어가 끝남),
    row: 표 안이면 (쪽, 가로선 사이 행 번호), split: 왼쪽 칸과 오른쪽 칸에 걸친 줄이면 (왼쪽 글자, 오른쪽 글자),
    cells: 세로선이 있는 표 안이면 [(칸 번호, 글자)]."""
    for i, page in enumerate(pymupdf.open(path)):
        (rules, cols), lines = table_rules(page), []
        for b in page.get_text("rawdict", sort=True)["blocks"]:
            for l in b.get("lines", []):
                text, raw = line_text(l), raw_text(l)
                if not text:
                    continue
                x0, y0, x1, y1 = l["bbox"]
                y = (y0 + y1) / 2
                row = (i, bisect.bisect(rules, y)) if rules and rules[0] < y < rules[-1] else None
                split = None
                if x0 < SIDE_X and x1 > SIDE_X + 50:
                    left = line_text(l, lambda ch: ch["bbox"][0] < SIDE_X)
                    if left:
                        split = (left, line_text(l, lambda ch: ch["bbox"][0] >= SIDE_X))
                cells = None  # 3칸 이상 표 안의 줄: 칸 번호별 글자
                if row and len(cols) >= 4:
                    col = lambda ch: bisect.bisect(cols, (ch["bbox"][0] + ch["bbox"][2]) / 2)
                    found = sorted({col(ch) for sp in l["spans"] for ch in sp["chars"] if ch["c"].strip()})
                    cells = [(k, line_text(l, lambda ch, k=k: col(ch) == k)) for k in found]
                lines.append((text, {"x0": x0, "x1": x1, "y": y, "row": row, "split": split, "cells": cells,
                                     "spaced": " " in raw.strip(), "tail_space": raw.endswith(" ")}))
        printed = next((int(m.group(1)) for l, _ in lines if (m := FOOTER.match(l))), None)
        for l, info in lines:
            if not FOOTER.match(l):
                yield printed, i + 1, l, info


def bare(word):
    return re.sub(r"[^0-9A-Za-z가-힣]", "", word)


def word_counts(path):
    """줄 가운데 단어(줄 처음·끝 단어는 잘렸을 수 있어 뺌)의 빈도. 줄 끝에서 끊긴 단어를 붙일지 정할 때 씁니다."""
    counts = Counter()
    for _, _, line, _ in pdf_lines(path):
        words = line.split(" ")
        counts.update(bare(w) for w in words[1:-1] if bare(w))
    return counts


def reflow(lines, words):
    """PDF 쪽 너비에서 끊긴 줄을 문장으로 다시 잇습니다. 항·호 시작이나 문장 끝에서만 줄을 바꿉니다.
    띄어쓰기: 자동차 약관은 원문 줄 끝 공백으로, 실손 약관(원문에 공백 문자 없음)은 앞뒤 조각이 본문에 단어로 나오는지로 정합니다."""
    out = []
    for text, info in lines:
        if not out or ITEM.match(text) or SENTENCE_END.search(out[-1][0]):
            out.append([text, info]); continue
        prev, prev_info = out[-1]
        out[-1] = [prev + join_gap(prev, prev_info, text, words) + text, info]
    return "\n".join(t for t, _ in out)


def join_gap(prev, prev_info, text, words):
    """끊긴 두 줄 사이 띄어쓰기."""
    if prev_info["spaced"]:
        return " " if prev_info["tail_space"] else ""
    a, b = bare(prev.split(" ")[-1]), bare(text.split(" ")[0])
    # 둘 다 단어로 나오고, 붙인 꼴이 그보다 드물면 띄움. 한쪽이 단어 조각(않|습니다, 이|전인)이면 붙임
    return " " if words[a] and words[b] and words[a + b] < min(words[a], words[b]) else ""


def definition_rows(lines, words):
    """붙임(용어 | 정의 2열 표)을 '용어: 정의' 한 줄씩으로 바꿉니다.
    표 가로선 사이를 한 행으로 보고, 왼쪽 칸 글자는 용어, 오른쪽 칸 글자는 정의로 모읍니다.
    용어가 없는 행은 앞 행이 다음 쪽으로 이어진 것으로 봅니다. 표 밖의 줄(제목)은 그대로 둡니다."""
    out, rows = [], {}
    for text, info in lines:
        if info["row"] is None:
            out.append(("line", text)); continue
        if info["row"] not in rows:
            rows[info["row"]] = {"term": [], "body": []}
            out.append(("row", rows[info["row"]]))
        r = rows[info["row"]]
        if SIDE(info):
            r["term"].append((text, info))
        elif info["split"]:
            r["term"].append((info["split"][0], info)); r["body"].append((info["split"][1], info))
        else:
            r["body"].append((text, info))
    text = []
    for kind, v in out:
        if kind == "line":
            text.append(v); continue
        term = reflow(sorted(v["term"], key=lambda t: t[1]["y"]), words).replace("\n", " ")
        body = reflow(v["body"], words)
        if term:
            text.append(f"{term}: {body}")
        elif text and body:  # 앞 쪽에서 이어진 행
            cont = ITEM.match(body) or SENTENCE_END.search(text[-1])
            text[-1] += "\n" + body if cont else join_gap(text[-1], v["body"][0][1], body, words) + body
        elif body:
            text.append(body)
    return "\n".join(text)


def with_side_labels(lines, words):
    """실손 조항 표의 왼쪽 칸(보장종목 이름)을 그 칸 본문 첫머리에 '[보장종목: (1) 상해급여]' 줄로 넣습니다.
    왼쪽 칸 글자는 행 가운데 높이에 있어 줄 순서대로 두면 본문 중간에 끼기 때문입니다."""
    labels = {}
    for t, i in lines:
        if SIDE(i) and i["row"]:
            labels.setdefault(i["row"], []).append((t, i))
    out, last, seen = [], None, set()
    for t, i in lines:
        if SIDE(i):
            continue
        if i["row"] in labels and i["row"] not in seen:
            seen.add(i["row"])
            label = reflow(sorted(labels[i["row"]], key=lambda x: x[1]["y"]), words).replace("\n", " ")
            if label != last:
                out.append((f"[보장종목: {label}]", {**i, "spaced": False})); last = label
        out.append((t, i))
    return out


MARK = re.compile(r"^[◦○]+$")


def mark_table(lines, words):
    """◦ 표시 표(제출 서류 × 보장종목)를 '서류 (필요한 보장종목, ...)' 한 줄씩으로 바꿉니다.
    머리글 행(◦ 없이 글자만 있는 첫 행)의 칸 이름을 ◦ 자리에 씁니다. 표 밖 줄은 이어서 문장으로 둡니다.
    번호 없이 ◦도 없는 행은 앞 서류가 다음 쪽으로 이어진 것으로 봅니다."""
    out, rows = [], {}
    for text, info in lines:
        if not info["cells"]:
            if out and out[-1][0] == "lines":
                out[-1][1].append((text, info))
            else:
                out.append(("lines", [(text, info)]))
            continue
        if info["row"] not in rows:
            rows[info["row"]] = {}
            out.append(("row", rows[info["row"]]))
        for k, t in info["cells"]:
            rows[info["row"]].setdefault(k, []).append((t, info))
    items, header = [], None  # items: [글, 보장종목 목록 또는 None]
    for kind, v in out:
        if kind == "lines":
            items.append([reflow(v, words), None]); continue
        cells = {k: [t for t, _ in parts] for k, parts in v.items()}
        if header is None and not any(MARK.match(t) for ts in cells.values() for t in ts):
            header = {k: "".join(ts) for k, ts in cells.items()}  # "대인/배상" → "대인배상"
            continue
        label = reflow(v[min(cells)], words).replace("\n", " ")
        marks = []
        for k in sorted(cells)[1:]:
            name = (header or {}).get(k, f"{k}칸")
            rest = " ".join(t for t in cells[k] if not MARK.match(t.replace(" ", ""))).replace("◦", "").strip()
            marks.append(f"{name}: {rest}" if rest else name)
        if items and items[-1][1] is not None and (not marks or not label) and not ITEM.match(label or "x"):
            items[-1][0] += join_gap(items[-1][0], v[min(cells)][0][1], label, words) + label if label else ""
            items[-1][1] += [m for m in marks if m not in items[-1][1]]
        else:
            items.append([label, marks])
    return "\n".join(f"{t} ({', '.join(m)})" if m else t for t, m in items if t)


def split_long(text):
    if len(text) <= MAX_CHARS:
        return [text]
    parts, cur = [], ""
    for line in text.split("\n"):
        if cur and len(cur) + len(line) > MAX_CHARS:
            parts.append(cur); cur = ""
        cur += ("\n" if cur else "") + line
    return parts + [cur] if cur else parts


def chunk(path):
    chunks, cur, doc, part, last = [], None, None, None, 0
    words = word_counts(path)

    def close():
        if cur and cur["lines"]:
            lines = cur.pop("lines")
            if cur["article"].startswith("붙임") and any(SIDE(i) for _, i in lines):
                body = definition_rows(lines, words)
            elif any(MARK.match(t.replace(" ", "")) for t, _ in lines):
                body = mark_table(lines, words)
            elif cur["doc"] != "자동차보험 표준약관":
                body = reflow(with_side_labels(lines, words), words)
            else:
                body = reflow(lines, words)
            pieces = split_long(body)
            for k, p in enumerate(pieces):
                head = "" if k == 0 else f"[{cur['article']} {cur['title']} 계속]\n"
                chunks.append({**cur, "part_no": k + 1, "parts": len(pieces), "text": head + p})

    for printed, ext_page, line, info in pdf_lines(path):
        new_doc = next((name for pat, name in DOC_MARKERS if pat.match(line)), None)
        art, app = heading(ARTICLE, line), heading(APPENDIX_HEAD, line)
        # 줄바꿈으로 본문 속 "제27조(...)" 인용이 줄 맨 앞에 오는 경우를 배제: 조 번호가 순서대로 증가할 때만 새 조항
        if art:
            n = int(art.group(1))
            if last < n <= last + 3 or (n == last and art.group(2)):
                last = n
            else:
                art = None
        if new_doc:
            close(); doc, part, last = new_doc, None, 0
            cur = {"doc": doc, "section": None, "article": "머리말", "title": line[:60], "kind": "intro", "page": printed, "extract_page": ext_page, "lines": []}
        elif PART.match(line) and not art:
            part = line
            continue  # 편·관 제목은 본문에 넣지 않고 다음 조항의 section 메타데이터로만 사용
        if app and cur and cur["kind"] == "appendix" and cur["article"] == re.sub(r"\s+", "", app.group(1)):
            app = None  # 같은 별표가 쪽마다 다시 표기된 경우
        if art or app:
            close()
            if art:
                no = f"제{art.group(1)}조" + (f"의{art.group(2)}" if art.group(2) else "")
                cur = {"doc": doc, "section": part, "article": no, "title": (art.group(3) or art.group(4)).strip(), "kind": "article"}
            else:
                cur = {"doc": doc, "section": part, "article": re.sub(r"\s+", "", app.group(1)), "title": re.sub(r"\s*<\s*(개정|신설).*$", "", line[app.end():]).strip()[:60], "kind": "appendix"}
            cur.update(page=printed, extract_page=ext_page, lines=[])
        is_head = bare(line) in TABLE_HEAD or (bare(line) in ("정", "의") and info["x0"] > 300)  # 붙임 머리글 "용어 | 정 의"
        if cur is not None and not is_head and not NOTE_PIECE.match(line):
            cur["lines"].append((NOTE_TAIL.sub("", line), info))
        if cur is not None:
            cur["page_end"] = printed
    close()
    for n, c in enumerate(chunks):
        c["id"] = f"T{n:04d}"
        c["cite"] = f"{c['doc']} {c['article']}" + (f"({c['title']})" if c["kind"] != "intro" and c["title"] else "") + (f" [{c['part_no']}/{c['parts']}]" if c["parts"] > 1 else "") + f", 별표15 {c['page']}쪽"
    return chunks


def self_check(chunks):
    arts = {(c["doc"], c["article"]) for c in chunks}
    for key in [("자동차보험 표준약관", "제27조"), ("자동차보험 표준약관", "제59조"), ("자동차보험 표준약관", "별표1"),
                ("실손의료보험 표준약관(기본형)", "제37조"), ("실손의료보험 표준약관(기본형)", "제7조"), ("실손의료보험 표준약관(기본형)", "붙임1")]:
        assert key in arts, f"누락: {key}"
    assert any("4주" in c["text"] and c["article"] == "별표1" for c in chunks), "지급기준 4주 조항 누락"
    for doc in {c["doc"] for c in chunks}:  # 조 번호가 1부터 빠짐없이 올라가는지
        nums = sorted({int(re.match(r"제(\d+)조", c["article"]).group(1)) for c in chunks if c["doc"] == doc and c["kind"] == "article"})
        missing = sorted(set(range(1, nums[-1] + 1)) - set(nums))
        print(f"  {doc}: 조 {len(nums)}개, 최대 제{nums[-1]}조, 빠진 번호 {missing or '없음'}")


if __name__ == "__main__":
    src, out = sys.argv[1], sys.argv[2]
    chunks = chunk(src)
    with open(out, "w", encoding="utf-8") as f:
        for c in chunks:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")
    print(f"청크 {len(chunks)}개 -> {out}")
    self_check(chunks)
