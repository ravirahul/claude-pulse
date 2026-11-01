// Claude Pulse: local usage indexer + tiny HTTP server. Zero dependencies.
// Reads Claude Code transcripts, Cowork audit logs and the desktop app's plan-usage history,
// keeps per-file aggregates in a cache so only appended bytes are re-read.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const os = require('os');

const PORT = Number(process.env.PULSE_PORT || 47821);
const HOME = os.homedir();
const WIN = process.platform === 'win32', MAC = process.platform === 'darwin';
const CLAUDE = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
// Claude desktop app data + Pulse's own data, per platform
const DESKTOP = WIN ? path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Claude')
  : MAC ? path.join(HOME, 'Library', 'Application Support', 'Claude')
  : path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'Claude');
const DATA_DIR = WIN ? path.join(process.env.LOCALAPPDATA || HOME, 'ClaudePulse')
  : MAC ? path.join(HOME, 'Library', 'Application Support', 'ClaudePulse')
  : path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'ClaudePulse');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');
const CACHE_VERSION = 4;
const TOKEN = crypto.randomBytes(16).toString('hex');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, 'token'), TOKEN); // read by the tray app (same user profile)

// ---------- settings ----------
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const settings = Object.assign({ liveLimits: false, lan: false, alerts: true, devices: [] }, safeJSON0(SETTINGS_FILE));
function saveSettings() { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 1)); }
function safeJSON0(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } }

// ---------- pricing ($ per 1M tokens: input, output, cache read) ----------
const PRICES = [
  [/fable|mythos/, 10, 50, 0.25],
  [/opus-5-5/, 4, 20, 0.2],
  [/opus/, 5, 25, 0.5],
  [/sonnet-5/, 2, 10, 0.2],
  [/sonnet/, 3, 15, 0.3],
  [/haiku-5/, 0.1, 0.5, 0.01],
  [/haiku/, 1, 5, 0.1],
];
function price(model) {
  for (const p of PRICES) if (p[0].test(model)) return p;
  return [null, 4, 20, 0.2];
}

// ---------- helpers ----------
const pad = n => String(n).padStart(2, '0');
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const safeJSON = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
const lsDir = d => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) for (const c of content) if (c && c.type === 'text' && c.text) return c.text;
  return '';
}
function cleanTitle(s) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (!s || s.startsWith('<') || s.startsWith('[Request interrupted') || s.startsWith('Caveat:')) return '';
  return s.length > 90 ? s.slice(0, 88) + '…' : s;
}

// ---------- file discovery ----------
function discover() {
  const files = [];
  const desktopIds = new Set();
  // Desktop app "Code" sessions -> their CLI session ids
  for (const org of lsDir(path.join(DESKTOP, 'claude-code-sessions'))) {
    if (!org.isDirectory()) continue;
    const od = path.join(DESKTOP, 'claude-code-sessions', org.name);
    for (const acc of lsDir(od)) {
      if (!acc.isDirectory()) continue;
      for (const f of lsDir(path.join(od, acc.name))) {
        if (!f.name.startsWith('local_') || !f.name.endsWith('.json')) continue;
        const j = safeJSON(path.join(od, acc.name, f.name), null);
        if (j && j.cliSessionId) desktopIds.add(j.cliSessionId);
      }
    }
  }
  // Claude Code transcripts (+ subagent transcripts)
  const proj = path.join(CLAUDE, 'projects');
  for (const p of lsDir(proj)) {
    if (!p.isDirectory()) continue;
    const pd = path.join(proj, p.name);
    const desktopDir = /AppData-Roaming-Claude|Application-Support-Claude|config-Claude/i.test(p.name);
    for (const f of lsDir(pd)) {
      if (f.isFile() && f.name.endsWith('.jsonl')) {
        const sid = f.name.slice(0, -6);
        files.push({ file: path.join(pd, f.name), kind: desktopDir || desktopIds.has(sid) ? 'desktop' : 'cli', sid, proj: p.name });
      } else if (f.isDirectory()) {
        const sad = path.join(pd, f.name, 'subagents');
        for (const s of lsDir(sad)) {
          if (!s.isFile() || !s.name.endsWith('.jsonl')) continue;
          const meta = safeJSON(path.join(sad, s.name.replace(/\.jsonl$/, '.meta.json')), {});
          files.push({ file: path.join(sad, s.name), kind: 'agent', sid: f.name, proj: p.name,
            agentType: meta.agentType || 'unknown', title: cleanTitle(meta.description) });
        }
      }
    }
  }
  // Cowork (local agent mode) sessions
  const cw = path.join(DESKTOP, 'local-agent-mode-sessions');
  for (const org of lsDir(cw)) {
    if (!org.isDirectory()) continue;
    for (const acc of lsDir(path.join(cw, org.name))) {
      if (!acc.isDirectory()) continue;
      const ad = path.join(cw, org.name, acc.name);
      for (const f of lsDir(ad)) {
        if (!f.isFile() || !/^local_.*\.json$/.test(f.name)) continue;
        const meta = safeJSON(path.join(ad, f.name), {});
        const audit = path.join(ad, f.name.slice(0, -5), 'audit.jsonl');
        if (!fs.existsSync(audit)) continue;
        files.push({ file: audit, kind: 'cowork', sid: meta.sessionId || f.name, proj: 'cowork',
          title: cleanTitle(meta.title || meta.initialMessage), model: meta.model,
          created: meta.createdAt, lastAct: meta.lastActivityAt, archived: !!meta.isArchived });
      }
    }
  }
  return files;
}

