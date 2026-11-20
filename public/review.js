'use strict';

const byId = (id) => document.getElementById(id);
const signedTokens = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n));
const exactTokens = new Intl.NumberFormat('zh-CN').format;
const exactChange = new Intl.NumberFormat('zh-CN', { signDisplay: 'exceptZero' }).format;
const rangeLabel = (w) => `${w.start} – ${w.end}，对比 ${w.previousStart} – ${w.previousEnd}`;
const hostLabel = (value) => ({ all: '全部本机日志', linux: 'Linux', win: 'Windows' })[value];

async function reviewJSON(url, body) {
  const options = body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  };
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败，请重试');
  return data;
}

function downloadText(content, type, filename) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function reviewTable(headings, rows) {
  return '<div class="review-scroll"><table class="review-table"><thead><tr>' +
    headings.map((h) => '<th scope="col">' + esc(h) + '</th>').join('') +
    '</tr></thead><tbody>' + rows.map((row) => '<tr>' +
      row.map((cell) => '<td>' + esc(cell) + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></div>';
}

document.querySelectorAll('dialog .btn[data-close]').forEach((button) => {
  button.onclick = () => button.closest('dialog').close();
});

let showAllGrowth = false;
let lastWeeklyKey = '';

function renderWeekly() {
  const w = STATS.weekly;
  const key = [STATS.generatedAt, host, showAllGrowth].join(':');
  if (key === lastWeeklyKey) return;
  lastWeeklyKey = key;
  byId('weeklyRange').textContent = rangeLabel(w);
  const growing = w.projects.filter((p) => p.current.tokens > p.previous.tokens);
  const rows = showAllGrowth ? w.projects : growing.slice(0, 3);
  byId('weeklyProjects').innerHTML = rows.map((p) => {
    const delta = p.current.tokens - p.previous.tokens;
    return `<button class="growth-row" data-project="${esc(p.id)}">
      <strong>${esc(p.name)}</strong><span>上期 ${fmt(p.previous.tokens)} · 本期 ${fmt(p.current.tokens)}</span>
      <b>${signedTokens(delta)} <small>tokens</small> ›</b></button>`;
  }).join('') || '<p class="review-note">' +
    (w.projects.length ? '本期没有用量增长的项目。' : '两个比较周期内均无用量。') + '</p>';
  const more = byId('weeklyMore');
  more.hidden = w.projects.length <= Math.min(3, growing.length);
  more.textContent = showAllGrowth ? '仅看增长前三' : `查看全部 ${w.projects.length} 个项目`;
}

byId('weeklyMore').onclick = () => { showAllGrowth = !showAllGrowth; renderWeekly(); };

byId('weeklyProjects').onclick = (event) => {
  const button = event.target.closest('[data-project]');
  if (!button) return;
  const p = STATS.weekly.projects.find((p) => p.id === button.dataset.project);
  const changes = (label, current, previous) => [label, exactTokens(previous), exactTokens(current), exactChange(current - previous)];
  const headings = ['类别', '上期 tokens', '本期 tokens', '变化'];
  const buckets = [['净输入', 'i'], ['输出', 'o'], ['缓存读取', 'cr'], ['缓存写入', 'cw'], ['合计', 'tokens']];
  byId('growthTitle').textContent = p.name + ' · 用量变化';
  byId('growthRange').textContent = rangeLabel(STATS.weekly) +
    `。估算费用从 USD ${p.previous.cost.toFixed(4)} 到 USD ${p.current.cost.toFixed(4)}。`;
  byId('growthDetail').innerHTML = '<h4>Token 构成</h4>' + reviewTable(headings,
    buckets.map(([label, key]) => changes(label, p.current[key], p.previous[key]))) +
    '<h4>按工具与模型</h4>' + reviewTable(['工具 / 模型', ...headings.slice(1)], p.models.map((m) =>
      changes(m.tool + ' · ' + m.model, m.current.tokens, m.previous.tokens))) +
    '<h4>按会话</h4>' + p.sessions.map((s) =>
      `<details class="session-change"><summary><span>${esc(s.tool)} · ${esc(s.first || s.file)}</span>
        <b>${exactChange(s.current.tokens - s.previous.tokens)} tokens</b></summary>
        <p class="review-note">${esc(hostLabel(s.host) || '本机')} · ${esc(s.firstDate)} – ${esc(s.lastDate)}</p>
        <code class="session-path">${esc(s.path)}</code>
        ${reviewTable(headings, buckets.map(([label, key]) => changes(label, s.current[key], s.previous[key])))}
      </details>`).join('');
  byId('growthDialog').showModal();
};

let reportWeek, reportHost;

function reportItem(title, kind) {
  return `<label class="report-item"><input type="checkbox" data-kind="${kind}"><span>${esc(title)}</span></label>`;
}

byId('reportBtn').onclick = () => {
  if (!STATS) return;
  reportWeek = STATS.weekly;
  reportHost = host;
  byId('reportRange').textContent = `${reportWeek.start} – ${reportWeek.end} · ${hostLabel(host)}。勾选要导出的会话与提交，可补写结果。`;
  byId('reportProjects').innerHTML = reportWeek.projects.filter((p) => p.current.tokens > 0).map((p) => {
    const sessions = p.sessions.filter((s) => s.current.tokens > 0);
    return `<section class="report-project" data-project="${esc(p.id)}">
      <h4>${esc(p.name)}</h4><p class="review-note">${fmt(p.current.tokens)} tokens · ${sessions.length} 个会话</p>
      <div class="report-items">${sessions.map((s, i) => reportItem(s.tool + ' · ' + (s.first || '会话 ' + (i + 1)), 'session')).join('')}</div>
      <button class="btn load-commits">读取本周 Git 提交</button><div class="report-commits" aria-live="polite"></div>
      <label class="review-field">工作结果<textarea rows="2" placeholder="这个项目本周完成了什么？"></textarea></label>
    </section>`;
  }).join('') || '<p class="review-note">当前主机近 7 天没有项目活动。</p>';
  byId('reportDialog').showModal();
};

byId('reportProjects').onclick = async (event) => {
  const button = event.target.closest('.load-commits');
  if (!button) return;
  const project = button.closest('[data-project]');
  const output = project.querySelector('.report-commits');
  button.disabled = true;
  output.textContent = '正在读取…';
  try {
    const query = new URLSearchParams({ host: reportHost, project: project.dataset.project, end: reportWeek.end });
    const data = await reviewJSON('/api/project-commits?' + query);
    if (data.status !== 'ok') {
      output.textContent = '当前无法读取这个项目的 Git 历史。';
      button.disabled = false;
      return;
    }
    output.innerHTML = data.commits.map((c) => reportItem(`${c.date} · ${c.hash} ${c.subject}`, 'commit')).join('') ||
      '这个项目在该时段没有提交。';
    if (data.truncated) output.append('显示最近 100 条提交。');
    button.hidden = true;
  } catch (err) { output.textContent = err.message; button.disabled = false; }
};

function markdownText(value) {
  return value.trim().replace(/\s+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#!|~])/g, '\\$1');
}

byId('downloadReport').onclick = () => {
  const w = reportWeek;
  const lines = [`# 开发周报 · ${w.start} – ${w.end}`, '',
    `${hostLabel(reportHost)} · ${w.current.tokens} tokens · 估算费用 USD ${w.current.cost.toFixed(4)}`];
  for (const section of byId('reportProjects').querySelectorAll('.report-project')) {
    const checked = [...section.querySelectorAll('input:checked')];
    const note = section.querySelector('textarea').value.trim();
    if (!checked.length && !note) continue;
    lines.push('', '## ' + markdownText(section.querySelector('h4').textContent));
    if (note) lines.push('', markdownText(note));
    for (const [key, title] of [['session', '代表会话'], ['commit', 'Git 提交']]) {
      const items = checked.filter((box) => box.dataset.kind === key);
      if (items.length) lines.push('', '### ' + title, '', ...items.map((box) => '- ' + markdownText(box.nextElementSibling.textContent)));
    }
  }
  downloadText(lines.join('\n') + '\n', 'text/markdown;charset=utf-8', `token-week-${w.end}.md`);
};

async function renderDevices(updateSettings = true) {
  const data = await reviewJSON('/api/devices');
  const headings = ['设备', '累计 tokens', '近 7 天', '较上期'];
  const row = (label, x) => [label, fmt(x.all), fmt(x.current), signedTokens(x.current - x.previous)];
  byId('deviceRange').textContent = rangeLabel(data.range) + '。日期按各设备记录的当地日期汇总。';
  byId('deviceTotals').innerHTML = reviewTable(headings, [
    row('全部设备', data.combined), ...data.devices.map((d) => row(d.name + (d.id === data.local.id ? '（本机）' : ''), d)),
  ]) + (data.projects.length ? '<details class="review-group"><summary>按项目别名查看</summary>' +
    reviewTable(['项目别名', ...headings.slice(1)], data.projects.map((p) => row(p.name, p))) + '</details>' : '');
  if (updateSettings) {
    byId('deviceName').value = data.local.name;
    byId('deviceAliases').innerHTML = data.local.projects.map((p) =>
      `<label class="review-field"><span title="${esc(p.path)}">${esc(p.name)}</span><input data-key="${p.key}" maxlength="80" value="${esc(p.alias)}" placeholder="${p.fallback}"></label>`).join('');
  }
}

byId('devicesBtn').onclick = async () => {
  byId('devicesDialog').showModal();
  byId('deviceStatus').textContent = '正在读取设备摘要…';
  try { await renderDevices(); byId('deviceStatus').textContent = ''; }
  catch (err) { byId('deviceStatus').textContent = err.message; }
};

async function saveDeviceSettings() {
  const aliases = {};
  for (const input of byId('deviceAliases').querySelectorAll('input')) aliases[input.dataset.key] = input.value.trim();
  await reviewJSON('/api/devices/settings', { name: byId('deviceName').value.trim(), aliases });
}

byId('saveDevice').onclick = async () => {
  try {
    await saveDeviceSettings();
    await renderDevices();
    byId('deviceStatus').textContent = '已保存名称与别名。';
  } catch (err) { byId('deviceStatus').textContent = err.message; }
};

byId('exportDevice').onclick = async () => {
  try {
    await saveDeviceSettings();
    const data = await reviewJSON('/api/devices/export');
    downloadText(JSON.stringify(data), 'application/json', `token-device-${data.deviceId}.json`);
    await renderDevices();
    byId('deviceStatus').textContent = `已导出本机 ${data.rows.length} 条每日项目记录。`;
  } catch (err) { byId('deviceStatus').textContent = err.message; }
};

byId('importDevice').onclick = () => byId('deviceFile').click();
byId('deviceFile').onchange = async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 16 * 1024 * 1024) throw new Error('单份摘要上限为 16 MiB。');
    const { state } = await reviewJSON('/api/devices/import', JSON.parse(await file.text()));
    await renderDevices(false);
    byId('deviceStatus').textContent = {
      self: '本机用量已计入汇总。', duplicate: '该摘要已导入。', older: '已保留这台设备较新的摘要。',
      added: '已加入设备汇总。', updated: '已更新这台设备的摘要。',
    }[state];
  } catch (err) { byId('deviceStatus').textContent = err.message; }
  finally { event.target.value = ''; }
};
