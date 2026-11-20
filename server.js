#!/usr/bin/env node
/**
 * Token Observatory — local usage dashboard for dsh / codex / claude code.
 * Zero-dependency Node server: scans local session logs, aggregates token
 * usage by day / hour / tool / model / session, estimates cost, and serves
 * a static dashboard plus JSON API.
 *
 * Data sources (all local):
 *   dsh     <home>/.dsh/sessions/<workspace>/session-<id>/session.jsonl.zstd
 *   codex   <home>/.codex/sessions/YYYY/MM/DD/rollout-<id>.jsonl
 *   claude  <home>/.claude/projects/<project>/<session>.jsonl
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const cp = require('child_process');
const http = require('http');
const os = require('os');
const { dataDir, writeJSON } = require('./lib/storage');
const { localDate, validDate } = require('./public/calendar');
const { createWeekly } = require('./lib/weekly');
const { projectCommits } = require('./lib/commits');
const devices = require('./lib/devices');

const HOME = process.env.OBS_LOG_HOME || os.homedir();
const PORT = Number(process.env.PORT || 3180);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const CACHE_FILE = path.join(dataDir, '.scan-cache.json');
const RESCAN_INTERVAL_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function localParts(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    wd: (d.getDay() + 6) % 7, // 0 = Monday
    hour: d.getHours(),
  };
}

function isoToMs(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function* walk(dir, filter) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, filter);
    else if (e.isFile() && filter(e.name)) yield full;
  }
}

function readFileText(file, zstd) {
  if (!zstd) return fs.readFileSync(file, 'utf8');
  // dsh logs are multi-frame zstd (appended incrementally); Node's one-shot
  // zstdDecompressSync only returns the first frame, so shell out to `zstd`.
  try {
    return cp.execFileSync('zstd', ['-dc', file], { maxBuffer: 4 * 1024 ** 3 }).toString('utf8');
  } catch {
    try { return zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8'); }
    catch { return fs.readFileSync(file, 'utf8'); }
  }
}

/** Buckets: [freshInput, output, cacheRead, cacheWrite] */
const newB = () => [0, 0, 0, 0];
const bSum = (b) => b[0] + b[1] + b[2] + b[3];

// ---------------------------------------------------------------------------
// collector: per-file aggregation target
// ---------------------------------------------------------------------------

function makeColl() {
  return {
    agg: {},        // "date\u0000model" -> [i,o,cr,cw]
    hours: {},      // "wd*24+hour" -> total tokens
    first: null,    // first user message text
    firstDate: null,
    lastDate: null,
    tot: 0,
    calls: 0,
    ctx: null,      // workspace / cwd / project
    modelTot: {},   // model -> total (for dominant model)
  };
}

function emit(coll, ms, model, b) {
  const sum = bSum(b);
  if (sum <= 0) return;
  const lp = localParts(ms);
  const k = lp.date + '\u0000' + model;
  const cur = coll.agg[k] || (coll.agg[k] = newB());
  for (let i = 0; i < 4; i++) cur[i] += b[i];
  const hk = lp.wd * 24 + lp.hour;
  coll.hours[hk] = (coll.hours[hk] || 0) + sum;
  coll.tot += sum;
  coll.calls++;
  if (!coll.firstDate || lp.date < coll.firstDate) coll.firstDate = lp.date;
  if (!coll.lastDate || lp.date > coll.lastDate) coll.lastDate = lp.date;
  coll.modelTot[model] = (coll.modelTot[model] || 0) + sum;
}

function setFirst(coll, text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t && coll.first === null) coll.first = t.slice(0, 300);
}

function dominantModel(coll) {
  let best = null, bv = -1;
  for (const [m, v] of Object.entries(coll.modelTot)) if (v > bv) { bv = v; best = m; }
  return best || 'unknown';
}

