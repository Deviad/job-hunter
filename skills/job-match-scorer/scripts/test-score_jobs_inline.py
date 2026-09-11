#!/usr/bin/env python3
"""Direct-invocation tests for score_jobs_inline.py (inline-v4).

Every scoring assertion runs the real scorer against real DOCX fixtures parsed by
the real profile extractor (jh_profile → node jh-profile-extract.mjs), with
classifications from the real shared classifier CLI. Evidence is synthetic
("Testerson" profiles, tool lists, and caches built in temporary JOBHUNTER_HOME
directories); no personal CV, cache, or network access is used.

Run from the repository root:
    python3 skills/job-match-scorer/scripts/test-score_jobs_inline.py
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
sys.dont_write_bytecode = True

SCRIPT = Path(__file__).with_name("score_jobs_inline.py")
SCRIPTS_DIR = SCRIPT.parent
CLI = SCRIPT.parents[2] / "job-hunter" / "scripts" / "role-classifier-cli.mjs"
DERIVED_FILE = "profile-derived.json"

FIXTURES = tempfile.TemporaryDirectory()
FIXTURE_PATH = Path(FIXTURES.name)

# Generic AI-architecture taxonomy for the synthetic primary profile. The role
# classifier is profile-driven, so the fixture cache carries its own taxonomy.
TAXONOMY = json.loads(r'''{"schemaVersion":1,"name":"ai-architect","domainTokens":["ai","artificial intelligence","gen ai","genai","generative ai","agentic ai","agentic","llm","large language model","machine learning","ml","ml platform","mlops"],"disciplineTokens":["architect","architecture","system design","systems design","production architecture","platform decisions","technical direction","technical strategy","design authority","architectural decisions","architecture ownership","engineering standards"],"adjacentTitles":["principal ai engineer","staff ai engineer","lead ai engineer","principal applied ai engineer","staff applied ai engineer","lead applied ai engineer","principal ml engineer","staff ml engineer","lead ml engineer","ai technical lead","ai engineering lead","ai platform lead","principal ai platform engineer","staff ai platform engineer","lead ai platform engineer","ml platform lead","mlops architect","ai enablement architect"],"leadershipTitles":["engineering manager","senior engineering manager","head of ai","head of ai engineering","head of ai platform","director of ai","director of ai engineering","director of ai platform","ai engineering director","ai platform director","vp of ai","vp of ai engineering","vp of ai platform","solutions architecture manager","technical delivery manager"],"gapSkills":[{"name":"data modelling","pattern":"\\bdata modell?ing\\b"},{"name":"data governance","pattern":"\\bdata governance\\b"},{"name":"lakehouse","pattern":"\\blakehouse\\b"},{"name":"data warehouse","pattern":"\\bdata warehouse(?:s|ing)?\\b"},{"name":"Spark","pattern":"\\b(?:apache )?spark\\b|\\bpyspark\\b"},{"name":"Databricks","pattern":"\\bdatabricks\\b"},{"name":"Snowflake","pattern":"\\bsnowflake\\b"}],"gapRoleTitlePattern":"\\b(?:data and ai|ai and data|data ai|ai data) architect\\b","conditionalTerms":["pre-sales","presales","post-sales","sales engineering","commercial","solutions consultant","solution consultant","security specialist","security lead","responsible ai","ai governance","governance lead","governance manager","strategy lead","ai strategy","risk and compliance"],"queryExpansions":["AI Architect","AI/ML Architect","Generative AI Architect","GenAI Architect","Agentic AI Architect","LLM Architect","Enterprise AI Architect","AI Platform Architect","AI Solutions Architect","Applied AI Architect","Forward Deployed Architect","Forward Deployed Engineer","AI Customer Engineer","AI Field Engineer","AI Integration Architect","AI Infrastructure Architect","Principal AI Architect","Principal AI Engineer","Staff AI Engineer","Lead AI Engineer","Applied AI Engineer","AI Technical Lead","AI Engineering Lead","AI Platform Lead","ML Platform Lead","MLOps Architect","AI Enablement Architect","Data & AI Architect","Engineering Manager AI/ML","Engineering Manager AI Platform","Head of AI Engineering","Head of AI Platform","Director of AI Engineering","Solutions Architecture Manager AI","Technical Delivery Manager AI","AI Pre-Sales Solutions Architect","AI Security Specialist","AI Governance Lead","AI Strategy Lead"],"queryExclusionTerms":["software engineer","data scientist","research scientist"],"excludedTitleFamilies":["building-architecture","sales","product-management","data-specialist"]}''')

CV_A_TEXT = (
    "Alex Testerson\n"
    "Solutions Architect | Example Corp | 2014 – 2026\n"
    "Tech: Python, Kubernetes, Kafka, Terraform, Azure.\n"
    "Languages\n"
    "Italian: native\n"
    "English (fluent)"
)
CV_B_TEXT = (
    "Alex Testerson\n"
    "Solutions Architect | Example Corp | 2014 – 2026\n"
    "Tech: Power BI, SAP, Excel.\n"
    "Languages\n"
    "Italian: native\n"
    "English (fluent)"
)
CV_GERMAN_B2_TEXT = CV_A_TEXT + "\nGerman: B2 (upper intermediate)"
CV_GERMAN_BASIC_TEXT = CV_A_TEXT + "\nGerman (basic)"
CV_EMBEDDED_TEXT = (
    "Sam Testerson\n"
    "Embedded Software Engineer | Example Devices | 2018 – 2026\n"
    "Firmware in Embedded C and Rust on FreeRTOS; CAN bus diagnostics.\n"
    "Languages\n"
    "Dutch: native\n"
    "English (fluent)"
)


def docx_bytes(text: str) -> bytes:
    """Minimal valid DOCX whose word/document.xml the extractors parse."""
    paragraphs = "".join(
        f'<w:p><w:r><w:t xml:space="preserve">{line}</w:t></w:r></w:p>'
        for line in text.splitlines()
    )
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{paragraphs}</w:body></w:document>"
    )
    import io
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("[Content_Types].xml", "<types/>")
        archive.writestr("word/document.xml", document)
    return buffer.getvalue()


def make_docx(path: Path, text: str) -> str:
    path.write_bytes(docx_bytes(text))
    return str(path)


def make_home(name: str, cv_text: str | None, cache: dict | None) -> Path:
    home = FIXTURE_PATH / name
    home.mkdir(parents=True, exist_ok=True)
    if cv_text is not None:
        make_docx(home / "CV.docx", cv_text)
    if cache is not None:
        (home / "personal-info-cache.json").write_text(json.dumps(cache), encoding="utf-8")
    return home


PRIMARY_CACHE = {
    "schemaVersion": 2,
    "languages": {"Italian": "native"},
    "skills": ["terraform", "sap"],
    "workAuthorization": {"SE": "yes", "DE": "no"},
    "rolePreferences": {
        "preferredPrimaryRoles": ["AI Solution Architect", "AI Architect", "Solutions Architect"],
        "excludedTitleFamilies": ["building-architecture"],
        "queryExclusionTerms": ["Data Scientist"],
        "adjacentRoles": {
            "adjacentTechnicalLeadership": ["ML Platform Lead", "AI Technical Lead"],
            "leadershipProgression": ["Engineering Manager", "Head of AI Platform"],
        },
        "taxonomy": TAXONOMY,
    },
}
# Same roles/taxonomy, but no curated skills, languages, or authorization.
BARE_CACHE = {
    "schemaVersion": 2,
    "rolePreferences": PRIMARY_CACHE["rolePreferences"],
}

HOME_A = make_home("home-a", CV_A_TEXT, PRIMARY_CACHE)
HOME_BARE = make_home("home-bare", CV_A_TEXT, BARE_CACHE)
os.environ["JOBHUNTER_HOME"] = str(HOME_A)

spec = importlib.util.spec_from_file_location("score_jobs_inline", SCRIPT)
scorer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scorer)
jh_profile = scorer.jh_profile

CV_A = str(HOME_A / "CV.docx")
CV_B = make_docx(FIXTURE_PATH / "synthetic-profile-b.docx", CV_B_TEXT)
CACHE_FULL = HOME_A / "personal-info-cache.json"
CACHE_BARE = HOME_BARE / "personal-info-cache.json"


def evidence_for(home: Path, cv_path: str | None = None, cache_path: str | None = None) -> dict:
    profile = jh_profile.load_profile(home=str(home), cv_path=cv_path, cache_path=cache_path, log=lambda _: None)
    return scorer.build_evidence(profile=profile, cv_path=cv_path, cache_path=cache_path)


assert scorer.SCORER_VERSION == "inline-v4"
for banned in ("REQUIREMENT_VOCAB", "LANG_PATTERNS", "FALLBACK_TITLE_MATCH", "ROLE_PREFERENCES",
               "TITLE_MATCH", "PREFERRED_PRIMARY_ROLES", "BUILDING_ARCH_TITLE", "DEFAULT_TARGET_ROLE",
               "load_role_preferences"):
    assert not hasattr(scorer, banned), f"maintainer-specific constant still present: {banned}"
assert "AI Architect" not in (scorer.__doc__ or "")

EVIDENCE_A = scorer.build_evidence()  # default home (HOME_A), first extraction
assert EVIDENCE_A["profile"]["provenance"]["refreshed"] is True
assert (HOME_A / DERIVED_FILE).is_file()
EVIDENCE_B = evidence_for(HOME_A, cv_path=CV_B, cache_path=str(CACHE_FULL))
EVIDENCE_NONE = evidence_for(HOME_BARE)  # CV_A text, but no curated skills/languages/authorization

assert "Python" in scorer.extract_cv_text(CV_A)
assert "Python" not in scorer.extract_cv_text(CV_B)
assert EVIDENCE_A["title_match"].search("AI Solution Architect")
assert EVIDENCE_A["title_match"].search("Head of AI Platform")
assert not EVIDENCE_A["title_match"].search("Field Application Engineer")
assert EVIDENCE_A["fit_threshold"] == 60
assert EVIDENCE_A["default_target_role"] == "AI Solution Architect; AI Architect; Solutions Architect"
# Generic vocabulary is recognition-only: terms and aliases are present even when
# the profile holds none of them.
assert {"langgraph", "amazon web services", "aws", "python"} <= EVIDENCE_A["vocab"]["terms"]
assert EVIDENCE_A["vocab"]["canonical"]["amazon web services"] == "aws"
assert "langgraph" not in EVIDENCE_A["skills"]
assert EVIDENCE_A["skills"]["python"].startswith("cv-span:")
assert EVIDENCE_A["skills"]["sap"] == "cache:skills:sap"
assert set(EVIDENCE_A["language_patterns"]) == set(jh_profile.load_reference_data()["languages"]["languages"])


def invariant_check(result):
    """fit_score must equal recomputed criterion counts; never a fake percentage."""
    total = result["must_have_total"]
    matched = result["must_have_matched"]
    assert 0 <= matched <= total, result["job_id"]
    if total == 0:
        assert result["fit_score"] == 0.0
        assert result["assessment_status"] == "insufficient_evidence"
        assert result["stretch_label"] == "Blocked"
        assert result["cta"] == "Skip"
    else:
        assert result["fit_score"] == round(matched / total * 100.0, 1), (
            result["job_id"], result["fit_score"], matched, total
        )
    assert 0 <= result["tech_stack_matched"] <= result["tech_stack_total"] <= total
    assert "100" not in result["score_display"] or result["must_have_matched"] > 0
    provenance = result["evidence_provenance"]
    assert provenance["scorer_version"] == "inline-v4"
    assert provenance["profile"]["extractorVersion"] == jh_profile.EXTRACTOR_VERSION
    assert provenance["profile"]["referenceDataSha256"]


def score(case, evidence=None, classification=None, **kwargs):
    classification = classification or scorer.classify_jobs([case["job"]], (evidence or EVIDENCE_NONE)['profile']['taxonomy'])[0]
    return scorer.score_job(
        case["job"], search_id="evidence-test",
        role_classification=classification, evidence=evidence or EVIDENCE_NONE, **kwargs
    )


def test_only_cv_supported_skill_matches():
    """Same job, different CV evidence => different scores; matches carry CV spans."""
    job = {
        "name": "only CV-supported skills match",
        "job": {
            "source": "test", "job_id": "ev-python",
            "title": "AI Solution Architect",
            "description": "Strong experience with Python required. Experience with Databricks required.",
        },
    }
    with_a = score(job, EVIDENCE_A)
    with_b = score(job, EVIDENCE_B)
    assert with_a["must_have_total"] == 2, json.dumps(with_a["mandatory_skills_found_json"])
    assert with_a["must_have_matched"] == 1 and with_a["fit_score"] == 50.0, json.dumps(with_a)
    assert with_b["must_have_matched"] == 0 and with_b["fit_score"] == 0.0
    assert with_a["fit_score"] != with_b["fit_score"]
    matched_json = json.dumps(json.loads(with_a["matched_must_haves_json"]))
    assert "Python" in matched_json and "cv-span" in matched_json
    assert "Strong experience with Python required" in matched_json
    missing_b = json.dumps(json.loads(with_b["missing_or_unclear_must_haves_json"]))
    assert "evidence unknown (not counted as matched)" in missing_b and "Databricks" in missing_b
    invariant_check(with_a)
    invariant_check(with_b)
    print("ok test_only_cv_supported_skill_matches")


def test_preferred_skill_does_not_change_denominator():
    """Preferred items never enter the mandatory denominator."""
    job_a = {
        "job": {
            "source": "test", "job_id": "pref-a", "title": "AI Solution Architect",
            "description": "Own event-driven platforms. Experience with Kafka required. Nice to have Terraform.",
        },
    }
    job_b = {
        "job": {
            "source": "test", "job_id": "pref-b", "title": "AI Solution Architect",
            "description": "Own event-driven platforms. Experience with Kafka required.",
        },
    }
    a = score(job_a, EVIDENCE_A)
    b = score(job_b, EVIDENCE_A)
    assert a["must_have_total"] == 1 == b["must_have_total"], (a["must_have_total"], b["must_have_total"])
    assert a["fit_score"] == b["fit_score"] == 100.0, (a["fit_score"], b["fit_score"])
    assert a["cta"] == "Apply" == b["cta"]
    assert json.loads(a["matched_nice_to_haves_json"]) == ["terraform"]
    assert "terraform" not in json.dumps(json.loads(a["mandatory_skills_found_json"]))
    assert a["nice_to_have_total"] == 1 and a["nice_to_have_matched"] == 1
    invariant_check(a)
    invariant_check(b)
    print("ok test_preferred_skill_does_not_change_denominator")


def test_missing_evidence_is_unknown():
    """Absent CV/cache evidence stays unknown: not matched, not a blocker, lowers fit."""
    job = {
        "job": {
            "source": "test", "job_id": "unknown-sap", "title": "AI Solution Architect",
            "description": "Proven experience with SAP required.",
        },
    }
    unknown = score(job, EVIDENCE_NONE)
    assert unknown["must_have_total"] == 1 and unknown["must_have_matched"] == 0, json.dumps(unknown)
    assert unknown["fit_score"] == 0.0 and unknown["cta"] == "Skip"
    assert json.loads(unknown["blockers_json"]) == []
    criteria = json.loads(unknown["mandatory_skills_found_json"])
    assert criteria[0]["status"] == "unknown" and "evidence" not in criteria[0]
    cache_backed = score(job, EVIDENCE_A)
    # synthetic cache lists SAP, so the same requirement resolves via explicit cache
    assert cache_backed["must_have_matched"] == 1
    assert cache_backed["matched_must_haves_json"].count("cache:skills:sap") == 1
    span_backed = score(job, evidence_for(HOME_BARE, cv_path=CV_B, cache_path=str(CACHE_BARE)))
    assert span_backed["must_have_matched"] == 1 and "cv-span" in span_backed["matched_must_haves_json"]
    invariant_check(unknown)
    invariant_check(cache_backed)
    print("ok test_missing_evidence_is_unknown")


def test_equal_inputs_produce_equal_evidence():
    """Identical inputs produce identical criterion records and search identity."""
    job = {
        "job": {
            "source": "test", "job_id": "determinism", "title": "AI Solution Architect",
            "description": "Strong experience with Python required. Fluent German required.",
            "country_code": "DE",
        },
    }
    home = make_home("home-determinism", CV_A_TEXT, PRIMARY_CACHE)

    def full_run():
        evidence = evidence_for(home)
        classification = scorer.classify_jobs([job["job"]], EVIDENCE_A['profile']['taxonomy'])[0]
        first = scorer.score_job(job["job"], search_id="x", role_classification=classification, evidence=evidence)
        identity = scorer.deterministic_search_id([job["job"]], evidence, False)
        return first, identity, evidence

    (run_a, id_a, evidence_a) = full_run()
    (run_b, id_b, evidence_b) = full_run()
    assert evidence_a["profile"]["provenance"]["refreshed"] is True
    assert evidence_b["profile"]["provenance"]["refreshed"] is False
    assert json.dumps(run_a, sort_keys=True) == json.dumps(run_b, sort_keys=True)
    assert id_a == id_b
    # Changing the CV bytes invalidates the derived identity (profile provenance is in the ID).
    other_evidence = evidence_for(home, cv_path=CV_B)
    assert scorer.deterministic_search_id([job["job"]], other_evidence, False) != id_a
    # Changing cache bytes likewise invalidates it.
    other_cache = evidence_for(home, cv_path=CV_A, cache_path=str(CACHE_BARE))
    assert scorer.deterministic_search_id([job["job"]], other_cache, False) != id_a
    invariant_check(run_a)
    print("ok test_equal_inputs_produce_equal_evidence")


def test_unassessable_job_is_not_a_fake_percentage():
    """A job without assessable mandatory criteria reports insufficient evidence."""
    job = {
        "job": {
            "source": "test", "job_id": "no-criteria", "title": "AI Solution Architect",
            "description": "You may work with a broad modern toolset. Nice to have Terraform.",
        },
    }
    result = score(job, EVIDENCE_A)
    assert result["fit_score"] == 0.0 and result["cta"] == "Skip"
    assert result["stretch_label"] == "Blocked"
    assert result["must_have_total"] == 0 and result["must_have_matched"] == 0
    assert json.loads(result["matched_must_haves_json"]) == []
    missing = json.loads(result["missing_or_unclear_must_haves_json"])
    assert missing[0]["assessment_status"] == "insufficient_evidence"
    assert result["score_display"].startswith("insufficient_evidence")
    assert "100" not in json.dumps({k: v for k, v in result.items() if k != "evidence_provenance"})
    invariant_check(result)
    print("ok test_unassessable_job_is_not_a_fake_percentage")


def test_changed_cv_refreshes_profile_and_search_id():
    """Replacing CV.docx rebuilds the derived profile; ids and criterion evidence change."""
    home = make_home("home-refresh", CV_A_TEXT, PRIMARY_CACHE)
    job = {
        "job": {
            "source": "test", "job_id": "refresh", "title": "AI Solution Architect",
            "description": "Strong experience with Python required.",
        },
    }
    classification = scorer.classify_jobs([job["job"]], EVIDENCE_A['profile']['taxonomy'])[0]
    before = evidence_for(home)
    assert before["profile"]["provenance"]["refreshed"] is True
    derived_before = json.loads((home / DERIVED_FILE).read_text(encoding="utf-8"))
    assert "python" in before["profile"]["skillTerms"]
    id_before = scorer.deterministic_search_id([job["job"]], before, False)
    result_before = scorer.score_job(job["job"], search_id=id_before, role_classification=classification, evidence=before)
    assert result_before["must_have_matched"] == 1 and result_before["cta"] == "Apply"

    # Same CV again: no refresh, same derived bytes, same id.
    again = evidence_for(home)
    assert again["profile"]["provenance"]["refreshed"] is False
    assert scorer.deterministic_search_id([job["job"]], again, False) == id_before

    # New CV uploaded in place: the loader rebuilds the derived profile automatically.
    make_docx(home / "CV.docx", CV_B_TEXT)
    after = evidence_for(home)
    assert after["profile"]["provenance"]["refreshed"] is True
    derived_after = json.loads((home / DERIVED_FILE).read_text(encoding="utf-8"))
    assert derived_after["cvSha256"] != derived_before["cvSha256"]
    assert after["provenance"]["profile"]["cvSha256"] == derived_after["cvSha256"]
    assert "python" not in after["profile"]["skillTerms"] and "sap" in after["profile"]["skillTerms"]
    id_after = scorer.deterministic_search_id([job["job"]], after, False)
    assert id_after != id_before
    result_after = scorer.score_job(job["job"], search_id=id_after, role_classification=classification, evidence=after)
    assert result_after["must_have_matched"] == 0 and result_after["cta"] == "Skip"
    criteria_before = json.loads(result_before["mandatory_skills_found_json"])
    criteria_after = json.loads(result_after["mandatory_skills_found_json"])
    assert criteria_before[0]["status"] == "matched" and criteria_after[0]["status"] == "unknown"
    assert result_before["evidence_provenance"]["cv"]["sha256"] != result_after["evidence_provenance"]["cv"]["sha256"]
    invariant_check(result_before)
    invariant_check(result_after)
    print("ok test_changed_cv_refreshes_profile_and_search_id")


def test_second_profile_has_no_maintainer_terms():
    """An embedded-C profile is scored with its own roles; nothing AI-specific leaks in."""
    home = make_home("home-embedded", CV_EMBEDDED_TEXT, {
        "schemaVersion": 2,
        "languages": {"Dutch": "native"},
        "rolePreferences": {
            "preferredPrimaryRoles": ["Embedded Software Engineer", "Firmware Engineer"],
            "excludedTitleFamilies": ["early-career", "Field Application Engineer"],
        },
    })
    evidence = evidence_for(home)
    assert evidence["taxonomy"]["titles"] == ["Embedded Software Engineer", "Firmware Engineer"]
    assert evidence["default_target_role"] == "Embedded Software Engineer; Firmware Engineer"
    assert evidence["title_match"].search("Senior Firmware Engineer")
    assert not evidence["title_match"].search("AI Architect")
    assert not evidence["title_match"].search("Solutions Architect")
    rules = evidence["exclusion_rules"]
    assert [f["name"] for f in rules["families"]] == ["early-career"], rules
    assert rules["literals"] == ["field application engineer"]
    assert "freertos" in evidence["skills"] and "embedded c" in evidence["skills"]
    assert "python" not in evidence["skills"] and "langgraph" not in evidence["skills"]
    assert evidence["languages"].get("Dutch") == "cache:languages:Dutch"
    assert "English" not in evidence["languages"]  # CV suggestions need confirmation.
    assert "Italian" not in evidence["languages"]

    neutral = {"label": "Exact architecture", "confidence": 0.5, "reason": {"summary": "synthetic classification"}}
    firmware = {
        "job": {
            "source": "test", "job_id": "firmware", "title": "Senior Firmware Engineer",
            "description": "Hands-on experience with FreeRTOS required. Experience with LangGraph required. Fluent Dutch required.",
        },
    }
    result = score(firmware, evidence, classification=neutral)
    criteria = {}
    for c in json.loads(result["mandatory_skills_found_json"]):
        for key in c.get("terms", []) + [c.get("language")]:
            criteria[key] = c
    assert criteria["freertos"]["status"] == "matched" and "cv-span" in criteria["freertos"]["evidence"]
    assert criteria["langgraph"]["status"] == "unknown", "generic vocabulary recognizes LangGraph but the profile cannot match it"
    assert criteria["Dutch"]["status"] == "matched" and criteria["Dutch"]["evidence"] == "cache:languages:Dutch"
    assert result["must_have_total"] == 3 and result["must_have_matched"] == 2
    assert json.loads(result["blockers_json"]) == []
    assert result["cta"] == "Apply" and result["stretch_label"] == "Stretch"
    invariant_check(result)

    # No building-architecture family for a profile without "architect" roles.
    architekt = {"job": {"source": "test", "job_id": "architekt", "title": "Architekt Hochbau",
                         "description": "Experience with Embedded C required."}}
    architekt_result = score(architekt, evidence, classification=neutral)
    assert not any(b.startswith("Role mismatch") for b in json.loads(architekt_result["blockers_json"])), architekt_result["blockers_json"]
    assert architekt_result["stretch_label"] == "Major domain stretch"
    # Curated family and literal exclusions still apply.
    student = {"job": {"source": "test", "job_id": "student", "title": "Werkstudent Embedded Software",
                       "description": "Experience with Embedded C required."}}
    student_blockers = json.loads(score(student, evidence, classification=neutral)["blockers_json"])
    assert any(b.startswith("Role mismatch (early-career") for b in student_blockers), student_blockers
    literal = {"job": {"source": "test", "job_id": "fae", "title": "Field Application Engineer",
                       "description": "Experience with Embedded C required."}}
    literal_blockers = json.loads(score(literal, evidence, classification=neutral)["blockers_json"])
    assert any('excluded title phrase "field application engineer"' in b for b in literal_blockers), literal_blockers
    # Italian is not assumed for this profile even though the primary fixture speaks it.
    italian = {"job": {"source": "test", "job_id": "italian", "title": "Senior Firmware Engineer",
                       "description": "Fluent Italian required. Experience with Rust required."}}
    italian_result = score(italian, evidence, classification=neutral)
    assert italian_result["has_language_blocker"] == 1 and italian_result["cta"] == "Skip"
    print("ok test_second_profile_has_no_maintainer_terms")


def test_missing_profile_fails_loudly():
    """An empty home has no profile: exit 2 with the loader's message, no scores written."""
    empty_home = make_home("home-empty", None, None)
    jobs_file = FIXTURE_PATH / "jobs-empty-home.json"
    jobs_file.write_text(json.dumps([{"source": "test", "job_id": "x", "title": "Solutions Architect",
                                      "description": "Experience with Python required."}]), encoding="utf-8")
    output = FIXTURE_PATH / "scores-empty-home.json"
    env = os.environ.copy()
    env.update({"JOBHUNTER_HOME": str(empty_home), "SCORE_JOBS_PATH": str(jobs_file), "SCORE_OUTPUT_PATH": str(output)})
    for key in ("SCORE_CV_PATH", "SCORE_CACHE_PATH", "SCORE_SEARCH_ID", "SCORE_TARGET_ROLE"):
        env.pop(key, None)
    completed = subprocess.run([sys.executable, str(SCRIPT)], env=env, capture_output=True, text=True)
    assert completed.returncode == 2, (completed.returncode, completed.stderr)
    assert "PROFILE_MISSING" in completed.stderr and "No CV.docx" in completed.stderr, completed.stderr
    assert not output.exists()
    # The library entry point raises the same error instead of inventing defaults.
    try:
        jh_profile.load_profile(home=str(empty_home))
    except jh_profile.ProfileError as exc:
        assert exc.code == "PROFILE_MISSING"
    else:
        raise AssertionError("load_profile must fail for an empty home")
    print("ok test_missing_profile_fails_loudly")


