#!/usr/bin/env python3
"""Inline scoring template for unscored jobs. Use when the unscored queue exceeds
~15 jobs (a leaf subagent times out around 40+ jobs on a 600s leaf budget).

The script builds ONE evidence bundle per pass from the installing user's profile
(jh_profile.load_profile: curated cache + CV-derived profile + generic reference
data) and scores every job against that bundle. It never assumes that a candidate
holds a skill, language, or work authorization: a requirement counts as matched only
when a literal span of the parsed CV or an explicit cache field supports it. The
generic technology vocabulary recognizes requirement terms in a job description; it
is never possession evidence. There is no built-in role, skill, or language default:
when no profile can be loaded the scorer exits with the loader's message (code 2).

Scoring: fit_score = matched mandatory criteria / total mandatory criteria * 100,
computed from actual criterion records. Preferred ("nice to have") items never enter
the mandatory denominator. A job with no assessable mandatory criteria is reported as
insufficient evidence (fit_score 0, cta Skip, stretch_label Blocked, zero counts, and
an `assessment_status: insufficient_evidence` marker in the evidence JSON), never as
a fabricated 100%.

Profile-driven values:
  target roles      rolePreferences.preferredPrimaryRoles (+ adjacent/leadership)
                    from personal-info-cache.json, or CV title lines when absent
  title exclusions  generic families from title-exclusions.json selected by the
                    user's roles plus rolePreferences.excludedTitleFamilies
  languages         every language in language-aliases.json is recognized; support
                    comes from confirmed preferences in the cache `languages` field
  skills            technology-vocabulary.json terms/aliases plus the profile's
                    skill terms are recognized; possession needs a CV span or a
                    cache `skills` entry
  Apply threshold   applicationPreferences.fitScoreThreshold (loader default 60)
The derived profile is rebuilt automatically whenever CV.docx changes, and the
search id embeds the profile provenance so a refreshed CV invalidates prior ids.

Inputs (paths can be overridden via env vars):
  $JOBHUNTER_HOME        profile home (default ~/.job-hunter): CV.docx,
                         personal-info-cache.json, profile-derived.json
  $SCORE_CV_PATH         CV override (default $JOBHUNTER_HOME/CV.docx)
  $SCORE_JOBS_PATH       default: /tmp/jobs-to-score.json
  $SCORE_OUTPUT_PATH     default: /tmp/scores.json
  $SCORE_CACHE_PATH      explicit personal-cache override. When set, only this file is
                         used; if missing or unparseable, cache evidence stays unknown
                         (no silent fallback to the home cache).
  $SCORE_REQUIRE_TITLE   default: "0" — retained CLI compatibility; "1" adds an
                         adjacent-title tailoring note but never vetoes a
                         score-driven Apply decision.
  $SCORE_TARGET_ROLE     default: the first three primary roles of the profile
                         joined by "; " (also used in the search ID).
  $SCORE_SEARCH_ID       optional explicit override. Without it, the script derives
                         one stable ID from the target role, country scope, profile
                         provenance (CV, cache, extractor, derived timestamp),
                         reference-data identity, scorer version, and canonical job
                         payload (description-precedence text).

Usage:
  python3 score_jobs_inline.py
  SCORE_TARGET_ROLE="Platform Architect; Cloud Architect" python3 score_jobs_inline.py
"""
from __future__ import annotations

import hashlib
import html
import json
import os
import re
import subprocess
import sys
sys.dont_write_bytecode = True  # importing jh_profile must not leave __pycache__ in the skill tree
import zipfile
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))
import jh_profile  # noqa: E402  (Python twin of jh-profile.mjs)
from jh_profile import ProfileError  # noqa: E402

SCORER_VERSION = "inline-v4"
_DATA_DIR = _HERE.parents[1] / "job-hunter" / "data"
_REFERENCE_FILES = ("technology-vocabulary.json", "language-aliases.json", "title-exclusions.json")
_UNUSABLE_LEVELS = {"none", "no", "false", "a1", "a2", "basic", "beginner", "elementary"}

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
CLASSIFIER_CLI = _HERE.parents[1] / "job-hunter" / "scripts" / "role-classifier-cli.mjs"