function projectForContext(ctx) {
  let raw = String(ctx || '').trim();
  if (!raw) return { id: 'unknown', name: '未归类', path: null };
  if (path.sep === '/' && /^[A-Za-z]:[\\/]/.test(raw)) {
    const drive = '/mnt/' + raw[0].toLowerCase();
    if (!fs.existsSync(drive)) {
      return { id: 'windows:' + path.win32.normalize(raw).toLowerCase(), name: path.win32.basename(raw) || 'Windows', path: raw };
    }
    raw = path.join(drive, raw.slice(3).replace(/\\/g, '/'));
  }
  if (!path.isAbsolute(raw)) return { id: 'label:' + raw, name: raw, path: raw };

  let projectPath = path.normalize(raw);
  const worktreeMarker = path.sep + '.worktrees' + path.sep;
  const worktreeAt = projectPath.indexOf(worktreeMarker);
  if (worktreeAt > 0) {
    projectPath = projectPath.slice(0, worktreeAt);
  } else {
    const contextPath = projectPath;
    let cur = projectPath;
    try { if (!fs.statSync(cur).isDirectory()) cur = path.dirname(cur); } catch { /* path may no longer exist */ }
    while (cur && cur !== path.dirname(cur)) {
      // A home directory may itself be version-controlled for dotfiles. Do not
      // absorb every nested workspace into that repository.
      if (cur === HOME && contextPath !== HOME) break;
      const marker = path.join(cur, '.git');
      try {
        const st = fs.statSync(marker);
        projectPath = cur;
        if (st.isFile()) {
          const m = fs.readFileSync(marker, 'utf8').match(/^gitdir:\s*(.+)$/m);
          if (m) {
            const gitDir = path.resolve(cur, m[1].trim());
            const commonMarker = path.sep + '.git' + path.sep + 'worktrees' + path.sep;
            const commonAt = gitDir.indexOf(commonMarker);
            if (commonAt > 0) projectPath = gitDir.slice(0, commonAt);
          }
        }
        break;
      } catch { /* keep walking */ }
      cur = path.dirname(cur);
    }
  }

  return {
    id: projectPath,
    name: projectPath === HOME ? '主目录 · 未归类' : (path.basename(projectPath) || projectPath),
    path: projectPath,
  };
}

// ---------------------------------------------------------------------------
// parsers
// ---------------------------------------------------------------------------

/** DSH: usage chunks followed by assistant/message carrying the model. */
function parseDsh(text, coll) {
  let pendingDates = null;
  let lastModel = 'unknown';
  for (const line of text.split('\n')) {
    if (!line.includes('"assistant/') && !line.includes('"user/message"') && !line.includes('"session"')) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const data = d.data || {};
    if (d.type === 'session') {
      if (!coll.ctx && typeof d.cwd === 'string') coll.ctx = d.cwd;
    } else if (d.type === 'assistant/chunk') {
      const c = data.chunk || {};
      if (c.type === 'usage' && typeof d.time === 'number') {
        const u = c.usage || {};
        if (!pendingDates) pendingDates = {};
        const b = (pendingDates[d.time] ||= newB());
        b[0] += u.inputTokens || 0;
        b[1] += u.outputTokens || 0;
        b[2] += u.cacheReadTokens || 0;
        b[3] += u.cacheWriteTokens || 0;
      }
    } else if (d.type === 'assistant/message') {
      const model = ((data.message || {}).source || {}).model || lastModel;
      lastModel = model;
      if (pendingDates) {
        for (const [ts, b] of Object.entries(pendingDates)) emit(coll, Number(ts), model, b);
        pendingDates = null;
      }
    } else if (d.type === 'user/message') {
      const cs = data.content || [];
      setFirst(coll, cs.map((x) => (x && x.text) || '').join(' '));
    }
  }
  if (pendingDates) {
    for (const [ts, b] of Object.entries(pendingDates)) emit(coll, Number(ts), lastModel, b);
  }
}

/** Codex: token_count events; model from session_meta / turn_context. */
function parseCodex(text, coll) {
  let model = 'unknown';
  for (const line of text.split('\n')) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const p = d.payload || {};
    if (d.type === 'session_meta') {
      const initial = p.model || line.match(/"model"\s*:\s*"([^"]+)"/)?.[1];
      if (typeof initial === 'string') model = initial;
      if (!coll.ctx && p.cwd) coll.ctx = p.cwd;
      continue;
    }
    if (d.type === 'turn_context' && typeof p.model === 'string') { model = p.model; continue; }
    if (p.type === 'user_message') { setFirst(coll, p.message); continue; }
    if (p.type === 'token_count') {
      const ms = isoToMs(d.timestamp);
      if (ms === null) continue;
      const u = (p.info || {}).last_token_usage || {};
      const cached = u.cached_input_tokens || 0;
      const b = newB();
      b[0] = Math.max(0, (u.input_tokens || 0) - cached);
      b[1] = u.output_tokens || 0;
      b[2] = cached;
      b[3] = u.cache_write_input_tokens || 0;
      emit(coll, ms, model, b);
    }
  }
}