for fn in (
    test_only_cv_supported_skill_matches,
    test_preferred_skill_does_not_change_denominator,
    test_missing_evidence_is_unknown,
    test_equal_inputs_produce_equal_evidence,
    test_unassessable_job_is_not_a_fake_percentage,
    test_changed_cv_refreshes_profile_and_search_id,
    test_second_profile_has_no_maintainer_terms,
    test_missing_profile_fails_loudly,
):
    fn()


# ---------------------------------------------------------------------------
# Retained behavioral proofs: classification labels, blocker carriage,
# leadership/data-gap facts, and requirement-vs-preference handling.
# ---------------------------------------------------------------------------

cases = [
    {
        "name": "adjacent title does not veto evidence-driven Apply",
        "job": {
            "source": "test",
            "job_id": "adjacent-evidence",
            "title": "ML Platform Lead",
            "description": "Lead technical direction for ML products. Strong experience with Python required.",
        },
        "label": "Adjacent role",
        "evidence": "A",
        "cta": "Apply",
        "fit_score": 100.0,
    },
    {
        "name": "out of scope is a role-family skip",
        "job": {
            "source": "test",
            "job_id": "out-of-scope",
            "title": "Data Scientist",
            "description": "Research machine learning models and publish findings. Deep knowledge of molecular biology required.",
        },
        "label": "Out of scope",
        "cta": "Skip",
        "blocker": "Role family blocker (Out of scope)",
    },
    {
        "name": "unconfirmed adjacent title requires review",
        "job": {
            "source": "test",
            "job_id": "data-stretch",
            "title": "Data & AI Architect",
            "description": "Design AI architecture for lending products; data modelling and Databricks are secondary responsibilities. Hands-on experience with Databricks required.",
        },
        "label": "Primary role",
        "cta": "Skip",
        "missing": "evidence unknown",
    },
    {
        "name": "leadership evaluation is carried into score fields",
        "job": {
            "source": "test",
            "job_id": "leadership",
            "title": "Engineering Manager — AI Platform",
            "description": "Lead 8 engineers across two teams. Own platform strategy, technical direction, hiring, and cross-team architecture.",
        },
        "label": "Leadership progression",
        "cta": "Skip",
        "missing": "Leadership evaluation:",
        "tailoring": "Leadership evaluation:",
        "reason_field": "queryUsedAsEvidence",
    },
]

