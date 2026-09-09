import crypto from 'node:crypto';

const SECRET_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const VALUE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

function randomInt(min, max) {
  return crypto.randomInt(min, max + 1);
}

function randomChars(alphabet, length) {
  const bytes = crypto.randomBytes(length);
  let result = '';
  for (let index = 0; index < length; index += 1) result += alphabet[bytes[index] % alphabet.length];
  return result;
}

export function randomSecretName(minLength, maxLength, usedNames) {
  const length = randomInt(minLength, maxLength);
  let name = randomChars(SECRET_ALPHABET, length);
  let attempts = 0;
  while (usedNames.has(name) && attempts < 20) {
    name = randomChars(SECRET_ALPHABET, length);
    attempts += 1;
  }
  usedNames.add(name);
  return name;
}

export function randomValue(minLength, maxLength) {
  return randomChars(VALUE_ALPHABET, randomInt(minLength, maxLength));
}

function selectRepeatedValue(valuePool) {
  return valuePool[randomInt(0, valuePool.length - 1)];
}

export function buildRequest(config, workerState = { valuePool: [] }) {
  const usedNames = new Set();
  const fields = [];
  for (let index = 0; index < config.secretCount; index += 1) {
    const name = randomSecretName(config.secretMinLength, config.secretMaxLength, usedNames);
    const shouldRepeat = config.allowRepeatedValues && workerState.valuePool.length > 0 && randomInt(1, 100) <= config.repeatPercent;
    const value = shouldRepeat ? selectRepeatedValue(workerState.valuePool) : randomValue(config.valueMinLength, config.valueMaxLength);
    if (workerState.valuePool.length < 512) workerState.valuePool.push(value);
    fields.push(`${name}=${value}`);
  }
  const body = fields.join('&');
  return {
    body,
    curl: `curl -s -X POST -d '${body}' ${config.targetUrl}`,
  };
}

export function normalizeConfig(input = {}) {
  const targetUrl = String(input.targetUrl || '').trim();
  let parsedUrl;
  try { parsedUrl = new URL(targetUrl); } catch { throw new Error('Target URL must be a valid http:// or https:// URL.'); }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('Target URL must use http:// or https://.');

  const integer = (value, fallback, min, max, label) => {
    const number = Number.parseInt(value ?? fallback, 10);
    if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label} must be between ${min} and ${max}.`);
    return number;
  };
  const durationUnits = { sec: 1, minute: 60, day: 86400, month: 2592000 };
  const durationUnit = String(input.durationUnit || 'sec');
  if (!Object.hasOwn(durationUnits, durationUnit)) throw new Error('Duration unit must be sec, minute, day, or month.');
  const durationMax = { sec: 86400, minute: 1440, day: 30, month: 1 };
  const durationValue = integer(input.durationValue ?? input.durationSeconds, 60, 1, durationMax[durationUnit], 'Run duration');
  const durationSeconds = durationValue * durationUnits[durationUnit];
  const config = {
    name: String(input.name || 'Secret wave').trim().slice(0, 120) || 'Secret wave',
    targetUrl,
    durationSeconds,
    requestTimeoutMs: integer(input.requestTimeoutMs, 10000, 100, 120000, 'Request timeout'),
    secretCount: integer(input.secretCount, 4, 1, 1000, 'Secret count'),
    secretMinLength: integer(input.secretMinLength, 2, 2, 20, 'Secret name minimum length'),
    secretMaxLength: integer(input.secretMaxLength, 8, 2, 20, 'Secret name maximum length'),
    valueMinLength: integer(input.valueMinLength, 12, 12, 40, 'Value minimum length'),
    valueMaxLength: integer(input.valueMaxLength, 40, 12, 40, 'Value maximum length'),
    allowRepeatedValues: input.allowRepeatedValues !== false,
    repeatPercent: integer(input.repeatPercent, 20, 0, 100, 'Repeat percentage'),
    dockerWorkers: integer(input.dockerWorkers, 100, 1, 10000, 'Docker workers'),
    workerConcurrency: integer(input.workerConcurrency, 16, 1, 256, 'Concurrency per worker'),
    successLogLimit: integer(input.successLogLimit, 200, 0, 10000, 'Successful cURL retention'),
    rampStartWorkers: integer(input.rampStartWorkers, 1, 1, 10000, 'Ramp-up starting workers'),
    rampDurationSeconds: integer(input.rampDurationSeconds, 0, 0, 86400, 'Ramp-up duration'),
  };
  if (config.secretMinLength > config.secretMaxLength) throw new Error('Secret name minimum length cannot exceed maximum length.');
  if (config.valueMinLength > config.valueMaxLength) throw new Error('Value minimum length cannot exceed maximum length.');
  if (config.rampStartWorkers > config.dockerWorkers) throw new Error('Ramp-up starting workers cannot exceed Docker workers.');
  if (config.rampDurationSeconds > config.durationSeconds) throw new Error('Ramp-up duration cannot exceed run time.');
  return config;
}
