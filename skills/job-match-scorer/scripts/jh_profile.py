"""Python adapter to the authoritative JS profile loader and refresh contract."""
from __future__ import annotations
import sys
sys.dont_write_bytecode = True  # never leave __pycache__ inside the published skill tree
import json
import os
import subprocess
import importlib.util
from pathlib import Path

EXTRACTOR_VERSION = 'cv-v2'
DERIVED_FILE = 'profile-derived.json'
DEFAULT_FIT_THRESHOLD = 60
_SCRIPTS = Path(__file__).resolve().parents[2] / 'job-hunter' / 'scripts'
_DATA = _SCRIPTS.parent / 'data'
_docx_spec = importlib.util.spec_from_file_location('job_hunter_docx', _SCRIPTS / 'docx_text.py')
_docx = importlib.util.module_from_spec(_docx_spec)
_docx_spec.loader.exec_module(_docx)
extract_docx_text = _docx.extract_docx_text

class ProfileError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code

def resolve_home(home=None):
    return Path(home or os.environ.get('JOBHUNTER_HOME') or (Path.home() / '.job-hunter')).expanduser()

def load_reference_data():
    return {key: json.loads((_DATA / name).read_text()) for key, name in [('vocabulary', 'technology-vocabulary.json'), ('languages', 'language-aliases.json'), ('exclusions', 'title-exclusions.json')]}

def _bridge(action, home=None, cv_path=None, cache_path=None, derived_path=None, refresh='auto', require_confirmed=False, log=None):
    argv = ['node', str(_SCRIPTS / 'jh-profile.mjs'), action, '--json', '--home', str(resolve_home(home))]
    for flag, value in [('--cv', cv_path), ('--cache', cache_path), ('--derived', derived_path), ('--refresh', refresh)]:
        if value is not None:
            argv.extend([flag, str(value)])
    if require_confirmed:
        argv.append('--require-confirmed')
    result = subprocess.run(argv, capture_output=True, text=True, check=False)
    if result.returncode and not (action == 'status' and result.returncode == 3):
        detail = result.stderr.strip() or 'profile loader failed'
        last = detail.splitlines()[-1]
        code, _, message = last.partition(': ')
        raise ProfileError(code or 'PROFILE_ERROR', message or detail)
    if log and result.stderr.strip():
        log(result.stderr.strip())
    return json.loads(result.stdout)

def profile_status(home=None, cv_path=None, derived_path=None):
    return _bridge('status', home=home, cv_path=cv_path, derived_path=derived_path)

def load_profile(home=None, cv_path=None, cache_path=None, derived_path=None, refresh='auto', log=None, require_confirmed=False):
    return _bridge('export', home, cv_path, cache_path, derived_path, refresh, require_confirmed, log)

def title_exclusion_rules(profile):
    families = profile['reference']['exclusions']['families']
    selected, literals = [], []
    for entry in profile['excludedTitleFamilies']:
        key = '-'.join(entry.lower().split())
        if key in families:
            selected.append({'name': key, **families[key]})
        else:
            literals.append(entry.lower())
    return {'families': selected, 'literals': literals}

if __name__ == '__main__':
    import sys
    try:
        profile = load_profile(refresh='never' if '--no-refresh' in sys.argv else 'auto')
        print(json.dumps({'status': profile['provenance']['status'], 'confirmation': profile['confirmation'], 'roles': profile['roles'], 'speaks': profile['speaks']}))
    except ProfileError as exc:
        print(f'{exc.code}: {exc}', file=sys.stderr)
        sys.exit(2)
