// Runs Claude Pulse on made-up data, for screenshots. Nothing from your real ~/.claude is read.
// Usage: node docs/demo.js   then open http://127.0.0.1:47830/
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-demo-'));
const PORT = 47830;
const DESKTOP = process.platform === 'win32' ? path.join(HOME, 'AppData', 'Roaming', 'Claude')
  : process.platform === 'darwin' ? path.join(HOME, 'Library', 'Application Support', 'Claude') : path.join(HOME, '.config', 'Claude');
const now = Date.now(), H = 3600e3, D = 24 * H;
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = a => a[Math.floor(rnd() * a.length)];
const uuid = () => crypto.randomUUID();
const w = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

const PROJECTS = {
  'acme-storefront': ['Add a dark mode toggle to the header', 'Fix the checkout total rounding bug', 'Write tests for the cart reducer', 'Speed up product image loading'],
  'weather-cli': ['Add a --units flag', 'Cache API responses for 10 minutes', 'Explain how the forecast parser works'],
  'notes-api': ['Add pagination to GET /notes', 'Migrate the database to Postgres', 'Review this PR for security issues'],
  'portfolio-site': ['Make the hero section responsive', 'Add an RSS feed'],
  'data-scripts': ['Clean up the CSV import script', 'Plot weekly signups'],
};
const MODELS = ['claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const TOOLS = ['Read', 'Read', 'Read', 'Edit', 'Edit', 'Bash', 'Bash', 'Grep', 'Glob', 'Write', 'WebSearch'];
const SKILLS = ['frontend-design', 'code-review', 'pdf', 'xlsx'];

const firstSids = [];
for (const [name, prompts] of Object.entries(PROJECTS)) {
  const cwd = path.join(HOME, 'code', name);
  fs.mkdirSync(cwd, { recursive: true });
  const dir = path.join(HOME, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  for (let s = 0; s < 6; s++) {
    const sid = uuid(); firstSids.push([sid, cwd]);
    let t = now - Math.floor(rnd() * 13 * D) - 2 * H;
    if (s === 0) t = now - Math.floor(rnd() * 6 * H) - H; // something from today
    const day = new Date(t); day.setHours(9 + Math.floor(rnd() * 11)); t = Math.min(day.getTime(), now - 20 * 60e3);
    const lines = [];
    const model = pick(MODELS);
    const turns = 3 + Math.floor(rnd() * 10);
    for (let i = 0; i < turns; i++) {
      const ts = () => new Date(t += 20e3 + rnd() * 120e3).toISOString();
      lines.push({ type: 'user', timestamp: ts(), cwd, sessionId: sid, message: { role: 'user', content: i ? 'Looks good, continue.' : pick(prompts) } });
      for (let k = 0; k < 2 + Math.floor(rnd() * 5); k++) {
        const content = [{ type: 'text', text: 'Working on it.' }];
        if (rnd() < 0.8) content.push({ type: 'tool_use', name: pick(TOOLS), input: {} });
        if (rnd() < 0.06) content.push({ type: 'tool_use', name: 'Skill', input: { skill: pick(SKILLS) } });
        if (rnd() < 0.05) content.push({ type: 'tool_use', name: 'Agent', input: { subagent_type: pick(['Explore', 'general-purpose', 'Plan']) } });
        lines.push({ type: 'assistant', timestamp: ts(), cwd, sessionId: sid, message: { id: uuid(), model, content,
          usage: { input_tokens: 40 + Math.floor(rnd() * 900), output_tokens: 200 + Math.floor(rnd() * 2500),
            cache_read_input_tokens: 20000 + Math.floor(rnd() * 90000), cache_creation_input_tokens: Math.floor(rnd() * 8000) } } });
      }
    }
    w(path.join(dir, sid + '.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  }
}

// Plan usage the desktop app would have synced, and a Cowork task carrying exact reset times
const samples = [];
for (let t = now - 7 * D; t <= now; t += H) samples.push({ t, u: { fh: Math.round(20 + 40 * Math.abs(Math.sin(t / 9e6))), sd: Math.round(18 + 34 * (t - now + 7 * D) / (7 * D)) } });
samples[samples.length - 1].u = { fh: 64, sd: 52 };
w(path.join(DESKTOP, 'plan-usage-history.json'), JSON.stringify({ samples }));
const cw = path.join(DESKTOP, 'local-agent-mode-sessions', 'org', 'acct');
w(path.join(cw, 'local_demo.json'), JSON.stringify({ sessionId: 'local_demo', title: 'Summarise this week\'s meeting notes', model: 'claude-opus-5-5', createdAt: now - 26 * H, lastActivityAt: now - 25 * H }));
w(path.join(cw, 'local_demo', 'audit.jsonl'), [
  { type: 'user', timestamp: new Date(now - 26 * H).toISOString(), message: { content: 'Summarise this week\'s meeting notes' } },
  { type: 'assistant', timestamp: new Date(now - 26 * H + 60e3).toISOString(), message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 900, output_tokens: 3000, cache_read_input_tokens: 40000 } } },
  { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', resetsAt: Math.floor((now + 1.7 * H) / 1000) } },
  { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'seven_day', resetsAt: Math.floor((now + 3.4 * D) / 1000) } },
].map(l => JSON.stringify(l)).join('\n') + '\n');
for (const s of ['frontend-design', 'code-review', 'pdf']) fs.mkdirSync(path.join(HOME, '.claude', 'skills', s), { recursive: true });

const env = { ...process.env, HOME, USERPROFILE: HOME, APPDATA: path.join(HOME, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(HOME, 'AppData', 'Local'),
  XDG_CONFIG_HOME: path.join(HOME, '.config'), XDG_DATA_HOME: path.join(HOME, '.local', 'share'), CLAUDE_CONFIG_DIR: '', PULSE_PORT: String(PORT) };
delete env.CLAUDE_CONFIG_DIR;
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: 'inherit' });
// one "running" session (any live pid works)
const [sid, cwd] = firstSids[0];
w(path.join(HOME, '.claude', 'sessions', srv.pid + '.json'), JSON.stringify({ pid: srv.pid, sessionId: sid, cwd, status: 'busy', name: '', startedAt: now - 40 * 60e3, updatedAt: now - 60e3 }));
console.log(`Demo data in ${HOME}\nOpen http://127.0.0.1:${PORT}/`);
process.on('SIGINT', () => { srv.kill(); fs.rmSync(HOME, { recursive: true, force: true }); process.exit(); });
