#!/usr/bin/env python3
"""Visible LinkedIn search runner for the job-hunter workspace.

Runs a bounded, anti-detection-friendly LinkedIn search through Chromium CDP 9225,
streams progress to the visible panel, stops on security/CAPTCHA/login blockers,
scores newly saved LinkedIn jobs from this run, and writes a concise summary.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import selectors
import signal
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
SCORER_DIR = SCRIPT_DIR.parents[1] / "job-match-scorer" / "scripts"
if str(SCORER_DIR) not in sys.path:
    sys.path.insert(0, str(SCORER_DIR))
import jh_profile  # noqa: E402

HOME = Path.home()
WORKSPACE = Path(os.environ.get("JOBHUNTER_HOME", HOME / ".job-hunter")).expanduser().resolve()
DB = Path(os.environ.get("JOBHUNTER_DB", WORKSPACE / "jobhunter.sqlite")).expanduser().resolve()
RUN_DIR = Path(os.environ.get("RUN_DIR", Path.cwd())).resolve()
LINKEDIN_RUNNER = Path(os.environ.get("LINKEDIN_RUNNER", HOME / ".pi/agent/skills/linkedin-job-search/scripts/search-linkedin-jobs.mjs"))
SCORER = Path(os.environ.get("SCORER", HOME / ".pi/agent/skills/job-match-scorer/scripts/score_jobs_inline.py"))
VISUAL_RECOVER = Path(os.environ.get("VISUAL_RECOVER", HOME / ".pi/agent/skills/qwen-screenshot-debug/scripts/visual-recover.mjs"))

LOCATIONS: list[str] = []
QUERIES: list[str] = []
SPEAKS = ""
EXCLUDE_LANGS = ""
TARGET_ROLE = ""
FRESH_DAYS = "7"
MAX_START = "14"  # 0, 7, 14: bounded scan to avoid long hidden backoff loops.
LOCATION_TIMEOUT_SECONDS = int(os.environ.get("LI_LOCATION_TIMEOUT_SECONDS", "2700"))

SERIOUS_BLOCK_RE = re.compile(
    r"(\[captcha\]|captcha detected|captcha|security verification|unusual activity|"
    r"verify (?:your|you are|that you)|verification required|checkpoint|auth wall|"
    r"login page|sign[ -]?in wall|please log in|please sign in)",
    re.IGNORECASE,
)
FIT_THRESHOLD = jh_profile.DEFAULT_FIT_THRESHOLD


def log(msg: str = "") -> None:
    print(msg, flush=True)


def load_profile_defaults() -> dict:
    profile = jh_profile.load_profile(home=str(WORKSPACE), require_confirmed=True)
    data_dir = SCRIPT_DIR.parents[1] / "job-hunter" / "data"
    domains = json.loads((data_dir / "indeed-domains.json").read_text(encoding="utf-8"))
    search_config_path = WORKSPACE / "search-config.json"
    search_config = json.loads(search_config_path.read_text(encoding="utf-8")) if search_config_path.exists() else {"countries": {}}
    locations = []
    for code in profile.get("targetCountries", []):
        country = (search_config.get("countries") or {}).get(code, {})
        generic = (domains.get("countries") or {}).get(code, {})
        locations.append(country.get("location") or generic.get("location") or code)
    roles = profile.get("roles", {})
    queries = list(dict.fromkeys((roles.get("primary") or []) + (roles.get("adjacent") or []) + (roles.get("leadership") or [])))
    return {
        "profile": profile,
        "locations": locations,
        "queries": queries[:16],
        "speaks": ",".join(profile.get("speaks") or []),
        "target_role": "; ".join((roles.get("primary") or queries)[:4]),
    }


def run_simple(cmd: list[str], *, cwd: Path = WORKSPACE, timeout: int = 120) -> tuple[int, str]:
    try:
        p = subprocess.run(cmd, cwd=str(cwd), text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
        return p.returncode, p.stdout
    except subprocess.TimeoutExpired as e:
        return 124, (e.stdout or "") + f"\n[TIMEOUT after {timeout}s]\n"


def sqlite_value(sql: str) -> str:
    with sqlite3.connect(DB) as conn:
        row = conn.execute(sql).fetchone()
        return str(row[0]) if row else ""


def run_streaming(cmd: list[str], *, label: str, timeout: int) -> tuple[int, str | None]:
    log(f"\n=== {label} ===")
    log("$ " + " ".join(cmd))
    proc = subprocess.Popen(
        cmd,
        cwd=str(WORKSPACE),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=1,
        start_new_session=True,
    )
    assert proc.stdout is not None
    sel = selectors.DefaultSelector()
    sel.register(proc.stdout, selectors.EVENT_READ)
    start = time.monotonic()
    last_heartbeat = start
    blocker_line: str | None = None

    while True:
        now = time.monotonic()
        if now - start > timeout:
            log(f"[timeout] {label} exceeded {timeout//60} minutes; terminating this location and continuing.")
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except Exception:
                proc.terminate()
            try:
                proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except Exception:
                    proc.kill()
            return 124, None

        if now - last_heartbeat > 60:
            elapsed = int(now - start)
            log(f"[heartbeat] {label}: still running after {elapsed//60}m{elapsed%60:02d}s")
            last_heartbeat = now

        events = sel.select(timeout=1.0)
        if events:
            line = proc.stdout.readline()
            if line:
                sys.stdout.write(line)
                sys.stdout.flush()
                if SERIOUS_BLOCK_RE.search(line):
                    blocker_line = line.strip()[:500]
                    log(f"[blocker] Detected LinkedIn/security blocker: {blocker_line}")
                    try:
                        os.killpg(proc.pid, signal.SIGTERM)
                    except Exception:
                        proc.terminate()
                    try:
                        proc.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        try:
                            os.killpg(proc.pid, signal.SIGKILL)
                        except Exception:
                            proc.kill()
                    return 4, blocker_line
        if proc.poll() is not None:
            # Drain the rest.
            rest = proc.stdout.read()
            if rest:
                sys.stdout.write(rest)
                sys.stdout.flush()
                for line in rest.splitlines():
                    if SERIOUS_BLOCK_RE.search(line):
                        blocker_line = line.strip()[:500]
                        log(f"[blocker] Detected LinkedIn/security blocker: {blocker_line}")
                        return 4, blocker_line
            return proc.returncode or 0, blocker_line


def run_visual_probe() -> None:
    if not VISUAL_RECOVER.exists():
        log(f"[visual] visual-recover helper missing: {VISUAL_RECOVER}")
        return
    log("\n=== Visual probe of LinkedIn blocker state ===")
    cmd = [
        "node", str(VISUAL_RECOVER),
        "--url-substr", "linkedin.com",
        "--prompt", "Inspect the visible LinkedIn browser state. Is there a CAPTCHA, security verification, login wall, unusual-activity warning, or normal jobs page? Quote the visible blocker text and next human action if any.",
    ]
    rc, out = run_simple(cmd, cwd=WORKSPACE, timeout=180)
    log(out[-4000:] if out else f"[visual] no output, rc={rc}")


def snapshot_counts(run_start_sql: str) -> dict:
    with sqlite3.connect(DB) as conn:
        conn.row_factory = sqlite3.Row
        out: dict[str, object] = {}
        out["new_linkedin_jobs"] = conn.execute(
            "SELECT COUNT(*) FROM jobs WHERE source='linkedin' AND datetime(created_at) >= datetime(?)",
            (run_start_sql,),
        ).fetchone()[0]
        out["new_linkedin_with_desc"] = conn.execute(
            "SELECT COUNT(*) FROM jobs WHERE source='linkedin' AND datetime(created_at) >= datetime(?) AND COALESCE(description_text,'')<>''",
            (run_start_sql,),
        ).fetchone()[0]
        out["new_linkedin_unscored"] = conn.execute(
            """
            SELECT COUNT(*) FROM jobs j
            WHERE j.source='linkedin'
              AND datetime(j.created_at) >= datetime(?)
              AND j.application_status='saved'
              AND COALESCE(j.description_text,'')<>''
              AND NOT EXISTS (SELECT 1 FROM match_results mr WHERE mr.source=j.source AND mr.job_id=j.job_id)
            """,
            (run_start_sql,),
        ).fetchone()[0]
        out["fresh_apply_queue_by_source"] = [dict(r) for r in conn.execute(
            """
            SELECT j.source, COUNT(*) AS count
            FROM jobs j
            JOIN match_results mr ON mr.source=j.source AND mr.job_id=j.job_id
            WHERE j.application_status='saved'
              AND mr.fit_score >= ?
              AND mr.cta IN ('Apply','Maybe')
              AND COALESCE(mr.has_salary_blocker,0)=0
              AND datetime(j.created_at) > datetime('now','-14 days')
            GROUP BY j.source ORDER BY j.source
            """, (FIT_THRESHOLD,)
        )]
        return out


def export_new_jobs_to_score(run_start_sql: str, path: Path) -> list[dict]:
    sql = """
        SELECT source, job_id, title, company, city, country_code,
               SUBSTR(description_text, 1, 3000) AS description,
               url, COALESCE(application_links_json, '[]') AS application_links_json,
               created_at
        FROM jobs j
        WHERE source='linkedin'
          AND datetime(created_at) >= datetime(?)
          AND application_status='saved'
          AND COALESCE(description_text,'')<>''
          AND NOT EXISTS (SELECT 1 FROM match_results mr WHERE mr.source=j.source AND mr.job_id=j.job_id)
        ORDER BY datetime(created_at) DESC, title
    """
    with sqlite3.connect(DB) as conn:
        conn.row_factory = sqlite3.Row
        rows = [dict(r) for r in conn.execute(sql, (run_start_sql,))]
    path.write_text(json.dumps(rows, indent=2), encoding="utf-8")
    return rows


def postprocess_scores(scores: list[dict], jobs: list[dict]) -> list[dict]:
    # The shared scorer applies the user's exclusions and owns score arithmetic.
    return scores


def insert_scores(scores: list[dict]) -> None:
    if not scores:
        return
    cols = [
        "search_id", "source", "job_id", "fit_score", "cta", "stretch_label",
        "must_have_total", "must_have_matched", "nice_to_have_total", "nice_to_have_matched",
        "tech_stack_total", "tech_stack_matched", "mandatory_skills_found_json", "mandatory_skills_matched_json",
        "has_language_blocker", "has_country_mismatch", "has_work_mode_mismatch", "has_salary_blocker",
        "tailoring_effort", "matched_must_haves_json", "missing_or_unclear_must_haves_json",
        "matched_nice_to_haves_json", "tailoring_suggestions_json", "blockers_json",
    ]
    sql = f"""
        INSERT INTO match_results ({', '.join(cols)})
        VALUES ({', '.join(['?'] * len(cols))})
        ON CONFLICT(search_id, source, job_id) DO UPDATE SET
          fit_score=excluded.fit_score,
          cta=excluded.cta,
          stretch_label=excluded.stretch_label,
          must_have_total=excluded.must_have_total,
          must_have_matched=excluded.must_have_matched,
          nice_to_have_total=excluded.nice_to_have_total,
          nice_to_have_matched=excluded.nice_to_have_matched,
          tech_stack_total=excluded.tech_stack_total,
          tech_stack_matched=excluded.tech_stack_matched,
          mandatory_skills_found_json=excluded.mandatory_skills_found_json,
          mandatory_skills_matched_json=excluded.mandatory_skills_matched_json,
          has_language_blocker=excluded.has_language_blocker,
          has_country_mismatch=excluded.has_country_mismatch,
          has_work_mode_mismatch=excluded.has_work_mode_mismatch,
          has_salary_blocker=excluded.has_salary_blocker,
          tailoring_effort=excluded.tailoring_effort,
          matched_must_haves_json=excluded.matched_must_haves_json,
          missing_or_unclear_must_haves_json=excluded.missing_or_unclear_must_haves_json,
          matched_nice_to_haves_json=excluded.matched_nice_to_haves_json,
          tailoring_suggestions_json=excluded.tailoring_suggestions_json,
          blockers_json=excluded.blockers_json
    """
    vals = []
    for s in scores:
        row = []
        for c in cols:
            if c == "nice_to_have_total":
                row.append(int(s.get("nice_to_have_total", s.get("nice_have_total", 0)) or 0))
            elif c == "has_salary_blocker":
                row.append(int(s.get(c, 0) or 0))
            else:
                row.append(s.get(c))
        vals.append(row)
    with sqlite3.connect(DB) as conn:
        conn.executemany(sql, vals)
        conn.commit()


def score_new_jobs(run_start_sql: str, search_id: str) -> dict:
    jobs_path = RUN_DIR / "jobs-to-score.json"
    scores_path = RUN_DIR / "scores.json"
    jobs = export_new_jobs_to_score(run_start_sql, jobs_path)
    log(f"\n=== Scoring newly saved LinkedIn jobs ===")
    log(f"Jobs to score from this run: {len(jobs)}")
    if not jobs:
        return {"jobs_to_score": 0, "scores_inserted": 0, "apply": 0, "skip": 0, "top_apply": []}

    env = os.environ.copy()
    env.update({
        "SCORE_CV_PATH": str(WORKSPACE / "CV.docx"),
        "SCORE_CACHE_PATH": str(WORKSPACE / "personal-info-cache.json"),
        "SCORE_JOBS_PATH": str(jobs_path),
        "SCORE_OUTPUT_PATH": str(scores_path),
        "SCORE_SEARCH_ID": search_id,
        "SCORE_TARGET_ROLE": TARGET_ROLE,
        "SCORE_REQUIRE_TITLE": "0",
    })
    p = subprocess.run(["python3", str(SCORER)], cwd=str(WORKSPACE), env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    log(p.stdout)
    if p.returncode != 0:
        raise RuntimeError(f"score_jobs_inline.py failed with rc={p.returncode}")
    scores = json.loads(scores_path.read_text(encoding="utf-8"))
    scores = postprocess_scores(scores, jobs)
    scores_path.write_text(json.dumps(scores, indent=2), encoding="utf-8")
    insert_scores(scores)
    by_key = {(j.get("source"), j.get("job_id")): j for j in jobs}
    apply_scores = [s for s in scores if s.get("cta") == "Apply"]
    top_apply = []
    for s in sorted(apply_scores, key=lambda x: -float(x.get("fit_score") or 0))[:20]:
        j = by_key.get((s.get("source"), s.get("job_id")), {})
        top_apply.append({
            "fit_score": s.get("fit_score"),
            "title": j.get("title"),
            "company": j.get("company"),
            "country_code": j.get("country_code"),
            "url": j.get("url"),
        })
    log(f"Inserted/updated {len(scores)} score rows. Apply={len(apply_scores)} Skip={len(scores)-len(apply_scores)}")
    if top_apply:
        log("Top Apply rows:")
        for r in top_apply[:10]:
            log(f"  {r['fit_score']}% | {r['title']} | {r['company']} | {r['country_code']} | {r['url']}")
    return {
        "jobs_to_score": len(jobs),
        "scores_inserted": len(scores),
        "apply": len(apply_scores),
        "skip": len(scores) - len(apply_scores),
        "top_apply": top_apply,
    }



def split_list(value: str | None) -> list[str]:
    if not value:
        return []
    return [x.strip() for x in re.split(r"[;,]", value) if x.strip()]

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Visible LinkedIn search runner for job-hunter.")
    parser.add_argument("--run-dir", default=str(RUN_DIR), help="artifact directory (data only, no scripts)")
    parser.add_argument("--locations", default=None, help="comma/semicolon-separated locations (default: profile target countries)")
    parser.add_argument("--queries", default=None, help="comma/semicolon-separated LinkedIn search queries (default: profile roles)")
    parser.add_argument("--fresh-days", default=FRESH_DAYS)
    parser.add_argument("--max-start", default=MAX_START)
    parser.add_argument("--speaks", default=None)
    parser.add_argument("--exclude-languages", default="")
    parser.add_argument("--location-timeout-seconds", type=int, default=LOCATION_TIMEOUT_SECONDS)
    parser.add_argument("--score-fallback", action="store_true", help="only score jobs using --run-start-sql or fallback_start_sql.txt")
    parser.add_argument("--run-start-sql", default=None, help="SQLite timestamp for --score-fallback")
    return parser.parse_args()

def main() -> int:
    args = parse_args()
    global RUN_DIR, LOCATIONS, QUERIES, FRESH_DAYS, MAX_START, SPEAKS, EXCLUDE_LANGS, LOCATION_TIMEOUT_SECONDS, TARGET_ROLE, FIT_THRESHOLD
    try:
        defaults = load_profile_defaults()
    except jh_profile.ProfileError as exc:
        log(f"[fatal] {exc.code}: {exc}")
        return 2
    RUN_DIR = Path(args.run_dir).expanduser().resolve()
    LOCATIONS = split_list(args.locations) or defaults["locations"]
    QUERIES = split_list(args.queries) or defaults["queries"]
    FRESH_DAYS = str(args.fresh_days)
    MAX_START = str(args.max_start)
    SPEAKS = args.speaks or defaults["speaks"]
    EXCLUDE_LANGS = args.exclude_languages
    TARGET_ROLE = defaults["target_role"]
    FIT_THRESHOLD = defaults['profile']['fitThreshold']
    if not LOCATIONS:
        log("[fatal] no --locations supplied and search-config.json has no target countries")
        return 2
    if not QUERIES:
        log("[fatal] no --queries supplied and the profile has no roles")
        return 2
    if not SPEAKS:
        log("[fatal] no --speaks supplied and the profile has no usable languages")
        return 2
    LOCATION_TIMEOUT_SECONDS = int(args.location_timeout_seconds)
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    os.chdir(WORKSPACE)
    log(f"Run dir: {RUN_DIR}")
    log(f"Workspace: {WORKSPACE}")
    log(f"DB: {DB}")
    log(f"Started: {datetime.now(timezone.utc).isoformat()}")

    if args.score_fallback:
        run_start_sql = args.run_start_sql
        if not run_start_sql:
            for name in ["fallback_start_sql.txt", "run_start_sql.txt"]:
                candidate = RUN_DIR / name
                if candidate.exists():
                    run_start_sql = candidate.read_text(encoding="utf-8").strip()
                    break
        if not run_start_sql:
            log("[fatal] --score-fallback requires --run-start-sql or fallback_start_sql.txt/run_start_sql.txt")
            return 2
        score_summary = score_new_jobs(run_start_sql, f"score-li-visible-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}")
        final_counts = snapshot_counts(run_start_sql)
        summary = {
            "run_dir": str(RUN_DIR),
            "run_start_sql": run_start_sql,
            "score_summary": score_summary,
            "final_counts": final_counts,
        }
        (RUN_DIR / "fallback-score-summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
        log("\n=== Fallback score summary ===")
        log(json.dumps(summary, indent=2)[:8000])
        return 0

    for required in [DB, WORKSPACE / "CV.docx", WORKSPACE / "personal-info-cache.json", LINKEDIN_RUNNER, SCORER]:
        if not required.exists():
            log(f"[fatal] missing required path: {required}")
            return 2

    log("\n=== Job-hunter doctor ===")
    rc, out = run_simple(["node", str(HOME / ".pi/agent/skills/job-hunter/scripts/jh-doctor.mjs")], timeout=180)
    log(out[-6000:] if out else f"jh-doctor rc={rc}")
    if rc != 0:
        log("[fatal] jh-doctor returned non-zero; stopping before LinkedIn search.")
        return rc

    # Match SQLite CURRENT_TIMESTAMP semantics.
    run_start_sql = sqlite_value("SELECT datetime('now')")
    (RUN_DIR / "run_start_sql.txt").write_text(run_start_sql + "\n", encoding="utf-8")
    log(f"Run start timestamp for DB filtering: {run_start_sql}")

    searches = []
    for loc in LOCATIONS:
        out = RUN_DIR / f"linkedin-results-{loc.lower().replace(' ', '-')}.json"
        summary = RUN_DIR / f"linkedin-summary-{loc.lower().replace(' ', '-')}.json"
        cmd = [
            "node", str(LINKEDIN_RUNNER),
            "--role", TARGET_ROLE.split(";")[0].strip() or QUERIES[0],
            "--location", loc,
            "--speaks", SPEAKS,
            "--queries", ",".join(QUERIES),
            "--fresh-days", FRESH_DAYS,
            "--max-start", MAX_START,
            "--detail-concurrency", "2",
            "--detail-timeout", "30",
            "--obscura-port", "9225",
            "--db", str(DB),
            "--out", str(out),
            "--summary", str(summary),
        ]
        if EXCLUDE_LANGS:
            cmd[cmd.index("--queries"):cmd.index("--queries")] = ["--exclude-languages", EXCLUDE_LANGS]
        searches.append((loc, cmd))

    search_results: list[dict] = []
    blocker: dict | None = None
    for loc, cmd in searches:
        before = snapshot_counts(run_start_sql)
        rc, block_line = run_streaming(cmd, label=f"LinkedIn search: {loc}", timeout=LOCATION_TIMEOUT_SECONDS)
        after = snapshot_counts(run_start_sql)
        record = {"location": loc, "returncode": rc, "blocker_line": block_line, "before": before, "after": after}
        search_results.append(record)
        (RUN_DIR / "search-progress.json").write_text(json.dumps(search_results, indent=2), encoding="utf-8")
        if rc == 4:
            blocker = {"location": loc, "line": block_line, "timestamp": datetime.now(timezone.utc).isoformat()}
            (RUN_DIR / "blocked.json").write_text(json.dumps(blocker, indent=2), encoding="utf-8")
            run_visual_probe()
            log("\n[blocked] Stopping as instructed because LinkedIn appears to require security/login/CAPTCHA handling.")
            (RUN_DIR / "BLOCKED").write_text(json.dumps(blocker, indent=2), encoding="utf-8")
            return 4
        if rc not in (0, 124):
            log(f"[warn] Search for {loc} exited with rc={rc}; continuing to next location.")

    score_summary = score_new_jobs(run_start_sql, f"score-li-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}")
    final_counts = snapshot_counts(run_start_sql)
    summary = {
        "run_dir": str(RUN_DIR),
        "run_start_sql": run_start_sql,
        "locations": LOCATIONS,
        "queries": QUERIES,
        "search_results": search_results,
        "score_summary": score_summary,
        "final_counts": final_counts,
    }
    (RUN_DIR / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    lines = []
    lines.append(f"Run dir: {RUN_DIR}")
    lines.append(f"New LinkedIn jobs: {final_counts['new_linkedin_jobs']}")
    lines.append(f"New LinkedIn jobs with descriptions: {final_counts['new_linkedin_with_desc']}")
    lines.append(f"Scores inserted: {score_summary['scores_inserted']} (Apply={score_summary['apply']}, Skip={score_summary['skip']})")
    lines.append(f"Fresh apply queue by source: {final_counts['fresh_apply_queue_by_source']}")
    if score_summary.get("top_apply"):
        lines.append("Top new LinkedIn Apply rows:")
        for r in score_summary["top_apply"][:10]:
            lines.append(f"  {r['fit_score']}% | {r['title']} | {r['company']} | {r['country_code']} | {r['url']}")
    else:
        lines.append("Top new LinkedIn Apply rows: none")
    (RUN_DIR / "summary.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    log("\n=== Final summary ===")
    log("\n".join(lines))
    (RUN_DIR / "DONE").write_text("ok\n", encoding="utf-8")
    log("DONE_OK")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        log("Interrupted")
        raise
    except Exception as exc:
        log(f"[fatal] {type(exc).__name__}: {exc}")
        try:
            (RUN_DIR / "ERROR").write_text(f"{type(exc).__name__}: {exc}\n", encoding="utf-8")
        except Exception:
            pass
        raise
