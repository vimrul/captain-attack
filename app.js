const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = { currentRun: null, pollTimer: null, previewTimer: null, running: false };
const secretAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const valueAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

function numberValue(id) { return Number.parseInt($(`#${id}`).value, 10); }
function randomChars(alphabet, length) {
  const values = new Uint32Array(length);
  crypto.getRandomValues(values);
  return [...values].map((value) => alphabet[value % alphabet.length]).join('');
}
function randomBetween(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function clientPreview() {
  const used = new Set();
  const fields = [];
  const count = numberValue('secretCount');
  const minName = numberValue('secretMinLength');
  const maxName = numberValue('secretMaxLength');
  const minValue = numberValue('valueMinLength');
  const maxValue = numberValue('valueMaxLength');
  for (let index = 0; index < count; index += 1) {
    let name = randomChars(secretAlphabet, randomBetween(minName, maxName));
    while (used.has(name)) name = randomChars(secretAlphabet, randomBetween(minName, maxName));
    used.add(name);
    fields.push(`${name}=${randomChars(valueAlphabet, randomBetween(minValue, maxValue))}`);
  }
  const body = fields.join('&');
  return `curl -s -X POST -d '${body}' ${$('#targetUrl').value.trim() || 'https://example.test/ingest'}`;
}

function readConfig() {
  return {
    name: $('#runName').value.trim(), targetUrl: $('#targetUrl').value.trim(), durationValue: numberValue('durationSeconds'), durationUnit: $('#durationUnit').value, requestTimeoutMs: numberValue('requestTimeoutMs'),
    secretCount: numberValue('secretCount'), secretMinLength: numberValue('secretMinLength'), secretMaxLength: numberValue('secretMaxLength'), valueMinLength: numberValue('valueMinLength'), valueMaxLength: numberValue('valueMaxLength'),
    allowRepeatedValues: $('#allowRepeatedValues').checked, repeatPercent: numberValue('repeatPercent'), dockerWorkers: numberValue('dockerWorkers'), workerConcurrency: numberValue('workerConcurrency'), successLogLimit: numberValue('successLogLimit'), rampStartWorkers: numberValue('rampStartWorkers'), rampDurationSeconds: numberValue('rampDurationSeconds'),
  };
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[character])); }
function showToast(message) { const toast = $('#toast'); toast.textContent = message; toast.classList.add('show'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600); }

function updateEnvelopeSummary() {
  const workers = numberValue('dockerWorkers') || 0;
  const concurrency = numberValue('workerConcurrency') || 0;
  const duration = numberValue('durationSeconds') || 0;
  const unit = $('#durationUnit').value;
  const maxByUnit = { sec: 86400, minute: 1440, day: 30, month: 1 };
  $('#durationSeconds').max = maxByUnit[unit];
  $('#capacitySummary').textContent = `Up to ${(workers * concurrency).toLocaleString()} active request loops`;
  const ramp = numberValue('rampDurationSeconds') || 0;
  $('#envelopeSummary').textContent = `${workers.toLocaleString()} worker leases · ${duration.toLocaleString()} ${unit} run${ramp ? ` · ramps over ${ramp}s` : ''}`;
  $('#dockerCommand').textContent = `docker compose up --build --scale worker=${Math.max(1, workers)}`;
}