for case in cases:
    result = score(case, {"A": EVIDENCE_A}.get(case.get("evidence")))
    gated_compat = scorer.score_job(
        case["job"], require_title_match=True, search_id="evidence-test",
        role_classification=scorer.classify_jobs([case["job"]], EVIDENCE_A['profile']['taxonomy'])[0],
        evidence={"A": EVIDENCE_A}.get(case.get("evidence")) or EVIDENCE_NONE,
    )
    if case["name"].startswith("adjacent title"):
        assert gated_compat["cta"] == "Apply", "adjacency must not veto an evidence-driven Apply"
        assert result["stretch_label"] == "Core fit", "profile adjacent role titles feed the title matcher"
    assert result["role_family_inferred"] == case["label"], case["name"]
    if "fit_score" in case:
        assert result["fit_score"] == case["fit_score"], (case["name"], result["fit_score"])
    assert result["cta"] == case["cta"], (case["name"], result["cta"])
    if "blocker" in case:
        assert any(case["blocker"] in value for value in json.loads(result["blockers_json"])), case["name"]
    if "missing" in case:
        assert any(case["missing"] in value for value in json.loads(result["missing_or_unclear_must_haves_json"])), (case["name"], result["missing_or_unclear_must_haves_json"])
    if "tailoring" in case:
        assert any(case["tailoring"] in value for value in json.loads(result["tailoring_suggestions_json"])), case["name"]
    if "reason_field" in case:
        role_reason = json.loads(result["role_family_reason"])
        assert case["reason_field"] in role_reason, case["name"]
    invariant_check(result)