// ---------- incremental parse ----------
function emptyAgg(d) {
  return { kind: d.kind, sid: d.sid, proj: d.proj, cwd: '', title: d.title || '', agentType: d.agentType,
    model: d.model, created: d.created, lastAct: d.lastAct, archived: d.archived,
    first: 0, last: 0, days: {}, hours: Array(24).fill(0), models: {}, tools: {}, skills: {}, agents: {},
    offset: 0, size: 0, mtime: 0, lastId: '' };
}

function parseChunk(agg, buf) {
  let start = 0;
  for (;;) {
    const nl = buf.indexOf(10, start);
    if (nl < 0) break;
    const line = buf.toString('utf8', start, nl);
    start = nl + 1;
    if (line.length < 20) continue;
    try { handleLine(agg, line); } catch { /* skip malformed line */ }
  }
  return start; // bytes consumed (complete lines only)
}

function handleLine(agg, line) {
  const isAsst = line.includes('"type":"assistant"');
  const isUser = !isAsst && line.includes('"type":"user"');
  if (!isAsst && !isUser) {
    if (line.includes('"rate_limit_event"')) { // Cowork logs carry exact reset times
      const j = JSON.parse(line), r = j.rate_limit_info;
      if (r && r.resetsAt && r.rateLimitType) (agg.rl || (agg.rl = {}))[r.rateLimitType] = r.resetsAt * 1000;
      return;
    }
    if (!agg.customTitle && (line.includes('"type":"custom-title"') || line.includes('"type":"summary"'))) {
      const j = JSON.parse(line);
      const t = cleanTitle(j.customTitle || j.summary);
      if (t) agg.customTitle = t;
    }
    return;
  }
  if (isUser && (line.length > 300000 || line.includes('"tool_result"') || line.includes('"isMeta":true'))) return;
  const j = JSON.parse(line);
  const ts = j.timestamp ? new Date(j.timestamp) : null;
  if (!ts || isNaN(ts)) return;
  const t = ts.getTime();
  if (!agg.first || t < agg.first) agg.first = t;
  if (t > agg.last) agg.last = t;
  if (!agg.cwd && j.cwd) agg.cwd = j.cwd;
  const dk = dayKey(ts);
  const day = agg.days[dk] || (agg.days[dk] = [0, 0, 0, 0, 0, 0, 0]); // in,out,cacheRead,cacheWrite,cost,msgs,prompts

  if (isUser) {
    const txt = textOf(j.message && j.message.content);
    if (!txt || txt.startsWith('<') || j.isSidechain && agg.kind !== 'agent') return;
    day[6]++;
    if (!agg.title) agg.title = cleanTitle(txt);
    return;
  }
  const m = j.message || {};
  const id = m.id || j.uuid;
  if (id && id === agg.lastId) { collectTools(agg, m); return; } // same API message split across lines
  agg.lastId = id || '';
  const u = m.usage;
  const model = m.model || agg.model || 'unknown';
  if (model === '<synthetic>') return;
  agg.hours[ts.getHours()]++;
  day[5]++;
  if (u) {
    const inp = u.input_tokens || 0, out = u.output_tokens || 0, cr = u.cache_read_input_tokens || 0;
    const cc = u.cache_creation || {};
    const cw1h = cc.ephemeral_1h_input_tokens || 0;
    const cwAll = u.cache_creation_input_tokens || 0;
    const cw5m = Math.max(0, cwAll - cw1h);
    const [, pi, po, pr] = price(model);
    const cost = (inp * pi + out * po + cr * pr + cw5m * pi * 1.25 + cw1h * pi * 2) / 1e6;
    day[0] += inp; day[1] += out; day[2] += cr; day[3] += cwAll; day[4] += cost;
    const mm = agg.models[model] || (agg.models[model] = [0, 0, 0]);
    mm[0] += inp + out + cr + cwAll; mm[1] += cost; mm[2]++;
  }
  collectTools(agg, m);
}

function collectTools(agg, m) {
  if (!Array.isArray(m.content)) return;
  for (const c of m.content) {
    if (!c || c.type !== 'tool_use') continue;
    const name = c.name || '?';
    agg.tools[name] = (agg.tools[name] || 0) + 1;
    const inp = c.input || {};
    if (name === 'Skill' && inp.skill) agg.skills[inp.skill] = (agg.skills[inp.skill] || 0) + 1;
    if ((name === 'Agent' || name === 'Task')) {
      const ty = inp.subagent_type || 'general-purpose';
      agg.agents[ty] = (agg.agents[ty] || 0) + 1;
    }
  }
}

