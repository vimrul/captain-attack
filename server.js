import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';
import { buildRequest, normalizeConfig } from './lib/generator.js';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number.parseInt(process.env.PORT || '4173', 10);
const databaseUrl = process.env.DATABASE_URL || 'postgres://captain:captain_local_password@localhost:5432/captain_attack';
const basicAuthUser = process.env.BASIC_AUTH_USER || '';
const basicAuthPassword = process.env.BASIC_AUTH_PASSWORD || '';
const pool = new Pool({ connectionString: databaseUrl, max: Number.parseInt(process.env.API_POOL_MAX || '30', 10) });
const app = express();

const schema = `
CREATE TABLE IF NOT EXISTS load_runs (
  id uuid PRIMARY KEY, name text NOT NULL, target_url text NOT NULL,
  duration_seconds integer NOT NULL, request_timeout_ms integer NOT NULL DEFAULT 10000,
  secret_count integer NOT NULL, secret_min_length integer NOT NULL, secret_max_length integer NOT NULL,
  value_min_length integer NOT NULL, value_max_length integer NOT NULL,
  allow_repeated_values boolean NOT NULL DEFAULT true, repeat_percent integer NOT NULL DEFAULT 20,
  docker_workers integer NOT NULL, worker_concurrency integer NOT NULL, success_log_limit integer NOT NULL DEFAULT 200,
  ramp_start_workers integer NOT NULL DEFAULT 1, ramp_duration_seconds integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'running', started_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
  stopped_at timestamptz, total_sent bigint NOT NULL DEFAULT 0, total_success bigint NOT NULL DEFAULT 0,
  total_failed bigint NOT NULL DEFAULT 0, total_timeout bigint NOT NULL DEFAULT 0,
  success_logs_used integer NOT NULL DEFAULT 0, last_error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS load_runs_status_ends_idx ON load_runs (status, ends_at);
CREATE TABLE IF NOT EXISTS worker_leases (
  run_id uuid NOT NULL REFERENCES load_runs(id) ON DELETE CASCADE, worker_id text NOT NULL,
  heartbeat_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (run_id, worker_id)
);
CREATE INDEX IF NOT EXISTS worker_leases_heartbeat_idx ON worker_leases (run_id, heartbeat_at);
CREATE TABLE IF NOT EXISTS success_logs (
  id bigserial PRIMARY KEY, run_id uuid NOT NULL REFERENCES load_runs(id) ON DELETE CASCADE,
  worker_id text NOT NULL, status_code integer, duration_ms integer NOT NULL,
  curl_command text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS success_logs_run_created_idx ON success_logs (run_id, created_at DESC, id DESC);
ALTER TABLE load_runs ADD COLUMN IF NOT EXISTS ramp_start_workers integer NOT NULL DEFAULT 1;
ALTER TABLE load_runs ADD COLUMN IF NOT EXISTS ramp_duration_seconds integer NOT NULL DEFAULT 0;
`;

function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

function basicAuth(request, response, next) {
  if (request.path === '/api/health') return next();
  const challenge = () => response.set('WWW-Authenticate', 'Basic realm="Captain Attack"').status(401).send('Authentication required.');
  if (!basicAuthUser || !basicAuthPassword) return response.status(503).send('Basic Auth is not configured.');
  const header = request.get('authorization') || '';
  if (!header.startsWith('Basic ')) return challenge();
  let suppliedUser = '';
  let suppliedPassword = '';
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) return challenge();
    suppliedUser = decoded.slice(0, separator);
    suppliedPassword = decoded.slice(separator + 1);
  } catch { return challenge(); }
  const equal = (left, right) => {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  if (!equal(suppliedUser, basicAuthUser) || !equal(suppliedPassword, basicAuthPassword)) return challenge();
  return next();
}

async function ensureSchema() {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { await pool.query(schema); return; } catch (error) { lastError = error; await sleep(1000); }
  }
  throw lastError;
}

function serializeRun(row, activeWorkers = 0) {
  const now = Date.now();
  const endsAt = new Date(row.ends_at).getTime();
  const startedAt = new Date(row.started_at).getTime();
  const durationMs = Math.max(1, endsAt - startedAt);
  const elapsedMs = Math.max(0, Math.min(durationMs, now - startedAt));
  const complete = row.status === 'running' && endsAt <= now;
  const totalSent = Number(row.total_sent || 0);
  return {
    id: row.id, name: row.name, targetUrl: row.target_url, status: complete ? 'complete' : row.status,
    durationSeconds: row.duration_seconds, requestTimeoutMs: row.request_timeout_ms,
    secretCount: row.secret_count, secretMinLength: row.secret_min_length, secretMaxLength: row.secret_max_length,
    valueMinLength: row.value_min_length, valueMaxLength: row.value_max_length,
    allowRepeatedValues: row.allow_repeated_values, repeatPercent: row.repeat_percent,
    dockerWorkers: row.docker_workers, workerConcurrency: row.worker_concurrency, successLogLimit: row.success_log_limit,
    rampStartWorkers: row.ramp_start_workers, rampDurationSeconds: row.ramp_duration_seconds,
    startedAt: row.started_at, endsAt: row.ends_at, totalSent, totalSuccess: Number(row.total_success || 0),
    totalFailed: Number(row.total_failed || 0), totalTimeout: Number(row.total_timeout || 0),
    activeWorkers, elapsedSeconds: Math.round(elapsedMs / 1000),
    throughput: elapsedMs ? Math.round((totalSent / elapsedMs) * 1000) : 0,
    remainingPercent: complete ? 0 : Math.max(0, Math.round(100 - (elapsedMs / durationMs) * 100)),
    lastError: row.last_error,
  };
}

