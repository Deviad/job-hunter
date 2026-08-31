#!/usr/bin/env python3
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).with_name("score_jobs_inline.py")
CLI = SCRIPT.parents[2] / "job-hunter" / "scripts" / "role-classifier-cli.mjs"
MODULE_HOME = tempfile.TemporaryDirectory()
os.environ["JOBHUNTER_HOME"] = MODULE_HOME.name
spec = importlib.util.spec_from_file_location("score_jobs_inline", SCRIPT)
scorer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scorer)


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


def score(case):
    classification = scorer.classify_jobs([case])[0]
    return scorer.score_job(case, search_id="score-test", role_classification=classification)


cases = [
    {
        "name": "cached adjacent title matches",
        "job": {
            "source": "test",
            "job_id": "adjacent-60",
            "title": "ML Platform Lead",
            "description": "Lead technical direction for ML products.",
        },
        "label": "Adjacent technical",
        "fit_score": 60.0,
        "cta": "Apply",
    },
    {
        "name": "out of scope is a role-family skip",
        "job": {
            "source": "test",
            "job_id": "out-of-scope",
            "title": "Data Scientist",
            "description": "Research machine learning models and publish findings.",
        },
        "label": "Out of scope",
        "cta": "Skip",
        "blocker": "Role family blocker (Out of scope)",
    },
    {
        "name": "data-domain stretch remains eligible and discloses gaps",
        "job": {
            "source": "test",
            "job_id": "data-stretch",
            "title": "Data & AI Architect",
            "description": "Design AI architecture; data modelling and Databricks are secondary responsibilities.",
        },
        "label": "Data-domain stretch",
        "cta": "Apply",
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
        "cta": "Apply",
        "missing": "Leadership evaluation:",
        "tailoring": "Leadership evaluation:",
        "reason_field": "technicalOwnership",
    },
]

for case in cases:
    result = score(case["job"])
    if case["name"] == "cached adjacent title matches":
        gated_compat = scorer.score_job(
            case["job"], require_title_match=True, role_classification=scorer.classify_jobs([case["job"]])[0]
        )
        assert gated_compat["fit_score"] == 60.0
        assert gated_compat["cta"] == "Apply"
    assert result["role_family_inferred"] == case["label"], case["name"]
    if "fit_score" in case:
        assert result["fit_score"] == case["fit_score"], case["name"]
    assert result["cta"] == case["cta"], case["name"]
    if "blocker" in case:
        assert any(case["blocker"] in value for value in json.loads(result["blockers_json"])), case["name"]
    if "missing" in case:
        assert any(case["missing"] in value for value in json.loads(result["missing_or_unclear_must_haves_json"])), case["name"]
    if "tailoring" in case:
        assert any(case["tailoring"] in value for value in json.loads(result["tailoring_suggestions_json"])), case["name"]
    if "reason_field" in case:
        role_reason = json.loads(result["role_family_reason"])
        assert case["reason_field"] in role_reason, case["name"]

fallback = {
    "source": "test",
    "job_id": "description-fallback",
    "title": "Enterprise Architect",
    "description": "",
    "description_text": "Own ERP architecture.",
    "query": "AI Architect",
}
fallback_result = score(fallback)
assert fallback_result["role_family_inferred"] == "Out of scope"
assert "AI Architect" not in fallback_result["role_family_reason"]

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

MODULE_HOME.cleanup()
print(f"score_jobs_inline tests: PASS ({len(cases)} table cases + fallback/filter/bridge parity)")