# Title exclusions apply only because this fixture explicitly selected the family.
neutral = {"label": "Exact architecture", "confidence": 0.5, "reason": {"summary": "synthetic classification"}}
for title, excluded in (
    ("Architekt (m/w/d) Hochbau", True), ("Interior Architect", True), ("BIM Coordinator", True),
    ("AI Solution Architect", False), ("Cloud Architect", False), ("Account Executive", False),
):
    blockers = json.loads(score({"job": {"source": "test", "job_id": title, "title": title,
                                          "description": "Experience with Python required."}},
                                EVIDENCE_A, classification=neutral)["blockers_json"])
    assert any(b.startswith("Role mismatch (building-architecture") for b in blockers) is excluded, (title, blockers)

# The Apply threshold follows applicationPreferences.fitScoreThreshold.
strict_home = make_home("home-strict", CV_A_TEXT, {**PRIMARY_CACHE, "applicationPreferences": {"fitScoreThreshold": 75}})
strict = evidence_for(strict_home)
assert strict["fit_threshold"] == 75
half = {"job": {"source": "test", "job_id": "half", "title": "AI Solution Architect",
                "description": "Strong experience with Python required. Experience with Databricks required."}}
assert score(half, EVIDENCE_A, classification=neutral)["fit_score"] == 50.0
threshold_row = score(half, strict, classification=neutral)
assert threshold_row["cta"] == "Skip" and threshold_row["evidence_provenance"]["fit_threshold"] == 75
full = {"job": {"source": "test", "job_id": "full", "title": "AI Solution Architect",
                "description": "Strong experience with Python required."}}
