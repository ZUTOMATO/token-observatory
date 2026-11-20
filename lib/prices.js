'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { dataDir, readJSON, writeJSON } = require('./storage');
const { localDate, validDate } = require('../public/calendar');

const priceFile = path.join(dataDir, 'prices.json');

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

function load() {
  const book = readJSON(priceFile, {});
  return { currency: 'USD', storeId: book.storeId, perM: book.perM || {}, history: book.history || {} };
}

function ratesAt(book, date) {
  const rates = Object.assign(Object.create(null), book.perM);
  for (const day of Object.keys(book.history).sort()) {
    if (day > date) break;
    Object.assign(rates, book.history[day]);
  }
  return rates;
}

function forModel(rates, model) {
  if (Object.hasOwn(rates, model)) return rates[model];
  if (Object.hasOwn(DEFAULT_PRICES, model)) return DEFAULT_PRICES[model];
  for (const [pattern, price] of Object.entries(DEFAULT_PRICES)) {
    if (pattern.endsWith('*') && model.startsWith(pattern.slice(0, -1))) return price;
  }
  return DEFAULT_PRICES.default;
}

function saveChanges(changes, date = localDate()) {
  if (!validDate(date) || !changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new RangeError('请提供有效的生效日期和模型单价');
  }
  const book = load();
  const patch = Object.assign(Object.create(null), book.history[date]);
  for (const [model, value] of Object.entries(changes)) {
    if (!model.trim() || !value || typeof value !== 'object' || Array.isArray(value)) {
      throw new RangeError('模型单价格式有误');
    }
    const price = {};
    for (const key of ['i', 'o', 'cr', 'cw']) {
      const amount = value[key] ?? 0;
      if (!Number.isFinite(amount) || amount < 0) throw new RangeError('单价必须是非负数字');
      price[key] = amount;
    }
    patch[model] = price;
  }
  if (Object.keys(changes).length) {
    book.storeId ||= randomUUID();
    book.history[date] = patch;
    writeJSON(priceFile, book);
  }
  return book;
}

module.exports = { defaults: DEFAULT_PRICES, load, ratesAt, forModel, saveChanges };
