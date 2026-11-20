'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHmac } = require('node:crypto');
const { dataDir, readJSON, writeJSON } = require('./storage');
const { localDate, week, period, validDate } = require('../public/calendar');

const dir = path.join(dataDir, '.observatory-devices');
const identityFile = path.join(dir, 'identity.json');
const uuid = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;
const aliasKey = /^[\da-f]{16}$/;
const format = 'token-observatory/device-v1';
const fields = ['i', 'o', 'cr', 'cw'];

function identity() {
  let local = readJSON(identityFile, null);
  if (!local) {
    const id = randomUUID();
    local = { id, aliasSecret: randomUUID(), name: '设备-' + id.slice(0, 6), aliases: {} };
    writeJSON(identityFile, local);
  }
  return local;
}

function validLabel(value) {
  return typeof value === 'string' && value === value.trim() && value.length > 0 &&
    value.length <= 80 && !/[\x00-\x1f\x7f/\\:]/.test(value);
}

function keyFor(local, project) {
  return createHmac('sha256', local.aliasSecret).update(project).digest('hex').slice(0, 16);
}

function settings(stats, local = identity()) {
  const projects = stats.projects.map((project) => {
    const key = keyFor(local, project.id);
    return { key, name: project.name, path: project.path, alias: local.aliases[key] || '', fallback: '项目-' + key };
  });
  return { id: local.id, name: local.name, projects };
}

function saveSettings(input) {
  if (!input || !validLabel(input.name) || !input.aliases || typeof input.aliases !== 'object' ||
      Array.isArray(input.aliases)) throw new RangeError('请检查设备名称和项目别名');
  const local = identity();
  for (const [key, value] of Object.entries(input.aliases)) {
    if (!aliasKey.test(key) || (value !== '' && !validLabel(value))) {
      throw new RangeError('项目别名限 80 个字符，请使用不含路径的名称');
    }
    if (value) local.aliases[key] = value;
    else delete local.aliases[key];
  }
  writeJSON(identityFile, { ...local, name: input.name });
}

function exportLocal(stats, local = identity()) {
  const rows = [];
  for (const day of stats.worklog) {
    const grouped = new Map();
    for (const p of day.projects) {
      if (!p.tot) continue;
      const key = keyFor(local, p.id);
      const alias = local.aliases[key] || '项目-' + key;
      if (!grouped.has(alias)) grouped.set(alias, { date: day.date, project: alias, i: 0, o: 0, cr: 0, cw: 0 });
      for (const field of fields) grouped.get(alias)[field] += p[field];
    }
    rows.push(...grouped.values());
  }
  return { format, deviceId: local.id, deviceName: local.name, exportedAt: new Date().toISOString(), rows };
}

function parseSnapshot(input) {
  if (!input || input.format !== format || typeof input.deviceId !== 'string' || !uuid.test(input.deviceId) ||
      !validLabel(input.deviceName) || !Array.isArray(input.rows) || typeof input.exportedAt !== 'string' ||
      !Number.isFinite(Date.parse(input.exportedAt)) || new Date(input.exportedAt).toISOString() !== input.exportedAt) {
    throw new RangeError('无法识别此设备摘要');
  }
  const seen = new Set();
  let total = 0;
  const rows = input.rows.map((record) => {
    if (!record || !validDate(record.date) || !validLabel(record.project)) throw new RangeError('摘要中含有无效日期或项目别名');
    const key = record.date + '\0' + record.project;
    if (seen.has(key)) throw new RangeError('摘要中有重复的项目日期');
    seen.add(key);
    const row = { date: record.date, project: record.project };
    for (const field of fields) {
      const n = record[field];
      if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('Token 数必须是非负整数');
      row[field] = n;
      total += n;
    }
    return row;
  });
  if (!Number.isSafeInteger(total)) throw new RangeError('摘要用量超过整数范围');
  return { format, deviceId: input.deviceId, deviceName: input.deviceName, exportedAt: input.exportedAt, rows };
}

function importSnapshot(input) {
  const data = parseSnapshot(input);
  if (data.deviceId === identity().id) return 'self';
  const file = path.join(dir, data.deviceId + '.json');
  const stored = readJSON(file, null);
  if (stored && stored.exportedAt >= data.exportedAt) {
    return stored.exportedAt === data.exportedAt ? 'duplicate' : 'older';
  }
  writeJSON(file, data);
  return stored ? 'updated' : 'added';
}

function totals(name) {
  return { name, all: 0, current: 0, previous: 0 };
}

function overview(stats) {
  const local = identity();
  const range = week(stats.weekly?.end || localDate());
  const combined = totals('全部设备');
  const projects = new Map();
  const devices = [];
  function include(snapshot) {
    const device = { ...totals(snapshot.deviceName), id: snapshot.deviceId, exportedAt: snapshot.exportedAt };
    for (const row of snapshot.rows) {
      const tokens = row.i + row.o + row.cr + row.cw;
      const side = period(row.date, range);
      if (!projects.has(row.project)) projects.set(row.project, totals(row.project));
      for (const target of [combined, device, projects.get(row.project)]) {
        target.all += tokens;
        if (side) target[side] += tokens;
      }
    }
    devices.push(device);
  }
  include(exportLocal(stats, local));
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith('.json') && uuid.test(file.slice(0, -5))) include(readJSON(path.join(dir, file)));
  }
  return { range, local: settings(stats, local), combined, devices,
    projects: [...projects.values()].sort((a, b) => b.current - a.current || b.all - a.all) };
}

module.exports = { overview, exportLocal, importSnapshot, saveSettings };
