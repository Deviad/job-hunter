// Single source of truth for salary schema DDL strings.
// Both the installer (Plan 04) and the drift detector (Plan 02) import from here.
//
// 8-index breakdown (CONTEXT.md corrected from 7 → 8 on 2026-05-12):
//   3 obs indexes  (idx_obs_job, idx_obs_benchmark, idx_obs_job_confidence)
// + 3 bench indexes (idx_bench_series_latest, idx_bench_identity_lookup, idx_bench_refresh_due)
// + 2 enrich indexes (idx_enrich_exact_retry_due, idx_enrich_benchmark_retry_due)
// = 8
//
// CONTEXT.md mandates 5 identity columns on salary_writer_lock; V4's minimal
// `id/holder/acquired_at` shape is superseded.

// LOCK_TABLE_DDL: separately-named export of the salary_writer_lock CREATE
// statement. Re-exported via TABLES.salary_writer_lock too — single literal
// string, two named bindings. Plan 03's acquire() runs this as its FIRST
// statement on a fresh DB to self-bootstrap.
export const LOCK_TABLE_DDL = `CREATE TABLE IF NOT EXISTS salary_writer_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hostname TEXT,
  pid INTEGER,
  started_at TEXT,
  nonce TEXT,
  acquired_at TEXT
)`;

// NOW_SQL: millisecond-precision "now" SQL. Owned here (single source of truth)
// and imported by writer-lock.mjs (one-way dependency: writer-lock → salary-schema,
// never the reverse, to avoid circular deps). SQLite's datetime() parses the .fff
// fractional seconds, so the 10-minute stale-window predicate keeps working.
export const NOW_SQL = `strftime('%Y-%m-%d %H:%M:%f','now')`;

export const TABLES = {
  job_salary_observations: `CREATE TABLE IF NOT EXISTS job_salary_observations (
  job_source TEXT NOT NULL,
  job_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,

  data_source TEXT NOT NULL,
  data_source_url TEXT,
  benchmark_id TEXT,

  confidence_label TEXT NOT NULL CHECK (
    confidence_label IN (
      'posted_exact',
      'external_exact',
      'api_exact_match',
      'aggregated_exact_title',
      'company_benchmark',
      'estimated_market',
      'official_baseline',
      'unknown_exact',
      'unknown_estimate'
    )
  ),
  matched_by TEXT NOT NULL CHECK (
    matched_by IN (
      'exact_job',
      'title_company_location',
      'title_company',
      'role_location',
      'company_role_level',
      'occupation_baseline',
      'manual'
    )
  ),

  is_posted_salary INTEGER NOT NULL DEFAULT 0 CHECK (is_posted_salary IN (0, 1)),
  is_predicted INTEGER NOT NULL DEFAULT 0 CHECK (is_predicted IN (0, 1)),

  currency TEXT NOT NULL CHECK (length(currency) = 3),
  amount_min REAL,
  amount_max REAL,
  amount_median REAL,
  period TEXT NOT NULL CHECK (period IN ('hour', 'day', 'week', 'month', 'year')),
  compensation_type TEXT NOT NULL CHECK (
    compensation_type IN ('base_salary', 'total_compensation', 'ote', 'contract_rate', 'unknown')
  ),

  annualized_min REAL,
  annualized_max REAL,
  annualized_median REAL,
  annualization_note TEXT,

  fx_currency TEXT CHECK (fx_currency IS NULL OR length(fx_currency) = 3),
  fx_annualized_median REAL,
  fx_rate REAL,
  fx_rate_as_of TEXT,

  location_raw TEXT,
  country_code TEXT,
  region TEXT,
  city TEXT,

  evidence_snippet TEXT,
  raw_payload_json TEXT,

  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (job_source, job_id, observation_id),
  FOREIGN KEY (job_source, job_id)
    REFERENCES jobs(source, job_id)
    ON DELETE CASCADE,
  FOREIGN KEY (benchmark_id)
    REFERENCES salary_benchmarks(benchmark_id)
    ON DELETE RESTRICT,

  CHECK (
    (benchmark_id IS NULL AND is_posted_salary = 1 AND confidence_label IN (
      'posted_exact',
      'external_exact',
      'api_exact_match',
      'unknown_exact'
    ))
    OR
    (benchmark_id IS NOT NULL AND is_posted_salary = 0 AND confidence_label IN (
      'aggregated_exact_title',
      'company_benchmark',
      'estimated_market',
      'official_baseline',
      'unknown_estimate'
    ))
  ),

  CHECK (
    is_predicted = 0
    OR (is_predicted = 1 AND is_posted_salary = 0 AND benchmark_id IS NOT NULL)
  ),

  CHECK (
    amount_min IS NOT NULL
    OR amount_max IS NOT NULL
    OR amount_median IS NOT NULL
  )
)`,

  salary_benchmarks: `CREATE TABLE IF NOT EXISTS salary_benchmarks (
  benchmark_id TEXT PRIMARY KEY,
  benchmark_series_id TEXT NOT NULL,

  data_source TEXT NOT NULL,
  data_source_url TEXT,

  raw_title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  role_family TEXT,
  seniority TEXT NOT NULL DEFAULT '_any',
  industry TEXT NOT NULL DEFAULT '_any',

  country_code TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  location_raw TEXT,

  currency TEXT NOT NULL CHECK (length(currency) = 3),
  period TEXT NOT NULL CHECK (period IN ('hour', 'day', 'week', 'month', 'year')),
  compensation_type TEXT NOT NULL CHECK (
    compensation_type IN ('base_salary', 'total_compensation', 'ote', 'contract_rate', 'unknown')
  ),

  amount_min REAL,
  amount_max REAL,
  amount_median REAL,
  amount_p10 REAL,
  amount_p25 REAL,
  amount_p75 REAL,
  amount_p90 REAL,

  sample_size INTEGER CHECK (sample_size IS NULL OR sample_size >= 0),
  confidence_score REAL CHECK (
    confidence_score IS NULL OR (confidence_score >= 0 AND confidence_score <= 1)
  ),

  effective_from TEXT,
  effective_to TEXT,
  fetched_at TEXT NOT NULL,
  next_refresh_at TEXT,
  refresh_frequency_days INTEGER NOT NULL DEFAULT 30,

  payload_hash TEXT NOT NULL,
  evidence_snippet TEXT,
  raw_payload_json TEXT,

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  normalizer_version INTEGER NOT NULL DEFAULT 1 CHECK (normalizer_version >= 1),

  UNIQUE (benchmark_series_id, payload_hash)
)`,

  job_enrichment_state: `CREATE TABLE IF NOT EXISTS job_enrichment_state (
  job_source TEXT NOT NULL,
  job_id TEXT NOT NULL,

  exact_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (exact_status IN ('pending', 'found', 'not_found', 'error')),
  exact_last_attempt_at TEXT,
  exact_error TEXT,
  exact_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (exact_attempt_count >= 0),
  next_exact_retry_at TEXT,

  benchmark_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (benchmark_status IN ('pending', 'found', 'not_found', 'error')),
  benchmark_last_attempt_at TEXT,
  benchmark_error TEXT,
  benchmark_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (benchmark_attempt_count >= 0),
  next_benchmark_retry_at TEXT,
  latest_benchmark_id TEXT,

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (job_source, job_id),
  FOREIGN KEY (job_source, job_id)
    REFERENCES jobs(source, job_id)
    ON DELETE CASCADE,
  FOREIGN KEY (latest_benchmark_id)
    REFERENCES salary_benchmarks(benchmark_id)
    ON DELETE SET NULL
)`,

  salary_writer_lock: LOCK_TABLE_DDL,
};

