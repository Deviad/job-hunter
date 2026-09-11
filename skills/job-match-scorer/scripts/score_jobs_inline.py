#!/usr/bin/env python3
"""Inline scoring template for unscored jobs. Use when the unscored queue exceeds
~15 jobs (a leaf subagent times out around 40+ jobs on a 600s leaf budget).

The script builds ONE evidence bundle per pass (parsed CV text, resolved personal
cache, taxonomy, scorer version) and scores every job against that bundle. It never
assumes that a candidate holds a skill, language, or work authorization: a
requirement counts as matched only when a literal span of the parsed CV or an
explicit cache field supports it. Recognition vocabulary recognizes requirement
terms in a job description; it is never possession evidence.

Scoring: fit_score = matched mandatory criteria / total mandatory criteria * 100,
computed from actual criterion records. Preferred ("nice to have") items never enter
the mandatory denominator. A job with no assessable mandatory criteria is reported as
insufficient evidence (fit_score 0, cta Skip, stretch_label Blocked, zero counts, and
an `assessment_status: insufficient_evidence` marker in the evidence JSON), never as
a fabricated 100%.

Inputs (paths can be overridden via env vars):
  $SCORE_CV_PATH         default: $PWD/CV.docx
  $SCORE_JOBS_PATH       default: /tmp/jobs-to-score.json
  $SCORE_OUTPUT_PATH     default: /tmp/scores.json
  $SCORE_CACHE_PATH      explicit personal-cache override. When set, only this file is
                         used; if missing or unparseable, cache evidence stays unknown
                         (no silent fallback). When unset, resolution order is
                         $JOBHUNTER_HOME/personal-info-cache.json, then
                         $PWD/personal-info-cache.json.
  $SCORE_REQUIRE_TITLE   default: "0" — retained CLI compatibility; "1" adds an
                         adjacent-title tailoring note but never vetoes a
                         score-driven Apply decision.
  $SCORE_TARGET_ROLE     default: first few preferred roles from rolePreferences, or
                         "" when the cache has none (also used in the search ID).
  $SCORE_SEARCH_ID       optional explicit override. Without it, the script derives
                         one stable ID from the target role, country scope, CV bytes,
                         resolved cache bytes, taxonomy identity, scorer version, and
                         canonical job payload (description-precedence text).

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

SCORER_VERSION = "inline-v3"

# Requirement-recognition vocabulary only (transcribed from the former
# CV_SKILLS/NON_CV_SKILLS inventories). Membership here means "this phrase names a
# requirement in a job description". It carries NO claim that the candidate holds the
# thing; possession evidence must come from the parsed CV or an explicit cache field.
REQUIREMENT_VOCAB = frozenset({
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
})

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
# Work-authorization wording is recognized as a requirement but never resolved from
# title, employer, nationality, or residence. Only explicit cache values can match it.
AUTHORISATION_RE = re.compile(
    r"\b(work (authorization|authorisation|permit|visa)|visa sponsorship|"
    r"sponsorship (is )?(not )?(available|required|provided)|no sponsorship|"
    r"without (any )?sponsorship|citizen(n|ship)? (only|required)|"
    r"must (be|hold|be a|already hold)\b[^.;]{0,60}?(citizen|citizenship|work "
    r"authorization|clearance)|security clearance (required|mandatory)|"
    r"eligible to work\b|require[sd]? (a )?work (authorization|permit|visa))\b",
    re.IGNORECASE,
)
AUTHORISATION_NEGATIVE_RE = re.compile(
    r"\b(no sponsorship (available|provided|offer(ed|ing))?|"
    r"without (any )?sponsorship|sponsorship is not available|"
    r"you (must|already) (be|hold|are))\b",
    re.IGNORECASE,
)
CLASSIFIER_CLI = Path(__file__).resolve().parents[2] / "job-hunter" / "scripts" / "role-classifier-cli.mjs"


def resolve_cache_path(explicit: str | None = None) -> str | None:
    """Resolve the personal-cache path: explicit override, canonical workspace, then cwd.

    An explicit $SCORE_CACHE_PATH that is missing is NOT replaced by the fallbacks;
    cache evidence stays unknown instead of silently switching identity.
    """
    if explicit:
        return explicit if Path(explicit).is_file() else None
    home = Path(os.environ.get("JOBHUNTER_HOME") or (Path.home() / ".job-hunter")).expanduser()
    canonical = home / "personal-info-cache.json"
    if canonical.is_file():
        return str(canonical)
    cwd_cache = Path.cwd() / "personal-info-cache.json"
    return str(cwd_cache) if cwd_cache.is_file() else None


def load_cache(path: str | None) -> dict | None:
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            data = handle.read()
        cache = json.loads(data)
        return cache if isinstance(cache, dict) else None
    except (OSError, ValueError):
        return None


def _cache_sha(path: str | None) -> str | None:
    if not path:
        return None
    try:
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()
    except OSError:
        return None


def load_role_preferences() -> dict | None:
    """Load machine-readable role taxonomy from the default-resolved cache."""
    cache = load_cache(resolve_cache_path())
    preferences = cache.get("rolePreferences") if cache else None
    return preferences if isinstance(preferences, dict) else None


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


def cache_supported_languages(cache: dict | None) -> set[str]:
    """Explicit language evidence from the cache, never inferred from residence.

    Accepts ["English", ...], {"German": "fluent", ...} or [{"language": ...,
    "level": ...}]. An empty/absent field yields the empty set (everything unknown).
    """
    if not cache:
        return set()
    raw = cache.get("languages")
    found: set[str] = set()

    def add(value: str, level: str | None = None):
        name = value.strip().title()
        if not name:
            return
        if level is None or str(level).strip().lower() not in {"none", "basic", "a1", "elementary"}:
            found.add(name)

    if isinstance(raw, dict):
        for name, level in raw.items():
            add(str(name), str(level) if level is not None else None)
    elif isinstance(raw, list):
        for item in raw:
            if isinstance(item, str):
                add(item)
            elif isinstance(item, dict):
                name = item.get("language") or item.get("name")
                if isinstance(name, str):
                    add(name, item.get("level") or item.get("proficiency"))
    return found


def cache_skill_evidence(cache: dict | None) -> set[str]:
    raw = cache.get("skills") if isinstance(cache, dict) else None
    items: set[str] = set()
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, str) and item.strip():
                items.add(item.strip().lower())
    return items


def cache_authorisation(cache: dict | None, country: str | None) -> str | None:
    """Return 'yes'/'no'/None — only from explicit cache values for the job country."""
    if not cache or not country:
        return None
    raw = cache.get("workAuthorization") or cache.get("work_authorization")
    key = country.strip().upper()
    value = None
    if isinstance(raw, dict):
        for name, entry in raw.items():
            if str(name).strip().upper() == key:
                value = entry
                break
    elif isinstance(raw, list):
        return "yes" if any(str(item).strip().upper() == key for item in raw) else None
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"yes", "true", "required", "granted", "have", "holder"}:
            return "yes"
        if lowered in {"no", "false", "none", "not held", "no permit"}:
            return "no"
    return None


def build_evidence(cv_path: str | None = None, cache_path: str | None = None) -> dict:
    """Collect one evidence bundle for a scoring pass (CV parsed once)."""
    cv_text = ""
    cv_sha = None
    if cv_path and Path(cv_path).is_file():
        cv_text = extract_cv_text(cv_path)
        cv_sha = _cache_sha(cv_path)
    cache = load_cache(cache_path)
    preferences = cache.get("rolePreferences") if isinstance(cache, dict) else None
    preferences = preferences if isinstance(preferences, dict) else None
    titles = _role_titles(preferences)
    taxonomy_sha = hashlib.sha256(
        json.dumps(sorted(t.lower() for t in titles), ensure_ascii=False).encode()
    ).hexdigest()[:12]
    return {
        "scorer_version": SCORER_VERSION,
        "cv": {"path": cv_path, "sha256": cv_sha, "text": cv_text},
        "cache": {
            "path": cache_path,
            "sha256": _cache_sha(cache_path),
            "data": cache or {},
            "languages": cache_supported_languages(cache),
            "skills": cache_skill_evidence(cache),
        },
        "taxonomy": {
            "source": "cache" if titles else "fallback",
            "titles": titles,
            "sha256": taxonomy_sha,
        },
        "title_match": build_title_match(preferences) if titles else FALLBACK_TITLE_MATCH,
    }


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


def _sentences(desc: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?;])\s+|\n", desc) if s.strip()]


def find_cv_span(term: str, cv_text: str) -> str | None:
    """Literal, word-bounded CV span for a requirement term (possession evidence)."""
    if not cv_text:
        return None
    match = re.search(r"\b" + re.escape(term) + r"\b", cv_text, re.IGNORECASE)
    if not match:
        return None
    start = max(match.start() - 20, 0)
    snippet = re.sub(r"\s+", " ", cv_text[start:match.end() + 20]).strip()
    return f"cv-span:{match.start()}:{snippet[:60]}"


def cv_language_support(language: str, cv_text: str) -> str | None:
    """A CV line naming the language with proficiency wording, else None."""
    if not cv_text:
        return None
    pattern = LANG_PATTERNS.get(language)
    if not pattern:
        return None
    proficiency = re.compile(
        r"\b(basic|intermediate|upper|advanced|fluent|fluency|proficient|proficiency|"
        r"native|professional working|working knowledge|b1|b2|c[12]|spoken)\b",
        re.IGNORECASE,
    )
    for line in cv_text.splitlines():
        if pattern.search(line) and proficiency.search(line):
            snippet = re.sub(r"\s+", " ", line).strip()
            return f"cv-span:line:{snippet[:60]}"
    return None


def extract_mandatory_criteria(desc: str, job: dict) -> list[dict]:
    """Extract assessable mandatory criterion records with exact JD quotes.

    Preferred sentences never become mandatory criteria. Language and
    work-authorization wording becomes a criterion only when it appears in a
    mandatory-flagged sentence or is itself explicit requirement language.
    """
    if not desc:
        return []
    criteria: list[dict] = []
    seen: set[tuple] = set()

    def add(criterion: dict):
        key = (criterion["kind"], criterion.get("language"), tuple(sorted(criterion.get("terms", []))))
        if key not in seen and len(criteria) < 12:
            seen.add(key)
            criteria.append(criterion)

    for index, sent in enumerate(_sentences(desc)):
        if NICE_TO_HAVE_MARKERS.search(sent):
            continue
        mandatory = bool(MANDATORY_MARKERS.search(sent))
        quote = sent[:400]
        if mandatory:
            sent_lower = sent.lower()
            terms: set[str] = set()
            for term in REQUIREMENT_VOCAB:
                if re.search(r"\b" + re.escape(term) + r"\b", sent_lower):
                    terms.add(term)
            for pattern in (
                r"experience (?:with|in)\s+([a-zA-Z][\w\s./+#-]{1,40}?)(?=[,;.]|\sand\s|\sor\s|$)",
                r"knowledge of\s+([a-zA-Z][\w\s./+#-]{1,40}?)(?=[,;.]|\sand\s|\sor\s|$)",
            ):
                for match in re.finditer(pattern, sent, re.IGNORECASE):
                    token = match.group(1).strip().lower()
                    if 2 < len(token) < 50:
                        terms.add(token)
            if terms:
                add({
                    "id": f"c{index}-{len(criteria)}",
                    "kind": "skill",
                    "terms": sorted(terms),
                    "requirement": quote,
                })
        for language, pattern in LANG_PATTERNS.items():
            mandatory_language = (
                pattern.search(sent)
                and (mandatory or re.search(r"\b(fluent|fluency|proficient|proficiency|mandatory|required)\b", sent, re.IGNORECASE))
                and not re.search(r"\b(non[- ]native|not (fluent|required)|nice)\b", sent, re.IGNORECASE)
            )
            if mandatory_language:
                add({"id": f"c{index}-{len(criteria)}", "kind": "language", "language": language, "requirement": quote})
        if AUTHORISATION_RE.search(sent) and (
            mandatory
            or AUTHORISATION_NEGATIVE_RE.search(sent)
            or re.search(r"\b(candidates? (without|from)|applicants? (without|from))\b", sent, re.IGNORECASE)
        ):
            add({
                "id": f"c{index}-{len(criteria)}",
                "kind": "authorization",
                "requirement": quote,
                "country": job.get("country_code") or job.get("countryCode"),
                "no_sponsorship": bool(AUTHORISATION_NEGATIVE_RE.search(sent)),
            })
    return criteria


def extract_preferred_items(desc: str) -> list[str]:
    """Preferred/nice-to-have items (display + `nice_to_have` counts only)."""
    if not desc:
        return []
    items: list[str] = []
    for sent in _sentences(desc):
        if not NICE_TO_HAVE_MARKERS.search(sent):
            continue
        sent_lower = sent.lower()
        for term in REQUIREMENT_VOCAB:
            if re.search(r"\b" + re.escape(term) + r"\b", sent_lower):
                if term not in items:
                    items.append(term)
    return items[:8]


def evaluate_criterion(criterion: dict, evidence: dict) -> tuple[str, str | None]:
    """Return ('matched', ref) only with explicit CV/cache evidence; else unknown."""
    kind = criterion["kind"]
    cache = evidence.get("cache", {})
    cv_text = evidence.get("cv", {}).get("text", "")
    if kind == "skill":
        for term in criterion.get("terms", []):
            span = find_cv_span(term, cv_text)
            if span:
                return "matched", f"{span} (cv sha {evidence['cv'].get('sha256', 'none')[:12]})"
            if term in cache.get("skills", set()):
                return "matched", f"cache:skills:{term}"
        return "unknown", None
    if kind == "language":
        language = criterion["language"]
        if language in cache.get("languages", set()):
            return "matched", f"cache:languages:{language}"
        span = cv_language_support(language, cv_text)
        if span:
            return "matched", f"{span} (cv sha {evidence['cv'].get('sha256', 'none')[:12]})"
        return "unknown", None
    if kind == "authorization":
        value = cache_authorisation(cache.get("data"), criterion.get("country"))
        if value == "yes" and not criterion.get("no_sponsorship"):
            return "matched", f"cache:workAuthorization:{criterion.get('country')}=yes"
        return "unknown", None
    return "unknown", None


def criterion_is_blocker(criterion: dict, evidence: dict) -> bool:
    """A mandatory requirement that explicit evidence contradicts, or a mandatory
    language the evidence base cannot support. Only called for unresolved criteria.
    Unknown authorization never blocks; unknown language keeps the frozen safety rule."""
    if criterion["kind"] == "language":
        return True  # unresolved mandatory language keeps the frozen safety behavior
    if criterion["kind"] == "authorization" and criterion.get("no_sponsorship"):
        value = cache_authorisation(evidence.get("cache", {}).get("data"), criterion.get("country"))
        return value == "no"
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
    evidence: dict | None = None,
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

    evidence = evidence or build_evidence()
    title_matcher = evidence.get("title_match") or TITLE_MATCH
    title_match = bool(title_matcher.search(title))

    criteria = extract_mandatory_criteria(desc, job)
    blockers: list[str] = []
    for criterion in criteria:
        status, ref = evaluate_criterion(criterion, evidence)
        criterion["status"] = status
        if status == "matched" and ref:
            criterion["evidence"] = ref
        if status == "unknown" and criterion_is_blocker(criterion, evidence):
            if criterion["kind"] == "language":
                blockers.append(f"Language blocker ({criterion['language']} required without supporting CV/cache evidence)")
            else:
                blockers.append(
                    f"Work-authorization conflict: {criterion['requirement'][:120]} "
                    f"(cache workAuthorization for {criterion.get('country')} = no)"
                )
    total = len(criteria)
    matched = [c for c in criteria if c["status"] == "matched"]
    unknown = [c for c in criteria if c["status"] == "unknown"]
    skill_criteria = [c for c in criteria if c["kind"] == "skill"]

    if BUILDING_ARCH_TITLE.search(title):
        blockers.append("Role mismatch (building/construction architect)")

    if total == 0:
        fit_score = 0.0
        assessment_status = "insufficient_evidence"
    else:
        fit_score = round(len(matched) / total * 100.0, 1)
        assessment_status = "assessed"
    ratio = len(matched) / total if total else 0.0
    language_blockers = [b for b in blockers if b.startswith("Language blocker")]

    if role_label == "Out of scope":
        blockers.append(f"Role family blocker (Out of scope): {role_reason}")
    has_blocker = bool(blockers)
    # The application threshold is score-driven. Adjacent titles are tailoring
    # signals only; they do not veto a score of 60 or higher.
    cta = "Apply" if (assessment_status == "assessed" and fit_score >= 60 and not has_blocker) else "Skip"

    # Stretch label — DB CHECK values only (see SKILL.md)
    if has_blocker or assessment_status != "assessed":
        stretch = "Blocked"
    elif title_match and ratio >= 0.8:
        stretch = "Core fit"
    elif title_match and ratio >= 0.5:
        stretch = "Stretch"
    elif not title_match:
        stretch = "Major domain stretch"
    else:
        stretch = "Major cloud stretch"

    tailoring: list[str] = []
    if require_title_match and not title_match:
        tailoring.append(f"Title '{title}' is adjacent to the target role tier — emphasize transferable architecture evidence")
    if unknown:
        summary = ", ".join(
            (c.get("language") or c.get("kind") or "?") if c["kind"] != "skill"
            else "/".join(c.get("terms", [])[:3])
            for c in unknown[:5]
        )
        tailoring.append(f"CV lacks {len(unknown)} of {total} mandatory criteria (evidence unknown): {summary}")
    if assessment_status == "assessed":
        tailoring_effort = (
            "high" if ratio < 0.5 else "medium" if len(matched) < total else "low"
        )
    else:
        tailoring_effort = "high"

    matched_must = [
        f"Requirement '{c['requirement'][:160]}' — {c['evidence']}" for c in matched
    ]
    missing_must = [
        f"Requirement '{c['requirement'][:160]}' — evidence unknown (not counted as matched)"
        for c in unknown
    ]

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

    preferred = extract_preferred_items(desc)
    preferred_matched = [
        item for item in preferred
        if find_cv_span(item, evidence.get("cv", {}).get("text", ""))
        or item in evidence.get("cache", {}).get("skills", set())
    ]
    provenance = {
        "scorer_version": SCORER_VERSION,
        "cv": {"path": evidence["cv"]["path"], "sha256": evidence["cv"]["sha256"]},
        "cache": {"path": evidence["cache"]["path"], "sha256": evidence["cache"]["sha256"]},
        "taxonomy": {"source": evidence["taxonomy"]["source"], "sha256": evidence["taxonomy"]["sha256"]},
    }

    return {
        "search_id": search_id,
        "source": job.get("source"),
        "job_id": job.get("job_id"),
        "fit_score": fit_score,
        "assessment_status": assessment_status,
        "score_display": "insufficient_evidence (no assessable mandatory criteria)"
        if assessment_status != "assessed" else f"{fit_score}%",
        "cta": cta,
        "stretch_label": stretch,
        "role_family_inferred": role_label,
        "role_family_confidence": classification.get("confidence"),
        "role_family_reason": role_reason_json,
        "must_have_total": total,
        "must_have_matched": len(matched),
        "tech_stack_total": len(skill_criteria),
        "tech_stack_matched": sum(1 for c in skill_criteria if c["status"] == "matched"),
        "mandatory_skills_found_json": json.dumps(criteria),
        "mandatory_skills_matched_json": json.dumps(matched),
        "nice_to_have_total": len(preferred),
        "nice_to_have_matched": len(preferred_matched),
        "has_language_blocker": 1 if language_blockers else 0,
        "has_country_mismatch": 0,
        "has_work_mode_mismatch": 0,
        "tailoring_effort": tailoring_effort,
        "matched_must_haves_json": json.dumps(matched_must),
        "missing_or_unclear_must_haves_json": json.dumps(
            [{"schemaVersion": 1, "assessment_status": "insufficient_evidence",
              "reason": "no_assessable_mandatory_criteria"}] + missing_must
            if assessment_status != "assessed" else missing_must
        ),
        "matched_nice_to_haves_json": json.dumps(preferred_matched),
        "tailoring_suggestions_json": json.dumps(tailoring),
        "blockers_json": json.dumps(blockers),
        "evidence_provenance": provenance,
    }


def slug(value: str, fallback: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return normalized[:32] or fallback


def deterministic_search_id(jobs: list[dict], evidence: dict, require_title: bool) -> str:
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
            "description": job_description(job),
        } for job in jobs),
        key=lambda job: (str(job["source"] or ""), str(job["job_id"] or "")),
    )
    payload = {
        "scorer_version": SCORER_VERSION,
        "target_role": target_role,
        "require_title": require_title,
        "cv_sha256": evidence["cv"].get("sha256") or "none",
        "cache_sha256": evidence["cache"].get("sha256") or "none",
        "taxonomy_sha256": evidence["taxonomy"].get("sha256"),
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

    explicit_cache = os.environ.get("SCORE_CACHE_PATH")
    if explicit_cache and not Path(explicit_cache).is_file():
        print(
            f"WARNING: SCORE_CACHE_PATH {explicit_cache} unresolved; "
            "no fallback is applied and cache-backed evidence stays unknown.",
            file=sys.stderr,
        )
    cache_path = resolve_cache_path(explicit_cache)
    if cache_path is None and explicit_cache:
        explicit_cache = None  # invalid explicit cache: evidence stays unknown
    evidence = build_evidence(cv_path, cache_path)

    jobs = json.loads(Path(jobs_path).read_text())
    if isinstance(jobs, dict) and isinstance(jobs.get("jobs"), list):
        jobs = jobs["jobs"]
    if not isinstance(jobs, list):
        sys.exit("Jobs JSON must contain an array of jobs")
    search_id = deterministic_search_id(jobs, evidence, require_title)
    jobs_to_score = jobs_unscored_for_search(jobs, search_id)
    classifications = classify_jobs(jobs_to_score)
    print(f"Search ID: {search_id}", file=sys.stderr)
    print(
        f"Evidence: cv={Path(cv_path).name} sha {evidence['cv'].get('sha256', 'none')[:12]} "
        f"cache={evidence['cache']['path'] or 'none'} taxonomy={evidence['taxonomy']['source']}",
        file=sys.stderr,
    )
    print(f"Scoring {len(jobs_to_score)} of {len(jobs)} jobs (require_title={require_title}) ...", file=sys.stderr)
    scored = [
        score_job(j, require_title_match=require_title, search_id=search_id,
                  role_classification=classification, evidence=evidence)
        for j, classification in zip(jobs_to_score, classifications)
    ]
    apply = sum(1 for s in scored if s["cta"] == "Apply")
    skip = len(scored) - apply
    insufficient = sum(1 for s in scored if s["assessment_status"] != "assessed")
    print(f"Apply: {apply}  Skip: {skip}  Insufficient-evidence rows: {insufficient}", file=sys.stderr)
    print("\nTop Apply jobs:", file=sys.stderr)
    by_id = {(j.get("source"), j.get("job_id")): j for j in jobs}
    for s in sorted([x for x in scored if x["cta"] == "Apply"], key=lambda x: -x["fit_score"])[:10]:
        j = by_id.get((s["source"], s["job_id"]), {})
        print(f"  {s['score_display']} | {j.get('title','')} | {j.get('company','')} | {s['stretch_label']}", file=sys.stderr)
    Path(output_path).write_text(json.dumps(scored, indent=2))
    print(f"\nWrote {output_path} ({len(scored)} scores)", file=sys.stderr)


if __name__ == "__main__":
    main()
