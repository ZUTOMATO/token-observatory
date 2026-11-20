'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { week, shift, localDate } = require('../public/calendar');

const run = promisify(execFile);
const limit = 100;

async function projectCommits(project, end) {
  if (!project.path || !path.isAbsolute(project.path) || !fs.existsSync(path.join(project.path, '.git'))) {
    return { status: 'unavailable', commits: [] };
  }
  const { start } = week(end);
  const from = new Date(start + 'T00:00:00').getTime() / 1000;
  const until = new Date(shift(end, 1) + 'T00:00:00').getTime() / 1000 - 1;
  try {
    const { stdout } = await run('git', ['-C', project.path, 'log', '--no-patch', '--no-notes', '--no-decorate',
      '--no-show-signature', '--max-count=' + (limit + 1), '--since=@' + from, '--until=@' + until,
      '--format=%h%x00%ct%x00%s', 'HEAD', '--'], { timeout: 5000, maxBuffer: 1024 * 1024 });
    const commits = stdout.trimEnd().split('\n').filter(Boolean).map((line) => {
      const [hash, seconds, subject] = line.split('\0');
      return { hash, date: localDate(new Date(Number(seconds) * 1000)), subject };
    });
    return { status: 'ok', commits: commits.slice(0, limit), truncated: commits.length > limit };
  } catch {
    return { status: 'unavailable', commits: [] };
  }
}

module.exports = { projectCommits };