export const INDEXES = {
  idx_obs_job: `CREATE INDEX IF NOT EXISTS idx_obs_job ON job_salary_observations (job_source, job_id)`,
  idx_obs_benchmark: `CREATE INDEX IF NOT EXISTS idx_obs_benchmark ON job_salary_observations (benchmark_id)`,
  idx_obs_job_confidence: `CREATE INDEX IF NOT EXISTS idx_obs_job_confidence ON job_salary_observations (job_source, job_id, confidence_label, observed_at DESC)`,
  idx_bench_series_latest: `CREATE INDEX IF NOT EXISTS idx_bench_series_latest ON salary_benchmarks (benchmark_series_id, fetched_at DESC)`,
  idx_bench_identity_lookup: `CREATE INDEX IF NOT EXISTS idx_bench_identity_lookup ON salary_benchmarks (normalized_title, country_code, region, city, compensation_type, period, seniority, industry, fetched_at DESC)`,
  idx_bench_refresh_due: `CREATE INDEX IF NOT EXISTS idx_bench_refresh_due ON salary_benchmarks (next_refresh_at) WHERE next_refresh_at IS NOT NULL`,
  idx_enrich_exact_retry_due: `CREATE INDEX IF NOT EXISTS idx_enrich_exact_retry_due ON job_enrichment_state (next_exact_retry_at) WHERE next_exact_retry_at IS NOT NULL`,
  idx_enrich_benchmark_retry_due: `CREATE INDEX IF NOT EXISTS idx_enrich_benchmark_retry_due ON job_enrichment_state (next_benchmark_retry_at) WHERE next_benchmark_retry_at IS NOT NULL`,
};

export const TRIGGERS = {
  trg_state_updated: `CREATE TRIGGER IF NOT EXISTS trg_state_updated
AFTER UPDATE ON job_enrichment_state
FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE job_enrichment_state
     SET updated_at = CURRENT_TIMESTAMP
   WHERE job_source = OLD.job_source
     AND job_id = OLD.job_id;
END`,
};

export const EXPECTED_NAMES = [
  ...Object.keys(TABLES),
  ...Object.keys(INDEXES),
  ...Object.keys(TRIGGERS),
];

export const ALL_DDL = [
  ...Object.values(TABLES),
  ...Object.values(INDEXES),
  ...Object.values(TRIGGERS),
];

export const COUNTS = { tables: 4, indexes: 8, triggers: 1 };
