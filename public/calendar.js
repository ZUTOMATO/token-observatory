'use strict';

const UsageCalendar = (() => {
  function localDate(time = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;
  }

  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  // Input keys already represent local calendar dates. UTC arithmetic on the keys
  // advances a calendar day even across a short or long daylight-saving day.
  function shift(day, amount) {
    const date = new Date(day + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + amount);
    return date.toISOString().slice(0, 10);
  }

  function week(end = localDate()) {
    return { end, start: shift(end, -6), previousEnd: shift(end, -7), previousStart: shift(end, -13) };
  }

  function period(date, range) {
    if (date < range.previousStart || date > range.end) return null;
    return date < range.start ? 'previous' : 'current';
  }

  function series(rows, start, end, empty) {
    const byDate = new Map(rows.map((row) => [row.date, row]));
    const days = [];
    for (let date = start; date <= end; date = shift(date, 1)) {
      days.push(byDate.get(date) || empty(date));
    }
    return days;
  }

  return { localDate, validDate, shift, week, period, series };
})();

if (typeof module !== 'undefined') module.exports = UsageCalendar;