/** Claude: assistant message usage; ids deduped globally by caller. */
function parseClaude(text, coll, exclude, claimed, project) {
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"') && !line.includes('"user"')) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (!coll.ctx && typeof d.cwd === 'string' && d.cwd) coll.ctx = d.cwd;
    const m = d.message || {};
    if (d.type === 'user') {
      const c = m.content;
      if (typeof c === 'string') setFirst(coll, c);
      else if (Array.isArray(c)) setFirst(coll, c.filter((x) => x && x.type === 'text').map((x) => x.text).join(' '));
      continue;
    }
    if (m.role !== 'assistant') continue;
    const id = m.id;
    if (id) {
      if (exclude.has(id) || claimed.has(id)) continue;
      claimed.add(id);
    }
    const ms = isoToMs(d.timestamp);
    if (ms === null) continue;
    const model = m.model && m.model !== '<synthetic>' ? m.model : 'unknown';
    const u = m.usage || {};
    const b = newB();
    b[0] = u.input_tokens || 0;
    b[1] = u.output_tokens || 0;
    b[2] = u.cache_read_input_tokens || 0;
    b[3] = u.cache_creation_input_tokens || 0;
    emit(coll, ms, model, b);
  }
  if (!coll.ctx) coll.ctx = project;
}

// ---------------------------------------------------------------------------
// prices
// ---------------------------------------------------------------------------

const prices = require('./lib/prices');
let priceBook;
try { priceBook = prices.load(); }
catch (error) {
  console.warn('[prices] using default rates:', error.message);
  priceBook = { perM: {}, history: {} };
}
let dailyPrices = new Map();

function costOf(buckets, model, date) {
  if (!dailyPrices.has(date)) dailyPrices.set(date, prices.ratesAt(priceBook, date));
  const p = prices.forModel(dailyPrices.get(date), model);
  return (buckets[0] * (p.i || 0) + buckets[1] * (p.o || 0) +
    buckets[2] * (p.cr || 0) + buckets[3] * (p.cw || 0)) / 1e6;
}


// ---------------------------------------------------------------------------
// scanner + cache
// ---------------------------------------------------------------------------

// Windows user profiles auto-discovered under WSL's /mnt/c mount.
function discoverWindowsUsers() {
  const out = [];
  try {
    const users = process.env.OBS_WINDOWS_USERS_DIR || '/mnt/c/Users';
    if (fs.existsSync(users)) {
      for (const u of fs.readdirSync(users)) {
        const base = path.join(users, u);
        if (fs.existsSync(base + '/.codex') || fs.existsSync(base + '/.claude')) out.push(base);
      }
    }
  } catch { /* not a WSL host */ }
  return out;
}
const WIN_USERS = discoverWindowsUsers();

function fileHost(file) {
  return process.platform === 'win32' || WIN_USERS.some((dir) => file.startsWith(dir + path.sep)) ? 'win' : 'linux';
}

const TOOL_SOURCES = {
  dsh:    { dirs: [path.join(HOME, '.dsh', 'sessions')],                                                                  match: (n) => n === 'session.jsonl.zstd', zstd: true },
  codex:  { dirs: [path.join(HOME, '.codex', 'sessions'), ...WIN_USERS.map((u) => u + '/.codex/sessions')],                match: (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'), zstd: false },
  claude: { dirs: [path.join(HOME, '.claude', 'projects'), ...WIN_USERS.map((u) => u + '/.claude/projects')],              match: (n) => n.endsWith('.jsonl'), zstd: false },
};

let cache = loadCache();
let snapshot = null;
let scanning = false;
let lastScan = null;

function loadCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (raw && raw.v === 4 && raw.files) return raw;
  } catch { /* fresh */ }
  return { v: 4, files: {} };
}

function saveCache() {
  try { writeJSON(CACHE_FILE, cache); }
  catch (err) { console.error('[cache] write failed:', err.message); }
}

