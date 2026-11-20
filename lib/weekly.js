'use strict';

const { week, period } = require('../public/calendar');
const path = require('node:path');
const empty = () => ({ i: 0, o: 0, cr: 0, cw: 0, tokens: 0, cost: 0 });
const comparison = () => ({ current: empty(), previous: empty() });

function addUsage(target, [i, o, cr, cw], cost) {
  target.i += i;
  target.o += o;
  target.cr += cr;
  target.cw += cw;
  target.tokens += i + o + cr + cw;
  target.cost += cost;
}

function byGrowth(a, b) {
  const delta = (x) => x.current.tokens - x.previous.tokens;
  return delta(b) - delta(a) || b.current.tokens - a.current.tokens;
}

function createWeekly(end) {
  const range = week(end);
  const totals = comparison();
  const projects = new Map();

  function add(date, info, file, entry, model, buckets, cost) {
    const side = period(date, range);
    if (!side) return;
    let project = projects.get(info.id);
    if (!project) {
      project = { id: info.id, name: info.name, ...comparison(), models: new Map(), sessions: new Map() };
      projects.set(info.id, project);
    }
    const modelKey = entry.tool + '\0' + model;
    if (!project.models.has(modelKey)) {
      project.models.set(modelKey, { tool: entry.tool, model, ...comparison() });
    }
    if (!project.sessions.has(file)) {
      const shortFile = path.basename(path.dirname(file)) + '/' + path.basename(file);
      project.sessions.set(file, {
        tool: entry.tool, first: entry.first, file: shortFile, path: file, host: entry.host,
        firstDate: entry.firstDate, lastDate: entry.lastDate, ...comparison(),
      });
    }
    for (const row of [totals, project, project.models.get(modelKey), project.sessions.get(file)]) {
      addUsage(row[side], buckets, cost);
    }
  }

  function result() {
    const rows = [...projects.values()].sort(byGrowth).map((p) => ({
      ...p, models: [...p.models.values()].sort(byGrowth), sessions: [...p.sessions.values()].sort(byGrowth),
    }));
    return { ...range, ...totals, projects: rows };
  }
  return { add, result };
}

module.exports = { createWeekly };