# ---------------------------------------------------------------------------
# Reference-data helpers (generic; nothing here names a person's skills)
# ---------------------------------------------------------------------------

def reference_data_sha256() -> str:
    """Identity of the bundled reference files (vocabulary, languages, exclusions)."""
    digest = hashlib.sha256()
    for name in _REFERENCE_FILES:
        digest.update((_DATA_DIR / name).read_bytes())
    return digest.hexdigest()


def phrase_pattern(phrase: str) -> str:
    """Regex source for a phrase whose edges may be symbols (c++, .net, c#).

    Mirrors termPattern() in jh-profile-extract.mjs: a non-term character (or the
    text edge) is required on both sides and inner whitespace is flexible.
    """
    escaped = r"\s+".join(re.escape(part) for part in phrase.split())
    return r"(?<![\w+#.])" + escaped + r"(?![\w+#])"


def build_requirement_vocab(profile: dict) -> dict:
    """Recognition vocabulary: every generic term and alias UNION profile skill terms.

    Returns {"terms": set, "canonical": {alias: term}, "regex": compiled}. Membership
    means "this phrase names a requirement"; it carries NO possession claim.
    """
    canonical: dict[str, str] = {}
    for entry in profile["reference"]["vocabulary"].get("terms", []):
        term = str(entry.get("term", "")).strip().lower()
        if not term:
            continue
        canonical.setdefault(term, term)
        for alias in entry.get("aliases") or []:
            alias = str(alias).strip().lower()
            if alias:
                canonical.setdefault(alias, term)
    for term in profile.get("skillTerms", []) + [entry['term'] for entry in profile.get('certifications', [])]:
        canonical.setdefault(term, term)
    terms = set(canonical)
    ordered = sorted(terms, key=lambda t: (-len(t), t))  # longest phrase wins
    regex = re.compile(
        r"(?<![\w+#.])(?:" + "|".join(r"\s+".join(re.escape(p) for p in t.split()) for t in ordered) + r")(?![\w+#])",
        re.IGNORECASE,
    ) if ordered else re.compile(r"(?!x)x")
    return {"terms": terms, "canonical": canonical, "regex": regex}


def recognized_terms(text: str, vocab: dict) -> set[str]:
    """Vocabulary phrases present in `text` (lower-cased, whitespace-normalized)."""
    found: set[str] = set()
    for match in vocab["regex"].finditer(text):
        found.add(re.sub(r"\s+", " ", match.group(0).lower()))
    return found


def build_language_patterns(reference_languages: dict) -> dict[str, re.Pattern[str]]:
    """Word-bounded alias regex for EVERY language in language-aliases.json."""
    patterns: dict[str, re.Pattern[str]] = {}
    for name, aliases in reference_languages.get("languages", {}).items():
        alts = [phrase_pattern(alias) for alias in aliases if alias] or [phrase_pattern(name.lower())]
        patterns[name] = re.compile("(?:" + "|".join(alts) + ")", re.IGNORECASE)
    return patterns


def build_proficiency_pattern(reference_languages: dict) -> re.Pattern[str]:
    """Proficiency wording that supports a language: only levels the data file
    lists as usable (a "basic"/"A1" line is recognized, never counted)."""
    usable = set(reference_languages.get("usableLevels", []))
    words: list[str] = []
    for level, level_words in reference_languages.get("proficiencyLevels", {}).items():
        if level in usable:
            words.append(level)
            words.extend(level_words)
    if not words:
        return re.compile(r"(?!x)x")
    return re.compile("(?:" + "|".join(phrase_pattern(w) for w in sorted(set(words), key=lambda w: (-len(w), w))) + ")", re.IGNORECASE)


# ---------------------------------------------------------------------------
# Profile-backed possession evidence (explicit cache fields or CV spans only)
# ---------------------------------------------------------------------------

def profile_supported_languages(profile: dict) -> dict[str, str]:
    """Languages the profile supports with an evidence reference.

    A CV-derived language counts when its level is not in the unusable set; a cache
    entry counts as long as its level is not explicitly unusable. Nothing is inferred
    from residence or nationality.
    """
    supported: dict[str, str] = {}
    for entry in profile.get("languages", []):
        level = str(entry.get("level", "unspecified")).lower()
        if level in _UNUSABLE_LEVELS:
            continue
        name = entry["name"]
        if entry.get("source") == "cache":
            supported[name] = f"cache:languages:{name}"
        elif entry.get("evidence"):
            supported[name] = str(entry["evidence"])
        else:
            supported[name] = f"profile:languages:{name}"
    return supported