// ---------- index state ----------
let cache = safeJSON(CACHE_FILE, null);
if (!cache || cache.v !== CACHE_VERSION) cache = { v: CACHE_VERSION, files: {} };
let indexing = { running: false, done: 0, total: 0 };
let lastScan = 0;
let statsMemo = null;

async function scan() {
  if (indexing.running) return;
  indexing = { running: true, done: 0, total: 0 };
  let changed = false;
  try {
    const list = discover();
    indexing.total = list.length;
    const seen = new Set();
    for (const d of list) {
      seen.add(d.file);
      let st;
      try { st = fs.statSync(d.file); } catch { indexing.done++; continue; }
      let agg = cache.files[d.file];
      if (agg && d.kind === 'cowork') Object.assign(agg, { title: d.title || agg.title, lastAct: d.lastAct, archived: d.archived });
      if (agg && agg.size === st.size && agg.mtime === st.mtimeMs) { indexing.done++; continue; }
      if (!agg || st.size < agg.offset) agg = emptyAgg(d);
      await readFrom(agg, d.file, st.size);
      agg.size = st.size; agg.mtime = st.mtimeMs;
      cache.files[d.file] = agg;
      changed = true;
      indexing.done++;
      await new Promise(r => setImmediate(r)); // keep the server responsive during first index
    }
    for (const f of Object.keys(cache.files)) if (!seen.has(f)) { delete cache.files[f]; changed = true; }
    if (changed) {
      statsMemo = null;
      fs.writeFile(CACHE_FILE + '.tmp', JSON.stringify(cache), e => { if (!e) fs.rename(CACHE_FILE + '.tmp', CACHE_FILE, () => {}); });
    }
  } finally {
    indexing.running = false;
    lastScan = Date.now();
  }
}

function readFrom(agg, file, size) {
  return new Promise(resolve => {
    if (size <= agg.offset) return resolve();
    const s = fs.createReadStream(file, { start: agg.offset, highWaterMark: 1 << 20 });
    let carry = Buffer.alloc(0);
    s.on('data', chunk => {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const used = parseChunk(agg, buf);
      agg.offset += used;
      carry = buf.subarray(used);
      if (carry.length > 64 << 20) { agg.offset += carry.length; carry = Buffer.alloc(0); } // runaway line
    });
    s.on('end', resolve);
    s.on('error', resolve);
  });
}

// ---------- live data ----------
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

function liveSessions() {
  const out = [];
  for (const f of lsDir(path.join(CLAUDE, 'sessions'))) {
    if (!/^\d+\.json$/.test(f.name)) continue;
    const j = safeJSON(path.join(CLAUDE, 'sessions', f.name), null);
    if (!j || !j.pid || !pidAlive(j.pid)) continue;
    out.push({ pid: j.pid, name: j.name || '', cwd: j.cwd || '', status: j.status || 'idle', kind: j.kind || '',
      startedAt: j.startedAt || 0, updatedAt: j.statusUpdatedAt || j.updatedAt || 0, sessionId: j.sessionId });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

function planUsage() {
  const h = safeJSON(path.join(DESKTOP, 'plan-usage-history.json'), null);
  if (!h || !Array.isArray(h.samples) || !h.samples.length) return null;
  const since = Date.now() - 7 * 864e5;
  const s = h.samples.filter(x => x.t >= since).map(x => [x.t, x.u.fh ?? null, x.u.sd ?? null]);
  const last = h.samples[h.samples.length - 1];
  return { samples: s, last: { t: last.t, fh: last.u.fh, sd: last.u.sd } };
}

// Live limits: the endpoint Claude Code's /usage uses. Opt-in, read-only, never refreshes the login
// token itself (that would rotate it under Claude Code); an expired token just pauses live mode.
const live = { t: 0, data: null, err: '', busy: false };
async function refreshLive(force) {
  if (!settings.liveLimits || live.busy || (!force && Date.now() - live.t < 120000)) return;
  live.busy = true;
  try {
    const c = credentials();
    if (!c.accessToken) throw new Error('Not signed in to Claude Code');
    if (c.expiresAt && c.expiresAt < Date.now()) throw new Error('Login expired. Open Claude Code once to refresh it');
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: 'Bearer ' + c.accessToken, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('Usage endpoint returned ' + r.status);
    const j = await r.json();
    const lim = (o) => o ? { pct: Math.round(o.utilization), reset: Date.parse(o.resets_at) || null, exact: true } : null;
    live.data = {
      fh: lim(j.five_hour), sd: lim(j.seven_day),
      scoped: (j.limits || []).filter(l => l.kind === 'weekly_scoped' && l.scope).map(l => ({
        name: (l.scope.model && l.scope.model.display_name) || (l.scope.surface && l.scope.surface.display_name) || 'Scoped',
        pct: Math.round(l.percent), reset: Date.parse(l.resets_at) || null })),
      breakdown: j.seven_day_breakdown ? j.seven_day_breakdown.rows.map(x => ({ name: x.display_name, pct: x.percent })) : null,
    };
    live.err = '';
  } catch (e) { live.err = e.name === 'TimeoutError' ? 'Usage endpoint timed out' : e.message; }
  finally { live.t = Date.now(); live.busy = false; }
}

// Claude Code keeps its login in ~/.claude/.credentials.json, except on macOS where it lives in the Keychain.
function credentials() {
  const f = safeJSON(path.join(CLAUDE, '.credentials.json'), {}).claudeAiOauth;
  if (f || !MAC) return f || {};
  try {
    const raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8', timeout: 5000 });
    return JSON.parse(raw).claudeAiOauth || {};
  } catch { return {}; }
}

// Limit alerts on macOS / Linux (on Windows the tray app shows them).
let alertedFor = 0, resetWatch = 0;
function notify() {
  if (WIN || !settings.alerts) return;
  const L = limits(), now = Date.now(), reset = L.fh.reset || 0;
  let msg = null;
  if (L.fh.pct >= 80 && reset > now && alertedFor !== reset) {
    alertedFor = resetWatch = reset;
    msg = [`5-hour limit at ${L.fh.pct}%`, 'Resets at ' + new Date(reset).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })];
  } else if (resetWatch && now >= resetWatch) { resetWatch = 0; msg = ['5-hour limit has reset', "You're back to full capacity."]; }
  if (!msg) return;
  const [title, body] = msg;
  const p = MAC ? spawn('osascript', ['-e', 'on run a', '-e', 'display notification (item 2 of a) with title (item 1 of a)', '-e', 'end run', title, body], { stdio: 'ignore' })
    : spawn('notify-send', ['-a', 'Claude Pulse', title, body], { stdio: 'ignore' });
  p.on('error', () => {});
}

