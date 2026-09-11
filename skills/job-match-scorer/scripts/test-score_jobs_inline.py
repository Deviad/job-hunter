#!/usr/bin/env python3
"""Direct-invocation tests for score_jobs_inline.py (inline-v3).

Every scoring assertion runs the real scorer against real DOCX fixtures parsed by
the real extractor, with classifications from the real shared classifier CLI.
Evidence is synthetic ("Testerson" profile, tool list, and cache); no personal
CV, cache, or network access is used.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

SCRIPT = Path(__file__).with_name("score_jobs_inline.py")
CLI = SCRIPT.parents[2] / "job-hunter" / "scripts" / "role-classifier-cli.mjs"
MODULE_HOME = tempfile.TemporaryDirectory()
os.environ["JOBHUNTER_HOME"] = MODULE_HOME.name
spec = importlib.util.spec_from_file_location("score_jobs_inline", SCRIPT)
scorer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scorer)

FIXTURES = tempfile.TemporaryDirectory()
FIXTURE_PATH = Path(FIXTURES.name)


def make_docx(name: str, text: str) -> str:
    """Build a minimal valid DOCX whose word/document.xml the extractor parses."""
    paragraphs = "".join(
        f'<w:p><w:r><w:t xml:space="preserve">{line}</w:t></w:r></w:p>'
        for line in text.splitlines()
    )
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{paragraphs}</w:body></w:document>"
    )
    path = FIXTURE_PATH / name
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("[Content_Types].xml", "<types/>")
        archive.writestr("word/document.xml", document)
    return str(path)


def title_match_in_home(home: Path, title: str) -> bool:
    env = os.environ.copy()
    env["JOBHUNTER_HOME"] = str(home)
    probe = (
        "import importlib.util, sys; "
        "spec = importlib.util.spec_from_file_location('scorer', sys.argv[1]); "
        "module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); "
        "raise SystemExit(0 if module.TITLE_MATCH.search(sys.argv[2]) else 1)"
    )
    completed = subprocess.run(
        [sys.executable, "-c", probe, str(SCRIPT), title],
        env=env,
        check=False,
    )
    return completed.returncode == 0


with tempfile.TemporaryDirectory() as temp_home:
    home = Path(temp_home)
    (home / "personal-info-cache.json").write_text(
        json.dumps({"rolePreferences": {"preferredPrimaryRoles": ["Head of AI Platform"]}}),
        encoding="utf-8",
    )
    assert title_match_in_home(home, "Head of AI Platform")

with tempfile.TemporaryDirectory() as empty_home:
    assert title_match_in_home(Path(empty_home), "AI Architect")


CV_A_TEXT = (
    "Solutions Architect — 12 years designing cloud and data platforms.\n"
    "Tech: Python, Kubernetes, Kafka, Terraform, Azure.\n"
    "Languages: English (fluent), Italian (native)."
)
CV_B_TEXT = (
    "Solutions Architect — 12 years designing cloud and data platforms.\n"
    "Tech: Power BI, SAP, Excel.\n"
    "Languages: English (fluent), Italian (native)."
)
CV_A = make_docx("synthetic-profile-a.docx", CV_A_TEXT)
CV_B = make_docx("synthetic-profile-b.docx", CV_B_TEXT)
CACHE_FULL = FIXTURE_PATH / "synthetic-cache-full.json"
CACHE_FULL.write_text(
    json.dumps({
        "languages": {"English": "fluent", "Italian": "native"},
        "skills": ["terraform", "sap"],
        "workAuthorization": {"SE": "yes", "DE": "no"},
        "rolePreferences": {"preferredPrimaryRoles": ["AI Solution Architect"]},
    }),
    encoding="utf-8",
)

EVIDENCE_NONE = scorer.build_evidence()
EVIDENCE_A = scorer.build_evidence(CV_A, str(CACHE_FULL))
EVIDENCE_B = scorer.build_evidence(CV_B, str(CACHE_FULL))

assert "Python" in scorer.extract_cv_text(CV_A)
assert "Python" not in scorer.extract_cv_text(CV_B)


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


def score(case, evidence=None, **kwargs):
    classification = scorer.classify_jobs([case["job"]])[0]
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
    cache_backed = score(job, scorer.build_evidence(CV_A, str(CACHE_FULL)))
    # synthetic cache lists SAP, so the same requirement may resolve via explicit cache
    assert cache_backed["must_have_matched"] == 1
    assert cache_backed["matched_must_haves_json"].count("cache:skills:sap") == 1
    span_backed = score(job, scorer.build_evidence(CV_B, None))
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

    def full_run():
        evidence = scorer.build_evidence(CV_A, str(CACHE_FULL))
        classification = scorer.classify_jobs([job["job"]])[0]
        first = scorer.score_job(job["job"], search_id="x", role_classification=classification, evidence=evidence)
        identity = scorer.deterministic_search_id([job["job"]], evidence, False)
        return first, identity

    (run_a, id_a) = full_run()
    (run_b, id_b) = full_run()
    assert json.dumps(run_a, sort_keys=True) == json.dumps(run_b, sort_keys=True)
    assert id_a == id_b
    # Changing the CV bytes invalidates the derived identity (evidence is in the ID).
    other_evidence = scorer.build_evidence(CV_B, str(CACHE_FULL))
    assert scorer.deterministic_search_id([job["job"]], other_evidence, False) != id_a
    # Changing cache bytes likewise invalidates it.
    no_cache = scorer.build_evidence(CV_A, None)
    assert scorer.deterministic_search_id([job["job"]], no_cache, False) != id_a
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
    assert "100" not in json.dumps(result)
    invariant_check(result)
    print("ok test_unassessable_job_is_not_a_fake_percentage")


for fn in (
    test_only_cv_supported_skill_matches,
    test_preferred_skill_does_not_change_denominator,
    test_missing_evidence_is_unknown,
    test_equal_inputs_produce_equal_evidence,
    test_unassessable_job_is_not_a_fake_percentage,
):
    fn()


# ---------------------------------------------------------------------------
# Retained behavioral proofs (recalibrated expectations under inline-v3):
# classification labels, blocker carriage, leadership/data-gap facts, and
# requirement-vs-preference handling must survive; the old fixed-five-boolean
# percentages were the defect and are intentionally not reproduced.
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
        "label": "Adjacent technical",
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
        "name": "data-domain stretch discloses gaps",
        "job": {
            "source": "test",
            "job_id": "data-stretch",
            "title": "Data & AI Architect",
            "description": "Design AI architecture for lending products; data modelling and Databricks are secondary responsibilities. Hands-on experience with Databricks required.",
        },
        "label": "Data-domain stretch",
        "cta": "Skip",
        "missing": "Data-domain stretch gaps:",
        "tailoring": "Data-domain stretch:",
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
        "reason_field": "technicalOwnership",
    },
]

for case in cases:
    result = score(case, {"A": EVIDENCE_A}.get(case.get("evidence")))
    gated_compat = scorer.score_job(
        case["job"], require_title_match=True, search_id="evidence-test",
        role_classification=scorer.classify_jobs([case["job"]])[0],
        evidence={"A": EVIDENCE_A}.get(case.get("evidence")) or EVIDENCE_NONE,
    )
    if case["name"].startswith("adjacent title"):
        assert gated_compat["cta"] == "Apply", "adjacency must not veto an evidence-driven Apply"
        assert any("adjacent to the target role tier" in note for note in json.loads(gated_compat["tailoring_suggestions_json"]))
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

print("ok retained behavioral proofs recalibrated")

# ---------------------------------------------------------------------------
# Retained language-safety + authorization-unknownness proofs
# ---------------------------------------------------------------------------

language_job = {
    "job": {
        "source": "test", "job_id": "lang-german", "title": "AI Solution Architect",
        "description": "Fluent German required for client workshops. Experience with Python required.",
    },
}
without_support = score(language_job)
assert any("Language blocker" in blocker for blocker in json.loads(without_support["blockers_json"]))
assert without_support["has_language_blocker"] == 1
assert without_support["cta"] == "Skip"
FIXTURE_PATH.joinpath("german-cache.json").write_text(
    json.dumps({"languages": ["English", "German"]}), encoding="utf-8"
)
with_support = score(language_job, scorer.build_evidence(CV_A, str(FIXTURE_PATH / "german-cache.json")))
assert json.loads(with_support["blockers_json"]) == [], with_support["blockers_json"]
assert with_support["has_language_blocker"] == 0

auth_job = {
    "job": {
        "source": "test", "job_id": "auth-de", "title": "AI Solution Architect",
        "country_code": "DE",
        "description": "Candidates without work authorization may not apply (no sponsorship available). Experience with Kafka required.",
    },
}
unknown_auth = score(auth_job)
assert json.loads(unknown_auth["blockers_json"]) == [], "unknown authorization must not be inferred into a blocker"
criteria = json.loads(unknown_auth["mandatory_skills_found_json"])
auth_criteria = [c for c in criteria if c["kind"] == "authorization"]
assert len(auth_criteria) == 1 and auth_criteria[0]["status"] == "unknown"
assert unknown_auth["must_have_matched"] == 0 and unknown_auth["must_have_total"] == 2
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
assert fallback_result["role_family_inferred"] == "Out of scope"
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
assert alias_result["label"] == "Exact architecture"
assert alias_result["reason"]["queryUsedAsEvidence"] is False

print("ok fallback, filter, bridge parity, alias proofs")

# ---------------------------------------------------------------------------
# End-to-end CLI proof: real process, real DOCX, explicit cache contract
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
    "SCORE_CV_PATH": CV_A,
    "SCORE_JOBS_PATH": str(jobs_file),
    "SCORE_OUTPUT_PATH": str(out_ok),
    "SCORE_CACHE_PATH": str(CACHE_FULL),
    "SCORE_TARGET_ROLE": "AI Architect",
})
env_ok.pop("SCORE_SEARCH_ID", None)
completed = subprocess.run([sys.executable, str(SCRIPT)], env=env_ok, capture_output=True, text=True)
assert completed.returncode == 0, completed.stderr
assert "Insufficient-evidence rows: 1" in completed.stderr
rows = json.loads(out_ok.read_text())
by_id = {row["job_id"]: row for row in rows}
assert by_id["cli-insufficient"]["fit_score"] == 0.0
assert by_id["cli-insufficient"]["assessment_status"] == "insufficient_evidence"
assert by_id["cli-python"]["must_have_total"] == 2 and by_id["cli-python"]["must_have_matched"] == 1
assert by_id["cli-german"]["has_language_blocker"] == 1
assert by_id["cli-german"]["cta"] == "Skip"
assert all(row["fit_score"] >= 60 for row in rows if row["cta"] == "Apply")
assert "Search ID: score-" in completed.stderr  # derived identity present

out_bad = FIXTURE_PATH / "scores-bad-cache.json"
env_bad = env_ok.copy()
env_bad["SCORE_CACHE_PATH"] = str(FIXTURE_PATH / "missing-cache.json")
env_bad["SCORE_OUTPUT_PATH"] = str(out_bad)
completed_bad = subprocess.run([sys.executable, str(SCRIPT)], env=env_bad, capture_output=True, text=True)
assert completed_bad.returncode == 0
assert "SCORE_CACHE_PATH" in completed_bad.stderr and "unknown" in completed_bad.stderr
bad_rows = json.loads(out_bad.read_text())
assert all(row["evidence_provenance"]["cache"]["path"] is None for row in bad_rows)
assert all("cache:" not in row["matched_must_haves_json"] for row in bad_rows)
print("ok end-to-end CLI evidence contract")

print("ALL SCORE-JOB TESTS PASSED")
