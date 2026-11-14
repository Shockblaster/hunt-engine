"""Search LinkedIn, Indeed, Naukri, Glassdoor and Google Jobs with JobSpy; print normalised postings as one JSON line."""
import json
import sys

from jobspy import scrape_jobs


def main() -> None:
    o = json.loads(sys.argv[1])
    out = []
    errors = []
    # One site at a time, so a site that blocks or changes does not lose the others.
    for site in o.get("sites", ["linkedin", "indeed"]):
        try:
            df = scrape_jobs(
                site_name=[site],
                search_term=o["term"],
                google_search_term=f'{o["term"]} jobs near {o["location"]} since last week',
                location=o["location"],
                results_wanted=int(o.get("results", 40)),
                hours_old=int(o.get("hours", 168)),
                country_indeed=o.get("country", "India"),
                linkedin_fetch_description=False,
                verbose=0,
            )
        except Exception as e:  # noqa: BLE001 - report and continue with other sites
            errors.append(f"{site}: {e}")
            continue
        for r in df.fillna("").to_dict("records"):
            pay = ""
            if r.get("min_amount"):
                pay = f'{r.get("currency", "")} {r.get("min_amount")}-{r.get("max_amount")} {r.get("interval", "")}'.strip()
            out.append({
                "source": f"jobspy:{r.get('site', site)}",
                "company": str(r.get("company", "")),
                "title": str(r.get("title", "")),
                "url": str(r.get("job_url_direct") or r.get("job_url", "")),
                "location": str(r.get("location", "")) or None,
                "remote": bool(r.get("is_remote")) if r.get("is_remote") != "" else None,
                "posted_at": str(r.get("date_posted", ""))[:10] or None,
                "description": (str(r.get("description", "")) or None) and str(r.get("description", ""))[:6000],
                "pay": pay or None,
                "company_domain": str(r.get("company_url_direct", "")) or None,
            })
    if errors:
        print("; ".join(errors), file=sys.stderr)
    sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode("utf-8") + b"\n")


if __name__ == "__main__":
    main()