function scan() {
  if (scanning) return;
  scanning = true;
  const t0 = Date.now();
  let changed = 0;
  const seen = new Set();

  for (const tool of Object.keys(TOOL_SOURCES)) {
    const src = TOOL_SOURCES[tool];
    const files = [];
    for (const dir of src.dirs) {
      for (const f of walk(dir, src.match)) {
        try { files.push({ file: f, st: fs.statSync(f) }); } catch { /* gone */ }
      }
    }
    files.sort((a, b) => a.st.mtimeMs - b.st.mtimeMs);

    const globalClaimed = new Set(); // claude message-id dedup across files

    for (const { file, st } of files) {
      seen.add(file);
      const cached = cache.files[file];
      if (cached && cached.mt === st.mtimeMs && cached.sz === st.size) {
        if (tool === 'claude' && cached.ids) cached.ids.forEach((id) => globalClaimed.add(id));
        continue;
      }
      let text;
      try { text = readFileText(file, src.zstd); }
      catch (err) { console.error('[scan] read failed:', file, err.message); continue; }

      const coll = makeColl();
      const ids = [];
      if (tool === 'dsh') parseDsh(text, coll);
      else if (tool === 'codex') parseCodex(text, coll);
      else {
        const claimed = new Set();
        const project = path.basename(path.dirname(file));
        parseClaude(text, coll, globalClaimed, claimed, project);
        claimed.forEach((id) => ids.push(id));
      }

      cache.files[file] = {
        tool, mt: st.mtimeMs, sz: st.size,
        host: fileHost(file),
        agg: coll.agg, hours: coll.hours,
        tot: coll.tot, calls: coll.calls,
        first: coll.first, firstDate: coll.firstDate, lastDate: coll.lastDate,
        model: dominantModel(coll), ctx: coll.ctx,
        ...(tool === 'claude' ? { ids } : {}),
      };
      if (tool === 'claude') ids.forEach((id) => globalClaimed.add(id));
      changed++;
    }
  }

  for (const p of Object.keys(cache.files)) {
    if (!seen.has(p)) { delete cache.files[p]; changed++; }
  }

  snapshot = buildSnapshot();
  lastScan = { at: new Date().toISOString(), ms: Date.now() - t0, reparsed: changed };
  if (changed > 0) saveCache();
  scanning = false;
  console.log(`[scan] ${lastScan.ms}ms, reparsed=${changed}, files=${seen.size}`);
}

