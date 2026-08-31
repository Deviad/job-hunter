#!/usr/bin/env python3
"""Inline scoring template for unscored jobs.

Use this when the unscored queue exceeds 15 jobs (a leaf subagent times out
around 40+ jobs at the 600s leaf budget). The script reads the CV, the
unscored jobs JSON, and the personal-info cache, then emits a JSON array of
score objects in the exact match_results INSERT format.

Inputs (paths can be overridden via env vars):
  $SCORE_CV_PATH         default: $PWD/CV.docx
  $SCORE_JOBS_PATH       default: /tmp/jobs-to-score.json
  $SCORE_OUTPUT_PATH     default: /tmp/scores.json
  $SCORE_CACHE_PATH      default: $PWD/personal-info-cache.json
  $SCORE_REQUIRE_TITLE   default: "0" — retained for CLI compatibility; when
                         "1", add an adjacent-title tailoring note but never
                         veto a score-driven Apply decision.
  $SCORE_TARGET_ROLE     default: first few preferred roles from rolePreferences,
                         or "" when the cache has no rolePreferences (also used in
                         the deterministic search ID)
  $SCORE_SEARCH_ID       optional explicit override. Without it, the script derives
                         one stable ID from the target role, country scope, CV bytes,
                         scoring version, and canonical job payload.

Usage:
  python3 score_jobs_inline.py
  SCORE_TARGET_ROLE="AI Architect; AI Lead" python3 score_jobs_inline.py
"""
import hashlib
import html
import json
import os
import re
import subprocess
import sys
import zipfile
from pathlib import Path

# --- CV skill inventory (from SKILL.md "For each mandatory requirement") ---
CV_SKILLS = {
    "aws", "azure", "cosmos db", "cosmosdb", "blob storage", "azure ai search",
    "azure web service", "azure functions", "entra id", "microsoft entra",
    "langgraph", "langchain", "rag", "retrieval-augmented generation",
    "openai", "ai agents", "agentic ai", "agentic", "prompt engineering",
    "anthropic", "claude", "claude code", "github copilot", "copilot",
    "java", "spring boot", "python", "typescript", "javascript",
    "docker", "kubernetes", "k8s", "kafka",
    "microservices", "api-driven design", "api design", "ddd",
    "domain-driven design", "event-driven", "event-driven architecture",
    "jenkins", "gitlab ci", "github actions",
    "sql", "nosql", "dynamodb", "elastic search", "elasticsearch",
    "oauth2", "sso", "oidc", "gdpr",
    "az-900", "az-305", "safer agilist", "safer", "safe agilist",
    "ci/cd", "ci-cd", "continuous integration", "continuous deployment",
    "cloud migration", "microservice", "rest", "restful", "openapi",
    "azure cloud", "aws lambda",
    "ai architect", "solution architect", "cloud architect", "enterprise architect",
    "integration architect", "technical architect", "software architect",
    "platform architect", "ai engineer", "llm",
}

NON_CV_SKILLS = {
    "databricks", "pyspark", "spark", "mlflow", "terraform", "pulumi",
    "salesforce", "servicenow", "mulesoft", "sap", "oracle database",
    "snowflake", "airflow", "hadoop", "react", "angular", "node.js", "nodejs",
    "go", "golang", "rust", "c++", "c#", ".net", "power bi", "tableau",
    "grafana", "prometheus", "istio", "linkerd", "helm", "argocd",
    "murex", "calypso", "bloomberg", "figma", "redux", "vue", "vue.js",
    "flutter", "swift", "kotlin", "android", "ios", "react native",
    "jquery", "sass", "scss", "less", "graphql", "trpc", "deno", "bun",
    "postman", "swagger", "fastapi", "django", "flask", "express",
    "laravel", "rails", "ruby", "php", "perl", "scala", "groovy",
    "r language", "matlab", "sas", "spss", "looker", "metabase",
    "datadog", "splunk", "newrelic", "appdynamics", "dynatrace",
    "selenium", "cypress", "playwright", "jest", "mocha", "junit",
    "testng", "cucumber", "jmeter", "loadrunner", "soapui",
    "rest-assured", "pytest",
}