assert score(full, strict, classification=neutral)["cta"] == "Apply"
assert scorer.deterministic_search_id([full["job"]], strict, False) != scorer.deterministic_search_id([full["job"]], EVIDENCE_A, False)

print("ok retained behavioral proofs recalibrated")

# ---------------------------------------------------------------------------
# Language-safety + authorization-unknownness proofs. Support for a language is
# never assumed: it must come from a CV line with a usable level or the cache.
# ---------------------------------------------------------------------------

language_job = {
    "job": {
        "source": "test", "job_id": "lang-german", "title": "AI Solution Architect",
        "description": "Fluent German required for client workshops. Experience with Python required.",
    },
}
without_support = score(language_job, EVIDENCE_NONE)
assert any("Language blocker (German" in blocker for blocker in json.loads(without_support["blockers_json"]))
assert without_support["has_language_blocker"] == 1
assert without_support["cta"] == "Skip"
german_cache = FIXTURE_PATH / "german-cache.json"
german_cache.write_text(json.dumps({**BARE_CACHE, "languages": ["German"]}), encoding="utf-8")
with_cache_support = score(language_job, evidence_for(HOME_BARE, cache_path=str(german_cache)))
assert json.loads(with_cache_support["blockers_json"]) == [], with_cache_support["blockers_json"]
assert with_cache_support["has_language_blocker"] == 0
assert "cache:languages:German" in with_cache_support["matched_must_haves_json"]
# CV language evidence stays unconfirmed until saved in the user configuration.
cv_b2 = make_docx(FIXTURE_PATH / "synthetic-german-b2.docx", CV_GERMAN_B2_TEXT)
with_cv_support = score(language_job, evidence_for(HOME_BARE, cv_path=cv_b2, cache_path=str(CACHE_BARE)))
assert with_cv_support["has_language_blocker"] == 1
assert "cv-span:line:German: B2" not in with_cv_support["matched_must_haves_json"]
cv_basic = make_docx(FIXTURE_PATH / "synthetic-german-basic.docx", CV_GERMAN_BASIC_TEXT)
basic_only = score(language_job, evidence_for(HOME_BARE, cv_path=cv_basic, cache_path=str(CACHE_BARE)))
assert basic_only["has_language_blocker"] == 1, basic_only["blockers_json"]
# Languages the profile does support match from either source, and every
# reference language is recognized in job text (here a non-Latin alias).
italian_job = {"job": {"source": "test", "job_id": "lang-italian", "title": "AI Solution Architect",
                       "description": "Fluent Italian required. Experience with Python required."}}