async function updatePreview() {
  const preview = $('#curlPreview');
  preview.textContent = clientPreview();
  try {
    const result = await fetchJson('/api/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(readConfig()) });
    preview.textContent = result.curl;
  } catch (error) {
    preview.textContent = clientPreview();
    if (!error.message.includes('Failed to fetch')) showToast(error.message);
  }
}

function schedulePreview() { clearTimeout(state.previewTimer); state.previewTimer = setTimeout(updatePreview, 220); }

function setRunState(status) {
  const stateLabel = status === 'running' ? 'running' : status === 'complete' ? 'complete' : status === 'stopped' ? 'stopped' : 'idle';
  const runState = $('#runState');
  runState.className = `run-state ${stateLabel === 'complete' ? 'complete' : stateLabel === 'running' ? 'running' : ''}`;
  runState.innerHTML = `<i></i> ${stateLabel}`;
  $('#sessionStatus').textContent = status === 'running' ? 'Running' : status === 'complete' ? 'Complete' : status === 'stopped' ? 'Stopped' : 'Draft';
}

function renderStatus(run) {
  state.currentRun = run;
  const sent = run.totalSent || 0;
  const success = run.totalSuccess || 0;
  const rate = sent ? `${Math.round((success / sent) * 100)}%` : '—';
  $('#sentMetric').textContent = sent.toLocaleString();
  $('#successMetric').textContent = rate;
  $('#throughputMetric').textContent = run.throughput ? `${run.throughput.toLocaleString()}/s` : '—';
  $('#workersMetric').textContent = `${run.activeWorkers || 0} / ${run.dockerWorkers}`;
  const progress = run.status === 'complete' ? 100 : Math.max(0, Math.min(100, 100 - (run.remainingPercent || 0)));
  $('#progressBar').style.width = `${progress}%`;
  $('#runTimer').textContent = `${run.elapsedSeconds || 0}s elapsed · ${run.durationSeconds}s total`;
  $('#runError').textContent = run.lastError || '';
  setRunState(run.status);
  $('#launchButton').classList.toggle('running', run.status === 'running');
  $('#launchLabel').textContent = run.status === 'running' ? 'Stop wave' : 'Launch wave';
}

function renderLogs(logs) {
  $('#logCount').textContent = `${logs.length.toLocaleString()} samples retained`;
  const log = $('#curlLog');
  if (!logs.length) { log.innerHTML = '<div class="empty-log">Successful sends will appear here as workers report back.</div>'; return; }
  log.innerHTML = logs.map((item) => `<div class="curl-log-item"><div class="curl-log-meta"><strong>HTTP ${item.status_code || 'sent'}</strong><span>${item.duration_ms} ms · ${escapeHtml(item.worker_id)}</span></div><code>${escapeHtml(item.curl_command)}</code></div>`).join('');
}

async function pollRun() {
  if (!state.currentRun) return;
  try {
    const [run, logs] = await Promise.all([fetchJson(`/api/runs/${state.currentRun.id}`), fetchJson(`/api/runs/${state.currentRun.id}/logs?limit=100`)]);
    renderStatus(run); renderLogs(logs);
    if (run.status === 'running') state.pollTimer = setTimeout(pollRun, 900);
    else { state.running = false; $('#signal').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  } catch (error) { $('#runError').textContent = error.message; state.pollTimer = setTimeout(pollRun, 2000); }
}

async function launchOrStop() {
  if (state.currentRun?.status === 'running') {
    try { const run = await fetchJson(`/api/runs/${state.currentRun.id}/stop`, { method: 'POST' }); renderStatus(run); showToast('Wave stop requested.'); clearTimeout(state.pollTimer); state.pollTimer = setTimeout(pollRun, 700); } catch (error) { showToast(error.message); }
    return;
  }
  try {
    const run = await fetchJson('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(readConfig()) });
    state.running = true; $('#signal').hidden = false; renderStatus(run); renderLogs([]); showToast('Wave launched. Workers are claiming leases.'); clearTimeout(state.pollTimer); state.pollTimer = setTimeout(pollRun, 200); $('#signal').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { showToast(error.message); }
}

function resetForm() {
  $('#targetUrl').value = 'https://example.test/ingest'; $('#runName').value = 'Uppercase secret wave'; $('#durationSeconds').value = 60; $('#durationUnit').value = 'sec'; $('#requestTimeoutMs').value = 10000; $('#dockerWorkers').value = 100; $('#workerConcurrency').value = 16; $('#successLogLimit').value = 200; $('#rampStartWorkers').value = 1; $('#rampDurationSeconds').value = 0; $('#secretCount').value = 4; $('#repeatPercent').value = 20; $('#secretMinLength').value = 2; $('#secretMaxLength').value = 8; $('#valueMinLength').value = 12; $('#valueMaxLength').value = 40; $('#allowRepeatedValues').checked = true; updateEnvelopeSummary(); updatePreview(); showToast('Wave form reset.');
}

async function copyText(text, successMessage) { try { await navigator.clipboard.writeText(text); showToast(successMessage); } catch { showToast('Clipboard permission was unavailable.'); } }

$('#launchButton').addEventListener('click', launchOrStop);
$('#regenerateButton').addEventListener('click', () => { updatePreview(); showToast('New cURL preview generated.'); });
$('#previewButton').addEventListener('click', () => { updatePreview(); showToast('Preview refreshed.'); });
$('#resetButton').addEventListener('click', resetForm);
$('#copyDockerButton').addEventListener('click', () => copyText($('#dockerCommand').textContent, 'Docker command copied.'));
$('#helpButton').addEventListener('click', () => { $('#helpModal').hidden = false; });
$('#closeModal').addEventListener('click', () => { $('#helpModal').hidden = true; });
$('#helpModal').addEventListener('click', (event) => { if (event.target === $('#helpModal')) $('#helpModal').hidden = true; });
$$('input').forEach((input) => input.addEventListener('input', () => { updateEnvelopeSummary(); schedulePreview(); }));
$('#durationUnit').addEventListener('change', () => { updateEnvelopeSummary(); schedulePreview(); });
$('#allowRepeatedValues').addEventListener('change', schedulePreview);
document.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); launchOrStop(); } if (event.key === 'Escape') $('#helpModal').hidden = true; });

updateEnvelopeSummary(); updatePreview();
