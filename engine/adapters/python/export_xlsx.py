"""Write lead rows to a formatted Excel workbook: one sheet per city, a notes sheet, filters and frozen headers."""
import json
import sys
from collections import defaultdict

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

HEAD = PatternFill("solid", fgColor="1B2A33")
GOOD = PatternFill("solid", fgColor="D9F2E3")
MID = PatternFill("solid", fgColor="FFF4D6")
SMALL = PatternFill("solid", fgColor="DCEBFA")
LABELS = {
    "name": "Name", "role": "Role", "business": "Business", "phone": "Phone", "phone_type": "Phone type", "email": "Email",
    "email_status": "Email check", "city": "City", "locality": "Area", "website": "Website", "rating": "Rating",
    "reviews": "Reviews", "confidence": "How sure (0-1)", "band": "Band", "source_url": "Source", "checked": "Last checked",
}


def main():
    data = json.load(open(sys.argv[1], encoding="utf-8"))
    rows, title, note = data["rows"], data.get("title", "Leads"), data.get("note", "")
    wb = Workbook()
    info = wb.active
    info.title = "Read me"
    info["A1"] = title
    info["A1"].font = Font(bold=True, size=14)
    info["A3"] = note
    info["A3"].alignment = Alignment(wrap_text=True, vertical="top")
    info.column_dimensions["A"].width = 110
    info.row_dimensions[3].height = 90
    by_city = defaultdict(list)
    for r in rows:
        by_city[(r.get("city") or "Unknown")[:28]].append(r)
    cols = [c for c in LABELS if any(c in r for r in rows)] if rows else list(LABELS)
    for city in sorted(by_city):
        ws = wb.create_sheet(city)
        ws.append([LABELS[c] for c in cols])
        for cell in ws[1]:
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = HEAD
        for r in by_city[city]:
            ws.append([r.get(c) for c in cols])
            conf = r.get("confidence")
            if isinstance(conf, (int, float)):
                fill = GOOD if conf >= 0.7 else SMALL if r.get("band") else MID if conf >= 0.4 else None
                if fill:
                    for cell in ws[ws.max_row]:
                        cell.fill = fill
        ws.freeze_panes = "A2"
        ws.auto_filter.ref = ws.dimensions
        for i, c in enumerate(cols, start=1):
            width = max([len(str(LABELS[c]))] + [len(str(r.get(c) or "")) for r in by_city[city][:200]])
            ws.column_dimensions[get_column_letter(i)].width = min(48, max(10, width + 2))
    wb.save(sys.argv[2])


if __name__ == "__main__":
    main()
