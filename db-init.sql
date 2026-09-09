CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS load_runs (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  target_url text NOT NULL,
  duration_seconds integer NOT NULL CHECK (duration_seconds BETWEEN 1 AND 86400),
  request_timeout_ms integer NOT NULL DEFAULT 10000 CHECK (request_timeout_ms BETWEEN 100 AND 120000),
  secret_count integer NOT NULL CHECK (secret_count BETWEEN 1 AND 1000),
  secret_min_length integer NOT NULL CHECK (secret_min_length BETWEEN 2 AND 20),
  secret_max_length integer NOT NULL CHECK (secret_max_length BETWEEN 2 AND 20),
  value_min_length integer NOT NULL CHECK (value_min_length BETWEEN 12 AND 40),
  value_max_length integer NOT NULL CHECK (value_max_length BETWEEN 12 AND 40),
  allow_repeated_values boolean NOT NULL DEFAULT true,
  repeat_percent integer NOT NULL DEFAULT 20 CHECK (repeat_percent BETWEEN 0 AND 100),
  docker_workers integer NOT NULL CHECK (docker_workers BETWEEN 1 AND 10000),
  worker_concurrency integer NOT NULL CHECK (worker_concurrency BETWEEN 1 AND 256),
  success_log_limit integer NOT NULL DEFAULT 200 CHECK (success_log_limit BETWEEN 0 AND 10000),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'complete', 'stopped')),
  started_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  stopped_at timestamptz,
  total_sent bigint NOT NULL DEFAULT 0,
  total_success bigint NOT NULL DEFAULT 0,
  total_failed bigint NOT NULL DEFAULT 0,
  total_timeout bigint NOT NULL DEFAULT 0,
  success_logs_used integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS load_runs_status_ends_idx ON load_runs (status, ends_at);

CREATE TABLE IF NOT EXISTS worker_leases (
  run_id uuid NOT NULL REFERENCES load_runs(id) ON DELETE CASCADE,
  worker_id text NOT NULL,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, worker_id)
);

CREATE INDEX IF NOT EXISTS worker_leases_heartbeat_idx ON worker_leases (run_id, heartbeat_at);

CREATE TABLE IF NOT EXISTS success_logs (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES load_runs(id) ON DELETE CASCADE,
  worker_id text NOT NULL,
  status_code integer,
  duration_ms integer NOT NULL,
  curl_command text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS success_logs_run_created_idx ON success_logs (run_id, created_at DESC, id DESC);