def profile_skill_evidence(profile: dict) -> dict[str, str]:
    """Skill term → evidence reference (CV span or explicit cache entry)."""
    evidence: dict[str, str] = {}
    for skill in profile.get("skills", []) + profile.get('certifications', []):
        term = str(skill.get("term", "")).lower()
        if not term:
            continue
        if skill.get("source") == "cache":
            evidence[term] = f"cache:skills:{term}"
        else:
            evidence[term] = str(skill.get("evidence") or f"profile:skills:{term}")
    return evidence


def cache_authorisation(work_authorization: dict | None, country: str | None) -> str | None:
    """Return 'yes'/'no'/None — only from explicit cache values for the job country."""
    if not work_authorization or not country:
        return None
    key = country.strip().upper()
    value = None
    if isinstance(work_authorization, dict):
        for name, entry in work_authorization.items():
            if str(name).strip().upper() == key:
                value = entry
                break
    elif isinstance(work_authorization, list):
        return "yes" if any(str(item).strip().upper() == key for item in work_authorization) else None
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"yes", "true", "required", "granted", "have", "holder"}:
            return "yes"
        if lowered in {"no", "false", "none", "not held", "no permit"}:
            return "no"
    return None


def build_title_match(titles: list[str]) -> re.Pattern[str] | None:
    """Build a title matcher from profile role titles, allowing spacing or hyphens."""
    patterns = []
    for title in titles:
        words = re.findall(r"[a-z0-9]+", title.lower())
        if words:
            patterns.append(r"\b" + r"[\s\-–—/,]+".join(re.escape(word) for word in words) + r"\b")
    return re.compile("(?:" + "|".join(patterns) + ")", re.IGNORECASE) if patterns else None


def title_exclusion(rules: dict, title: str) -> str | None:
    """Reason text when a title falls in an excluded family or literal phrase.

    A family excludes a title when one of its titleTerms phrases matches and none of
    its exemptTerms phrases does; a literal phrase always excludes.
    """
    text = (title or "").lower()

    def contains(phrase: str) -> bool:
        return re.search(r"(?<![\w])" + r"\s+".join(re.escape(p) for p in phrase.lower().split()) + r"(?![\w])", text) is not None

    for family in rules.get("families", []):
        if any(contains(term) for term in family.get("titleTerms", [])) and not any(
            contains(term) for term in family.get("exemptTerms", [])
        ):
            return f"{family['name']}: {family.get('summary') or 'excluded title family'}"
    for literal in rules.get("literals", []):
        if contains(literal):
            return f'excluded title phrase "{literal}"'
    return None


def default_target_role(profile: dict) -> str:
    return "; ".join(role for role in profile["roles"]["primary"][:3] if isinstance(role, str) and role.strip())