italian_row = score(italian_job, EVIDENCE_A)
assert italian_row["has_language_blocker"] == 0 and "cache:languages:Italian" in italian_row["matched_must_haves_json"]
italian_cv_row = score(italian_job, EVIDENCE_NONE)
assert italian_cv_row["has_language_blocker"] == 1
japanese_job = {"job": {"source": "test", "job_id": "lang-japanese", "title": "AI Solution Architect",
                        "description": "日本語 proficiency required. Experience with Python required."}}
japanese_row = score(japanese_job, EVIDENCE_A)
japanese_criteria = [c for c in json.loads(japanese_row["mandatory_skills_found_json"]) if c["kind"] == "language"]
assert [c["language"] for c in japanese_criteria] == ["Japanese"] and japanese_row["has_language_blocker"] == 1
english_job = {"job": {"source": "test", "job_id": "lang-english", "title": "Senior Firmware Engineer",
                       "description": "Fluent English required. Experience with Rust required."}}
no_english_home = make_home("home-no-english", "Kim Testerson\nFirmware Engineer | Example Devices | 2019 – 2026\nRust and FreeRTOS.\nLanguages\nDutch: native",
                            {"rolePreferences": {"preferredPrimaryRoles": ["Firmware Engineer"]}})
english_row = score(english_job, evidence_for(no_english_home), classification=neutral)
assert english_row["has_language_blocker"] == 1, "English is never assumed"

