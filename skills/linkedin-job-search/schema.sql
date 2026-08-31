PRAGMA foreign_keys = ON;

CREATE TABLE jobs (
  source TEXT NOT NULL,
  job_id TEXT NOT NULL,
  url TEXT,
  title TEXT,
  company TEXT,
  description_raw TEXT,
  description_text TEXT,
  location_raw TEXT,
  country_code TEXT,
  region TEXT,
  city TEXT,
  job_posting_date TEXT,
  applicants_raw TEXT,
  applicants_count INTEGER CHECK (applicants_count IS NULL OR applicants_count >= 0),
  application_links_json TEXT,
  recruiter TEXT,
  recruiter_email TEXT,
  recruiter_profile_link TEXT,
  role_family_inferred TEXT,
  role_family_confidence REAL CHECK (
    role_family_confidence IS NULL
    OR (role_family_confidence >= 0 AND role_family_confidence <= 1)
  ),
  role_family_reason TEXT,
  language_filter_reason TEXT,
  work_mode_reason TEXT,
  searched_keywords TEXT,
  searched_location TEXT,
  application_status TEXT NOT NULL DEFAULT 'saved'
    CHECK (application_status IN ('saved', 'applying', 'applied', 'failed', 'withdrawn')),
  applied_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source, job_id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_application_status
ON jobs(application_status, applied_at);

CREATE TRIGGER jobs_touch_updated_at
AFTER UPDATE ON jobs
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE jobs
  SET updated_at = CURRENT_TIMESTAMP
  WHERE source = NEW.source AND job_id = NEW.job_id;
END;

CREATE TABLE job_languages (
  source TEXT NOT NULL,
  job_id TEXT NOT NULL,
  language TEXT NOT NULL,
  importance TEXT NOT NULL CHECK (importance IN ('required', 'nice_to_have')),
  PRIMARY KEY (source, job_id, language, importance),
  FOREIGN KEY (source, job_id) REFERENCES jobs(source, job_id) ON DELETE CASCADE
);

CREATE TABLE job_work_modes (
  source TEXT NOT NULL,
  job_id TEXT NOT NULL,
  work_mode TEXT NOT NULL CHECK (work_mode IN ('onsite', 'hybrid', 'remote')),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  PRIMARY KEY (source, job_id, work_mode),
  FOREIGN KEY (source, job_id) REFERENCES jobs(source, job_id) ON DELETE CASCADE
);

CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  name TEXT,
  default_stretch_tolerance TEXT NOT NULL DEFAULT 'medium' CHECK (
    default_stretch_tolerance IN ('low', 'medium', 'high')
  ),
  current_country_code TEXT,
  current_city TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_countries (
  user_id TEXT NOT NULL,
  country_code TEXT NOT NULL,
  PRIMARY KEY (user_id, country_code),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE user_languages (
  user_id TEXT NOT NULL,
  language TEXT NOT NULL,
  proficiency TEXT NOT NULL CHECK (
    proficiency IN ('basic', 'conversational', 'professional', 'fluent', 'native')
  ),
  PRIMARY KEY (user_id, language),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE resumes (
  resume_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  label TEXT,
  file_path TEXT NOT NULL,
  file_language TEXT,
  parsed_text TEXT,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE search_profiles (
  search_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  resume_id TEXT NOT NULL,
  target_role_input TEXT NOT NULL,
  target_role_confirmed TEXT,
  role_family_suggestions_json TEXT,
  stretch_tolerance_override TEXT CHECK (
    stretch_tolerance_override IS NULL
    OR stretch_tolerance_override IN ('low', 'medium', 'high')
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (resume_id) REFERENCES resumes(resume_id) ON DELETE CASCADE
);

CREATE TABLE match_results (
  search_id TEXT NOT NULL,
  source TEXT NOT NULL,
  job_id TEXT NOT NULL,
  fit_score REAL NOT NULL CHECK (fit_score >= 0 AND fit_score <= 100),
  cta TEXT NOT NULL CHECK (cta IN ('Apply', 'Maybe', 'Skip')),
  stretch_label TEXT NOT NULL CHECK (
    stretch_label IN ('Core fit', 'Stretch', 'Blocked')
  ),
  must_have_total INTEGER NOT NULL DEFAULT 0 CHECK (must_have_total >= 0),
  must_have_matched INTEGER NOT NULL DEFAULT 0 CHECK (
    must_have_matched >= 0 AND must_have_matched <= must_have_total
  ),
  nice_to_have_total INTEGER NOT NULL DEFAULT 0 CHECK (nice_to_have_total >= 0),
  nice_to_have_matched INTEGER NOT NULL DEFAULT 0 CHECK (
    nice_to_have_matched >= 0 AND nice_to_have_matched <= nice_to_have_total
  ),
  has_language_blocker INTEGER NOT NULL DEFAULT 0 CHECK (has_language_blocker IN (0, 1)),
  has_country_mismatch INTEGER NOT NULL DEFAULT 0 CHECK (has_country_mismatch IN (0, 1)),
  has_work_mode_mismatch INTEGER NOT NULL DEFAULT 0 CHECK (has_work_mode_mismatch IN (0, 1)),
  tailoring_effort TEXT CHECK (tailoring_effort IN ('low', 'medium', 'high')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  matched_must_haves_json TEXT,
  missing_or_unclear_must_haves_json TEXT,
  matched_nice_to_haves_json TEXT,
  tailoring_suggestions_json TEXT,
  blockers_json TEXT,
  PRIMARY KEY (search_id, source, job_id),
  FOREIGN KEY (search_id) REFERENCES search_profiles(search_id) ON DELETE CASCADE,
  FOREIGN KEY (source, job_id) REFERENCES jobs(source, job_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX ux_job_work_modes_primary
ON job_work_modes(source, job_id)
WHERE is_primary = 1;

CREATE UNIQUE INDEX ux_resumes_default_per_user
ON resumes(user_id)
WHERE is_default = 1;

CREATE INDEX idx_jobs_country_region_city
ON jobs(country_code, region, city);

CREATE INDEX idx_jobs_role_family
ON jobs(role_family_inferred);

CREATE INDEX idx_job_languages_language_importance
ON job_languages(language, importance);

CREATE INDEX idx_job_work_modes_mode
ON job_work_modes(work_mode);

CREATE INDEX idx_user_languages_language
ON user_languages(language);

CREATE INDEX idx_match_results_cta_score
ON match_results(cta, fit_score DESC);

CREATE INDEX idx_match_results_flags
ON match_results(has_language_blocker, has_country_mismatch, has_work_mode_mismatch);