MANDATORY_MARKERS = re.compile(
    r"\b(required|must have|essential|strong background in|strong experience with|"
    r"significant experience with|deep experience with|deep knowledge of|"
    r"deep understanding of|proven experience in|proven track record with|"
    r"demonstrated experience with|hands-on experience with|hands-on expertise in|"
    r"expertise in|proficient in|solid experience with|you will work with|"
    r"you will use|you will be responsible for|experience with)\b",
    re.IGNORECASE,
)
NICE_TO_HAVE_MARKERS = re.compile(
    r"\b(nice to have|preferred|bonus|plus|optional|familiarity with|"
    r"exposure to|good to have|advantageous)\b",
    re.IGNORECASE,
)
BUILDING_ARCH_TITLE = re.compile(
    r"\b(architekt|architecte|architetto|bim|riba|part ii|revit|autocad|"
    r"construction architect|building architect|innenarchitekt|"
    r"architecte d.int.rieur|architetto d.interni|interior architect|"
    r"draftsman|zeichner|bauleiter|praktikant|construction manager)\b",
    re.IGNORECASE,
)
# Backward-compatible title matcher used when the cache has no usable taxonomy.
FALLBACK_TITLE_MATCH = re.compile(
    r"\b(ai architect|solution architect|cloud architect|enterprise architect|"
    r"integration architect|technical architect|software architect|"
    r"platform architect|ai lead|head of ai|ai engineer|principal architect|"
    r"lead architect|senior architect|chief architect|pre.?sales.*architect|"
    r"data architect|gen.*ai architect|generative ai architect|"
    r"agentic.*ai architect|ai knowledge architect|ai solution architect|"
    r"ai strategy|head of architecture|director of architecture|ai principal)\b",
    re.IGNORECASE,
)
LANG_PATTERNS = {
    "German": re.compile(r"\b(german|deutsch|fluent in german|german required)\b", re.IGNORECASE),
    "French": re.compile(r"\b(french|français|fluent in french|french required)\b", re.IGNORECASE),
    "Spanish": re.compile(r"\b(spanish|español|fluent in spanish)\b", re.IGNORECASE),
    "English": re.compile(r"\b(english|fluent in english)\b", re.IGNORECASE),
    "Italian": re.compile(r"\b(italian|italiano|fluent in italian)\b", re.IGNORECASE),
}
USER_SPOKEN = {"English", "Italian"}
CLASSIFIER_CLI = Path(__file__).resolve().parents[2] / "job-hunter" / "scripts" / "role-classifier-cli.mjs"


def load_role_preferences() -> dict | None:
    """Load the optional machine-readable role taxonomy from the canonical cache."""
    home = Path(os.environ.get("JOBHUNTER_HOME") or (Path.home() / ".job-hunter")).expanduser()
    try:
        with (home / "personal-info-cache.json").open(encoding="utf-8") as handle:
            cache = json.load(handle)
        preferences = cache.get("rolePreferences")
        return preferences if isinstance(preferences, dict) else None
    except (OSError, TypeError, ValueError):
        return None


def _role_titles(preferences: dict | None) -> list[str]:
    if not preferences:
        return []
    titles: list[str] = []
    groups = [
        preferences.get("preferredPrimaryRoles"),
        (preferences.get("adjacentRoles") or {}).get("adjacentTechnicalLeadership"),
        (preferences.get("adjacentRoles") or {}).get("leadershipProgression"),
    ]
    for group in groups:
        if not isinstance(group, list):
            continue
        for title in group:
            if isinstance(title, str) and title.strip() and title.strip().lower() not in {
                existing.lower() for existing in titles
            }:
                titles.append(title.strip())
    return titles


def build_title_match(preferences: dict | None) -> re.Pattern[str]:
    """Build a title matcher from cached role titles, allowing spacing or hyphens."""
    patterns = []
    for title in _role_titles(preferences):
        words = re.findall(r"[a-z0-9]+", title.lower())
        if words:
            patterns.append(r"\b" + r"[\s\-\u2013\u2014/,]+".join(re.escape(word) for word in words) + r"\b")
    return re.compile("(?:" + "|".join(patterns) + ")", re.IGNORECASE) if patterns else FALLBACK_TITLE_MATCH


ROLE_PREFERENCES = load_role_preferences()
TITLE_MATCH = build_title_match(ROLE_PREFERENCES) if ROLE_PREFERENCES else FALLBACK_TITLE_MATCH
PREFERRED_PRIMARY_ROLES = (
    ROLE_PREFERENCES.get("preferredPrimaryRoles", [])
    if ROLE_PREFERENCES and isinstance(ROLE_PREFERENCES.get("preferredPrimaryRoles"), list)
    else []
)
DEFAULT_TARGET_ROLE = "; ".join(
    role for role in PREFERRED_PRIMARY_ROLES[:3] if isinstance(role, str) and role.strip()
) if PREFERRED_PRIMARY_ROLES else ""