auth_job = {
    "job": {
        "source": "test", "job_id": "auth-de", "title": "AI Solution Architect",
        "country_code": "DE",
        "description": "Candidates without work authorization may not apply (no sponsorship available). Experience with Kafka required.",
    },
}
unknown_auth = score(auth_job, EVIDENCE_NONE)
assert json.loads(unknown_auth["blockers_json"]) == [], "unknown authorization must not be inferred into a blocker"
criteria = json.loads(unknown_auth["mandatory_skills_found_json"])
auth_criteria = [c for c in criteria if c["kind"] == "authorization"]
assert len(auth_criteria) == 1 and auth_criteria[0]["status"] == "unknown"
assert unknown_auth["must_have_matched"] == 1 and unknown_auth["must_have_total"] == 2
conflict_auth = score(auth_job, EVIDENCE_A)  # synthetic cache: DE work authorization = no
assert any("Work-authorization conflict" in blocker for blocker in json.loads(conflict_auth["blockers_json"]))
assert conflict_auth["cta"] == "Skip"
assert conflict_auth["must_have_total"] == 2 and conflict_auth["must_have_matched"] == 1
support_auth = score(
    {**auth_job, "job": {**auth_job["job"], "country_code": "SE", "description": "Work authorization in Sweden required. Experience with Kafka required."}},
    EVIDENCE_A,  # synthetic cache: SE = yes
)
assert json.loads(support_auth["blockers_json"]) == []
assert support_auth["must_have_matched"] == 2 and support_auth["must_have_total"] == 2
print("ok language-safety and authorization-unknownness")

# ---------------------------------------------------------------------------
# Retained fallback-description, bridge-parity, and alias proofs (unchanged)
# ---------------------------------------------------------------------------

fallback = {
    "source": "test",
    "job_id": "description-fallback",
    "title": "Enterprise Architect",
    "description": "",
    "description_text": "Own ERP architecture.",
    "query": "AI Architect",
}
fallback_result = score({"job": fallback})
assert fallback_result["role_family_inferred"] == "Unclassified"
assert "AI Architect" not in fallback_result["role_family_reason"]
invariant_check(fallback_result)

