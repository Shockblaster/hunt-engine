"""Write a tailored resume or cover letter as .docx from Hunt Engine's render model.

Single column, real text, no tables or text boxes, contact details in the body (not the page header),
standard headings: the layout applicant tracking systems parse best.
"""
import json
import re
import sys

import docx
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

LINK = re.compile(r"\[([^\]]+)\]\(([^)\s]+)\)")
INK = RGBColor(0x1A, 0x1A, 0x1A)


def style_run(run, size, bold=False, italic=False, color=INK):
    run.font.name = "Calibri"
    run.font.size = Pt(size)
    run.bold = bold
    run.italic = italic
    run.font.color.rgb = color


def add_link(paragraph, label, url, size):
    part = paragraph.part
    rid = part.relate_to(url, docx.opc.constants.RELATIONSHIP_TYPE.HYPERLINK, is_external=True)
    h = OxmlElement("w:hyperlink")
    h.set(qn("r:id"), rid)
    r = OxmlElement("w:r")
    rpr = OxmlElement("w:rPr")
    for tag, val in (("w:rFonts", None), ("w:color", "1155CC"), ("w:sz", str(int(size * 2)))):
        el = OxmlElement(tag)
        if tag == "w:rFonts":
            el.set(qn("w:ascii"), "Calibri")
            el.set(qn("w:hAnsi"), "Calibri")
        else:
            el.set(qn("w:val"), val)
        rpr.append(el)
    r.append(rpr)
    t = OxmlElement("w:t")
    t.text = label
    t.set(qn("xml:space"), "preserve")
    r.append(t)
    h.append(r)
    paragraph._p.append(h)


def rich(paragraph, text, size, bold=False, italic=False):
    pos = 0
    for m in LINK.finditer(text):
        if m.start() > pos:
            style_run(paragraph.add_run(text[pos:m.start()]), size, bold, italic)
        add_link(paragraph, m.group(1), m.group(2), size)
        pos = m.end()
    if pos < len(text):
        style_run(paragraph.add_run(text[pos:]), size, bold, italic)


def spacing(p, before=0, after=0, line=1.05):
    pf = p.paragraph_format
    pf.space_before = Pt(before)
    pf.space_after = Pt(after)
    pf.line_spacing = line


def bottom_rule(p):
    ppr = p._p.get_or_add_pPr()
    bdr = OxmlElement("w:pBdr")
    b = OxmlElement("w:bottom")
    b.set(qn("w:val"), "single")
    b.set(qn("w:sz"), "6")
    b.set(qn("w:space"), "1")
    b.set(qn("w:color"), "1A1A1A")
    bdr.append(b)
    ppr.append(bdr)


def setup(doc, fmt):
    s = doc.sections[0]
    if fmt.get("paper") == "Letter":
        s.page_width, s.page_height = Inches(8.5), Inches(11)
    else:
        s.page_width, s.page_height = Inches(8.27), Inches(11.69)
    m = Inches(fmt.get("margin_in", 0.6))
    s.left_margin = s.right_margin = s.top_margin = s.bottom_margin = m
    normal = doc.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(fmt.get("font_pt", 10.5))
    return s


def resume(model, out):
    doc = docx.Document()
    fmt = model["format"]
    size = fmt.get("font_pt", 10.5)
    sec = setup(doc, fmt)
    width = sec.page_width - sec.left_margin - sec.right_margin

    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    style_run(p.add_run(model["name"]), size + 9, bold=True)
    spacing(p)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    links = {l["label"]: l["url"] for l in model["contact"].get("links", [])}
    for i, part in enumerate(model["contact"]["parts"]):
        if i:
            style_run(p.add_run("  |  "), size - 0.5)
        if part in links:
            add_link(p, part, links[part], size - 0.5)
        else:
            style_run(p.add_run(part), size - 0.5)
    spacing(p, after=3)

    def heading(title):
        h = doc.add_paragraph()
        style_run(h.add_run(title.upper()), size + 0.5, bold=True)
        bottom_rule(h)
        spacing(h, before=6, after=2)

    def bullet(text):
        b = doc.add_paragraph(style="List Bullet")
        rich(b, text, size)
        spacing(b, after=1)
        b.paragraph_format.left_indent = Inches(0.2)

    if model.get("summary"):
        heading("Profile")
        sp = doc.add_paragraph()
        rich(sp, model["summary"], size)
        spacing(sp, after=1)
    for s in model["sections"]:
        heading(s["title"])
        for e in s["entries"]:
            row = doc.add_paragraph()
            row.paragraph_format.tab_stops.add_tab_stop(width, WD_TAB_ALIGNMENT.RIGHT)
            style_run(row.add_run(e["title"]), size, bold=True)
            if e.get("role"):
                style_run(row.add_run("  " + e["role"]), size, italic=True)
            if e.get("dates"):
                style_run(row.add_run("\t" + e["dates"]), size, bold=True)
            spacing(row, before=2)
            if e.get("subtitle"):
                sub = doc.add_paragraph()
                rich(sub, e["subtitle"], size, italic=True)
                spacing(sub)
            for b in e["bullets"]:
                bullet(b["text"])
        for it in s["items"]:
            if s["key"] == "skills":
                ip = doc.add_paragraph()
                if it.get("label"):
                    style_run(ip.add_run(it["label"] + ": "), size, bold=True)
                rich(ip, it["text"], size)
                spacing(ip, after=1)
            else:
                bullet((it["label"] + ": " if it.get("label") else "") + it["text"])
    doc.core_properties.title = f'{model["name"]} Resume'
    doc.core_properties.author = model["name"]
    doc.save(out)


def letter(model, data, out):
    doc = docx.Document()
    setup(doc, model["format"])
    p = doc.add_paragraph()
    style_run(p.add_run(model["name"]), 18, bold=True)
    spacing(p)
    p = doc.add_paragraph()
    style_run(p.add_run("  |  ".join(model["contact"]["parts"])), 10)
    bottom_rule(p)
    spacing(p, after=14)
    for line in [data["date"], f'{data.get("company") or ""}\nRe: {data["role"]}']:
        q = doc.add_paragraph()
        style_run(q.add_run(line), 11)
        spacing(q, after=10)
    for para in re.split(r"\n\s*\n", data["body"].strip()):
        q = doc.add_paragraph()
        style_run(q.add_run(para.strip()), 11)
        spacing(q, after=10, line=1.2)
    q = doc.add_paragraph()
    style_run(q.add_run(model["name"]), 11)
    doc.save(out)


def main():
    data = json.load(open(sys.argv[1], encoding="utf-8"))
    if data["kind"] == "letter":
        letter(data["model"], data["letter"], sys.argv[2])
    else:
        resume(data["model"], sys.argv[2])


if __name__ == "__main__":
    main()
