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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source, job_id)
);

CREATE TABLE match_results (
  job_source TEXT NOT NULL,
  job_id TEXT NOT NULL,
  fit_score REAL NOT NULL,
  cta TEXT NOT NULL DEFAULT 'Skip' CHECK (cta IN ('Apply', 'Skip')),
  stretch_label TEXT,
  blockers TEXT,
  tailoring_suggestions TEXT,
  scored_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (job_source, job_id),
  FOREIGN KEY (job_source, job_id) REFERENCES jobs(source, job_id)
);

CREATE TABLE salaries (
  job_source TEXT NOT NULL,
  job_id TEXT NOT NULL,
  salary_min INTEGER CHECK (salary_min IS NULL OR salary_min >= 0),
  salary_max INTEGER CHECK (salary_max IS NULL OR salary_max >= 0),
  salary_currency TEXT,
  salary_period TEXT,
  provenance TEXT,
  fetched_at TEXT,
  PRIMARY KEY (job_source, job_id),
  FOREIGN KEY (job_source, job_id) REFERENCES jobs(source, job_id)
);

CREATE TABLE applications (
  job_source TEXT NOT NULL,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','failed','skipped')),
  applied_at TEXT,
  log_path TEXT,
  PRIMARY KEY (job_source, job_id),
  FOREIGN KEY (job_source, job_id) REFERENCES jobs(source, job_id)
);

CREATE TABLE writer_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder TEXT,
  acquired_at TEXT
);

CREATE TRIGGER jobs_updated
  AFTER UPDATE ON jobs
  FOR EACH ROW
  WHEN NEW.updated_at = OLD.updated_at
  BEGIN
    UPDATE jobs SET updated_at = datetime('now') WHERE source = NEW.source AND job_id = NEW.job_id;
  END;
