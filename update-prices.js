#!/usr/bin/env node
/**
 * update-prices.js — 提取"现价"并写入 prices.json（可选热重载运行中的服务）
 *
 * 数据来源（按优先级）：
 *   1) --official <file>   离线官方价表（最准，自己维护，格式见文件底部注释）
 *   2) OpenRouter 公开 API  https://openrouter.ai/api/v1/models
 *      （免 key；返回的 prompt/completion/input_cache_* 是「每 token」美元价，
 *        脚本自动乘 1e6 换算成 USD / 1M tokens，并优先使用其 cache 价）
 *   3) 现有 prices.json 里已有的值（作为兜底，保证不会丢模型）
 *
 * 用法：
 *   node update-prices.js                 # 从 OpenRouter 拉，写 prices.json + 热重载
 *   node update-prices.js --dry-run       # 只看会改成什么，不写不重载
 *   node update-prices.js --official ./official-prices.json
 *   node update-prices.js --effective-date 2026-11-20
 *   OBS_URL=http://127.0.0.1:3180 node update-prices.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const prices = require('./lib/prices');
const { localDate, validDate } = require('./public/calendar');

const ROOT = __dirname;
const SERVER = process.env.OBS_URL || 'http://127.0.0.1:3180';
const OR_URL = 'https://openrouter.ai/api/v1/models';

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const dateIdx = args.indexOf('--effective-date');
const effectiveDate = dateIdx === -1 ? localDate() : args[dateIdx + 1];
const dryRun = args.includes('--dry-run');
const noReload = args.includes('--no-reload');
const orIdx = args.indexOf('--openrouter-url');
const OR_BASE = orIdx >= 0 ? args[orIdx + 1] : OR_URL;
const offIdx = args.indexOf('--official');
const OFFICIAL_FILE = offIdx >= 0 ? args[offIdx + 1] : path.join(ROOT, 'official-prices.json');

// ---------------------------------------------------------------------------
// 本地模型名 -> OpenRouter 模型 id 的映射表（按你实际用的模型填）
// 匹配不上的会走下面的模糊匹配；再匹配不上就保留 prices.json 原值。
// ---------------------------------------------------------------------------
const MODEL_MAP = {
  'gpt-5.5':            'openai/gpt-5.5',
  'gpt-5.6-sol':        'openai/gpt-5.6',
  'gpt-5.6-terra':      'openai/gpt-5.6',
  'gpt-5.6-luna':       'openai/gpt-5.6',
  'deepseek-v4-flash':  'deepseek/deepseek-chat',
  'deepseek-v4-flash-ga-260731': 'deepseek/deepseek-v4-flash-0731',
  'deepseek-v4-pro':    'deepseek/deepseek-reasoner',
  'deepseek-v4-pro-ga-260831':   'deepseek/deepseek-v4-pro-0813',
  'glm-5.2':            'z-ai/glm-4-plus',
  'glm-5.3':            'z-ai/glm-4-plus',
  'qwen3.8-max':        'qwen/qwen-max',
  'doubao-seed-2.0-pro':'bytedance/doubao-seed-1-6-250615',
  'mimo-v2.5':          'xiaomi/mimo-7b',
  'openrouter/free':    'openrouter/auto',
};

// cache read / cache write 的推算比例（很多源只给 input/output）
// cr = crRatio × input  （OpenRouter 常见 ~0.1×）
// cw = cwRatio × input  （缓存写入通常≈输入价）
const RATIOS = { cr: 0.1, cw: 1 };

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
const round = (n, d = 6) => { const p = 10 ** d; return Math.round(n * p) / p; };
const parseNum = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

// 带超时的 fetch（离线时快速失败，不卡住）
async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// 拉取正在使用的模型列表（优先问服务，服务挂了就退回 prices.json 的键）
async function getModelsInUse(current) {
  try {
    const res = await fetchWithTimeout(SERVER + '/api/stats', {}, 3000);
    const j = await res.json();
    if (j.stats && j.stats.byModel && j.stats.byModel.length) {
      return [...new Set(j.stats.byModel.map((m) => m.model))];
    }
  } catch { /* server 不在跑 */ }
  return Object.keys(current);
}

// 拉 OpenRouter 定价，返回 { openrouter_id: { i, o, cr?, cw? } }
// 注意：OpenRouter 的 prompt/completion/input_cache_* 单位是「每 token」，
// 这里统一乘 1e6 换算成「USD / 1M tokens」再存。
async function fetchOpenRouter() {
  const res = await fetchWithTimeout(OR_BASE, { headers: { Accept: 'application/json' } }, 12000);
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
  const j = await res.json();
  const out = {};
  for (const m of j.data || []) {
    const p = m.pricing || {};
    const i = parseNum(p.prompt), o = parseNum(p.completion);
    if (i == null || o == null) continue;
    const entry = {
      i: round(i * 1e6),
      o: round(o * 1e6),
    };
    const cr = parseNum(p.input_cache_read);
    const cw = parseNum(p.input_cache_write);
    if (cr != null) entry.cr = round(cr * 1e6);
    if (cw != null) entry.cw = round(cw * 1e6);
    out[m.id] = entry;
  }
  return out;
}

