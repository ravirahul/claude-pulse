#!/usr/bin/env node
// Opens the Claude Pulse window on macOS / Linux (Windows uses the tray app, ClaudePulse.exe).
// Starts server.js first if the background service isn't running.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

const PORT = Number(process.env.PULSE_PORT || 47821);
const URL = `http://127.0.0.1:${PORT}/`;
const MAC = process.platform === 'darwin';
const DATA_DIR = MAC ? path.join(os.homedir(), 'Library', 'Application Support', 'ClaudePulse')
  : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'ClaudePulse');

const up = () => new Promise(r => http.get(URL + 'api/settings', res => { res.resume(); r(res.statusCode === 200); }).on('error', () => r(false)));

function startServer() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const log = fs.openSync(path.join(DATA_DIR, 'server.log'), 'a');
  spawn(process.execPath, ['--max-old-space-size=192', path.join(__dirname, 'server.js')], { detached: true, stdio: ['ignore', log, log] }).unref();
}

function chromium() {
  if (MAC) {
    return ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium', 'Vivaldi']
      .find(a => fs.existsSync(`/Applications/${a}.app`) || fs.existsSync(path.join(os.homedir(), 'Applications', `${a}.app`)));
  }
  const dirs = (process.env.PATH || '').split(':');
  return ['google-chrome', 'google-chrome-stable', 'microsoft-edge', 'brave-browser', 'chromium', 'chromium-browser', 'vivaldi']
    .find(b => dirs.some(d => fs.existsSync(path.join(d, b))));
}

function openWindow(hash) {
  const flags = [`--app=${URL}${hash}`, `--user-data-dir=${path.join(DATA_DIR, 'browser')}`, '--window-size=460,820',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync'];
  const app = chromium();
  const [cmd, args] = app ? (MAC ? ['open', ['-na', app, '--args', ...flags]] : [app, flags])
    : [MAC ? 'open' : 'xdg-open', [URL + hash]]; // no Chromium browser: default browser tab
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', e => console.error(e.message)).unref();
}

(async () => {
  if (!(await up())) {
    startServer();
    for (let i = 0; i < 40 && !(await up()); i++) await new Promise(r => setTimeout(r, 250));
  }
  openWindow(process.argv.includes('--new') ? '#new' : '');
})();