search_id = "score-current"
filter_cases = [
    {"job_id": "other", "scored_search_ids": ["score-other"]},
    {"job_id": "current", "scored_search_ids": [search_id]},
    {"job_id": "nested", "match_results": [{"search_id": search_id}]},
    {"job_id": "new"},
]
assert [job["job_id"] for job in scorer.jobs_unscored_for_search(filter_cases, search_id)] == ["other", "new"]

bridge_input = [case["job"] for case in cases]
bridge_payload = [
    {"title": job.get("title", ""), "descriptionText": scorer.job_description(job)}
    for job in bridge_input
]
completed = subprocess.run(
    ["node", str(CLI)],
    input=json.dumps(bridge_payload),
    text=True,
    capture_output=True,
    check=True,
)
cli_results = json.loads(completed.stdout)
python_results = scorer.classify_jobs(bridge_input)
assert [result["label"] for result in python_results] == [result["label"] for result in cli_results]
assert [result["confidence"] for result in python_results] == [result["confidence"] for result in cli_results]
assert [result["reason"] for result in python_results] == [result["reason"] for result in cli_results]

alias_bridge = subprocess.run(
    ["node", str(CLI)],
    input=json.dumps([{
        "title": "AI Architect",
        "description": "Own production AI architecture.",
        "query": "Data Architect",
    }]),
    text=True,
    capture_output=True,
    check=True,
)
alias_result = json.loads(alias_bridge.stdout)[0]
assert alias_result["label"] == "Unclassified"
assert alias_result["reason"]["queryUsedAsEvidence"] is False

print("ok fallback, filter, bridge parity, alias proofs")

# ---------------------------------------------------------------------------
# End-to-end CLI proof: real process, real DOCX in JOBHUNTER_HOME, explicit cache contract
# ---------------------------------------------------------------------------

jobs_file = FIXTURE_PATH / "jobs.json"
jobs_file.write_text(json.dumps([
    {
        "source": "test", "job_id": "cli-insufficient", "title": "AI Solution Architect",
        "description": "You may work with a broad modern toolset.",
    },
    {
        "source": "test", "job_id": "cli-python", "title": "AI Solution Architect",
        "description": "Strong experience with Python required. Experience with Databricks required.",
    },
    {
        "source": "test", "job_id": "cli-german", "title": "AI Solution Architect",
        "description": "Fluent German required. Experience with Python required.",
    },
]), encoding="utf-8")
out_ok = FIXTURE_PATH / "scores-ok.json"
env_ok = os.environ.copy()
env_ok.update({
    "JOBHUNTER_HOME": str(HOME_A),
    "SCORE_JOBS_PATH": str(jobs_file),
    "SCORE_OUTPUT_PATH": str(out_ok),
})
for key in ("SCORE_CV_PATH", "SCORE_CACHE_PATH", "SCORE_SEARCH_ID", "SCORE_TARGET_ROLE"):
    env_ok.pop(key, None)
reviewed = jh_profile.load_profile(home=str(HOME_A))
subprocess.run(['node', str(CLI.parent / 'jh-profile.mjs'), 'confirm', '--home', str(HOME_A), '--expected-profile-sha', reviewed['provenance']['profileSha256']], capture_output=True, text=True, check=True)
completed = subprocess.run([sys.executable, str(SCRIPT)], env=env_ok, capture_output=True, text=True)
assert completed.returncode == 0, json.dumps({'stderr': completed.stderr, 'reviewed': reviewed['provenance']['profileSha256'], 'after': jh_profile.load_profile(home=str(HOME_A))['confirmation']})
assert "Insufficient-evidence rows: 1" in completed.stderr
assert "profile=current" in completed.stderr and "threshold=60" in completed.stderr, completed.stderr
rows = json.loads(out_ok.read_text())
by_id = {row["job_id"]: row for row in rows}
assert by_id["cli-insufficient"]["fit_score"] == 0.0
assert by_id["cli-insufficient"]["assessment_status"] == "insufficient_evidence"
assert by_id["cli-python"]["must_have_total"] == 2 and by_id["cli-python"]["must_have_matched"] == 1
assert by_id["cli-german"]["has_language_blocker"] == 1
assert by_id["cli-german"]["cta"] == "Skip"
assert all(row["fit_score"] >= 60 for row in rows if row["cta"] == "Apply")
assert "Search ID: score-ai-solution-architect-ai-arch" in completed.stderr, completed.stderr  # profile-derived target role
assert all(row["evidence_provenance"]["profile"]["cvSha256"] for row in rows)
assert all(row["evidence_provenance"]["cache"]["path"] == str(CACHE_FULL) for row in rows)

out_bad = FIXTURE_PATH / "scores-bad-cache.json"
env_bad = env_ok.copy()
env_bad["SCORE_CACHE_PATH"] = str(FIXTURE_PATH / "missing-cache.json")
env_bad["SCORE_OUTPUT_PATH"] = str(out_bad)
completed_bad = subprocess.run([sys.executable, str(SCRIPT)], env=env_bad, capture_output=True, text=True)
assert completed_bad.returncode != 0, completed_bad.stderr
assert "ROLES_MISSING" in completed_bad.stderr, completed_bad.stderr
assert not out_bad.exists(), 'missing confirmed preferences must not produce scores'
print("ok end-to-end CLI evidence contract")

for stale in (SCRIPTS_DIR / "__pycache__",):
    shutil.rmtree(stale, ignore_errors=True)
print("ALL SCORE-JOB TESTS PASSED")