// 从名字里提取"日期版本"（取最后一段 4~8 位数字的后 4 位）：
//   'deepseek-v4-flash-ga-260731' -> '0731'
//   'deepseek-v4-flash-0731'      -> '0731'
function extractDate(s) {
  const m = s.match(/\d{4,8}/g);
  return m ? m[m.length - 1].slice(-4) : null;
}

// 去掉名字末尾的版本尾巴，得到"家族基名"：
//   'deepseek-v4-flash-ga-260731' -> 'deepseek-v4-flash'
//   'deepseek-v4-pro-ga-260831'   -> 'deepseek-v4-pro'
function localBase(s) {
  return s.replace(/-ga-\d+$/, '').replace(/-\d{6,8}$/, '').replace(/-\d{4}$/, '');
}

// 在 OpenRouter 结果里找一个模型，按优先级：
//   1) 精确匹配（本地名 = openrouter id 的后半段）
//   2) MODEL_MAP 显式映射
//   3) 评分匹配：家族基名相同者打分，日期版本一致者大幅加分，
//      再按 id 长度加分（更具体的优先），取最高分。
//      这样 deepseek-v4-flash-ga-260731 会优先命中 -0731 而不是 -vision-exp。
function matchOpenRouter(localModel, or) {
  const q = localModel.toLowerCase();
  for (const id of Object.keys(or)) {
    if (id.toLowerCase() === q || id.toLowerCase().endsWith('/' + q)) {
      return { source: id, p: or[id] };
    }
  }
  const direct = MODEL_MAP[localModel];
  if (direct && or[direct]) return { source: direct, p: or[direct] };

  const base = localBase(q);
  const localDate = extractDate(q);
  let best = null;
  for (const id of Object.keys(or)) {
    const tail = id.split('/').pop().toLowerCase();
    if (base && !tail.startsWith(base)) continue; // 家族不同，跳过
    let score = 10 + tail.length * 0.5;           // 越具体分越高
    const candDate = extractDate(tail);
    if (localDate && candDate && candDate === localDate) score += 100; // 日期一致，强烈优先
    if (!best || score > best.score) best = { source: id, p: or[id], score };
  }
  return best ? { source: best.source, p: best.p } : null;
}

// 把只有 i/o 的价格补全成 { i, o, cr, cw }
function complete(p) {
  return {
    i: round(p.i), o: round(p.o),
    cr: round(p.cr ?? p.i * RATIOS.cr),
    cw: round(p.cw ?? p.i * RATIOS.cw),
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  if (!validDate(effectiveDate)) throw new Error('--effective-date 需要 YYYY-MM-DD 日期');
  const current = prices.ratesAt(prices.load(), effectiveDate);
  const official = readJSON(OFFICIAL_FILE, null); // 有官方表时优先且不联网
  const models = await getModelsInUse(current);
  if (!models.length && official) models.push(...Object.keys(official));

  let or = {};
  if (official) {
    console.log(`[official] 使用离线价表 ${OFFICIAL_FILE}`);
  } else {
    try {
      or = await fetchOpenRouter();
      console.log(`[openrouter] 拉到 ${Object.keys(or).length} 个模型定价`);
    } catch (e) {
      console.warn(`[openrouter] 拉取失败（${e.message}），将退回现有 prices.json`);
    }
  }

  const changes = Object.create(null);
  const log = [];
  for (const model of models) {
    const cur = current[model];
    let found = null, src = null;

    if (official && official[model]) { found = complete(official[model]); src = 'official'; }
    else {
      const m = matchOpenRouter(model, or);
      if (m) { found = complete(m.p); src = `openrouter(${m.source})`; }
      else if (cur) { found = complete(cur); src = 'keep(existing)'; }
      else continue; // 没有来源也没有原值，跳过
    }
    const before = cur ? JSON.stringify(cur) : '∅';
    const after = JSON.stringify(found);
    if (before !== after) {
      changes[model] = found;
      log.push(`  ${model}: ${before} -> ${after}  [${src}]`);
    }
  }

  console.log(`\n生效日期 ${effectiveDate}，检查 ${models.length} 个模型，变更 ${log.length} 项。`);
  console.log(log.length ? '变更：\n' + log.join('\n') : '无变更。');

  if (dryRun) { console.log('\n[dry-run] 未写入。'); return; }

  if (!noReload) {
    try {
      const capabilities = await fetchWithTimeout(SERVER + '/api/prices?date=' + effectiveDate, {}, 3000);
      if (!capabilities.ok || !(await capabilities.json()).versioned) {
        // A legacy server treats a partial update as a replacement for the entire price file.
        console.warn('运行中的服务尚不支持历史单价。请更新并重启服务。');
      } else {
        const res = await fetchWithTimeout(SERVER + '/api/prices', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ perM: changes, effectiveDate }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { storeId } = await res.json();
        console.log(`已热重载 ${SERVER}，新单价自 ${effectiveDate} 生效。`);
        // The server serialized this write with UI edits. Write locally only
        // when OBS_URL points to a different store.
        if (prices.load().storeId === storeId) return;
      }
    } catch (e) {
      console.warn(`无法热重载（${e.message}），将使用本地价格文件。`);
    }
  }
  prices.saveChanges(changes, effectiveDate);
  console.log(`本机单价已保存，生效日期为 ${effectiveDate}。`);
}

main().catch((e) => { console.error('出错:', e); process.exit(1); });
