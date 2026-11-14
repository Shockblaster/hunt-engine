"""Read a resume .docx into Hunt Engine's master resume JSON (printed as one JSON line).

Works with the common single-column layout: name, contact line, UPPERCASE section headings,
bold entry headings with dates after a tab, a plain sub-line (organisation | place), and bullets.
Hyperlinks inside bullets are kept as [label](url).
"""
import json
import re
import sys

import docx
import docx.table
import docx.text.paragraph
from docx.text.hyperlink import Hyperlink


def para_text(p) -> str:
    out = []
    for item in p.iter_inner_content():
        if isinstance(item, Hyperlink):
            label = item.text
            out.append(f"[{label}]({item.url})" if item.url else label)
        else:
            out.append(item.text)
    return "".join(out).replace(" ", " ").strip()


BULLET_CHARS = ("\u2022", "\u25aa", "\u25cf", "\u2023", "\u2043", "-", "*", "\u2013")


def is_list(p) -> bool:
    ppr = p._p.pPr
    style = (p.style.name if p.style is not None else "") or ""
    return "List" in style or (ppr is not None and ppr.numPr is not None) or p.text.lstrip().startswith(BULLET_CHARS)


def style_bold(style) -> bool:
    while style is not None:
        if style.font is not None and style.font.bold:
            return True
        style = style.base_style
    return False


def is_bold(p) -> bool:
    runs = [r for r in p.runs if r.text.strip()]
    if not runs:
        return False
    r = runs[0]
    return bool(r.bold) or (r.bold is None and (style_bold(r.style) or style_bold(p.style)))


def is_heading_style(p) -> bool:
    name = (p.style.name if p.style is not None else "") or ""
    return name.lower().startswith("heading") or name.lower() == "title"


MONTH = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?"
DATES = re.compile(rf"^(?:{MONTH}\s+)?\d{{4}}\s*(?:[-–—to]+\s*(?:(?:{MONTH}\s+)?\d{{4}}|present|current|now))?$", re.I)

KNOWN = ("summary", "education", "experience", "projects", "certifications", "skills", "leadership", "awards")


def all_paragraphs(doc):
    # Body paragraphs and those inside table cells, in reading order.
    body = doc.element.body
    for child in body.iterchildren():
        tag = child.tag.split("}")[-1]
        if tag == "p":
            yield docx.text.paragraph.Paragraph(child, doc)
        elif tag == "tbl":
            table = docx.table.Table(child, doc)
            for row in table.rows:
                seen = set()
                for cell in row.cells:
                    if id(cell._tc) in seen:
                        continue
                    seen.add(id(cell._tc))
                    for cp in cell.paragraphs:
                        yield cp


def heading_key(title: str) -> str:
    t = title.lower()
    for key, words in [("summary", ["profile", "summary", "objective", "about"]), ("education", ["education"]),
                       ("experience", ["experience", "employment", "work"]), ("projects", ["project"]),
                       ("certifications", ["certification", "training", "course"]), ("skills", ["skill", "interest"]),
                       ("leadership", ["leadership", "activities", "extra"]), ("awards", ["award", "achievement", "honour", "honor"])]:
        if any(w in t for w in words):
            return key
    return re.sub(r"[^a-z]+", "-", t).strip("-")


def main() -> None:
    path = sys.argv[1]
    d = docx.Document(path)
    paras = [p for p in all_paragraphs(d) if p.text.strip() or p.hyperlinks]
    sec = d.sections[0]
    master = {
        "name": "", "contact": {"line": "", "parts": [], "links": []}, "summary": [], "sections": [],
        "layout": {"page_width_in": round(sec.page_width.inches, 2), "page_height_in": round(sec.page_height.inches, 2)},
    }
    i = 0
    master["name"] = paras[i].text.strip()
    i += 1
    contact = paras[i]
    master["contact"]["line"] = contact.text.strip()
    master["contact"]["links"] = [{"label": h.text, "url": h.url} for h in contact.hyperlinks if h.url]
    master["contact"]["parts"] = [s.strip() for s in contact.text.split("|") if s.strip()]
    i += 1

    section = None
    entry = None
    for p in paras[i:]:
        text = para_text(p)
        if not text:
            continue
        plain = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
        looks_heading = not is_list(p) and len(plain) < 50 and "\t" not in plain and (
            is_heading_style(p) or (is_bold(p) and plain.upper() == plain and (heading_key(plain) in KNOWN or section is None)))
        if looks_heading:
            section = {"key": heading_key(plain), "title": plain.title().replace("&", "&"), "entries": [], "items": []}
            master["sections"].append(section)
            entry = None
            continue
        if section is None:
            continue
        if section["key"] == "summary":
            master["summary"].append(text.lstrip("".join(BULLET_CHARS) + " "))
            continue
        if is_list(p) or section["key"] in ("certifications", "skills"):
            text = text.lstrip("".join(BULLET_CHARS) + " ")
            plain = plain.lstrip("".join(BULLET_CHARS) + " ")
            if entry is not None and section["key"] not in ("certifications", "skills"):
                entry["bullets"].append(text)
            else:
                label, _, rest = plain.partition(":") if section["key"] == "skills" else ("", "", plain)
                section["items"].append({"label": label.strip(), "text": (rest or plain).strip()} if section["key"] == "skills" and rest else {"label": "", "text": text})
            continue
        if is_bold(p):
            head, _, dates = plain.partition("\t")
            m = re.match(r"^(.*?\S)\s{3,}(\S.*)$", head)
            title, role = (m.group(1), m.group(2)) if m and not dates else (head, "")
            entry = {"title": title.strip(), "role": role.strip(), "dates": dates.strip(), "subtitle": "", "bullets": []}
            section["entries"].append(entry)
            continue
        # A line that is only dates (common when the dates sit in their own table cell) belongs to the entry heading.
        if entry is not None and not entry["dates"] and not entry["bullets"] and DATES.match(plain.strip()):
            entry["dates"] = plain.strip()
        elif entry is not None and not entry["subtitle"] and not entry["bullets"]:
            entry["subtitle"] = plain
        elif entry is not None:
            entry["bullets"].append(text)
        else:
            section["items"].append({"label": "", "text": text})
    warnings = []
    if not master["sections"]:
        warnings.append("no section headings were recognised; check the result before using it")
    for s in master["sections"]:
        if s["key"] != "summary" and not s["entries"] and not s["items"]:
            warnings.append(f'the {s["title"]} section came out empty')
    if not master["summary"]:
        warnings.append("no profile or summary was found (fine if the resume has none)")
    master["warnings"] = warnings
    sys.stdout.buffer.write(json.dumps(master, ensure_ascii=False).encode("utf-8") + b"\n")


if __name__ == "__main__":
    main()
