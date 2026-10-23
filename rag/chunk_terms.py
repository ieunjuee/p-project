"""표준약관 발췌 PDF -> 조항 단위 청크(JSONL). terms-rag.mjs가 이 결과를 읽습니다.
사용 (레포 루트에서):
  pip install -r rag/requirements.txt
  python rag/chunk_terms.py rag/source/terms_auto_silson_excerpt.pdf rag/terms_chunks.jsonl
"""
import json, re, sys
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


def heading(pattern, line):
    m = pattern.match(line)
    return m if m and not CITED.match(line[m.end():]) else None


def line_text(line):
    """글자 간격으로 띄어쓰기 복원 (양쪽정렬 PDF라 공백 문자가 대부분 빠져 있음)."""
    out, prev = [], None
    for span in line["spans"]:
        gap_min = span["size"] * 0.25
        for ch in span["chars"]:
            c = ch["c"]
            if prev is not None and c != " " and out and out[-1] != " " and ch["bbox"][0] - prev > gap_min:
                out.append(" ")
            out.append(c)
            prev = ch["bbox"][2]
    return re.sub(r"\s+", " ", "".join(out)).strip()


def pdf_lines(path):
    """(원본 별표15 쪽, 발췌본 쪽, 줄) 순서대로."""
    for i, page in enumerate(pymupdf.open(path)):
        lines = [line_text(l) for b in page.get_text("rawdict", sort=True)["blocks"] for l in b.get("lines", [])]
        lines = [l for l in lines if l]
        printed = next((int(m.group(1)) for l in lines if (m := FOOTER.match(l))), None)
        for l in lines:
            if not FOOTER.match(l):
                yield printed, i + 1, l


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

    def close():
        if cur and cur["lines"]:
            body = "\n".join(cur.pop("lines"))
            pieces = split_long(body)
            for k, p in enumerate(pieces):
                head = "" if k == 0 else f"[{cur['article']} {cur['title']} 계속]\n"
                chunks.append({**cur, "part_no": k + 1, "parts": len(pieces), "text": head + p})

    for printed, ext_page, line in pdf_lines(path):
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
        if cur is not None:
            cur["lines"].append(line)
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