function aggregate(entries, today) {
  const weekly = createWeekly(today);
  const b2o = (b) => ({ i: b[0], o: b[1], cr: b[2], cw: b[3] });
  const totals = { all: newB(), dsh: newB(), codex: newB(), claude: newB() };
  const byDay = new Map();
  const byDayModel = new Map(); // date -> Map(model -> [i,o,cr,cw])
  const byModel = new Map();
  const byProject = new Map();
  const worklogByDay = new Map();
  const hours = { dsh: new Array(168).fill(0), codex: new Array(168).fill(0), claude: new Array(168).fill(0) };
  const costByDay = new Map();
  const costByTool = { dsh: 0, codex: 0, claude: 0 };
  const sessions = [];
  const fileCount = { dsh: 0, codex: 0, claude: 0 };

  function projectAgg(info) {
    let p = byProject.get(info.id);
    if (!p) {
      p = {
        ...info, b: newB(), cost: 0, calls: 0, sessionCount: 0,
        firstDate: null, lastDate: null,
        tools: { dsh: newB(), codex: newB(), claude: newB() },
        toolCost: { dsh: 0, codex: 0, claude: 0 },
        models: new Map(), sessions: [],
      };
      byProject.set(info.id, p);
    }
    return p;
  }

  function worklogProject(date, info) {
    let day = worklogByDay.get(date);
    if (!day) worklogByDay.set(date, day = new Map());
    let p = day.get(info.id);
    if (!p) {
      p = { ...info, tot: 0, i: 0, o: 0, cr: 0, cw: 0, cost: 0, tools: new Set(), sessionCount: 0, prompts: [] };
      day.set(info.id, p);
    }
    return p;
  }

  for (const [file, e] of entries) {
    const tool = e.tool;
    if (!TOOL_SOURCES[tool]) continue;
    fileCount[tool]++;
    const projectInfo = projectForContext(e.ctx);
    const project = projectAgg(projectInfo);
    let sessionCost = 0;

    for (const [k, b] of Object.entries(e.agg)) {
      const sep = k.indexOf('\u0000');
      const date = k.slice(0, sep);
      const model = k.slice(sep + 1);
      const sum = bSum(b);
      for (let i = 0; i < 4; i++) { totals.all[i] += b[i]; totals[tool][i] += b[i]; }
      let day = byDay.get(date);
      if (!day) byDay.set(date, day = { dsh: newB(), codex: newB(), claude: newB() });
      for (let i = 0; i < 4; i++) day[tool][i] += b[i];
      let dm = byDayModel.get(date);
      if (!dm) byDayModel.set(date, dm = new Map());
      let mb = dm.get(model);
      if (!mb) dm.set(model, mb = newB());
      for (let i = 0; i < 4; i++) mb[i] += b[i];
      const mk = tool + '\u0000' + model;
      let mm = byModel.get(mk);
      if (!mm) byModel.set(mk, mm = { tool, model, b: newB() });
      for (let i = 0; i < 4; i++) mm.b[i] += b[i];
      const c = costOf(b, model, date);
      weekly.add(date, projectInfo, file, e, model, b, c);
      costByDay.set(date, (costByDay.get(date) || 0) + c);
      costByTool[tool] += c;
      mm.cost = (mm.cost || 0) + c;
      sessionCost += c;

      for (let i = 0; i < 4; i++) { project.b[i] += b[i]; project.tools[tool][i] += b[i]; }
      project.cost += c;
      project.toolCost[tool] += c;
      if (!project.firstDate || date < project.firstDate) project.firstDate = date;
      if (!project.lastDate || date > project.lastDate) project.lastDate = date;
      const pmk = tool + '\u0000' + model;
      let pm = project.models.get(pmk);
      if (!pm) project.models.set(pmk, pm = { tool, model, b: newB(), cost: 0 });
      for (let i = 0; i < 4; i++) pm.b[i] += b[i];
      pm.cost += c;

      const logProject = worklogProject(date, projectInfo);
      logProject.tot += sum;
      logProject.i += b[0];
      logProject.o += b[1];
      logProject.cr += b[2];
      logProject.cw += b[3];
      logProject.cost += c;
      logProject.tools.add(tool);
    }

    for (const [hk, v] of Object.entries(e.hours)) hours[tool][Number(hk)] += v;

    if (e.tot > 0) {
      const session = {
        tool, file: path.basename(path.dirname(file)) + '/' + path.basename(file),
        host: e.host || fileHost(file),
        first: e.first, firstDate: e.firstDate, lastDate: e.lastDate,
        tot: e.tot, calls: e.calls, model: e.model, ctx: e.ctx, cost: sessionCost,
        projectId: projectInfo.id, projectName: projectInfo.name, projectPath: projectInfo.path,
      };
      sessions.push(session);
      project.sessions.push(session);
      project.sessionCount++;
      project.calls += e.calls;
      if (e.lastDate) {
        const logProject = worklogProject(e.lastDate, projectInfo);
        logProject.sessionCount++;
        if (e.first && logProject.prompts.length < 4 && !logProject.prompts.includes(e.first)) logProject.prompts.push(e.first);
      }
    }
  }

  sessions.sort((a, b) => b.tot - a.tot);

  const days = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, t]) => ({
      date, dsh: b2o(t.dsh), codex: b2o(t.codex), claude: b2o(t.claude),
      cost: costByDay.get(date) || 0,
    }));

  const models = [...byModel.values()]
    .map((m) => ({ tool: m.tool, model: m.model, ...b2o(m.b), cost: m.cost || 0 }))
    .sort((a, b) => (b.i + b.o + b.cr + b.cw) - (a.i + a.o + a.cr + a.cw));

  const dayModels = [...byDayModel.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, m]) => {
      const ms = [...m.entries()]
        .map(([model, b]) => ({ model, ...b2o(b) }))
        .sort((a, b) => (b.i + b.o + b.cr + b.cw) - (a.i + a.o + a.cr + a.cw));
      return { date, models: ms.slice(0, 6) }; // top models per day for the trend chart
    });

  const projects = [...byProject.values()]
    .map((p) => {
      p.sessions.sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || '') || b.tot - a.tot);
      const models = [...p.models.values()]
        .map((m) => ({ tool: m.tool, model: m.model, ...b2o(m.b), cost: m.cost }))
        .sort((a, b) => (b.i + b.o + b.cr + b.cw) - (a.i + a.o + a.cr + a.cw));
      const tools = Object.fromEntries(Object.keys(TOOL_SOURCES).map((tool) => [tool, {
        ...b2o(p.tools[tool]), cost: p.toolCost[tool],
      }]));
      return {
        id: p.id, name: p.name, path: p.path,
        ...b2o(p.b), cost: p.cost, calls: p.calls, sessionCount: p.sessionCount,
        firstDate: p.firstDate, lastDate: p.lastDate, tools,
        models: models.slice(0, 8),
        recentSessions: p.sessions.slice(0, 24),
      };
    })
    .filter((p) => p.i + p.o + p.cr + p.cw > 0)
    .sort((a, b) => (b.i + b.o + b.cr + b.cw) - (a.i + a.o + a.cr + a.cw));

  const worklog = [...worklogByDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, p]) => ({
      date,
      projects: [...p.values()]
        .map((x) => ({ ...x, tools: [...x.tools].sort() }))
        .sort((a, b) => b.tot - a.tot),
    }));

  return {
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    generatedAt: new Date().toISOString(),
    totals: Object.fromEntries(Object.entries(totals).map(([k, b]) => [k, b2o(b)])),
    cost: {
      total: costByTool.dsh + costByTool.codex + costByTool.claude,
      byTool: costByTool,
    },
    fileCount,
    byDay: days,
    byDayModel: dayModels,
    byModel: models,
    weekly: weekly.result(),
    projects,
    worklog,
    hours,
    sessions,
  };
}

