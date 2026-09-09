import os from 'node:os';
import process from 'node:process';
import pg from 'pg';
import { buildRequest } from './lib/generator.js';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL || 'postgres://captain:captain_local_password@localhost:5432/captain_attack';
const pool = new Pool({ connectionString: databaseUrl, max: Number.parseInt(process.env.WORKER_DB_POOL_MAX || '3', 10) });
const workerId = process.env.WORKER_ID || `${os.hostname()}-${process.pid}`;
const workerConcurrency = Math.max(1, Number.parseInt(process.env.WORKER_CONCURRENCY || '16', 10));
const pollMs = Math.max(250, Number.parseInt(process.env.WORKER_POLL_MS || '1000', 10));
const heartbeatMs = Math.max(1000, Number.parseInt(process.env.WORKER_HEARTBEAT_MS || '3000', 10));

function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function waitForDatabase() {
  for (;;) {
    try { await pool.query('SELECT 1'); return; } catch { await sleep(1000); }
  }
}

async function getActiveRuns() {
  const result = await pool.query(`SELECT * FROM load_runs WHERE status = 'running' AND ends_at > now() ORDER BY created_at ASC`);
  return result.rows;
}

async function claimLease(runId, desiredWorkers) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`captain-attack-run:${runId}`]);
    const existing = await client.query('SELECT 1 FROM worker_leases WHERE run_id = $1 AND worker_id = $2', [runId, workerId]);
    const active = await client.query(`SELECT count(*)::int AS count FROM worker_leases WHERE run_id = $1 AND heartbeat_at > now() - interval '15 seconds'`, [runId]);
    const canClaim = existing.rowCount > 0 || active.rows[0].count < desiredWorkers;
    if (canClaim) {
      await client.query(`INSERT INTO worker_leases (run_id, worker_id, heartbeat_at) VALUES ($1, $2, now()) ON CONFLICT (run_id, worker_id) DO UPDATE SET heartbeat_at = now()`, [runId, workerId]);
    }
    await client.query('COMMIT');
    return canClaim;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function heartbeat(runId) {
  await pool.query(`UPDATE worker_leases SET heartbeat_at = now() WHERE run_id = $1 AND worker_id = $2`, [runId, workerId]);
}

async function releaseLease(runId) {
  await pool.query('DELETE FROM worker_leases WHERE run_id = $1 AND worker_id = $2', [runId, workerId]);
}

async function runIsStillActive(runId) {
  const result = await pool.query(`SELECT status, ends_at > now() AS within_window FROM load_runs WHERE id = $1`, [runId]);
  return result.rows[0]?.status === 'running' && result.rows[0]?.within_window === true;
}

async function flushStats(runId, stats) {
  if (!stats.sent) return;
  await pool.query(`UPDATE load_runs SET total_sent = total_sent + $2, total_success = total_success + $3, total_failed = total_failed + $4, total_timeout = total_timeout + $5 WHERE id = $1`, [runId, stats.sent, stats.success, stats.failed, stats.timeout]);
  stats.sent = 0; stats.success = 0; stats.failed = 0; stats.timeout = 0;
}

async function saveSuccessSample(runId, config, durationMs, statusCode, curlCommand) {
  if (config.successLogLimit <= 0) return;
  const result = await pool.query(`WITH claim AS (
    UPDATE load_runs SET success_logs_used = success_logs_used + 1
    WHERE id = $1 AND success_logs_used < success_log_limit
    RETURNING success_logs_used
  ) INSERT INTO success_logs (run_id, worker_id, status_code, duration_ms, curl_command)
  SELECT $1, $2, $3, $4, $5 FROM claim RETURNING id`, [runId, workerId, statusCode, durationMs, curlCommand]);
  return result.rowCount > 0;
}

async function sendRequest(run, config, index, state) {
  const generated = buildRequest(config, state);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(config.targetUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: generated.body,
      signal: controller.signal,
    });
    const durationMs = Math.max(1, Math.round(performance.now() - started));
    if (response.body) await response.body.cancel().catch(() => {});
    return { success: response.status < 400, timeout: false, statusCode: response.status, durationMs, curl: generated.curl, index };
  } catch (error) {
    return { success: false, timeout: error.name === 'AbortError', statusCode: null, durationMs: Math.max(1, Math.round(performance.now() - started)), curl: generated.curl, index, error: error.message };
  } finally { clearTimeout(timeout); }
}

async function runClaimedRun(run) {
  const config = {
    targetUrl: run.target_url,
    requestTimeoutMs: run.request_timeout_ms,
    secretCount: run.secret_count,
    secretMinLength: run.secret_min_length,
    secretMaxLength: run.secret_max_length,
    valueMinLength: run.value_min_length,
    valueMaxLength: run.value_max_length,
    allowRepeatedValues: run.allow_repeated_values,
    repeatPercent: run.repeat_percent,
    successLogLimit: run.success_log_limit,
  };
  const deadline = new Date(run.ends_at).getTime();
  const state = { valuePool: [] };
  const stats = { sent: 0, success: 0, failed: 0, timeout: 0 };
  let sequence = 0;
  let lastFlush = Date.now();
  let lastHeartbeat = Date.now();
  let lastStatusCheck = 0;
  let active = true;
  let sampleWrites = 0;

  const loop = async () => {
    while (Date.now() < deadline && active) {
      const nowBeforeRequest = Date.now();
      if (nowBeforeRequest - lastStatusCheck >= 500) {
        active = await runIsStillActive(run.id);
        lastStatusCheck = nowBeforeRequest;
        if (!active) break;
      }
      const index = sequence;
      sequence += 1;
      const result = await sendRequest(run, config, index, state);
      stats.sent += 1;
      if (result.success) {
        stats.success += 1;
        if (sampleWrites < config.successLogLimit) {
          const saved = await saveSuccessSample(run.id, config, result.durationMs, result.statusCode, result.curl);
          if (saved) sampleWrites += 1;
        }
      } else if (result.timeout) stats.timeout += 1;
      else stats.failed += 1;

      const now = Date.now();
      if (now - lastFlush >= 250 || stats.sent >= 100) { await flushStats(run.id, stats); lastFlush = now; }
      if (now - lastHeartbeat >= heartbeatMs) { await heartbeat(run.id); lastHeartbeat = now; }
      if (stats.sent === 0 && now >= deadline) break;
    }
  };

  await Promise.all(Array.from({ length: Math.min(workerConcurrency, run.worker_concurrency) }, loop));
  await flushStats(run.id, stats);
  await releaseLease(run.id);
}

async function main() {
  await waitForDatabase();
  console.log(`Worker ${workerId} ready with ${workerConcurrency} local request loops.`);
  for (;;) {
    try {
      const runs = await getActiveRuns();
      for (const run of runs) {
        if (await claimLease(run.id, run.docker_workers)) {
          console.log(`Worker ${workerId} claimed run ${run.id}`);
          await runClaimedRun(run).catch(async (error) => {
            console.error(`Run ${run.id} failed on worker ${workerId}:`, error);
            await pool.query('UPDATE load_runs SET last_error = $2 WHERE id = $1', [run.id, error.message]).catch(() => {});
            await releaseLease(run.id).catch(() => {});
          });
        }
      }
    } catch (error) { console.error(`Worker ${workerId} polling error:`, error.message); }
    await sleep(pollMs);
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