def build_evidence(profile: dict | None = None, cv_path: str | None = None, cache_path: str | None = None) -> dict:
    """Collect one evidence bundle for a scoring pass (profile loaded/refreshed once).

    Raises ProfileError when no profile can be loaded: there is no built-in role,
    skill, or language default to fall back to.
    """
    if profile is None:
        profile = jh_profile.load_profile(
            cv_path=cv_path, cache_path=cache_path, log=lambda line: print(line, file=sys.stderr)
        )
    provenance = profile["provenance"]
    cv_file = provenance.get("cvPath")
    cv_text = extract_cv_text(cv_file) if cv_file and Path(cv_file).is_file() else ""
    cache_file = Path(cache_path) if cache_path else Path(profile["home"]) / "personal-info-cache.json"
    cache_present = cache_file.is_file()
    reference_sha = reference_data_sha256()
    titles = list(profile["roles"]["all"])
    taxonomy_sha = hashlib.sha256(
        json.dumps(sorted(t.lower() for t in titles), ensure_ascii=False).encode()
    ).hexdigest()[:12]
    languages = profile["reference"]["languages"]
    return {
        "scorer_version": SCORER_VERSION,
        "profile": profile,
        "cv": {"path": cv_file, "sha256": provenance.get("cvSha256"), "text": cv_text},
        "cache": {
            "path": str(cache_file) if cache_present else None,
            "sha256": provenance.get("cacheSha256") if cache_present else None,
            "data": profile.get("cache") or {},
        },
        "taxonomy": {"source": profile["roles"]["source"], "titles": titles, "sha256": taxonomy_sha},
        "title_match": build_title_match(titles),
        "exclusion_rules": jh_profile.title_exclusion_rules(profile),
        "vocab": build_requirement_vocab(profile),
        "language_patterns": build_language_patterns(languages),
        "proficiency_re": build_proficiency_pattern(languages),
        "languages": profile_supported_languages(profile),
        "skills": profile_skill_evidence(profile),
        "work_authorization": profile.get("workAuthorization") or {},
        "fit_threshold": profile.get("fitThreshold", jh_profile.DEFAULT_FIT_THRESHOLD),
        "default_target_role": default_target_role(profile),
        "reference_sha256": reference_sha,
        "provenance": {
            "scorer_version": SCORER_VERSION,
            "cv": {"path": cv_file, "sha256": provenance.get("cvSha256")},
            "cache": {
                "path": str(cache_file) if cache_present else None,
                "sha256": provenance.get("cacheSha256") if cache_present else None,
            },
            "taxonomy": {"source": profile["roles"]["source"], "sha256": taxonomy_sha},
            # `refreshed` is deliberately absent: identical inputs must yield
            # identical rows whether or not this pass triggered the extraction.
            "profile": {
                "status": provenance.get("status"),
                "cvSha256": provenance.get("cvSha256"),
                "cacheSha256": provenance.get("cacheSha256") if cache_present else None,
                "extractorVersion": provenance.get("extractorVersion"),
                "derivedGeneratedAt": provenance.get("derivedGeneratedAt"),
                "referenceDataSha256": reference_sha,
            },
        },
    }