def job_description(job: dict) -> str:
    """Return JD evidence without falling back to query/search metadata."""
    for field in ("description", "description_text"):
        value = job.get(field)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def classify_jobs(jobs: list[dict]) -> list[dict]:
    """Classify a batch through the shared JavaScript taxonomy."""
    if not jobs:
        return []
    payload = [
        {
            "title": job.get("title") or "",
            "descriptionText": job_description(job),
            "jobFunction": job.get("jobFunction") or job.get("job_function") or "",
            "industries": job.get("industries") or "",
        }
        for job in jobs
    ]
    if not CLASSIFIER_CLI.exists():
        raise RuntimeError(f"Shared role classifier CLI not found: {CLASSIFIER_CLI}")
    completed = subprocess.run(
        ["node", str(CLASSIFIER_CLI)],
        input=json.dumps(payload, sort_keys=True, separators=(",", ":")),
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        raise RuntimeError(f"Role classifier bridge failed: {detail}")
    try:
        results = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Role classifier bridge returned invalid JSON") from exc
    if not isinstance(results, list) or len(results) != len(jobs):
        raise RuntimeError("Role classifier bridge returned the wrong batch length")
    return results


def extract_cv_text(path: str) -> str:
    with zipfile.ZipFile(path) as z:
        data = z.read("word/document.xml").decode("utf-8", "ignore")
    data = re.sub(r"<w:tab[^>]*/>", " ", data)
    data = re.sub(r"</w:p>", "\n", data)
    data = re.sub(r"<[^>]+>", "", data)
    return html.unescape(data)


def extract_mandatory_skills(desc: str) -> list[str]:
    if not desc:
        return []
    skills: list[str] = []
    for sent in re.split(r"(?<=[.!?;])\s+|\n", desc):
        if not sent.strip():
            continue
        has_mandatory = bool(MANDATORY_MARKERS.search(sent))
        if not has_mandatory:
            continue
        sent_lower = sent.lower()
        candidates: set[str] = set()
        for skill in CV_SKILLS | NON_CV_SKILLS:
            if re.search(r"\b" + re.escape(skill) + r"\b", sent_lower):
                candidates.add(skill)
        for m in re.finditer(
            r"experience (?:with|in)\s+([a-zA-Z][\w\s./+#-]{1,40}?)(?=[,;.]|\sand\s|\sor\s|$)",
            sent, re.IGNORECASE,
        ):
            tok = m.group(1).strip().lower()
            if 2 < len(tok) < 50:
                candidates.add(tok)
        for m in re.finditer(
            r"knowledge of\s+([a-zA-Z][\w\s./+#-]{1,40}?)(?=[,;.]|\sand\s|\sor\s|$)",
            sent, re.IGNORECASE,
        ):
            tok = m.group(1).strip().lower()
            if 2 < len(tok) < 50:
                candidates.add(tok)
        for c in candidates:
            if c not in skills:
                skills.append(c)
    return skills


def check_cv_has_skill(skill: str) -> bool:
    s = skill.lower().strip()
    if s in CV_SKILLS:
        return True
    for cv_skill in CV_SKILLS:
        if s in cv_skill or cv_skill in s:
            return True
    return False


def detect_language_blocker(desc: str) -> bool:
    if not desc:
        return False
    for lang, pattern in LANG_PATTERNS.items():
        if lang in USER_SPOKEN:
            continue
        if not pattern.search(desc):
            continue
        for sent in re.split(r"(?<=[.!?;])\s+|\n", desc):
            if pattern.search(sent):
                if MANDATORY_MARKERS.search(sent) and not NICE_TO_HAVE_MARKERS.search(sent):
                    return True
                if re.search(r"\b(must|required|essential|fluent|proficient|mandatory).*" +
                             pattern.pattern, sent, re.IGNORECASE):
                    return True
    return False


def role_reason_text(classification: dict) -> str:
    reason = classification.get("reason") or {}
    parts = [reason.get("summary") or classification.get("label") or "Role classification unavailable"]
    evidence = reason.get("evidence") or []
    gaps = reason.get("gaps") or []
    if evidence:
        parts.append(f"Evidence: {', '.join(evidence)}.")
    if gaps:
        parts.append(f"Gaps: {', '.join(gaps)}.")
    evaluation = classification.get("leadershipEvaluation") or {}
    if evaluation.get("isLeadership"):
        scope = evaluation.get("teamScope") or {}
        technical = evaluation.get("technicalOwnership") or {}
        influence = evaluation.get("organizationalInfluence") or {}
        growth = evaluation.get("growthPath") or {}
        parts.append(
            "Leadership evaluation: "
            f"team scope engineers={scope.get('engineers')}, teams={scope.get('teams')}, "
            f"multiple_teams={scope.get('multipleTeams')}, organizational_remit={scope.get('organizationalRemit')}; "
            f"technical_ownership={technical.get('present')}; "
            f"organizational_influence={influence.get('present')}; "
            f"growth_path={growth.get('present')}; "
            f"hands_on_transition_risk={evaluation.get('handsOnTransitionRisk')}; "
            f"hybrid_architecture_leadership={evaluation.get('hybridArchitectureLeadership')}."
        )
    data_gap = classification.get("dataGap") or {}
    if data_gap.get("applies"):
        missing = data_gap.get("missingSkills") or []
        if missing:
            parts.append(f"Data-domain gaps: {', '.join(missing)}.")
    return " ".join(parts)


def _append_unique(items: list[str], value: str) -> None:
    if value and value not in items:
        items.append(value)


def scored_search_ids(job: dict) -> set[str]:
    """Read optional exported score metadata without requiring a DB write."""
    values = []
    for key in ("scored_search_ids", "existing_search_ids", "match_result_search_ids"):
        value = job.get(key)
        values.extend(value if isinstance(value, list) else [value] if value else [])
    value = job.get("scored_search_id")
    if value:
        values.append(value)
    match_results = job.get("match_results")
    if isinstance(match_results, list):
        values.extend(
            row.get("search_id") for row in match_results
            if isinstance(row, dict) and row.get("search_id")
        )
    elif isinstance(match_results, dict):
        values.extend(
            row.get("search_id") for row in match_results.values()
            if isinstance(row, dict) and row.get("search_id")
        )
    return {str(value) for value in values if value}


def jobs_unscored_for_search(jobs: list[dict], search_id: str) -> list[dict]:
    """Keep rows without a result for this search, not merely without history."""
    return [job for job in jobs if search_id not in scored_search_ids(job)]


def score_job(
    job: dict,
    require_title_match: bool = False,
    search_id: str | None = None,
    role_classification: dict | None = None,
) -> dict:
    title = (job.get("title") or "").strip()
    desc = job_description(job)
    classification = role_classification or classify_jobs([job])[0]
    role_label = classification["label"]
    role_reason = role_reason_text(classification)
    # jobs.role_family_reason is an existing structured TEXT field populated by
    # discovery with the shared classifier's reason object. Keep that shape so
    # scorer output can flow through the existing jobs-field integration path.
    role_reason_json = json.dumps(classification.get("reason") or {}, sort_keys=True)

    title_match = bool(TITLE_MATCH.search(title))
    domain_match = bool(re.search(
        r"\b(banking|fintech|finance|financial services|insurance|"
        r"investment|asset management|wealth|trading|"
        r"cloud|azure|aws|microservices|saas|enterprise|"
        r"architect|architecture)\b", desc, re.IGNORECASE,
    )) or title_match

    mandatory_skills = extract_mandatory_skills(desc)
    mandatory_matched = [s for s in mandatory_skills if check_cv_has_skill(s)]
    tech_total = len(mandatory_skills)
    tech_matched = len(mandatory_matched)
    tech_ratio = tech_matched / tech_total if tech_total else 1.0
    tech_stack_pass = (tech_total == 0) or (tech_ratio >= 0.5)
    if tech_total >= 3 and tech_ratio < 0.3:
        tech_stack_pass = False

    seniority_match = bool(re.search(
        r"\b(architect|principal|lead|head|director|chief|senior|staff)\b",
        title, re.IGNORECASE,
    )) or title_match
    language_pass = not detect_language_blocker(desc)

    blockers: list[str] = []
    if not language_pass:
        blockers.append("Language blocker (German/French/Spanish required)")
    if BUILDING_ARCH_TITLE.search(title):
        blockers.append("Role mismatch (building/construction architect)")

    must_have_matched = sum([
        1 if title_match else 0,
        1 if domain_match else 0,
        1 if tech_stack_pass else 0,
        1 if seniority_match else 0,
        1 if language_pass else 0,
    ])
    fit_score = (must_have_matched / 5) * 100.0

    if role_label == "Out of scope":
        blockers.append(f"Role family blocker (Out of scope): {role_reason}")
    has_blocker = bool(blockers)
    # The application threshold is score-driven. Adjacent titles are tailoring
    # signals only; they do not veto a score of 60 or higher.
    cta = "Apply" if (fit_score >= 60 and not has_blocker) else "Skip"

    # Stretch label — DB CHECK values only (see SKILL.md)
    if has_blocker:
        stretch = "Blocked"
    elif must_have_matched == 5 and tech_ratio >= 0.8:
        stretch = "Core fit"
    elif must_have_matched >= 4 and not has_blocker:
        stretch = "Stretch"
    elif not title_match:
        stretch = "Major domain stretch"
    elif not tech_stack_pass and tech_total > 0:
        stretch = "Major cloud stretch"
    else:
        stretch = "Stretch"

    tailoring: list[str] = []
    if require_title_match and not title_match:
        tailoring.append(f"Title '{title}' is adjacent to the target role tier — emphasize transferable architecture evidence")
    if tech_total > 0 and tech_matched < tech_total:
        missing = [s for s in mandatory_skills if s not in mandatory_matched]
        tailoring.append(f"CV lacks {len(missing)} of {tech_total} mandatory skills: {', '.join(missing[:5])}")
    tailoring_effort = (
        "high" if (tech_total > 0 and tech_matched < tech_total * 0.5) else
        "medium" if tech_matched < tech_total else "low"
    )

    matched_must: list[str] = []
    if title_match: matched_must.append("Title alignment")
    if domain_match: matched_must.append("Domain overlap (banking/cloud/enterprise)")
    if tech_stack_pass: matched_must.append(f"Tech stack: {tech_matched}/{tech_total} mandatory skills matched")
    if seniority_match: matched_must.append("Seniority match")
    if language_pass: matched_must.append("Language alignment")
    missing_must: list[str] = []
    if not title_match: missing_must.append(f"Title '{title}' not strictly AI/Solution/Cloud Architect")
    if not tech_stack_pass:
        if tech_total > 0:
            missing_must.append(f"Tech stack: missing {', '.join([s for s in mandatory_skills if s not in mandatory_matched][:5])}")
        else:
            missing_must.append("Tech stack: no explicit mandatory skills listed")
    if not seniority_match: missing_must.append("Seniority: title suggests IC/mid rather than architect/lead")
    if not language_pass: missing_must.append("Language blocker")

    if role_label == "Data-domain stretch":
        data_gap = classification.get("dataGap") or {}
        data_missing = data_gap.get("missingSkills") or []
        if data_missing:
            _append_unique(missing_must, f"Data-domain stretch gaps: {', '.join(data_missing)}")
            _append_unique(tailoring, f"Data-domain stretch: explicitly address missing specialist skills ({', '.join(data_missing)})")
    if (classification.get("leadershipEvaluation") or {}).get("isLeadership"):
        evaluation = classification["leadershipEvaluation"]
        scope = evaluation.get("teamScope") or {}
        technical = evaluation.get("technicalOwnership") or {}
        influence = evaluation.get("organizationalInfluence") or {}
        growth = evaluation.get("growthPath") or {}
        leadership_fact = (
            "Leadership evaluation: "
            f"team scope engineers={scope.get('engineers')}, teams={scope.get('teams')}, "
            f"technical ownership={technical.get('present')}, "
            f"organizational influence={influence.get('present')}, "
            f"growth path={growth.get('present')}, "
            f"hands-on transition risk={evaluation.get('handsOnTransitionRisk')}"
        )
        _append_unique(missing_must, leadership_fact)
        _append_unique(tailoring, leadership_fact)

    has_blocker = bool(blockers)
    if has_blocker:
        cta = "Skip"

    return {
        "search_id": search_id,
        "source": job.get("source"),
        "job_id": job.get("job_id"),
        "fit_score": round(fit_score, 1),
        "cta": cta,
        "stretch_label": stretch,
        "role_family_inferred": role_label,
        "role_family_confidence": classification.get("confidence"),
        "role_family_reason": role_reason_json,
        "must_have_total": 5,
        "must_have_matched": must_have_matched,
        "tech_stack_total": tech_total,
        "tech_stack_matched": tech_matched,
        "mandatory_skills_found_json": json.dumps(mandatory_skills),
        "mandatory_skills_matched_json": json.dumps(mandatory_matched),
        "nice_to_have_total": 0,
        "nice_to_have_matched": 0,
        "has_language_blocker": 0 if language_pass else 1,
        "has_country_mismatch": 0,
        "has_work_mode_mismatch": 0,
        "tailoring_effort": tailoring_effort,
        "matched_must_haves_json": json.dumps(matched_must),
        "missing_or_unclear_must_haves_json": json.dumps(missing_must),
        "matched_nice_to_haves_json": json.dumps([]),
        "tailoring_suggestions_json": json.dumps(tailoring),
        "blockers_json": json.dumps(blockers),
    }


def slug(value: str, fallback: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return normalized[:32] or fallback


def deterministic_search_id(jobs: list[dict], cv_path: str, require_title: bool) -> str:
    explicit = os.environ.get("SCORE_SEARCH_ID")
    if explicit:
        return explicit

    target_role = os.environ.get("SCORE_TARGET_ROLE") or DEFAULT_TARGET_ROLE
    countries = sorted({
        str(job.get("country_code") or job.get("countryCode") or "").upper()
        for job in jobs
        if job.get("country_code") or job.get("countryCode")
    })
    canonical_jobs = sorted(
        ({
            "source": job.get("source"),
            "job_id": job.get("job_id"),
            "title": job.get("title"),
            "company": job.get("company"),
            "country_code": job.get("country_code") or job.get("countryCode"),
            "description": job.get("description") or job.get("description_text"),
        } for job in jobs),
        key=lambda job: (str(job["source"] or ""), str(job["job_id"] or "")),
    )
    payload = {
        "scorer_version": "inline-v2",
        "target_role": target_role,
        "require_title": require_title,
        "cv_sha256": hashlib.sha256(Path(cv_path).read_bytes()).hexdigest(),
        "jobs": canonical_jobs,
    }
    digest = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()[:12]
    role_part = slug(target_role, "targeted")
    country_part = "-".join(countries).lower() or "global"
    return f"score-{role_part}-{country_part}-{digest}"


def main():
    cv_path = os.environ.get("SCORE_CV_PATH", str(Path.cwd() / "CV.docx"))
    jobs_path = os.environ.get("SCORE_JOBS_PATH", "/tmp/jobs-to-score.json")
    output_path = os.environ.get("SCORE_OUTPUT_PATH", "/tmp/scores.json")
    require_title = os.environ.get("SCORE_REQUIRE_TITLE", "0") == "1"

    if not Path(cv_path).exists():
        sys.exit(f"CV not found: {cv_path}")
    if not Path(jobs_path).exists():
        sys.exit(f"Jobs JSON not found: {jobs_path}")
    extract_cv_text(cv_path)  # sanity check parse

    jobs = json.loads(Path(jobs_path).read_text())
    if isinstance(jobs, dict) and isinstance(jobs.get("jobs"), list):
        jobs = jobs["jobs"]
    if not isinstance(jobs, list):
        sys.exit("Jobs JSON must contain an array of jobs")
    search_id = deterministic_search_id(jobs, cv_path, require_title)
    jobs_to_score = jobs_unscored_for_search(jobs, search_id)
    classifications = classify_jobs(jobs_to_score)
    print(f"Search ID: {search_id}", file=sys.stderr)
    print(f"Scoring {len(jobs_to_score)} of {len(jobs)} jobs (require_title={require_title}) ...", file=sys.stderr)
    scored = [
        score_job(j, require_title_match=require_title, search_id=search_id, role_classification=classification)
        for j, classification in zip(jobs_to_score, classifications)
    ]
    apply = sum(1 for s in scored if s["cta"] == "Apply")
    skip = len(scored) - apply
    print(f"Apply: {apply}  Skip: {skip}", file=sys.stderr)
    print("\nTop Apply jobs:", file=sys.stderr)
    by_id = {(j.get("source"), j.get("job_id")): j for j in jobs}
    for s in sorted([x for x in scored if x["cta"] == "Apply"], key=lambda x: -x["fit_score"])[:10]:
        j = by_id.get((s["source"], s["job_id"]), {})
        print(f"  {s['fit_score']:.0f}% | {j.get('title','')} | {j.get('company','')} | {s['stretch_label']}", file=sys.stderr)
    Path(output_path).write_text(json.dumps(scored, indent=2))
    print(f"\nWrote {output_path} ({len(scored)} scores)", file=sys.stderr)


if __name__ == "__main__":
    main()
