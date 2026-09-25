// Shared helpers for export-catalog.mjs and import-catalog.mjs.
// Uses only Node.js built-ins (Node 18+), so there is nothing to install.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

export const KIT_DIR = dirname(fileURLToPath(import.meta.url));
export const OUTPUT_DIR = join(KIT_DIR, 'output');
export const DEFAULT_API_URL = 'https://api.monetizeplatform.com';
export const EXPORT_FORMAT_VERSION = 1;
/** Shared by every file one run writes, so they sort together and are easy to match up. */
export const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-');

const PAGE_SIZE = 100; // the API's maximum page size
const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 60_000;

export function assertNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    fail(`Node.js 18 or newer is required (found ${process.version}).`);
  }
}

/**
 * Loads KEY=VALUE lines from a .env file into process.env.
 * Variables that are already set in the shell take precedence over the file.
 */
export function loadEnvFile(path = join(KIT_DIR, '.env')) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0];
    value = quoted ? value.slice(1, -1) : value.replace(/\s+#.*$/, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`Missing ${name}. Set it in .env (see .env.example) or in your shell.`);
  return value;
}

/** Parses --flag and --option value arguments. `spec` maps each flag name to 'boolean' or 'string'. */
export function parseFlags(argv, spec) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const [name, inlineValue] = argv[i].replace(/^--/, '').split(/=(.*)/s);
    if (!argv[i].startsWith('--') || !(name in spec)) fail(`Unknown argument "${argv[i]}". Run with --help for usage.`);
    if (spec[name] === 'boolean') {
      flags[name] = true;
    } else {
      const value = inlineValue ?? argv[++i];
      if (value === undefined) fail(`--${name} needs a value.`);
      flags[name] = value;
    }
  }
  return flags;
}

export class ApiError extends Error {
  constructor(message, { method, path, status, body } = {}) {
    super(message);
    this.method = method;
    this.path = path;
    this.status = status;
    this.body = body;
  }
}

/**
 * Minimal client for the MonetizeNow REST API, authenticated with an API key.
 *
 * Reads are retried on rate limiting, server errors and network failures. Writes are retried only when the API
 * answers 429 (the request was rejected before it was processed), so a retry can never create a duplicate record.
 */
export function createApiClient({ apiUrl, apiKey }) {
  const baseUrl = apiUrl.replace(/\/+$/, '');

  async function request(method, path, body) {
    for (let attempt = 1; ; attempt++) {
      let response;
      try {
        response = await fetch(`${baseUrl}${path}`, {
          method,
          headers: {
            'x-api-key': apiKey,
            Accept: 'application/json',
            ...(body !== undefined && { 'Content-Type': 'application/json' }),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        if (method === 'GET' && attempt < MAX_ATTEMPTS) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new ApiError(`${method} ${path} failed: ${err.cause?.message ?? err.message}`, { method, path });
      }

      const text = await response.text();
      if (response.ok) {
        return text ? JSON.parse(text) : {};
      }

      const retryable = response.status === 429 || (method === 'GET' && response.status >= 500);
      if (retryable && attempt < MAX_ATTEMPTS) {
        await sleep(retryAfterMs(response) ?? backoffMs(attempt));
        continue;
      }
      throw new ApiError(describeFailure(method, path, response.status, text), {
        method,
        path,
        status: response.status,
        body: text,
      });
    }
  }

  /** Fetches every page of a list endpoint. */
  async function getAll(path) {
    const [pathname, query = ''] = path.split('?');
    const params = new URLSearchParams(query);
    params.set('pageSize', String(PAGE_SIZE));
    const results = [];
    for (let page = 0; ; page++) {
      params.set('currentPage', String(page));
      const response = await request('GET', `${pathname}?${params}`);
      const content = response.content ?? [];
      results.push(...content);
      if (content.length === 0 || page + 1 >= (response.totalPages ?? 0)) return results;
    }
  }

  return {
    apiUrl: baseUrl,
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    put: (path, body) => request('PUT', path, body),
    getAll,
  };
}

function describeFailure(method, path, status, text) {
  let detail = text;
  try {
    const parsed = JSON.parse(text);
    // Validation errors carry a generic message; the specific reasons are in subErrors.
    const summary = [parsed.message, parsed.error?.details, parsed.error].find((value) => typeof value === 'string');
    const reasons = (parsed.subErrors ?? [])
      .map((sub) => [sub.field, sub.message].filter(Boolean).join(': '))
      .filter(Boolean);
    detail = [summary, reasons.join('; ')].filter(Boolean).join(': ') || text;
  } catch {
    // not JSON, keep the raw text
  }
  const hint =
    status === 401 || status === 403
      ? ' (check that the API key is correct, belongs to this environment, and has admin permissions)'
      : '';
  return `${method} ${path} returned ${status}${hint}: ${truncate(detail, 1000)}`;
}

function backoffMs(attempt) {
  return Math.min(30_000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
}

function retryAfterMs(response) {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/** Runs `worker` over `items` with at most `concurrency` calls in flight. */
export async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  return results;
}

/** Returns a copy of `object` without keys whose value is null or undefined. */
export function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== null && value !== undefined));
}

export function nonEmpty(value) {
  return typeof value === 'string' && value.trim() === '' ? undefined : value;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Writes JSON through a temporary file so an interrupted run never leaves a half-written file behind. */
export function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
}

export function toCsv(rows, columns) {
  const escape = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.join(','), ...rows.map((row) => columns.map((column) => escape(row[column])).join(','))];
  // The byte-order mark makes spreadsheet apps read non-ASCII names correctly.
  return `\uFEFF${lines.join('\n')}\n`;
}

export function writeCsv(path, rows, columns) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, toCsv(rows, columns));
}

/** A short, non-reversible fingerprint used to tell API keys apart without storing them. */
export function fingerprint(secret) {
  return createHash('sha256').update(secret).digest('hex').slice(0, 12);
}

export function maskSecret(secret) {
  return secret.length <= 8 ? '****' : `${'*'.repeat(8)}${secret.slice(-4)}`;
}

export async function confirm(question) {
  if (!process.stdin.isTTY) {
    fail('Confirmation is required but no terminal is attached. Re-run with --yes to skip the prompt.');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question(`${question} (y/n) `)).trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') return true;
      if (answer === 'n' || answer === 'no') return false;
    }
  } finally {
    rl.close();
  }
}

export function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

export function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let logFile;

/** Starts copying everything the script prints to output/logs/<name>-<time>.log. Returns the file's path. */
export function openLogFile(name) {
  logFile = join(OUTPUT_DIR, 'logs', `${name}-${RUN_STAMP}.log`);
  mkdirSync(dirname(logFile), { recursive: true });
  return logFile;
}

function print(stream, message) {
  stream(message);
  if (!logFile) return;
  const time = new Date().toISOString();
  const lines = message.replace(/^\n+/, '').split('\n');
  appendFileSync(logFile, lines.map((line) => `${time} ${line}`).join('\n') + '\n');
}

export const log = {
  info: (message) => print(console.log, message),
  step: (message) => print(console.log, `\n== ${message}`),
  ok: (message) => print(console.log, `  ok    ${message}`),
  skip: (message) => print(console.log, `  skip  ${message}`),
  warn: (message) => print(console.warn, `  WARN  ${message}`),
  error: (message) => print(console.error, `  FAIL  ${message}`),
};

export function fail(message) {
  print(console.error, `\nError: ${message}`);
  process.exit(1);
}