// Without live mode: weekly reset projected from the last exact reset seen in Cowork logs (it keeps its
// weekday and time). The 5-hour reset is only shown when exact: estimating it from local activity was
// hours off in testing, because chats on claude.ai or the phone open windows we can't see.
function limits() {
  const now = Date.now(), plan = planUsage();
  if (live.data && !live.err && now - live.t < 10 * 60e3)
    return { src: 'live', at: live.t, fh: live.data.fh, sd: live.data.sd, scoped: live.data.scoped, breakdown: live.data.breakdown,
      liveOn: true, liveErr: '', samples: plan && plan.samples };
  const rl = {};
  for (const a of Object.values(cache.files)) for (const [k, v] of Object.entries(a.rl || {})) rl[k] = Math.max(rl[k] || 0, v);
  let sdReset = rl.seven_day || null;
  while (sdReset && sdReset < now) sdReset += 7 * 864e5;
  const fhReset = rl.five_hour > now ? rl.five_hour : null;
  const at = plan ? plan.last.t : 0;
  // a synced % from before a reset is meaningless; a 5-hour % older than 5 hours is too
  const fhPct = plan && (fhReset ? fhReset - 5 * 3600e3 <= at : now - at < 5 * 3600e3) ? plan.last.fh : null;
  const sdPct = plan && !(sdReset && sdReset - 7 * 864e5 > at) ? plan.last.sd : null;
  return { src: plan ? 'desktop' : 'none', at, liveOn: settings.liveLimits, liveErr: settings.liveLimits ? live.err : '',
    fh: { pct: fhPct, reset: fhReset, exact: true }, sd: { pct: sdPct, reset: sdReset, exact: true },
    scoped: [], breakdown: null, samples: plan && plan.samples };
}

function inventory() {
  const count = d => lsDir(d).filter(x => x.isDirectory()).length;
  const plugins = safeJSON(path.join(CLAUDE, 'plugins', 'installed_plugins.json'), {});
  const pluginCount = plugins.plugins ? Object.keys(plugins.plugins).length : count(path.join(CLAUDE, 'plugins', 'cache'));
  const agentFiles = lsDir(path.join(CLAUDE, 'agents')).filter(x => x.name.endsWith('.md')).length;
  const settings = safeJSON(path.join(CLAUDE, 'settings.json'), {});
  const desk = safeJSON(path.join(DESKTOP, 'claude_desktop_config.json'), {});
  return { skills: count(path.join(CLAUDE, 'skills')), plugins: pluginCount, agents: agentFiles,
    mcp: Object.keys(desk.mcpServers || {}).length + Object.keys(settings.mcpServers || {}).length };
}

