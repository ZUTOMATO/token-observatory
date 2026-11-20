'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, execFile, spawn } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const { promisify } = require('node:util');
const { zstdCompressSync } = require('node:zlib');
const calendar = require('../public/calendar');

const root = path.join(__dirname, '..');
const run = promisify(execFile);

test('calendar windows fill inactive days across month, leap-year and DST boundaries', () => {
  assert.deepEqual(calendar.week('2024-03-05'), {
    end: '2024-03-05', start: '2024-02-28', previousEnd: '2024-02-27', previousStart: '2024-02-21',
  });
  const rows = [{ date: '2026-11-02', n: 100 }, { date: '2026-11-19', n: 100 }];
  const days = calendar.series(rows, '2026-11-14', '2026-11-20', (date) => ({ date, n: 0 }));
  assert.equal(days.length, 7);
  assert.equal(days.reduce((n, d) => n + d.n, 0), 100);
  assert.equal(calendar.shift('2026-11-01', 1), '2026-11-02');
  assert.equal(calendar.shift('2027-01-01', -1), '2026-12-31');
  assert.equal(calendar.validDate('2026-02-29'), false);
});

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function codex(file, cwd, prompt, rows) {
  const events = [
    { type: 'session_meta', payload: { cwd, model: 'meter' } },
    { type: 'event_msg', payload: { type: 'user_message', message: prompt } },
    ...rows.map(([date, input, cached, output]) => ({
      type: 'event_msg', timestamp: date + 'T12:00:00Z', payload: { type: 'token_count',
        info: { last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } },
    })),
  ];
  write(file, events.map((row) => JSON.stringify(row).replace('"model":', '"model": ')).join('\n'));
}

async function start(env) {
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  try {
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw new Error(output);
      const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match && (await (await fetch(match[1] + '/api/stats')).json()).ready) return { url: match[1], stop };
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Server did not become ready. ' + output);
  } catch (e) { await stop(); throw e; }
}

