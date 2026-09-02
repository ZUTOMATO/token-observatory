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

const HOME = os.homedir();
const PORT = Number(process.env.PORT || 3180);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const CACHE_FILE = path.join(ROOT, '.scan-cache.json');
const PRICES_FILE = path.join(ROOT, 'prices.json');
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
    return cp.execFileSync('zstd', ['-dc', file], { maxBuffer: 4 << 30 }).toString('utf8');
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
  const raw = String(ctx || '').trim();
  if (!raw) return { id: 'unknown', name: '未归类', path: null };
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
    if (!line.includes('"assistant/') && !line.includes('"user/message"') && !line.includes('"type":"session"')) continue;
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
      const m = line.match(/"model":"([^"]+)"/);
      if (m) model = m[1];
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

const DEFAULT_PRICES = {
  // USD per 1M tokens: i=fresh input, o=output, cr=cache read, cw=cache write
  'gpt-5.6-sol':            { i: 2.5,  o: 15,  cr: 0.25,  cw: 2.5 },
  'gpt-5.5':                { i: 2.5,  o: 15,  cr: 0.25,  cw: 2.5 },
  'gpt-5*':                 { i: 1.25, o: 10,  cr: 0.125, cw: 1.25 },
  'deepseek-v4-flash*':     { i: 0.05, o: 0.4, cr: 0.005, cw: 0.05 },
  'deepseek-v4-pro*':       { i: 0.5,  o: 2.4, cr: 0.05,  cw: 0.5 },
  'deepseek*':              { i: 0.3,  o: 1.2, cr: 0.03,  cw: 0.3 },
  'glm-5*':                 { i: 0.6,  o: 2.4, cr: 0.06,  cw: 0.6 },
  'glm*':                   { i: 0.4,  o: 1.6, cr: 0.04,  cw: 0.4 },
  'qwen3*':                 { i: 0.4,  o: 1.6, cr: 0.04,  cw: 0.4 },
  'claude*':                { i: 3,    o: 15,  cr: 0.3,   cw: 3.75 },
  'default':                { i: 1,    o: 5,   cr: 0.1,   cw: 1 },
};

let userPrices = {};
function loadPrices() {
  try {
    const raw = JSON.parse(fs.readFileSync(PRICES_FILE, 'utf8'));
    if (raw && typeof raw === 'object') userPrices = raw.perM || {};
  } catch { userPrices = {}; }
}
function savePrices(perM) {
  userPrices = perM || {};
  fs.writeFileSync(PRICES_FILE, JSON.stringify({ currency: 'USD', perM: userPrices }, null, 2));
}
function priceFor(model) {
  if (userPrices[model]) return userPrices[model];
  if (DEFAULT_PRICES[model]) return DEFAULT_PRICES[model];
  for (const [k, v] of Object.entries(DEFAULT_PRICES)) {
    if (k.endsWith('*') && model.startsWith(k.slice(0, -1))) return v;
  }
  return DEFAULT_PRICES.default;
}
function costOf(b, model) {
  const p = priceFor(model);
  return (b[0] * (p.i || 0) + b[1] * (p.o || 0) + b[2] * (p.cr || 0) + b[3] * (p.cw || 0)) / 1e6;
}
loadPrices();

// ---------------------------------------------------------------------------
// scanner + cache
// ---------------------------------------------------------------------------

// Windows user profiles auto-discovered under WSL's /mnt/c mount.
function discoverWindowsUsers() {
  const out = [];
  try {
    if (fs.existsSync('/mnt/c/Users')) {
      for (const u of fs.readdirSync('/mnt/c/Users')) {
        const base = '/mnt/c/Users/' + u;
        if (fs.existsSync(base + '/.codex') || fs.existsSync(base + '/.claude')) out.push(base);
      }
    }
  } catch { /* not a WSL host */ }
  return out;
}
const WIN_USERS = discoverWindowsUsers();

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
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); }
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

function buildSnapshot() {
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
      p = { ...info, tot: 0, cost: 0, tools: new Set(), sessionCount: 0, prompts: [] };
      day.set(info.id, p);
    }
    return p;
  }

  for (const [file, e] of Object.entries(cache.files)) {
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
      const c = costOf(b, model);
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
      logProject.cost += c;
      logProject.tools.add(tool);
    }

    for (const [hk, v] of Object.entries(e.hours)) hours[tool][Number(hk)] += v;

    if (e.tot > 0) {
      const session = {
        tool, file: path.basename(path.dirname(file)) + '/' + path.basename(file),
        host: file.startsWith('/mnt/c/') ? 'win' : 'linux',
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
    projects,
    worklog,
    hours,
    sessions,
  };
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

  if (url.pathname === '/api/prices') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ defaults: DEFAULT_PRICES, perM: userPrices }));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1 << 20) req.destroy(); });
      req.on('end', () => {
        try {
          const perM = JSON.parse(body).perM || {};
          savePrices(perM);
          snapshot = buildSnapshot(); // recompute costs
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false }));
        }
      });
      return;
    }
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
  console.log(`Token Observatory listening on http://${HOST}:${PORT}`);
  setImmediate(scan);
  setInterval(scan, RESCAN_INTERVAL_MS);
});