// ---------- aggregation ----------
function buildStats() {
  if (statsMemo) return statsMemo;
  const files = Object.values(cache.files);
  const days = {};       // day -> {cli:[..7], desktop, cowork, agent}
  const hours = Array(24).fill(0);
  const models = {}, tools = {}, skills = {}, agentCalls = {}, agentRuns = {}, projects = {};
  const sessions = [];
  for (const a of files) {
    for (const [dk, v] of Object.entries(a.days)) {
      const dd = days[dk] || (days[dk] = {});
      const k = dd[a.kind] || (dd[a.kind] = [0, 0, 0, 0, 0, 0, 0, 0]);
      for (let i = 0; i < 7; i++) k[i] += v[i];
    }
    for (const dk of Object.keys(a.days)) { const k = days[dk][a.kind]; if (a.kind !== 'agent') k[7]++; } // sessions active that day
    a.hours.forEach((n, i) => hours[i] += n);
    for (const [m, v] of Object.entries(a.models)) {
      const x = models[m] || (models[m] = [0, 0, 0]); x[0] += v[0]; x[1] += v[1]; x[2] += v[2];
    }
    for (const [k, n] of Object.entries(a.tools)) tools[k] = (tools[k] || 0) + n;
    for (const [k, n] of Object.entries(a.skills)) skills[k] = (skills[k] || 0) + n;
    for (const [k, n] of Object.entries(a.agents)) agentCalls[k] = (agentCalls[k] || 0) + n;
    const dayVals = Object.values(a.days);
    const tok = dayVals.reduce((s, v) => s + v[0] + v[1] + v[2] + v[3], 0);
    const cost = dayVals.reduce((s, v) => s + v[4], 0);
    if (a.kind === 'agent') {
      const r = agentRuns[a.agentType] || (agentRuns[a.agentType] = { runs: 0, tokens: 0, cost: 0, last: 0, recent: [] });
      r.runs++; r.tokens += tok; r.cost += cost; r.last = Math.max(r.last, a.last);
      r.recent.push([a.last, a.title]);
      continue;
    }
    if (!a.first) continue;
    if (a.kind === 'cowork') {
      sessions.push({ sid: a.sid, kind: 'cowork', title: a.title || 'Untitled task', project: 'Cowork', cwd: '',
        model: a.model || Object.keys(a.models)[0] || '', first: a.created || a.first,
        last: Math.max(a.lastAct || 0, a.last), tokens: tok, cost, prompts: dayVals.reduce((s, v) => s + v[6], 0) });
      continue;
    }
    if (!tok && !dayVals.some(v => v[6])) continue; // empty / aborted session
    const cwd = a.cwd || a.proj;
    const scratch = /scratch-workspaces/i.test(cwd);
    const pname = scratch ? 'Desktop scratch' : path.basename(cwd) || cwd;
    const pkey = scratch ? 'desktop-scratch' : cwd;
    const p = projects[pkey] || (projects[pkey] = { name: pname, cwd: scratch ? '' : cwd, sessions: 0, tokens: 0, cost: 0, last: 0 });
    p.sessions++; p.tokens += tok; p.cost += cost; p.last = Math.max(p.last, a.last);
    sessions.push({ sid: a.sid, kind: a.kind, title: a.customTitle || a.title || '(no prompt)', cwd, project: pname,
      model: Object.keys(a.models).sort((x, y) => a.models[y][0] - a.models[x][0])[0] || '',
      first: a.first, last: a.last, tokens: tok, cost, prompts: dayVals.reduce((s, v) => s + v[6], 0) });
  }
  for (const r of Object.values(agentRuns)) r.recent = r.recent.sort((x, y) => y[0] - x[0]).slice(0, 3).map(x => x[1]).filter(Boolean);
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
  sessions.sort((a, b) => b.last - a.last);
  statsMemo = {
    days, hours,
    models: Object.entries(models).map(([m, v]) => ({ model: m, tokens: v[0], cost: v[1], msgs: v[2] })).sort((a, b) => b.tokens - a.tokens),
    tools: top(tools, 14), skills: top(skills, 10), agentCalls: top(agentCalls, 10),
    agentRuns: Object.entries(agentRuns).map(([t, v]) => ({ type: t, ...v })).sort((a, b) => b.runs - a.runs),
    projects: Object.values(projects).sort((a, b) => b.tokens - a.tokens).slice(0, 10),
    sessions: sessions.slice(0, 200), sessionCount: sessions.length,
    dirs: [...new Set(sessions.filter(s => s.kind === 'cli' && fs.existsSync(s.cwd)).map(s => s.cwd))].slice(0, 12),
  };
  return statsMemo;
}