async function getRun(runId) {
  const result = await pool.query('SELECT * FROM load_runs WHERE id = $1', [runId]);
  return result.rows[0];
}

async function getActiveWorkers(runId) {
  const result = await pool.query(`SELECT count(*)::int AS count FROM worker_leases WHERE run_id = $1 AND heartbeat_at > now() - interval '15 seconds'`, [runId]);
  return result.rows[0]?.count || 0;
}

app.use(express.json({ limit: '32kb' }));
app.use(basicAuth);
app.get('/styles.css', (_request, response) => response.sendFile(path.join(__dirname, 'styles.css')));
app.get('/app.js', (_request, response) => response.sendFile(path.join(__dirname, 'app.js')));
app.get('/index.html', (_request, response) => response.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/health', async (_request, response) => {
  try { await pool.query('SELECT 1'); response.json({ ok: true }); } catch { response.status(503).json({ ok: false }); }
});

app.post('/api/preview', (request, response) => {
  try {
    const config = normalizeConfig({ ...request.body, durationValue: 1, durationUnit: 'sec', durationSeconds: 1, dockerWorkers: 1, workerConcurrency: 1, successLogLimit: 0, rampStartWorkers: 1, rampDurationSeconds: 0 });
    const generated = buildRequest(config);
    response.json(generated);
  } catch (error) { response.status(400).json({ error: error.message }); }
});

app.post('/api/runs', async (request, response) => {
  try {
    const config = normalizeConfig(request.body);
    const id = crypto.randomUUID();
    const startedAt = new Date();
    const endsAt = new Date(startedAt.getTime() + config.durationSeconds * 1000);
    await pool.query(`INSERT INTO load_runs (
      id, name, target_url, duration_seconds, request_timeout_ms, secret_count, secret_min_length, secret_max_length,
      value_min_length, value_max_length, allow_repeated_values, repeat_percent, docker_workers, worker_concurrency,
      success_log_limit, ramp_start_workers, ramp_duration_seconds, status, started_at, ends_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'running',$18,$19)`, [
      id, config.name, config.targetUrl, config.durationSeconds, config.requestTimeoutMs, config.secretCount,
      config.secretMinLength, config.secretMaxLength, config.valueMinLength, config.valueMaxLength,
      config.allowRepeatedValues, config.repeatPercent, config.dockerWorkers, config.workerConcurrency,
      config.successLogLimit, config.rampStartWorkers, config.rampDurationSeconds, startedAt, endsAt,
    ]);
    const run = await getRun(id);
    response.status(201).json(serializeRun(run));
  } catch (error) { response.status(400).json({ error: error.message }); }
});

app.get('/api/runs', async (_request, response) => {
  try {
    const result = await pool.query('SELECT * FROM load_runs ORDER BY created_at DESC LIMIT 25');
    response.json(await Promise.all(result.rows.map(async (row) => serializeRun(row, await getActiveWorkers(row.id)))));
  } catch (error) { response.status(500).json({ error: error.message }); }
});

app.get('/api/runs/:id', async (request, response) => {
  try {
    const run = await getRun(request.params.id);
    if (!run) return response.status(404).json({ error: 'Run not found.' });
    if (run.status === 'running' && new Date(run.ends_at).getTime() <= Date.now()) {
      await pool.query(`UPDATE load_runs SET status = 'complete' WHERE id = $1 AND status = 'running'`, [run.id]);
      run.status = 'complete';
    }
    return response.json(serializeRun(run, await getActiveWorkers(run.id)));
  } catch (error) { return response.status(500).json({ error: error.message }); }
});

app.get('/api/runs/:id/logs', async (request, response) => {
  try {
    const limit = Math.max(1, Math.min(1000, Number.parseInt(request.query.limit || '100', 10)));
    const result = await pool.query(`SELECT id, worker_id, status_code, duration_ms, curl_command, created_at FROM success_logs WHERE run_id = $1 ORDER BY id DESC LIMIT $2`, [request.params.id, limit]);
    response.json(result.rows);
  } catch (error) { response.status(500).json({ error: error.message }); }
});

app.post('/api/runs/:id/stop', async (request, response) => {
  try {
    const result = await pool.query(`UPDATE load_runs SET status = 'stopped', stopped_at = now() WHERE id = $1 AND status = 'running' RETURNING *`, [request.params.id]);
    if (!result.rows[0]) return response.status(404).json({ error: 'Run is already stopped or does not exist.' });
    return response.json(serializeRun(result.rows[0], await getActiveWorkers(request.params.id)));
  } catch (error) { return response.status(500).json({ error: error.message }); }
});

app.get('*', (_request, response) => response.sendFile(path.join(__dirname, 'index.html')));

ensureSchema().then(() => {
  app.listen(port, () => console.log(`Captain Attack API listening on :${port}`));
}).catch((error) => {
  console.error('Database bootstrap failed:', error);
  process.exit(1);
});