test('scans, project review, pricing and device exchange via the HTTP server', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-observatory-'));
  const logs = path.join(dir, 'logs'), data = path.join(dir, 'data'), win = path.join(dir, 'win');
  const repo = path.join(dir, 'private-repo');
  const env = { ...process.env, TZ: 'UTC', PORT: '0', HOST: '127.0.0.1', OBS_LOG_HOME: logs,
    OBS_WINDOWS_USERS_DIR: win, OBS_DATA_DIR: data };
  const end = new Date().toISOString().slice(0, 10);
  const week = calendar.week(end);
  const old = calendar.shift(end, -20);
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  for (const [day, subject] of [[old, 'old change'], [week.start, 'start of window'], [end, 'current change']]) {
    const at = day + 'T00:00:00Z';
    execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.org',
      '-c', 'commit.gpgSign=false', 'commit', '-qm', subject, '--allow-empty'], {
      env: { ...env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
    });
  }

  codex(path.join(logs, '.codex/sessions/rollout-mixed.jsonl'), repo, 'private repair request',
    [[old, 1000, 0, 0], [week.previousEnd, 100, 20, 10], [week.start, 240, 40, 20]]);
  codex(path.join(win, 'alice/.codex/sessions/rollout-win.jsonl'), repo, 'private windows prompt', [[end, 4, 0, 0]]);
  const claude = { type: 'assistant', cwd: repo, timestamp: end + 'T12:00:00Z', message: {
    role: 'assistant', id: 'same-resumed-message', model: 'meter',
    usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 },
  } };
  for (const name of ['original', 'resumed']) {
    write(path.join(logs, '.claude/projects/sample', name + '.jsonl'), JSON.stringify(claude));
  }
  const dshFile = path.join(logs, '.dsh/sessions/workspace/session-test/session.jsonl.zstd');
  const dshFrames = [week.previousStart, end].map((date) => [
    { type: 'session', cwd: repo },
    { type: 'assistant/chunk', time: Date.parse(date + 'T12:00:00Z'), data: {
      chunk: { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } } } },
    { type: 'assistant/message', data: { message: { source: { model: 'meter' } } } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
  write(dshFile, Buffer.concat(dshFrames.map((frame) => zstdCompressSync(frame))));
  const rate = (n) => ({ i: n, o: n, cr: n, cw: n });
  const priceFile = path.join(data, 'prices.json');
  write(priceFile, JSON.stringify({ currency: 'USD', perM: { meter: rate(1), unused: rate(9) } }));
  let server = await start(env);
  t.after(async () => { await server.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const get = async (url) => (await fetch(server.url + url)).json();
  const post = (url, body) => fetch(server.url + url, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const stats = async () => (await get('/api/stats')).stats;
  let exported;

  await t.test('weekly totals reconcile with per-project, per-model and cross-week session usage on both hosts', async () => {
    const s = await stats();
    assert.equal(s.weekly.current.tokens, 277);
    assert.equal(s.weekly.previous.tokens, 113);
    assert.equal(s.hosts.win.weekly.current.tokens, 4);
    assert.equal(s.hosts.linux.weekly.current.tokens, 273);
    assert.equal(s.weekly.projects.length, 1);
    const p = s.weekly.projects[0];
    const mixed = p.sessions.find((x) => x.first === 'private repair request');
    assert.deepEqual([mixed.previous.tokens, mixed.current.tokens, mixed.current.cr], [110, 260, 40]);
    assert.equal(p.models.reduce((n, m) => n + m.current.tokens, 0), p.current.tokens);
    assert.equal(p.sessions.reduce((n, x) => n + x.previous.tokens, 0), p.previous.tokens);
    assert.equal(p.current.i + p.current.o + p.current.cr + p.current.cw, 277);
    assert.equal(s.fileCount.claude, 2);
  });

  await t.test('report returns only commits from the selected repo and inclusive reporting dates', async () => {
    const query = new URLSearchParams({ host: 'win', project: repo, end });
    const result = await get('/api/project-commits?' + query);
    assert.deepEqual(result.commits.map((c) => c.subject), ['current change', 'start of window']);
    const missing = new URLSearchParams({ host: 'all', project: dir });
    assert.equal((await fetch(server.url + '/api/project-commits?' + missing)).status, 404);
  });

  await t.test('legacy rates, backdating, dated updates and the updater preserve historical costs', async () => {
    assert.equal((await post('/api/prices', { perM: { meter: rate(3) }, effectiveDate: week.start })).status, 200);
    assert.equal((await post('/api/prices', { perM: { meter: rate(2) }, effectiveDate: week.previousStart })).status, 200);
    assert.equal((await post('/api/prices', { perM: { meter: rate(-1) } })).status, 400);
    const s = await stats();
    assert.ok(Math.abs(s.weekly.previous.cost - 113 * 2 / 1e6) < 1e-12);
    assert.ok(Math.abs(s.weekly.current.cost - 277 * 3 / 1e6) < 1e-12);
    assert.deepEqual((await get('/api/prices?date=' + old)).perM.meter, rate(1));
    const official = path.join(dir, 'official.json');
    write(official, JSON.stringify({ meter: rate(0) }));
    const args = ['update-prices.js', '--effective-date', end, '--official', official];
    const options = { cwd: root, env: { ...env, OBS_URL: server.url } };
    const before = fs.readFileSync(priceFile, 'utf8');
    await run(process.execPath, [...args, '--dry-run'], options);
    assert.equal(fs.readFileSync(priceFile, 'utf8'), before);
    await run(process.execPath, args, options);
    const saved = await get('/api/prices?date=' + end);
    assert.deepEqual(saved.perM.meter, rate(0));
    assert.deepEqual(saved.perM.unused, rate(9));
    assert.deepEqual((await get('/api/prices?date=' + week.start)).perM.meter, rate(3));
    const edits = ['second-model', 'third-model'].map((model) =>
      post('/api/prices', { perM: { [model]: rate(4) }, effectiveDate: end }));
    for (const response of await Promise.all(edits)) assert.equal(response.status, 200);
    const afterEdits = (await get('/api/prices?date=' + end)).perM;
    assert.deepEqual(afterEdits['second-model'], rate(4));
    assert.deepEqual(afterEdits['third-model'], rate(4));
  });

  await t.test('portable daily summaries merge aliases and replace snapshots idempotently', async () => {
    const local = (await get('/api/devices')).local;
    const anonymous = await get('/api/devices/export');
    for (const sensitive of [repo, 'private-repo', 'private repair request', 'rollout-', 'meter']) {
      assert.ok(!JSON.stringify(anonymous).includes(sensitive));
    }
    const settings = { name: 'Desktop', aliases: { [local.projects[0].key]: 'Shared project' } };
    assert.equal((await post('/api/devices/settings', settings)).status, 200);
    exported = await get('/api/devices/export');
    assert.equal(exported.deviceId, anonymous.deviceId);
    assert.ok(exported.rows.every((r) => r.project === 'Shared project'));
    const send = async (body) => (await (await post('/api/devices/import', body)).json()).state;
    assert.equal(await send(exported), 'self');
    const other = { ...exported, deviceId: '12345678-1234-4123-8123-123456789abc', deviceName: 'Laptop',
      rows: [{ date: end, project: 'Shared project', i: 11, o: 1, cr: 0, cw: 0 }] };
    assert.equal(await send(other), 'added');
    assert.equal(await send(other), 'duplicate');
    const replacement = { ...other, exportedAt: new Date(Date.parse(other.exportedAt) + 1000).toISOString(),
      rows: [{ ...other.rows[0], i: 21 }] };
    assert.equal(await send(replacement), 'updated');
    assert.equal(await send(other), 'older');
    assert.equal((await post('/api/devices/import', { ...replacement, rows: [other.rows[0], other.rows[0]] })).status, 400);
    const summary = await get('/api/devices');
    assert.equal(summary.devices.length, 2);
    assert.equal(summary.projects[0].current, 299);
    assert.equal(summary.combined.current, 299);
    assert.equal((await stats()).weekly.current.tokens, 277);
    assert.deepEqual((await get('/api/devices/export')).rows, exported.rows);
  });

  await t.test('cached scans, dated prices, source identity and imports survive a restart', async () => {
    await server.stop();
    server = await start(env);
    assert.equal((await get('/api/stats')).lastScan.reparsed, 0);
    assert.equal((await get('/api/devices/export')).deviceId, exported.deviceId);
    assert.equal((await get('/api/devices')).combined.current, 299);
    assert.deepEqual((await get('/api/prices?date=' + end)).perM.meter, rate(0));
  });
});

test('empty installations expose zero totals and a portable empty summary', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observatory-empty-'));
  const server = await start({ ...process.env, PORT: '0', HOST: '127.0.0.1',
    OBS_DATA_DIR: path.join(dir, 'state'), OBS_LOG_HOME: path.join(dir, 'logs'),
    OBS_WINDOWS_USERS_DIR: path.join(dir, 'windows') });
  t.after(async () => { await server.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { stats } = await (await fetch(server.url + '/api/stats')).json();
  for (const view of [stats, stats.hosts.win, stats.hosts.linux]) {
    assert.equal(view.weekly.current.tokens, 0);
    assert.equal(view.weekly.previous.tokens, 0);
    assert.deepEqual(view.weekly.projects, []);
  }
  const exported = await (await fetch(server.url + '/api/devices/export')).json();
  assert.deepEqual(exported.rows, []);
});

test('the updater preserves the local price book when an older server is still running', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observatory-legacy-'));
  let writes = 0;
  const legacy = http.createServer((req, res) => {
    if (req.method === 'POST') writes++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/stats' ? { stats: { byModel: [{ model: 'meter' }] } } : { perM: {} }));
  });
  legacy.listen(0, '127.0.0.1');
  await once(legacy, 'listening');
  t.after(async () => {
    await new Promise((resolve) => legacy.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const baseline = { unused: { i: 7, o: 5, cr: 0, cw: 0 } };
  write(path.join(dir, 'prices.json'), JSON.stringify({ currency: 'USD', perM: baseline }));
  const official = path.join(dir, 'official.json');
  write(official, JSON.stringify({ meter: { i: 1, o: 5 } }));
  await run(process.execPath, ['update-prices.js', '--official', official, '--effective-date', '2026-03-01'],
    { cwd: root, env: { ...process.env, OBS_DATA_DIR: dir, OBS_URL: 'http://127.0.0.1:' + legacy.address().port } });
  assert.equal(writes, 0);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'prices.json'), 'utf8'));
  assert.deepEqual(stored.perM, baseline);
  assert.equal(stored.history['2026-03-01'].meter.i, 1);
});