// ---------- launching sessions ----------
const CLAUDE_EXE = (WIN ? [path.join(HOME, '.local', 'bin', 'claude.exe')]
  : [path.join(HOME, '.local', 'bin', 'claude'), path.join(HOME, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude'])
  .find(f => fs.existsSync(f)) || 'claude';
const MODELS = new Set(['', 'opus', 'sonnet', 'haiku', 'fable']);
const MODES = new Set(['', 'plan', 'acceptEdits', 'auto']);

function launch(body, remote) {
  const cwd = String(body.cwd || HOME);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('Folder not found: ' + cwd);
  const model = String(body.model || ''), mode = String(body.mode || '');
  if (!MODELS.has(model) || !MODES.has(mode)) throw new Error('Bad option');
  // a phone can start sessions, but never ones that skip permission prompts
  if (remote && (mode === 'auto' || mode === 'acceptEdits')) throw new Error('That permission mode is only available on the computer.');
  const args = [];
  // a name is always given so --remote-control never swallows the prompt as its optional value
  if (body.rc || remote) args.push('--remote-control', 'Pulse ' + (path.basename(cwd) || 'session'));
  if (body.resume) {
    if (!/^[0-9a-f-]{36}$/i.test(body.resume)) throw new Error('Bad session id');
    args.push('--resume', body.resume);
  }
  if (model) args.push('--model', model);
  if (mode) args.push('--permission-mode', mode);
  const prompt = String(body.prompt || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 4000);
  if (prompt && !body.resume) args.push(prompt);
  if (!WIN) return launchUnix(cwd, args);
  // Shell-launch claude.exe so it gets its own console (Windows Terminal when it is the default terminal).
  // Values travel in env vars, so nothing the user typed is ever parsed as PowerShell or cmd syntax.
  const env = { ...process.env, PULSE_EXE: CLAUDE_EXE, PULSE_CWD: cwd, PULSE_ARGS: args.map(winQuote).join(' ') };
  const ps = 'if ($env:PULSE_ARGS) { Start-Process -FilePath $env:PULSE_EXE -WorkingDirectory $env:PULSE_CWD -ArgumentList $env:PULSE_ARGS }' +
             ' else { Start-Process -FilePath $env:PULSE_EXE -WorkingDirectory $env:PULSE_CWD }';
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let err = '';
  child.stderr.on('data', d => { err += d; });
  child.on('error', e => console.error('launch failed:', e.message));
  child.on('exit', code => { if (code) console.error('launch failed:', code, err.trim().split('\n')[0]); });
}

// macOS: a new Terminal window. Linux: the first terminal found. Args are passed as argv or
// single-quoted, so nothing typed is ever parsed by a shell.
const shQuote = a => "'" + String(a).replace(/'/g, `'\\''`) + "'";
const TERMS = [['x-terminal-emulator', '-e'], ['gnome-terminal', '--'], ['ptyxis', '--'], ['kgx', '--'], ['konsole', '-e'],
  ['xfce4-terminal', '-x'], ['kitty'], ['alacritty', '-e'], ['foot'], ['wezterm', 'start', '--'], ['tilix', '-e'], ['xterm', '-e']];
function launchUnix(cwd, args) {
  if (MAC) {
    const cmd = 'cd ' + shQuote(cwd) + ' && ' + [CLAUDE_EXE, ...args].map(shQuote).join(' ');
    const p = spawn('osascript', ['-e', 'on run a', '-e', 'tell application "Terminal"', '-e', 'activate', '-e', 'do script (item 1 of a)',
      '-e', 'end tell', '-e', 'end run', cmd], { stdio: 'ignore' });
    return p.on('error', e => console.error('launch failed:', e.message));
  }
  const dirs = (process.env.PATH || '').split(':');
  const t = TERMS.find(([bin]) => dirs.some(d => fs.existsSync(path.join(d, bin))));
  if (!t) throw new Error('No terminal app found. Install one such as gnome-terminal, konsole or xterm.');
  const p = spawn(t[0], [...t.slice(1), CLAUDE_EXE, ...args], { cwd, detached: true, stdio: 'ignore' });
  p.on('error', e => console.error('launch failed:', e.message));
  p.unref();
}

// Quote one argument per the MSVCRT/CommandLineToArgvW rules.
function winQuote(a) {
  if (a && !/[\s"]/.test(a)) return a;
  return '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

// ---------- updates: compare with manifest.json on GitHub; update = git pull + restart ----------
const VERSION = safeJSON(path.join(__dirname, 'manifest.json'), {}).version || '0.0.0';
const REPO = 'ravirahul/claude-pulse';
const upd = { latest: '', checked: 0, err: '' };
function newer(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}
const updInfo = () => ({ version: VERSION, latest: upd.latest, available: !!upd.latest && newer(upd.latest, VERSION),
  checked: upd.checked, err: upd.err, git: fs.existsSync(path.join(__dirname, '.git')) });
async function checkUpdate() {
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/manifest.json`, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
    if (!r.ok) throw new Error('GitHub returned ' + r.status);
    upd.latest = String((await r.json()).version || ''); upd.err = '';
  } catch (e) { upd.err = 'Could not reach GitHub'; }
  upd.checked = Date.now();
  return updInfo();
}
const git = (...a) => execFileSync('git', a, { cwd: __dirname, encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: 'pipe' }).trim();
function applyUpdate() {
  if (!fs.existsSync(path.join(__dirname, '.git'))) throw new Error('This copy was not installed with git. Download the new version from GitHub.');
  let changed;
  try {
    const old = git('rev-parse', 'HEAD');
    git('pull', '--ff-only', '--quiet');
    changed = git('diff', '--name-only', old, 'HEAD').split('\n').filter(Boolean);
  } catch (e) { throw new Error('git pull failed: ' + String(e.stderr || e.message).trim().split('\n')[0]); }
  if (!changed.length) return { restart: false, note: 'Already up to date.' };
  if (WIN && changed.some(f => f === 'Pulse.cs' || f === 'build.ps1')) {
    // the tray app changed: rebuild it, which also restarts everything
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'build.ps1'), '-NoStartup', '-Silent'],
      { cwd: __dirname, detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return { restart: true, note: '' };
  }
  setTimeout(restartSelf, 400); // after the reply goes out
  return { restart: true, note: !WIN && changed.includes('install.sh') ? `To finish, run "sh install.sh" in ${__dirname} once.` : '' };
}
// The tray app (Windows), launchd or systemd start us again. With no supervisor, start a fresh copy first.
function restartSelf() {
  if (!process.env.PULSE_SUPERVISED) {
    server.close();
    spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
  process.exit(0);
}

function openUrl(u) {
  if (!/^https:\/\/(claude\.ai\/|bliink\.in\/?$|github\.com\/ravirahul\/claude-pulse)/.test(u)) throw new Error('Blocked URL');
  const [cmd, ...a] = WIN ? ['rundll32.exe', 'url.dll,FileProtocolHandler'] : MAC ? ['open'] : ['xdg-open'];
  spawn(cmd, [...a, u], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

// ---------- HTTP ----------
const INDEX = path.join(__dirname, 'index.html');
const STATIC = { '/qrcode.js': ['qrcode.js', 'text/javascript'], '/icon.png': ['icon.png', 'image/png'],
  '/manifest.json': ['manifest.json', 'application/manifest+json'] };
let wantNew = false; // set by the tray's "New session" item, consumed by the page's next poll
let pairing = null;  // { code, until } one-time QR pairing code

function send(res, code, body, type = 'application/json', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const isLoopback = a => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';

function lanIP() {
  const cands = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|VMware|VirtualBox|Tailscale|WSL|Hyper-V|Loopback|Bluetooth|docker|virbr|^br-|vmnet|utun|bridge/i.test(name)) continue;
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || !/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) continue;
      cands.push({ ip: a.address, wifi: /wi-?fi|wlan|wireless|^wl|^en0$/i.test(name) });
    }
  }
  cands.sort((a, b) => b.wifi - a.wifi);
  return cands.length ? cands[0].ip : null;
}

function deviceFor(req) {
  const m = /(?:^|;\s*)pulse_dev=([0-9a-f]{64})/.exec(req.headers.cookie || '');
  if (!m) return null;
  const h = sha(m[1]);
  return settings.devices.find(d => d.hash === h) || null;
}

function deviceName(ua) {
  ua = String(ua || '');
  const os_ = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return br ? `${os_} · ${br}` : os_;
}

const PAIR_PAGE = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Claude Pulse</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e9ecf2;font:15px system-ui;text-align:center;padding:24px">
<div><h2 style="margin:0 0 8px">Pair this phone</h2><p style="color:#9aa1b1;max-width:300px">On your computer, open Claude Pulse → Settings → Phone access, then scan the QR code with this phone's camera.</p></div>`;

const server = http.createServer((req, res) => {
  const host = req.headers.host || '';
  const remote = !isLoopback(req.socket.remoteAddress);
  const url = new URL(req.url, 'http://x');
  let device = null;

  if (!remote) {
    if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: 'bad host' });
  } else {
    // phones reach us by IP literal only, which rules out DNS-rebinding hostnames
    if (!settings.lan || !new RegExp(`^(\\d{1,3}\\.){3}\\d{1,3}:${PORT}$`).test(host)) return send(res, 403, { error: 'forbidden' });
    if (req.method === 'GET' && url.pathname === '/pair') {
      const c = url.searchParams.get('c') || '';
      if (!pairing || Date.now() > pairing.until || c.length !== pairing.code.length ||
          !crypto.timingSafeEqual(Buffer.from(c), Buffer.from(pairing.code)))
        return send(res, 403, PAIR_PAGE + '<p style="color:#f07272">That code expired. Make a new one on the computer.</p>', 'text/html; charset=utf-8');
      pairing = null;
      const tok = crypto.randomBytes(32).toString('hex');
      settings.devices.push({ id: crypto.randomBytes(4).toString('hex'), hash: sha(tok), name: deviceName(req.headers['user-agent']), added: Date.now(), seen: Date.now() });
      saveSettings();
      return send(res, 302, '', 'text/plain', { Location: '/',
        'Set-Cookie': `pulse_dev=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` });
    }
    device = deviceFor(req);
    if (!device) return send(res, 401, PAIR_PAGE, 'text/html; charset=utf-8');
    if (Date.now() - (device.seen || 0) > 3600e3) { device.seen = Date.now(); saveSettings(); }
  }

  if (req.method === 'GET' && url.pathname === '/') {
    return fs.readFile(INDEX, 'utf8', (e, html) => e ? send(res, 500, 'index missing', 'text/plain')
      : send(res, 200, html.replace('__PULSE_TOKEN__', TOKEN).replace(/__PULSE_VERSION__/g, VERSION), 'text/html; charset=utf-8'));
  }
  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [f, type] = STATIC[url.pathname];
    return fs.readFile(path.join(__dirname, f), (e, b) => e ? send(res, 404, 'missing', 'text/plain') : send(res, 200, b, type));
  }
  if (req.method === 'GET' && url.pathname === '/api/stats') {
    if (!indexing.running && Date.now() - lastScan > 10000) scan();
    refreshLive();
    const base = indexing.running && !Object.keys(cache.files).length ? null : buildStats();
    const openNew = !remote && wantNew; if (openNew) wantNew = false;
    return send(res, 200, { now: Date.now(), indexing, stats: base, live: liveSessions(), limits: limits(), inv: inventory(), openNew, remote, update: updInfo() });
  }
  // local-only from here on, except launching
  if (remote && !(req.method === 'POST' && url.pathname === '/api/launch')) return send(res, 403, { error: 'Only available on the computer' });

  if (req.method === 'GET' && url.pathname === '/api/signal-new') { wantNew = true; return send(res, 200, { ok: true }); }
  if (req.method === 'GET' && url.pathname === '/api/tray') {
    if (!indexing.running && Date.now() - lastScan > 10000) scan();
    refreshLive();
    const L = limits();
    const recent = Object.keys(cache.files).length ? buildStats().sessions.filter(s => s.kind === 'cli').slice(0, 8)
      .map(s => ({ sid: s.sid, title: s.title, cwd: s.cwd, project: s.project })) : [];
    return send(res, 200, { fh: L.fh.pct, fhReset: L.fh.reset, fhExact: L.fh.exact, sd: L.sd.pct, sdReset: L.sd.reset,
      alerts: settings.alerts, live: liveSessions().length, recent });
  }
  if (req.method === 'GET' && url.pathname === '/api/settings') {
    return send(res, 200, { liveLimits: settings.liveLimits, lan: settings.lan, alerts: settings.alerts, ip: lanIP(), port: PORT,
      devices: settings.devices.map(({ id, name, added, seen }) => ({ id, name, added, seen })) });
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    if (req.headers['x-pulse-token'] !== TOKEN) return send(res, 403, { error: 'bad token' });
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 20000) req.destroy(); });
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw || '{}');
        const p = url.pathname;
        if (p === '/api/launch') launch(body, remote);
        else if (p === '/api/open') openUrl(String(body.url || ''));
        else if (p === '/api/update/check') return send(res, 200, await checkUpdate());
        else if (p === '/api/update') return send(res, 200, applyUpdate());
        else if (p === '/api/rescan') { cache = { v: CACHE_VERSION, files: {} }; statsMemo = null; scan(); }
        else if (p === '/api/settings') {
          for (const k of ['liveLimits', 'alerts']) if (typeof body[k] === 'boolean') settings[k] = body[k];
          if (typeof body.lan === 'boolean' && body.lan !== settings.lan) {
            settings.lan = body.lan; if (!body.lan) pairing = null;
            res.on('finish', relisten); // rebinding drops open connections, so answer first
          }
          saveSettings();
          if (body.liveLimits) await refreshLive(true);
          if (body.liveLimits === false) { live.data = null; live.err = ''; }
          return send(res, 200, { ok: true, liveErr: live.err });
        } else if (p === '/api/pair') {
          const ip = lanIP();
          if (!settings.lan || !ip) throw new Error(ip ? 'Turn on phone access first.' : 'No Wi-Fi network found.');
          pairing = { code: crypto.randomBytes(12).toString('hex'), until: Date.now() + 5 * 60e3 };
          return send(res, 200, { url: `http://${ip}:${PORT}/pair?c=${pairing.code}`, until: pairing.until });
        } else if (p === '/api/devices/remove') {
          settings.devices = settings.devices.filter(d => d.id !== body.id); saveSettings();
        } else return send(res, 404, { error: 'not found' });
        send(res, 200, { ok: true });
      } catch (e) { send(res, 400, { error: e.message }); }
    });
    return;
  }
  send(res, 404, { error: 'not found' });
});

let bound = '';
function relisten() {
  const want = settings.lan ? '0.0.0.0' : '127.0.0.1';
  if (bound === want) return;
  const go = () => server.listen(PORT, want, () => { bound = want; console.log(`Claude Pulse on ${want}:${PORT}`); });
  if (server.listening) { server.close(go); server.closeAllConnections(); } else go();
}
server.on('error', e => { console.error(e.message); process.exit(e.code === 'EADDRINUSE' ? 3 : 1); });
relisten();
scan();
setTimeout(checkUpdate, 15000); setInterval(checkUpdate, 12 * 3600e3).unref();
setInterval(() => { if (!indexing.running && Date.now() - lastScan > 60000) scan(); refreshLive(); notify(); }, 30000).unref();