def job_description(job: dict) -> str:
    """Return JD evidence without falling back to query/search metadata."""
    for field in ("description", "description_text"):
        value = job.get(field)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def classify_jobs(jobs: list[dict], taxonomy: dict | None = None) -> list[dict]:
    """Classify a batch through the shared JavaScript taxonomy."""
    if not jobs:
        return []
    payload = [
        {
            "title": job.get("title") or "",
            "descriptionText": job_description(job),
            "jobFunction": job.get("jobFunction") or job.get("job_function") or "",
            "industries": job.get("industries") or "",
            "taxonomy": taxonomy or None,
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
    return jh_profile.extract_docx_text(path)


def _sentences(desc: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?;])\s+|\n", desc) if s.strip()]


def find_cv_span(term: str, cv_text: str) -> str | None:
    """Literal CV span for a requirement term (possession evidence)."""
    if not cv_text:
        return None
    match = re.search(phrase_pattern(term), cv_text, re.IGNORECASE)
    if not match:
        return None
    start = max(match.start() - 20, 0)
    snippet = re.sub(r"\s+", " ", cv_text[start:match.end() + 20]).strip()
    return f"cv-span:{match.start()}:{snippet[:60]}"


def cv_language_support(language: str, cv_text: str, evidence: dict) -> str | None:
    """A CV line naming the language with proficiency wording, else None."""
    if not cv_text:
        return None
    pattern = evidence.get("language_patterns", {}).get(language)
    proficiency = evidence.get("proficiency_re")
    if not pattern or not proficiency:
        return None
    for line in cv_text.splitlines():
        if pattern.search(line) and proficiency.search(line):
            snippet = re.sub(r"\s+", " ", line).strip()
            return f"cv-span:line:{snippet[:60]}"
    return None


def extract_mandatory_criteria(desc: str, job: dict, evidence: dict) -> list[dict]:
    """Extract assessable mandatory criterion records with exact JD quotes.

    Preferred sentences never become mandatory criteria. Language and
    work-authorization wording becomes a criterion only when it appears in a
    mandatory-flagged sentence or is itself explicit requirement language.
    """
    if not desc:
        return []
    criteria: list[dict] = []
    seen: set[tuple] = set()
    vocab = evidence["vocab"]
    language_patterns = evidence["language_patterns"]

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
            terms: set[str] = recognized_terms(sent, vocab)
            for pattern in (
                r"experience (?:with|in)\s+([a-zA-Z][\w\s./+#-]{1,40}?)(?=[,;.]|\sand\s|\sor\s|$)",
                r"knowledge of\s+([a-zA-Z][\w\s./+#-]{1,40}?)(?=[,;.]|\sand\s|\sor\s|$)",
            ):
                for match in re.finditer(pattern, sent, re.IGNORECASE):
                    token = re.sub(r'\s+(?:is\s+)?(?:required|mandatory|essential|needed).*$', '', match.group(1).strip().lower())
                    if 2 < len(token) < 50:
                        terms.add(token)
            if terms:
                add({
                    "id": f"c{index}-{len(criteria)}",
                    "kind": "skill",
                    "terms": sorted(terms),
                    "requirement": quote,
                })
            elif not any(pattern.search(sent) for pattern in language_patterns.values()) and not AUTHORISATION_RE.search(sent):
                add({"id": f"c{index}-{len(criteria)}", "kind": "skill", "terms": [sent.strip().lower()], "requirement": quote})
        for language, pattern in language_patterns.items():
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


def extract_preferred_items(desc: str, evidence: dict) -> list[str]:
    """Preferred/nice-to-have items (display + `nice_to_have` counts only)."""
    if not desc:
        return []
    items: list[str] = []
    for sent in _sentences(desc):
        if not NICE_TO_HAVE_MARKERS.search(sent):
            continue
        for term in sorted(recognized_terms(sent, evidence["vocab"])):
            if term not in items:
                items.append(term)
    return items[:8]


def skill_evidence_ref(term: str, evidence: dict) -> str | None:
    """Possession evidence for one requirement term: CV span or explicit cache entry."""
    cv = evidence.get("cv", {})
    span = find_cv_span(term, cv.get("text", ""))
    if span:
        return f"{span} (cv sha {(cv.get('sha256') or 'none')[:12]})"
    skills = evidence.get("skills", {})
    canonical = evidence.get("vocab", {}).get("canonical", {}).get(term, term)
    for candidate in (term, canonical):
        ref = skills.get(candidate)
        if ref:
            return ref if ref.startswith("cache:") else f"{ref} (cv sha {(cv.get('sha256') or 'none')[:12]})"
    return None


def evaluate_criterion(criterion: dict, evidence: dict) -> tuple[str, str | None]:
    """Return ('matched', ref) only with explicit CV/cache evidence; else unknown."""
    kind = criterion["kind"]
    cv_text = evidence.get("cv", {}).get("text", "")
    if kind == "skill":
        for term in criterion.get("terms", []):
            ref = skill_evidence_ref(term, evidence)
            if ref:
                return "matched", ref
        return "unknown", None
    if kind == "language":
        language = criterion["language"]
        ref = evidence.get("languages", {}).get(language)
        if ref:
            return "matched", ref
        return "unknown", None
    if kind == "authorization":
        value = cache_authorisation(evidence.get("work_authorization"), criterion.get("country"))
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
        value = cache_authorisation(evidence.get("work_authorization"), criterion.get("country"))
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
    evidence = evidence or build_evidence()
    classification = role_classification or classify_jobs([job], evidence['profile']['taxonomy'])[0]
    role_label = classification["label"]
    role_reason = role_reason_text(classification)
    # jobs.role_family_reason is an existing structured TEXT field populated by
    # discovery with the shared classifier's reason object. Keep that shape so
    # scorer output can flow through the existing jobs-field integration path.
    role_reason_json = json.dumps(classification.get("reason") or {}, sort_keys=True)

    evidence = evidence or build_evidence()
    title_matcher = evidence.get("title_match")
    title_match = bool(title_matcher and title_matcher.search(title))
    fit_threshold = evidence.get("fit_threshold", jh_profile.DEFAULT_FIT_THRESHOLD)

    criteria = extract_mandatory_criteria(desc, job, evidence)
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

    exclusion = title_exclusion(evidence.get("exclusion_rules", {}), title)
    if exclusion:
        blockers.append(f"Role mismatch ({exclusion})")

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
    if role_label in ("Unclassified", "Conditional"):
        blockers.append('Role preferences need review: no confirmed role matches this title')
    has_blocker = bool(blockers)
    # The application threshold is score-driven (profile fitThreshold). Adjacent
    # titles are tailoring signals only; they do not veto a score at or above it.
    cta = "Apply" if (assessment_status == "assessed" and fit_score >= fit_threshold and not has_blocker) else "Skip"

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

    preferred = extract_preferred_items(desc, evidence)
    preferred_matched = [item for item in preferred if skill_evidence_ref(item, evidence)]
    provenance = json.loads(json.dumps(evidence["provenance"]))
    provenance["fit_threshold"] = fit_threshold

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

    target_role = os.environ.get("SCORE_TARGET_ROLE") or evidence.get("default_target_role", "")
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
    profile_provenance = evidence["provenance"]["profile"]
    payload = {
        "scorer_version": SCORER_VERSION,
        "target_role": target_role,
        "require_title": require_title,
        "cv_sha256": evidence["cv"].get("sha256") or "none",
        "cache_sha256": evidence["cache"].get("sha256") or "none",
        "taxonomy_sha256": evidence["taxonomy"].get("sha256"),
        "extractor_version": profile_provenance.get("extractorVersion") or "none",
        "derived_generated_at": profile_provenance.get("derivedGeneratedAt") or "none",
        "reference_sha256": evidence.get("reference_sha256") or "none",
        "fit_threshold": evidence.get("fit_threshold"),
        "jobs": canonical_jobs,
    }
    digest = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()[:12]
    role_part = slug(target_role, "targeted")
    country_part = "-".join(countries).lower() or "global"
    return f"score-{role_part}-{country_part}-{digest}"


def main():
    cv_path = os.environ.get("SCORE_CV_PATH") or None
    jobs_path = os.environ.get("SCORE_JOBS_PATH", "/tmp/jobs-to-score.json")
    output_path = os.environ.get("SCORE_OUTPUT_PATH", "/tmp/scores.json")
    require_title = os.environ.get("SCORE_REQUIRE_TITLE", "0") == "1"

    if cv_path and not Path(cv_path).exists():
        sys.exit(f"CV not found: {cv_path}")
    if not Path(jobs_path).exists():
        sys.exit(f"Jobs JSON not found: {jobs_path}")

    explicit_cache = os.environ.get("SCORE_CACHE_PATH") or None
    if explicit_cache and not Path(explicit_cache).is_file():
        print(
            f"WARNING: SCORE_CACHE_PATH {explicit_cache} unresolved; "
            "no fallback is applied and cache-backed evidence stays unknown.",
            file=sys.stderr,
        )
    try:
        # An explicit-but-missing cache path is passed through unchanged so the
        # loader sees no cache (never the home cache): evidence stays unknown.
        evidence = build_evidence(cv_path=cv_path, cache_path=explicit_cache)
        if evidence['profile']['confirmation']['state'] != 'confirmed':
            raise ProfileError('PROFILE_REVIEW_REQUIRED', 'Review and confirm preferences with the user before scoring')
    except ProfileError as exc:
        print(f"{exc.code}: {exc}", file=sys.stderr)
        sys.exit(2)

    jobs = json.loads(Path(jobs_path).read_text())
    if isinstance(jobs, dict) and isinstance(jobs.get("jobs"), list):
        jobs = jobs["jobs"]
    if not isinstance(jobs, list):
        sys.exit("Jobs JSON must contain an array of jobs")
    search_id = deterministic_search_id(jobs, evidence, require_title)
    jobs_to_score = jobs_unscored_for_search(jobs, search_id)
    classifications = classify_jobs(jobs_to_score, evidence["profile"].get("taxonomy"))
    print(f"Search ID: {search_id}", file=sys.stderr)
    profile_provenance = evidence["provenance"]["profile"]
    print(
        f"Evidence: cv={Path(evidence['cv']['path']).name if evidence['cv']['path'] else 'none'} "
        f"sha {(evidence['cv'].get('sha256') or 'none')[:12]} "
        f"cache={evidence['cache']['path'] or 'none'} roles={evidence['taxonomy']['source']} "
        f"profile={profile_provenance.get('status')}"
        f"{' (refreshed)' if evidence['profile']['provenance'].get('refreshed') else ''} "
        f"threshold={evidence['fit_threshold']}",
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
