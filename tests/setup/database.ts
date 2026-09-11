import { afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Give every test run its own migrated database, before anything imports the
 * db client.
 *
 * Two problems this fixes at once. A test that reaches the real client used to
 * open whatever `SQLITE_PATH` pointed at — the developer's own dev database —
 * so a prompt override or a setting saved by hand could change what the suite
 * asserted, and CI got an empty file with no tables at all. The second half is
 * what broke: code reached the database through a path nobody had mocked, and
 * the failure surfaced as `no such table` in an unrelated test.
 *
 * `SQLITE_PATH` is read once when `src/server/env` is imported, and vitest runs
 * setup files before the test module, so setting it here is early enough.
 */
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'big-yahu-test-'));
process.env.SQLITE_PATH = path.join(directory, 'test.sqlite3');

const { runMigrations, closeDatabase } = await import('../../src/server/db/client');
runMigrations();

// Each test file gets its own worker, so each cleans up the database it made.
afterAll(() => {
  closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});