// per-host slices: same aggregation over a filtered entry set
function buildSnapshot() {
  const entries = Object.entries(cache.files);
  const today = localDate();
  const hostOf = (file, e) => e.host || fileHost(file);
  const all = aggregate(entries, today);
  const linux = aggregate(entries.filter(([f, e]) => hostOf(f, e) !== 'win'), today);
  const win = aggregate(entries.filter(([f, e]) => hostOf(f, e) === 'win'), today);
  return { ...all, hosts: { linux, win } };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readBody(req, limit = 1024 * 1024) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new RangeError('请提交 JSON 数据');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes <= limit) chunks.push(chunk);
  }
  if (bytes > limit) throw new RangeError('文件过大，请缩小摘要后重试');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function handleReview(req, res, url) {
  const route = url.pathname;
  if (route === '/api/prices') {
    if (req.method === 'GET') {
      const date = url.searchParams.get('date') ?? localDate();
      if (!validDate(date)) throw new RangeError('请选择有效日期');
      return json(res, 200, { date, versioned: true, defaults: prices.defaults, perM: prices.ratesAt(priceBook, date) });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      priceBook = prices.saveChanges(body?.perM, body?.effectiveDate);
      dailyPrices.clear();
      snapshot = buildSnapshot();
      return json(res, 200, { ok: true, storeId: priceBook.storeId });
    }
  }
  if (!snapshot) return json(res, 503, { error: '首次扫描进行中' });
  if (route === '/api/project-commits' && req.method === 'GET') {
    const host = url.searchParams.get('host') || 'all';
    const view = host === 'all' ? snapshot : ['linux', 'win'].includes(host) && snapshot.hosts[host];
    const project = view && view.projects.find((p) => p.id === url.searchParams.get('project'));
    if (!project) return json(res, 404, { error: '没有找到此主机上的项目' });
    const date = url.searchParams.get('end') ?? view.weekly.end;
    if (!validDate(date)) throw new RangeError('请选择有效日期');
    return json(res, 200, await projectCommits(project, date));
  }
  if (route === '/api/devices' && req.method === 'GET') return json(res, 200, devices.overview(snapshot));
  if (route === '/api/devices/export' && req.method === 'GET') return json(res, 200, devices.exportLocal(snapshot));
  if (route === '/api/devices/import' && req.method === 'POST') {
    const state = devices.importSnapshot(await readBody(req, 16 * 1024 * 1024));
    return json(res, 200, { state });
  }
  if (route === '/api/devices/settings' && req.method === 'POST') {
    devices.saveSettings(await readBody(req));
    return json(res, 200, { ok: true });
  }
  return json(res, 405, { error: '请求方法或地址有误' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ready: !!snapshot, scanning, lastScan, stats: snapshot }));
    return;
  }

  if (url.pathname === '/api/rescan') {
    setImmediate(scan);
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === '/api/prices' || url.pathname === '/api/project-commits' || url.pathname.startsWith('/api/devices')) {
    handleReview(req, res, url).catch((error) => {
      const invalid = error instanceof RangeError || error instanceof SyntaxError;
      if (!invalid) console.error('[api]', error.message);
      json(res, invalid ? 400 : 500, { error: invalid ? error.message : '无法读取或保存本地数据' });
    });
    return;
  }

  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.normalize(path.join(PUB, p));
  if (!full.startsWith(PUB)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Token Observatory listening on http://${HOST}:${server.address().port}`);
  setImmediate(scan);
  setInterval(scan, RESCAN_INTERVAL_MS);
});
