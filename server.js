#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════
   🤖  BOT HOST SERVER v3.3  —  Web UI + API + Auth + Shop
   ══════════════════════════════════════════════════════════════════════════

   ✅ CHẠY:   node server.js
   ✅ TOKEN:  API_TOKEN="xxx" node server.js
   ❌ KHÔNG:  python server.js

   Tài khoản admin mặc định:  admin / admin123
   (Đổi ngay sau khi đăng nhập lần đầu!)
   ══════════════════════════════════════════════════════════════════════════ */

'use strict';

const os     = require('os');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

/* ── KIỂM TRA NODE ── */
const NODE_MAJOR = parseInt(process.versions.node.split('.')[0], 10);
if (NODE_MAJOR < 16) {
  console.error(`\n❌ Node.js quá cũ: v${process.versions.node}\n   Cần v16+. Cài: pkg install nodejs\n`);
  process.exit(1);
}

/* ── KIỂM TRA DEPENDENCIES ── */
const REQUIRED_MODULES = ['express', 'multer', 'cors', 'systeminformation', 'adm-zip'];
(function checkDependencies() {
  const missing = [];
  for (const m of REQUIRED_MODULES) {
    try { require.resolve(m); } catch (e) { missing.push(m); }
  }
  if (missing.length === 0) return;
  console.error('\n❌ THIẾU PACKAGE:\n   ' + missing.join(', ') + '\n\n   Chạy: npm install\n');
  process.exit(1);
})();

/* ── IMPORT ── */
const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const { spawn, exec } = require('child_process');
const si      = require('systeminformation');
const AdmZip  = require('adm-zip');

/* ── POLYFILL fetch cho Node < 18 (AI chat) ── */
if (typeof global.fetch === 'undefined') {
  try { global.fetch = require('node-fetch'); } catch (e) {
    console.warn('⚠️  Node < 18 và không có node-fetch — AI chat sẽ dùng fallback offline');
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   CONFIG
   ══════════════════════════════════════════════════════════════════════════ */
const PORT       = parseInt(process.env.PORT || '8080', 10);
const API_TOKEN  = process.env.API_TOKEN || 'bothost-CHANGE-ME';
const BASE_DIR   = path.join(__dirname, 'bots');
const UP_DIR     = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR   = path.join(__dirname, 'data');
const MAX_LOG    = 800;
const IS_WIN     = os.platform() === 'win32';
const PY_BIN     = process.env.PY_BIN || (IS_WIN ? 'python' : 'python3');

for (const dir of [BASE_DIR, UP_DIR, PUBLIC_DIR, DATA_DIR]) {
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { console.warn(`⚠️  Không tạo được ${dir}: ${e.message}`); }
}

/* ══════════════════════════════════════════════════════════════════════════
   EXPRESS SETUP
   ══════════════════════════════════════════════════════════════════════════ */
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

/* ── Static: ưu tiên public/, fallback root (an toàn theo extension) ── */
app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

const SAFE_EXT = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.json',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.bmp',
  '.woff', '.woff2', '.ttf', '.eot', '.otf', '.map', '.txt'
]);
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const ext = path.extname(req.path).toLowerCase();
  if (!SAFE_EXT.has(ext)) return next();
  const rel = decodeURIComponent(req.path).replace(/^\/+/, '');
  if (rel.includes('..')) return next();
  const filePath = path.join(__dirname, rel);
  if (!filePath.startsWith(__dirname)) return next();
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return next();
    return res.sendFile(filePath);
  } catch (e) { return next(); }
});

/* ══════════════════════════════════════════════════════════════════════════
   USER / TOKEN DATABASE (JSON file)
   ══════════════════════════════════════════════════════════════════════════ */
const F_USERS  = path.join(DATA_DIR, 'users.json');
const F_TOKENS = path.join(DATA_DIR, 'tokens.json');

const rd = (f, d) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d; } catch (e) { return d; } };
const wr = (f, d) => { try { fs.writeFileSync(f, JSON.stringify(d, null, 2)); } catch (e) {} };

function hashPass(pass, salt) {
  return crypto.createHash('sha256').update(salt + ':' + pass).digest('hex');
}
function newToken(uid) {
  const token = crypto.randomBytes(24).toString('hex');
  const tokens = rd(F_TOKENS, {});
  tokens[token] = uid;
  wr(F_TOKENS, tokens);
  return token;
}

/* Tạo admin mặc định lần đầu */
(function seedAdmin() {
  const users = rd(F_USERS, []);
  if (!users.find(u => u.role === 'admin')) {
    const salt = crypto.randomBytes(8).toString('hex');
    users.push({
      id:        'u_admin_' + Date.now(),
      user:      'admin',
      email:     'admin@local',
      pass:      hashPass('admin123', salt),
      salt,
      role:      'admin',
      status:    'approved',
      createdAt: Date.now()
    });
    wr(F_USERS, users);
    console.log('👑 Đã tạo admin mặc định:  admin / admin123');
  }
})();

/* ══════════════════════════════════════════════════════════════════════════
   AUTH MIDDLEWARE  (đã set req.user — shop.js cần)
   ══════════════════════════════════════════════════════════════════════════ */
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ ok: false, error: 'Unauthorized — thiếu token' });

  if (token === API_TOKEN) {
    req.user = { id: 'root', user: 'root', role: 'admin', status: 'approved' };
    return next();
  }

  const tokens = rd(F_TOKENS, {});
  const uid    = tokens[token];
  if (!uid) return res.status(401).json({ ok: false, error: 'Token sai hoặc hết hạn' });

  const users = rd(F_USERS, []);
  const u     = users.find(x => x.id === uid);
  if (!u) return res.status(401).json({ ok: false, error: 'User không tồn tại' });
  if (u.status !== 'approved') return res.status(403).json({ ok: false, error: 'Tài khoản chưa được duyệt' });

  req.user = { id: u.id, user: u.user, role: u.role, status: u.status };
  next();
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Chỉ admin mới có quyền' });
  }
  next();
}

/* ══════════════════════════════════════════════════════════════════════════
   AUTH ROUTES (gốc)
   ══════════════════════════════════════════════════════════════════════════ */
app.post('/auth/register', (req, res) => {
  try {
    const { user, pass } = req.body || {};
    if (!user || !pass) return res.status(400).json({ ok: false, error: 'Thiếu user hoặc pass' });
    if (user.length < 3 || user.length > 32)
      return res.status(400).json({ ok: false, error: 'Tên 3-32 ký tự' });
    if (!/^[a-zA-Z0-9_.\-]+$/.test(user))
      return res.status(400).json({ ok: false, error: 'Chỉ chữ, số, gạch dưới, gạch ngang, chấm' });
    if (pass.length < 6)
      return res.status(400).json({ ok: false, error: 'Mật khẩu tối thiểu 6 ký tự' });

    const users = rd(F_USERS, []);
    if (users.find(u => u.user.toLowerCase() === user.toLowerCase()))
      return res.status(400).json({ ok: false, error: 'Tên đã tồn tại' });

    const salt = crypto.randomBytes(8).toString('hex');
    users.push({
      id:        'u_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex'),
      user,
      pass:      hashPass(pass, salt),
      salt,
      role:      'user',
      status:    'pending',
      createdAt: Date.now()
    });
    wr(F_USERS, users);
    res.json({ ok: true, msg: 'Đăng ký thành công, chờ admin duyệt' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/auth/login', (req, res) => {
  try {
    const { user, pass } = req.body || {};
    if (!user || !pass) return res.status(400).json({ ok: false, error: 'Thiếu user hoặc pass' });

    const users = rd(F_USERS, []);
    const u = users.find(x => x.user.toLowerCase() === user.toLowerCase());
    if (!u) return res.status(400).json({ ok: false, error: 'Sai tên hoặc mật khẩu' });
    if (u.pass !== hashPass(pass, u.salt))
      return res.status(400).json({ ok: false, error: 'Sai tên hoặc mật khẩu' });
    if (u.status === 'pending')
      return res.status(403).json({ ok: false, error: 'Tài khoản đang chờ admin duyệt' });
    if (u.status === 'rejected')
      return res.status(403).json({ ok: false, error: 'Tài khoản đã bị từ chối' });

    const token = newToken(u.id);
    res.json({
      ok: true,
      token,
      user: { id: u.id, user: u.user, username: u.user, email: u.email || '', role: u.role }
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/* ══════════════════════════════════════════════════════════════════════════
   ALIAS /api/auth/*  ← CHO FRONTEND index.html
   Nhận {username, email, password} và trả {user:{username,email}} để khớp UI
   ══════════════════════════════════════════════════════════════════════════ */
app.post('/api/auth/register', (req, res) => {
  try {
    const { username, email, password } = req.body || {};
    if (!username || username.length < 3)
      return res.json({ ok: false, error: 'Tên ≥ 3 ký tự' });
    if (!/^[a-zA-Z0-9_.\-]+$/.test(username))
      return res.json({ ok: false, error: 'Chỉ chữ, số, gạch dưới, gạch ngang, chấm' });
    if (!email || !/^\S+@\S+\.\S+$/.test(email))
      return res.json({ ok: false, error: 'Email không hợp lệ' });
    if (!password || password.length < 6)
      return res.json({ ok: false, error: 'Mật khẩu ≥ 6 ký tự' });

    const users = rd(F_USERS, []);
    if (users.find(u => u.user.toLowerCase() === username.toLowerCase()))
      return res.json({ ok: false, error: 'Tên đã tồn tại' });
    if (users.find(u => (u.email || '').toLowerCase() === email.toLowerCase()))
      return res.json({ ok: false, error: 'Email đã dùng' });

    const salt = crypto.randomBytes(8).toString('hex');
    const u = {
      id:        'u_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex'),
      user:      username,
      username,
      email,
      pass:      hashPass(password, salt),
      salt,
      role:      'user',
      status:    'approved',        // tự động duyệt cho dễ test
      createdAt: Date.now()
    };
    users.push(u);
    wr(F_USERS, users);

    const token = newToken(u.id);
    res.json({
      ok: true,
      token,
      user: { id: u.id, user: u.user, username: u.user, email: u.email, role: u.role }
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password)
      return res.json({ ok: false, error: 'Thiếu tên hoặc mật khẩu' });

    const users = rd(F_USERS, []);
    const u = users.find(x => x.user.toLowerCase() === username.toLowerCase());
    if (!u || u.pass !== hashPass(password, u.salt))
      return res.json({ ok: false, error: 'Sai tên hoặc mật khẩu' });
    if (u.status === 'pending')
      return res.json({ ok: false, error: 'Tài khoản đang chờ admin duyệt' });
    if (u.status === 'rejected')
      return res.json({ ok: false, error: 'Tài khoản đã bị từ chối' });

    const token = newToken(u.id);
    res.json({
      ok: true,
      token,
      user: { id: u.id, user: u.user, username: u.user, email: u.email || '', role: u.role }
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/auth/me', auth, (req, res) => {
  res.json({ ok: true, user: req.user });
});

app.get('/api/auth/me', auth, (req, res) => {
  res.json({ ok: true, user: { ...req.user, username: req.user.user } });
});

app.post('/auth/logout', (req, res) => {
  const header = req.headers.authorization || '';
  const token  = header.replace(/^Bearer\s+/i, '').trim();
  if (token) {
    const tokens = rd(F_TOKENS, {});
    delete tokens[token];
    wr(F_TOKENS, tokens);
  }
  res.json({ ok: true });
});

/* ══════════════════════════════════════════════════════════════════════════
   ADMIN ROUTES
   ══════════════════════════════════════════════════════════════════════════ */
app.get('/admin/users', auth, adminOnly, (req, res) => {
  const users = rd(F_USERS, []).map(u => ({
    id: u.id, user: u.user, email: u.email || '', role: u.role, status: u.status, createdAt: u.createdAt
  }));
  res.json({ ok: true, users });
});

app.post('/admin/approve/:id', auth, adminOnly, (req, res) => {
  const users = rd(F_USERS, []);
  const u = users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ ok: false, error: 'Không tìm thấy user' });
  u.status = 'approved';
  wr(F_USERS, users);
  res.json({ ok: true });
});

app.post('/admin/reject/:id', auth, adminOnly, (req, res) => {
  const users = rd(F_USERS, []);
  const u = users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ ok: false, error: 'Không tìm thấy user' });
  u.status = 'rejected';
  wr(F_USERS, users);
  res.json({ ok: true });
});

app.post('/admin/delete/:id', auth, adminOnly, (req, res) => {
  const users = rd(F_USERS, []).filter(x => x.id !== req.params.id);
  wr(F_USERS, users);
  const tokens = rd(F_TOKENS, {});
  Object.keys(tokens).forEach(t => { if (tokens[t] === req.params.id) delete tokens[t]; });
  wr(F_TOKENS, tokens);
  res.json({ ok: true });
});

app.post('/admin/promote/:id', auth, adminOnly, (req, res) => {
  const users = rd(F_USERS, []);
  const u = users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ ok: false, error: 'Không tìm thấy user' });
  u.role = 'admin';
  wr(F_USERS, users);
  res.json({ ok: true });
});

app.post('/admin/resetpass/:id', auth, adminOnly, (req, res) => {
  const { newPass } = req.body || {};
  if (!newPass || newPass.length < 6)
    return res.status(400).json({ ok: false, error: 'Mật khẩu >=6 ký tự' });
  const users = rd(F_USERS, []);
  const u = users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ ok: false, error: 'Không tìm thấy user' });
  u.salt = crypto.randomBytes(8).toString('hex');
  u.pass = hashPass(newPass, u.salt);
  wr(F_USERS, users);
  res.json({ ok: true });
});

/* ══════════════════════════════════════════════════════════════════════════
   REGISTRY PROCESS
   ══════════════════════════════════════════════════════════════════════════ */
const processes = new Map();

/* ══════════════════════════════════════════════════════════════════════════
   MULTER UPLOAD
   ══════════════════════════════════════════════════════════════════════════ */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UP_DIR),
  filename:    (req, file, cb) => cb(null, Date.now() + '_' + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

/* ══════════════════════════════════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════════════════════════════════ */
function pushLog(rec, text, type = 'out') {
  rec.logs.push({
    time: new Date().toLocaleTimeString('vi-VN', { hour12: false }),
    msg:  String(text).slice(0, 4000),
    type
  });
  if (rec.logs.length > MAX_LOG) rec.logs.shift();
}

function findEntry(dir, runtime) {
  const files = fs.readdirSync(dir).filter(f => f !== 'venv' && f !== 'node_modules');
  if (runtime === 'python') {
    return files.find(f => /^(main|bot|app|run|index)\.py$/i.test(f))
        || files.find(f => f.endsWith('.py'));
  }
  if (runtime === 'node') {
    return files.find(f => /^(main|bot|app|run|index)\.js$/i.test(f))
        || files.find(f => f.endsWith('.js'));
  }
  if (runtime === 'go') {
    return files.find(f => f === 'main.go') || files.find(f => f.endsWith('.go'));
  }
  if (runtime === 'java') {
    return files.find(f => f.endsWith('.jar'));
  }
  return files[0] || null;
}

async function setupPython(botDir) {
  const venvDir = path.join(botDir, 'venv');
  const pyPath  = IS_WIN
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');

  if (!fs.existsSync(pyPath)) {
    await new Promise((resolve, reject) => {
      const p = spawn(PY_BIN, ['-m', 'venv', 'venv'], { cwd: botDir });
      let err = '';
      p.stderr.on('data', d => err += d.toString());
      p.on('exit',  c => c === 0 ? resolve() : reject(new Error('venv: ' + err.slice(-300))));
      p.on('error', reject);
    });
  }

  await new Promise(resolve => {
    const p = spawn(pyPath, ['-m', 'pip', 'install', '--upgrade', 'pip',
      '--quiet', '--disable-pip-version-check'], { cwd: botDir });
    p.on('exit', () => resolve());
    p.on('error', () => resolve());
  });

  const reqFile = path.join(botDir, 'requirements.txt');
  if (fs.existsSync(reqFile)) {
    await new Promise((resolve, reject) => {
      const p = spawn(pyPath, ['-m', 'pip', 'install', '-r', 'requirements.txt',
        '--quiet', '--disable-pip-version-check'], { cwd: botDir });
      let out = '';
      p.stdout.on('data', d => out += d.toString());
      p.stderr.on('data', d => out += d.toString());
      p.on('exit',  c => c === 0 ? resolve() : reject(new Error('pip: ' + out.slice(-400))));
      p.on('error', reject);
    });
  }

  return { pyPath };
}

function buildCmd(runtime, botDir, entry) {
  if (runtime === 'python') {
    const pyPath = IS_WIN
      ? path.join(botDir, 'venv', 'Scripts', 'python.exe')
      : path.join(botDir, 'venv', 'bin', 'python');
    return { bin: fs.existsSync(pyPath) ? pyPath : PY_BIN, args: [entry] };
  }
  if (runtime === 'node') {
    return { bin: process.execPath, args: [entry] };
  }
  if (runtime === 'go') {
    return { bin: 'go', args: ['run', entry] };
  }
  if (runtime === 'java') {
    return { bin: 'java', args: ['-jar', entry] };
  }
  return { bin: entry, args: [] };
}

function startProcess({ name, group, cmd, runtime, cwd, entry }) {
  let bin, args;

  if (runtime && entry && cwd) {
    const built = buildCmd(runtime, cwd, entry);
    bin  = built.bin;
    args = built.args;
  } else {
    const parts = (cmd || '').split(/\s+/);
    bin  = parts[0];
    args = parts.slice(1);
  }

  const env = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    NODE_ENV: 'production'
  };

  const proc = spawn(bin, args, {
    cwd: cwd || BASE_DIR,
    shell: false,
    env,
    detached: !IS_WIN
  });

  const rec = {
    pid: proc.pid,
    name: name || 'process',
    group: group || name || 'default',
    cmd: `${path.basename(bin)} ${args.join(' ')}`,
    runtime: runtime || 'binary',
    start: Date.now(),
    proc,
    logs: [],
    status: 'running',
    cwd: cwd || BASE_DIR,
    entry: entry || null
  };
  processes.set(proc.pid, rec);

  pushLog(rec, `▶ ${rec.cmd}`, 'ok');
  pushLog(rec, `📁 ${rec.cwd}`, 'info');

  proc.stdout.on('data', d => {
    d.toString('utf8').split(/\r?\n/).forEach(l => {
      if (l.trim()) pushLog(rec, l);
    });
  });
  proc.stderr.on('data', d => {
    d.toString('utf8').split(/\r?\n/).forEach(l => {
      if (l.trim()) pushLog(rec, l, 'err');
    });
  });
  proc.on('exit', (code, signal) => {
    rec.status   = code === 0 ? 'exited' : 'crashed';
    rec.exitCode = code;
    pushLog(rec, `■ Exit code=${code} signal=${signal || 'none'}`,
      code === 0 ? 'ok' : 'err');
  });
  proc.on('error', err => {
    rec.status = 'error';
    pushLog(rec, `✗ ${err.message}`, 'err');
  });

  return rec;
}

function killProcess(pid) {
  const p = processes.get(pid);
  if (!p) return false;
  try {
    if (IS_WIN) {
      spawn('taskkill', ['/pid', String(pid), '/f', '/t']);
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch (e) {}
      try { process.kill(pid,  'SIGKILL'); } catch (e) {}
    }
    p.status = 'killed';
    pushLog(p, '💀 Killed', 'err');
    return true;
  } catch (e) {
    pushLog(p, '✗ ' + e.message, 'err');
    return false;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   API ROUTES
   ══════════════════════════════════════════════════════════════════════════ */
app.get('/api', (req, res) => {
  res.json({
    ok: true, name: 'Bot Host Server', version: '3.3.0',
    platform: os.platform(), node: process.versions.node,
    uptime: Math.floor(process.uptime()) + 's'
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, status: 'alive', time: Date.now() });
});

app.get('/status', auth, async (req, res) => {
  try {
    const [load, mem, cpu] = await Promise.all([
      si.currentLoad(), si.mem(), si.cpu()
    ]);
    const ramUsedMB  = Math.round((mem.active || (mem.total - mem.available)) / 1048576);
    const ramTotalMB = Math.round(mem.total / 1048576);
    const ramPct     = +((ramUsedMB / ramTotalMB) * 100).toFixed(1);
    const cpuPct     = +load.currentLoad.toFixed(1);
    const running    = [...processes.values()].filter(p => p.status === 'running').length;

    res.json({
      ok: true,
      status:   running > 0 ? 'running' : 'idle',
      platform: `${cpu.manufacturer || ''} ${cpu.brand || ''}`.trim() || 'Unknown CPU',
      cores:    cpu.physicalCores || cpu.cores || os.cpus().length,
      arch:     os.arch(),
      uptime:   Math.floor(process.uptime()) + 's',
      cpu:      cpuPct,
      ram:      ramUsedMB,
      ramTotal: ramTotalMB,
      ramPct,
      processes: processes.size,
      running,
      logs: [{
        time: new Date().toLocaleTimeString('vi-VN', { hour12: false }),
        msg:  `CPU ${cpuPct}% · RAM ${ramUsedMB}/${ramTotalMB}MB · ${running} process`,
        type: 'ok'
      }]
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/processes', auth, (req, res) => {
  const list = [...processes.values()].map(p => ({
    pid:       p.pid,
    name:      p.name,
    group:     p.group,
    cmd:       p.cmd,
    runtime:   p.runtime,
    entry:     p.entry,
    status:    p.status,
    uptime:    Math.floor((Date.now() - p.start) / 1000),
    startedAt: p.start,
    lineCount: p.logs.length,
    exitCode:  p.exitCode
  }));
  res.json({ ok: true, processes: list });
});

app.get('/logs/:pid', auth, (req, res) => {
  const p = processes.get(parseInt(req.params.pid, 10));
  if (!p) return res.status(404).json({ ok: false, error: 'Process not found' });
  res.json({ ok: true, logs: p.logs, status: p.status, name: p.name });
});

app.post('/upload', auth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Không có file' });

    const name    = (req.body.name || 'bot').replace(/[^a-zA-Z0-9_\-]/g, '_');
    const runtime = req.body.runtime || 'python';
    const group   = req.body.group || 'Mặc định';
    const botDir  = path.join(BASE_DIR, name);

    fs.mkdirSync(botDir, { recursive: true });

    const filePath = req.file.path;
    const ext      = path.extname(req.file.originalname).toLowerCase();

    if (ext === '.zip') {
      try {
        new AdmZip(filePath).extractAllTo(botDir, true);
      } catch (e) {
        return res.status(400).json({ ok: false, error: 'File zip lỗi: ' + e.message });
      }
      fs.unlinkSync(filePath);
    } else {
      fs.copyFileSync(filePath, path.join(botDir, req.file.originalname));
      fs.unlinkSync(filePath);
    }

    const entry = findEntry(botDir, runtime);
    const setup = [];

    // lưu meta để /bots hiện group
    try {
      fs.writeFileSync(path.join(botDir, 'meta.json'),
        JSON.stringify({ runtime, entry, group, uploadedAt: Date.now() }, null, 2));
    } catch (e) {}

    if (runtime === 'python') {
      try {
        await setupPython(botDir);
        setup.push({ msg: '✓ venv + pip đã sẵn sàng', type: 'ok' });
      } catch (e) {
        setup.push({ msg: '⚠️ ' + e.message, type: 'err' });
      }
    }

    res.json({
      ok: true, name, runtime, entry, group,
      files: fs.readdirSync(botDir),
      setup
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* Start bot — hỗ trợ cả /start/:name và POST /start {name} (index.html dùng body) */
async function handleStart(name, res) {
  try {
    name = String(name || '').replace(/[^a-zA-Z0-9_\-]/g, '_');
    if (!name) return res.status(400).json({ ok: false, error: 'Thiếu tên bot' });
    const botDir = path.join(BASE_DIR, name);
    if (!fs.existsSync(botDir))
      return res.status(404).json({ ok: false, error: 'Bot không tồn tại' });

    const files = fs.readdirSync(botDir).filter(f => f !== 'venv' && f !== 'node_modules' && f !== 'meta.json');
    let runtime = 'python';
    let entry   = null;
    let group   = 'Mặc định';

    const metaFile = path.join(botDir, 'meta.json');
    if (fs.existsSync(metaFile)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        if (meta.group) group = meta.group;
        if (meta.runtime) runtime = meta.runtime;
      } catch (e) {}
    }

    if (files.some(f => f.endsWith('.py'))) {
      runtime = 'python';
      entry   = findEntry(botDir, 'python');
      await setupPython(botDir).catch(() => {});
    } else if (files.some(f => f.endsWith('.js'))) {
      runtime = 'node';
      entry   = findEntry(botDir, 'node');
    } else if (files.some(f => f.endsWith('.go'))) {
      runtime = 'go';
      entry   = findEntry(botDir, 'go');
    } else if (files.some(f => f.endsWith('.jar'))) {
      runtime = 'java';
      entry   = findEntry(botDir, 'java');
    } else {
      runtime = 'binary';
      entry   = files.find(f => /^(bot|main|app|run)/i.test(f)) || files[0];
    }

    if (!entry) return res.status(400).json({ ok: false, error: 'Không tìm thấy file entry point' });

    const rec = startProcess({ name, group, runtime, cwd: botDir, entry });
    res.json({ ok: true, pid: rec.pid, entry, runtime, group });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

app.post('/start/:name', auth, (req, res) => handleStart(req.params.name, res));
app.post('/start', auth, (req, res) => handleStart((req.body || {}).name, res));

function handleStop(name, res) {
  name = String(name || '');
  if (!name) return res.status(400).json({ ok: false, error: 'Thiếu tên bot' });
  let killed = 0;
  for (const [pid, p] of processes) {
    if ((p.name === name || p.group === name) && p.status === 'running') {
      killProcess(pid);
      killed++;
    }
  }
  res.json({ ok: true, killed });
}

app.post('/stop/:name', auth, (req, res) => handleStop(req.params.name, res));
app.post('/stop', auth, (req, res) => handleStop((req.body || {}).name, res));

function handleDelete(name, res) {
  try {
    name = String(name || '').replace(/[^a-zA-Z0-9_\-]/g, '_');
    if (!name) return res.status(400).json({ ok: false, error: 'Thiếu tên bot' });
    const dir = path.join(BASE_DIR, name);
    if (!fs.existsSync(dir))
      return res.status(404).json({ ok: false, error: 'Bot không tồn tại' });

    for (const [pid, p] of processes) {
      if ((p.name === name || p.group === name) && p.status === 'running') killProcess(pid);
    }

    fs.rmSync(dir, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

app.post('/delete/:name', auth, (req, res) => handleDelete(req.params.name, res));
app.post('/delete', auth, (req, res) => handleDelete((req.body || {}).name, res));

app.post('/run-bg', auth, (req, res) => {
  const { cmd, name, group, runtime } = req.body || {};
  if (!cmd) return res.status(400).json({ ok: false, error: 'Thiếu cmd' });
  try {
    const rec = startProcess({
      name:    name || 'process',
      group:   group || name || 'terminal',
      cmd,
      runtime: runtime || 'custom'
    });
    res.json({ ok: true, pid: rec.pid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/exec', auth, (req, res) => {
  const { cmd, timeout, cwd } = req.body || {};
  if (!cmd) return res.status(400).json({ ok: false, error: 'Thiếu cmd' });

  const env = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1'
  };

  exec(cmd, {
    cwd:       cwd || BASE_DIR,
    env,
    maxBuffer: 10 * 1024 * 1024,
    timeout:   timeout || 30000,
    encoding:  'utf8'
  }, (err, stdout, stderr) => {
    // Trả cả output (cũ) và lines (index.html terminal dùng)
    const lines = [];
    if (stdout) {
      String(stdout).split(/\r?\n/).forEach(t => {
        if (t !== '') lines.push({ type: 'ok', text: t });
      });
    }
    if (stderr) {
      String(stderr).split(/\r?\n/).forEach(t => {
        if (t !== '') lines.push({ type: 'err', text: t });
      });
    }
    if (err && !lines.length) {
      lines.push({ type: 'err', text: '❌ ' + err.message });
    }
    if (!lines.length) lines.push({ type: 'info', text: '(no output)' });

    const out = (stdout || '') + (stderr ? '\n[stderr]\n' + stderr : '');
    res.json({
      ok: true,
      output: out.trim() || '(no output)',
      lines
    });
  });
});

app.post('/kill/:pid', auth, (req, res) => {
  const pid = parseInt(req.params.pid, 10);
  if (!processes.has(pid)) return res.status(404).json({ ok: false, error: 'Process not found' });
  res.json({ ok: killProcess(pid) });
});

app.post('/remove/:pid', auth, (req, res) => {
  const pid = parseInt(req.params.pid, 10);
  if (!processes.has(pid)) return res.status(404).json({ ok: false });
  const p = processes.get(pid);
  if (p.status === 'running') killProcess(pid);
  processes.delete(pid);
  res.json({ ok: true });
});

app.get('/bots', auth, (req, res) => {
  try {
    const list = fs.readdirSync(BASE_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        const dir   = path.join(BASE_DIR, d.name);
        const files = fs.readdirSync(dir).filter(f => f !== 'venv' && f !== 'node_modules' && f !== 'meta.json');

        let runtime = 'binary';
        if (files.some(f => f.endsWith('.py')))       runtime = 'python';
        else if (files.some(f => f.endsWith('.js')))  runtime = 'node';
        else if (files.some(f => f.endsWith('.go')))  runtime = 'go';
        else if (files.some(f => f.endsWith('.jar'))) runtime = 'java';

        let group = 'Mặc định';
        const metaFile = path.join(dir, 'meta.json');
        if (fs.existsSync(metaFile)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
            if (meta.group) group = meta.group;
          } catch (e) {}
        }

        return {
          name:    d.name,
          files,
          runtime,
          group,
          entry:   findEntry(dir, runtime),
          hasVenv: fs.existsSync(path.join(dir, 'venv')),
          hasReq:  fs.existsSync(path.join(dir, 'requirements.txt'))
        };
      });
    res.json({ ok: true, bots: list });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/pip/:name', auth, (req, res) => {
  const name   = req.params.name.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const botDir = path.join(BASE_DIR, name);
  if (!fs.existsSync(botDir))
    return res.status(404).json({ ok: false, error: 'Bot không tồn tại' });

  const pkgs = (req.body.packages || '').trim();
  if (!pkgs) return res.status(400).json({ ok: false, error: 'Thiếu packages' });

  const pyPath = IS_WIN
    ? path.join(botDir, 'venv', 'Scripts', 'python.exe')
    : path.join(botDir, 'venv', 'bin', 'python');

  if (!fs.existsSync(pyPath))
    return res.status(400).json({ ok: false, error: 'Venv chưa có — chạy bot 1 lần trước' });

  exec(`"${pyPath}" -m pip install ${pkgs}`,
    { cwd: botDir, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
    (err, stdout, stderr) => {
      res.json({ ok: !err, output: (stdout || '') + (stderr || '') });
    });
});

app.post('/restart/:pid', auth, async (req, res) => {
  const pid = parseInt(req.params.pid, 10);
  const p   = processes.get(pid);
  if (!p) return res.status(404).json({ ok: false });

  const { name, runtime, cwd, entry, group } = p;
  killProcess(pid);
  processes.delete(pid);

  await new Promise(r => setTimeout(r, 300));
  const rec = startProcess({ name, group, runtime, cwd, entry });
  res.json({ ok: true, pid: rec.pid });
});

/* ══════════════════════════════════════════════════════════════════════════
   GẮN SHOP MODULE
   ══════════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════════════
   SHOP + CHAT AI — GỘP TRONG SERVER (bộ não chính)
   • QR lấy từ file: public/qr.png  → URL: /qr.png
   • Mua key chỉ qua Chat AI (không cần shop.html riêng)
   ══════════════════════════════════════════════════════════════════════════ */
(function(opts) {

  const DATA_DIR  = opts.DATA_DIR;
  const auth      = opts.auth;
  const adminOnly = opts.adminOnly;
  const upload    = opts.upload;
  const UP_DIR    = opts.UP_DIR;

  /* ═══ NGÂN HÀNG ═══ */
  const BANK_BIN  = '970436';
  const BANK_ACC  = '0123456789';
  const BANK_NAME = 'NGUYEN VAN A';

  /* ═══ DÙNG QR TĨNH CỦA BẠN ═══ */
  const USE_STATIC_QR  = true;
  const STATIC_QR_FILE = '/qr.png';
  const ORDER_TTL_MS   = 120000; // 120 giây

  /* ═══ ADMIN ═══ */
  const ADMIN_TELEGRAM = '@dngocdz2000';
  const PRICE_TABLE =
    '📋 BẢNG GIÁ KEY HOST:\n' +
    '• Key Host 1 ngày: 10.000đ\n' +
    '• Key Host 1 tuần: 50.000đ\n' +
    '• Key Host 1 tháng: 100.000đ\n' +
    '• Key Host 3 tháng: 250.000đ\n';

  const F_PD = path.join(DATA_DIR, 'shop_products.json');
  const F_ST = path.join(DATA_DIR, 'shop_stock.json');
  const F_OD = path.join(DATA_DIR, 'shop_orders.json');

  const rd = (f, d) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d; } catch (e) { return d; } };
  const wr = (f, d) => { try { fs.writeFileSync(f, JSON.stringify(d, null, 2)); } catch (e) {} };

  /* ═══ TỰ TẠO 4 SẢN PHẨM NẾU CHƯA CÓ ═══ */
  function ensureProducts() {
    let list = rd(F_PD, []);
    if (!Array.isArray(list) || list.length === 0) {
      list = [
        { id:'p_host_1d', name:'Key Host 1 ngày',  price:10000,  duration:'1 ngày',  desc:'Dùng cho 1 thiết bị · Host bot', createdAt:Date.now() },
        { id:'p_host_1w', name:'Key Host 1 tuần',  price:50000,  duration:'1 tuần',  desc:'Dùng cho 1 thiết bị · Host bot', createdAt:Date.now()+1 },
        { id:'p_host_1m', name:'Key Host 1 tháng', price:100000, duration:'1 tháng', desc:'Dùng cho 1 thiết bị · Host bot', createdAt:Date.now()+2 },
        { id:'p_host_3m', name:'Key Host 3 tháng', price:250000, duration:'3 tháng', desc:'Dùng cho 1 thiết bị · Host bot (tiết kiệm 50k)', createdAt:Date.now()+3 }
      ];
      wr(F_PD, list);
      console.log('✅ Đã tạo 4 gói key mặc định');
    }
  }
  ensureProducts();

  /* ── Hết hạn đơn pending (chưa bill) sau 120s → cancelled, QR coi như xóa ── */
  function expireStaleOrders() {
    const list = rd(F_OD, []);
    let changed = false;
    const now = Date.now();
    for (const o of list) {
      if (o.status === 'pending' && !o.billFile && o.expiresAt && now > o.expiresAt) {
        o.status = 'expired';
        o.expiredAt = now;
        changed = true;
      }
    }
    if (changed) wr(F_OD, list);
    return list;
  }

  function makeQrUrl(content, price) {
    if (USE_STATIC_QR) return STATIC_QR_FILE;
    return 'https://img.vietqr.io/image/' + BANK_BIN + '-' + BANK_ACC + '-compact2.png'
      + '?amount=' + price
      + '&addInfo=' + encodeURIComponent(content)
      + '&accountName=' + encodeURIComponent(BANK_NAME);
  }

  function createOrderForUser(user, productId) {
    const p = rd(F_PD, []).find(x => x.id === productId);
    if (!p) return { error: 'Sản phẩm không tồn tại' };

    const st = rd(F_ST, {});
    if (!(st[p.id] || []).length)
      return { error: 'Hết hàng, chọn gói khác hoặc liên hệ admin ' + ADMIN_TELEGRAM };

    // Hủy đơn pending cũ của user (chỉ giữ 1 QR active)
    const list = expireStaleOrders();
    for (const o of list) {
      if (o.userId === user.id && o.status === 'pending' && !o.billFile) {
        o.status = 'expired';
        o.expiredAt = Date.now();
      }
    }

    const orderId = 'DH' + Date.now().toString().slice(-8);
    const content = 'NAP ' + orderId;
    const order = {
      id: orderId,
      userId: user.id,
      userName: user.user,
      productId: p.id,
      productName: p.name,
      duration: p.duration,
      price: p.price,
      content,
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + ORDER_TTL_MS,
      key: null,
      billFile: null
    };
    list.push(order);
    wr(F_OD, list);

    return {
      order,
      content,
      qrUrl: makeQrUrl(content, p.price),
      bank: { bin: BANK_BIN, acc: BANK_ACC, name: BANK_NAME },
      expireIn: Math.floor(ORDER_TTL_MS / 1000)
    };
  }

  /* Map tin nhắn → productId */
  function detectProduct(msg) {
    const m = String(msg).toLowerCase();
    if (m.includes('3 tháng') || m.includes('3 thang') || m.includes('3month') || m.includes('90 ngày') || m.includes('90 ngay'))
      return 'p_host_3m';
    if (m.includes('1 tháng') || m.includes('1 thang') || m.includes('1month') || m.includes('30 ngày') || m.includes('30 ngay'))
      return 'p_host_1m';
    if (m.includes('1 tuần') || m.includes('1 tuan') || m.includes('1week') || m.includes('7 ngày') || m.includes('7 ngay'))
      return 'p_host_1w';
    if (m.includes('1 ngày') || m.includes('1 ngay') || m.includes('1day') || m.includes('1 day'))
      return 'p_host_1d';
    return null;
  }

  function wantBuy(msg) {
    const m = String(msg).toLowerCase();
    return /mua|đặt|dat|order|key|gói|goi|thanh toán|thanh toan|nạp|nap/.test(m);
  }

  function saidPaid(msg) {
    const m = String(msg).toLowerCase();
    return /đã (ck|chuyển|bank|nạp|nap|thanh toán|tt)|da (ck|chuyen|bank|nap)|rồi (ck|chuyển)|xong (ck|chuyển)|bank rồi|đã gửi tiền|gui tien/.test(m)
      || m.includes('đã bank') || m.includes('da bank') || m.includes('ck rồi') || m.includes('ck roi');
  }

  /* Optional auth: đọc token nếu có, không bắt buộc */
  function tryAuth(req) {
    try {
      const header = req.headers.authorization || '';
      const token  = header.replace(/^Bearer\s+/i, '').trim();
      if (!token) return null;
      if (token === (process.env.API_TOKEN || 'bothost-CHANGE-ME'))
        return { id: 'root', user: 'root', role: 'admin', status: 'approved' };
      const tokens = rd(path.join(DATA_DIR, 'tokens.json'), {});
      const uid = tokens[token];
      if (!uid) return null;
      const users = rd(path.join(DATA_DIR, 'users.json'), []);
      const u = users.find(x => x.id === uid);
      if (!u || u.status !== 'approved') return null;
      return { id: u.id, user: u.user, role: u.role, status: u.status };
    } catch (e) { return null; }
  }

  /* ═══ SẢN PHẨM ═══ */
  app.get('/api/shop/products', (req, res) => res.json({ ok:true, products: rd(F_PD, []) }));

  app.post('/api/shop/admin/products', auth, adminOnly, (req, res) => {
    const { name, price, desc, duration } = req.body || {};
    if (!name || !price) return res.status(400).json({ ok:false, error:'Thiếu tên/giá' });
    const list = rd(F_PD, []);
    const p = { id:'p_'+Date.now(), name, price:+price, desc:desc||'', duration:duration||'', createdAt:Date.now() };
    list.push(p);
    wr(F_PD, list);
    res.json({ ok:true, product:p });
  });

  app.delete('/api/shop/admin/products/:id', auth, adminOnly, (req, res) => {
    wr(F_PD, rd(F_PD, []).filter(x => x.id !== req.params.id));
    res.json({ ok:true });
  });

  /* ═══ KHO KEY ═══ */
  app.post('/api/shop/admin/stock/:productId', auth, adminOnly, (req, res) => {
    const keys = String(req.body.keys || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!keys.length) return res.status(400).json({ ok:false, error:'Không có key' });
    const st = rd(F_ST, {});
    st[req.params.productId] = (st[req.params.productId] || []).concat(keys);
    wr(F_ST, st);
    res.json({ ok:true, added:keys.length, total:st[req.params.productId].length });
  });

  app.get('/api/shop/admin/stock', auth, adminOnly, (req, res) => {
    const st = rd(F_ST, {}), ps = rd(F_PD, []);
    res.json({
      ok:true,
      stock: ps.map(p => ({ id:p.id, name:p.name, price:p.price, count:(st[p.id]||[]).length }))
    });
  });

  /* ═══ TẠO ĐƠN ═══ */
  app.post('/api/shop/order', auth, (req, res) => {
    try {
      const { productId } = req.body || {};
      if (!productId) return res.status(400).json({ ok:false, error:'Thiếu sản phẩm' });
      const result = createOrderForUser(req.user, productId);
      if (result.error) return res.status(400).json({ ok:false, error: result.error });
      res.json({ ok:true, ...result });
    } catch (e) {
      res.status(500).json({ ok:false, error:e.message });
    }
  });

  /* ═══ POLLING + tự hủy QR sau 120s nếu chưa bank/bill ═══ */
  app.get('/api/shop/order/:id', auth, (req, res) => {
    expireStaleOrders();
    const o = rd(F_OD, []).find(x => x.id === req.params.id);
    if (!o) return res.status(404).json({ ok:false, error:'Không tìm thấy' });
    if (o.userId !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ ok:false, error:'Không có quyền' });

    const remain = Math.max(0, Math.floor((o.expiresAt - Date.now()) / 1000));
    res.json({
      ok:true,
      order:{
        id:o.id, status:o.status, productName:o.productName,
        price:o.price, key:o.key, content:o.content,
        remainSec:remain, billFile: !!o.billFile
      }
    });
  });

  /* ═══ HỦY ĐƠN / XÓA QR ═══ */
  app.post('/api/shop/order/:id/cancel', auth, (req, res) => {
    const list = rd(F_OD, []);
    const o = list.find(x => x.id === req.params.id);
    if (!o) return res.status(404).json({ ok:false, error:'Không tìm thấy' });
    if (o.userId !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ ok:false, error:'Không có quyền' });
    if (o.status === 'done') return res.status(400).json({ ok:false, error:'Đã giao key, không hủy được' });
    o.status = 'expired';
    o.expiredAt = Date.now();
    wr(F_OD, list);
    res.json({ ok:true, msg:'Đã hủy đơn / xóa QR' });
  });

  /* ═══ GỬI BILL ═══ */
  app.post('/api/shop/bill/:id', auth, upload.single('bill'), (req, res) => {
    try {
      expireStaleOrders();
      const list = rd(F_OD, []);
      const o = list.find(x => x.id === req.params.id);
      if (!o) return res.status(404).json({ ok:false, error:'Không tìm thấy' });
      if (o.userId !== req.user.id) return res.status(403).json({ ok:false, error:'Không có quyền' });
      if (o.status === 'done') return res.status(400).json({ ok:false, error:'Đã gửi key rồi' });
      if (!req.file) return res.status(400).json({ ok:false, error:'Không có ảnh' });

      // Cho phép gửi bill cả khi đơn vừa hết 120s (người đã bank muộn một chút)
      o.billFile = req.file.filename;
      o.billAt = Date.now();
      if (o.status === 'pending' || o.status === 'expired' || o.status === 'cancelled') o.status = 'bill_sent';
      wr(F_OD, list);

      res.json({ ok:true, msg:'Đã gửi bill — admin sẽ kiểm tra và gửi key' });
    } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
  });

  /* ═══ ĐƠN CỦA TÔI ═══ */
  app.get('/api/shop/myorders', auth, (req, res) => {
    expireStaleOrders();
    const list = rd(F_OD, [])
      .filter(x => x.userId === req.user.id)
      .sort((a, b) => b.createdAt - a.createdAt);
    res.json({
      ok:true,
      orders: list.map(o => ({
        id:o.id, productName:o.productName, price:o.price,
        status:o.status, key:o.key, createdAt:o.createdAt, content:o.content
      }))
    });
  });

  /* ═══ ADMIN ═══ */
  app.get('/api/shop/admin/orders', auth, adminOnly, (req, res) => {
    expireStaleOrders();
    res.json({ ok:true, orders: rd(F_OD, []).sort((a, b) => b.createdAt - a.createdAt) });
  });

  app.get('/api/shop/admin/bill/:id', auth, adminOnly, (req, res) => {
    const o = rd(F_OD, []).find(x => x.id === req.params.id);
    if (!o || !o.billFile) return res.status(404).json({ ok:false });
    res.sendFile(path.join(UP_DIR, o.billFile));
  });

  app.post('/api/shop/admin/order/:id/confirm', auth, adminOnly, (req, res) => {
    const list = rd(F_OD, []);
    const o = list.find(x => x.id === req.params.id);
    if (!o) return res.status(404).json({ ok:false, error:'Không tìm thấy' });
    if (o.status === 'done') return res.status(400).json({ ok:false, error:'Đã gửi key' });

    const st = rd(F_ST, {});
    const keys = st[o.productId] || [];
    if (!keys.length) return res.status(400).json({ ok:false, error:'Hết key — nhập thêm kho' });

    const key = keys.shift();
    st[o.productId] = keys;
    wr(F_ST, st);

    o.status = 'done';
    o.key = key;
    o.doneAt = Date.now();
    o.confirmedBy = req.user.user;
    wr(F_OD, list);
    res.json({ ok:true, key, order:o });
  });

  app.post('/api/shop/admin/order/:id/reject', auth, adminOnly, (req, res) => {
    const list = rd(F_OD, []);
    const o = list.find(x => x.id === req.params.id);
    if (!o) return res.status(404).json({ ok:false });
    o.status = 'cancelled';
    o.cancelledAt = Date.now();
    wr(F_OD, list);
    res.json({ ok:true });
  });

  /* ═══ CHAT AI — tự gửi bảng giá + QR khi khách muốn mua ═══ */
  app.post('/api/shop/chat', async (req, res) => {
    const { msg, history } = req.body || {};
    if (!msg) return res.status(400).json({ ok:false, error:'Thiếu tin nhắn' });

    const user = tryAuth(req);
    const m = String(msg).toLowerCase();
    const productId = detectProduct(msg);

    /* 1) Khách nói đã bank → nhắc gửi bill */
    if (saidPaid(msg)) {
      let lastOrder = null;
      if (user) {
        const orders = expireStaleOrders()
          .filter(x => x.userId === user.id && (x.status === 'pending' || x.status === 'expired' || x.status === 'bill_sent'))
          .sort((a, b) => b.createdAt - a.createdAt);
        lastOrder = orders[0] || null;
      }
      return res.json({
        ok: true,
        reply: '✅ Cảm ơn bạn đã chuyển khoản!\n\n📷 Bấm «Gửi bill» bên dưới để gửi ảnh giao dịch.\nAdmin sẽ kiểm tra và gửi key ngay.\n(Hoặc vào tab Key → Gửi bill)',
        action: 'need_bill',
        order: lastOrder ? { id: lastOrder.id, productName: lastOrder.productName, status: lastOrder.status } : null
      });
    }

    /* 2) Khách chọn gói cụ thể → tạo đơn + gửi QR (cần đăng nhập) */
    if (productId && (wantBuy(msg) || /1 ngày|1 tuần|1 tháng|3 tháng|1 ngay|1 tuan|1 thang|3 thang/.test(m))) {
      if (!user) {
        return res.json({
          ok: true,
          reply: '🔒 Bạn cần đăng nhập trước để nhận QR mua key.\n\n' + PRICE_TABLE + '\nSau khi đăng nhập, chat lại tên gói (vd: «mua 1 tuần») mình gửi QR ngay.',
          action: 'need_login'
        });
      }
      const result = createOrderForUser(user, productId);
      if (result.error) {
        return res.json({ ok: true, reply: '⚠️ ' + result.error, action: 'error' });
      }
      const o = result.order;
      return res.json({
        ok: true,
        reply: '🛒 Đã tạo đơn ' + o.id + '\n📦 ' + o.productName + ' — ' + Number(o.price).toLocaleString('vi-VN') + 'đ\n\n'
          + '💳 Quét QR bên dưới, chuyển ĐÚNG số tiền + nội dung:\n«' + result.content + '»\n\n'
          + '⏱ QR hết hạn sau 120 giây.\n'
          + '• Đã bank → bấm Gửi bill\n'
          + '• Chưa bank sau 120s → QR tự xóa',
        action: 'order',
        order: { id: o.id, productName: o.productName, price: o.price, content: result.content, status: o.status },
        qrUrl: result.qrUrl,
        content: result.content,
        expireIn: result.expireIn
      });
    }

    /* 3) Hỏi giá / muốn mua chung → bảng giá */
    if (m.includes('giá') || m.includes('bao nhiêu') || m.includes('bảng giá') || m.includes('price')
        || wantBuy(msg) || m.includes('hello') || m.includes('hi') || m.includes('chào') || m.includes('xin chào')) {
      return res.json({
        ok: true,
        reply: 'Xin chào! Mình là trợ lý shop 🛒\n\n' + PRICE_TABLE
          + '\n💬 Chat tên gói để nhận QR ngay, ví dụ:\n• «mua 1 ngày»\n• «mua 1 tuần»\n• «mua 1 tháng»\n• «mua 3 tháng»\n\n'
          + 'Hoặc vào tab Key để chọn gói.',
        action: 'prices'
      });
    }

    if (m.includes('bill') || m.includes('ảnh') || m.includes('chụp')) {
      return res.json({
        ok: true,
        reply: '📷 Sau khi chuyển khoản → bấm «Gửi bill» dưới QR (hoặc tab Key) → chọn ảnh giao dịch.\nAdmin kiểm tra xong sẽ gửi key.',
        action: 'need_bill'
      });
    }

    if (m.includes('admin') || m.includes('liên hệ') || m.includes('tele') || m.includes('telegram') || m.includes('hỗ trợ')) {
      return res.json({
        ok: true,
        reply: '📞 Liên hệ admin qua Telegram: ' + ADMIN_TELEGRAM,
        action: 'admin'
      });
    }

    /* Fallback + AI thật nếu có key */
    const AI_KEY = process.env.AI_KEY || '';
    const SYS =
      'Bạn là nhân viên tư vấn shop bán key host "Bot Host Shop". Trả lời ngắn, tiếng Việt.\n\n'
      + PRICE_TABLE + '\nAdmin: ' + ADMIN_TELEGRAM + '\n'
      + 'Khách muốn mua: bảo chat «mua 1 ngày/1 tuần/1 tháng/3 tháng» để nhận QR.\n'
      + 'Sau QR: 120s — đã bank thì gửi bill; chưa bank thì QR tự xóa.';

    if (!AI_KEY) {
      return res.json({
        ok: true,
        reply: 'Bạn cần mua key gì?\n\n' + PRICE_TABLE
          + '\nChat «mua 1 tuần» (hoặc gói khác) để nhận QR.\nHoặc liên hệ ' + ADMIN_TELEGRAM,
        action: 'prices'
      });
    }

    try {
      if (typeof fetch === 'undefined')
        throw new Error('Node < 18 cần cài node-fetch: npm i node-fetch');

      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AI_KEY },
        body: JSON.stringify({
          model: process.env.AI_MODEL || 'llama-3.1-8b-instant',
          messages: [
            { role:'system', content:SYS },
            ...(history || []).slice(-8),
            { role:'user', content:msg }
          ],
          temperature: 0.6,
          max_tokens: 500
        })
      });
      const j = await r.json();
      res.json({ ok:true, reply: j.choices?.[0]?.message?.content || '(trống)', action: 'ai' });
    } catch (e) {
      res.json({ ok:true, reply:'⚠️ AI lỗi: ' + e.message + '\n\nLiên hệ admin: ' + ADMIN_TELEGRAM, action: 'error' });
    }
  });

  /* Dọn đơn expired định kỳ */
  setInterval(expireStaleOrders, 15000);

  console.log('✅ Shop đã gắn — QR tĩnh ' + STATIC_QR_FILE + ' + AI chat tạo đơn + TTL 120s + admin ' + ADMIN_TELEGRAM);

})({ DATA_DIR, auth, adminOnly, upload, UP_DIR });


/* ══════════════════════════════════════════════════════════════════════════
   SPA FALLBACK
   ══════════════════════════════════════════════════════════════════════════ */
app.get('*', (req, res, next) => {
  const apiPrefixes = [
    '/status', '/processes', '/upload', '/bots', '/start', '/stop',
    '/kill', '/remove', '/delete', '/logs', '/exec', '/run-bg', '/pip',
    '/restart', '/api', '/health', '/auth', '/admin', '/qr.png'
  ];
  if (apiPrefixes.some(p => req.path === p || req.path.startsWith(p + '/'))) return next();

  const candidates = [
    path.join(PUBLIC_DIR, 'index.html'),
    path.join(__dirname, 'index.html'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return res.sendFile(p);
  }

  res.status(404).send(`
      <!DOCTYPE html>
      <html><head><meta charset="utf-8"><title>Chưa có index.html</title></head>
      <body style="background:#0a0e1a;color:#f1f5f9;font-family:system-ui,sans-serif;padding:40px;text-align:center">
        <h2 style="color:#fbbf24">⚠️ Chưa có file index.html</h2>
        <p style="color:#94a3b8;line-height:1.8">Đặt <code>index.html</code> vào <code>public/</code> hoặc cùng thư mục <code>server.js</code></p>
      </body></html>
    `);
});

/* ── ERROR HANDLER ── */
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err.message);
  res.status(500).json({ ok: false, error: err.message });
});

/* ══════════════════════════════════════════════════════════════════════════
   BOOT SERVER
   ══════════════════════════════════════════════════════════════════════════ */
const server = app.listen(PORT, '0.0.0.0', () => {
  const idxPublic = path.join(PUBLIC_DIR, 'index.html');
  const idxRoot   = path.join(__dirname, 'index.html');
  const hasWeb    = fs.existsSync(idxPublic) || fs.existsSync(idxRoot);
  const webPath   = fs.existsSync(idxPublic) ? 'public/index.html' : (fs.existsSync(idxRoot) ? 'index.html' : '❌ thiếu');
  const isDefaultToken = API_TOKEN === 'bothost-CHANGE-ME';
  const pad = (s, n) => String(s).padEnd(n);

  console.log(`
╔══════════════════════════════════════════════════════════╗
║  🤖  BOT HOST SERVER v3.3  —  ĐANG CHẠY                  ║
╠══════════════════════════════════════════════════════════╣
║  Port:     ${pad(PORT, 5)} (0.0.0.0 — deploy HTTPS được)
║  Web UI:   /  → ${hasWeb ? webPath : '❌ thiếu index.html'}
║  Shop:     Chat AI + tab Key (QR = public/qr.png)
║  Token:    ${pad(String(API_TOKEN).slice(0, 28), 28)}${isDefaultToken ? ' ⚠️ ĐỔI' : ''}
║  Node:     v${process.versions.node}
║  OS:       ${os.platform()} ${os.arch()}
║  Login:    admin / admin123   ⚠️ ĐỔI NGAY
╚══════════════════════════════════════════════════════════╝
`);
  console.log('✅ Server sẵn sàng (local hoặc hosting HTTPS). Ctrl+C để tắt.\n');
});

/* ══════════════════════════════════════════════════════════════════════════
   GRACEFUL SHUTDOWN
   ══════════════════════════════════════════════════════════════════════════ */
function shutdown(sig) {
  console.log(`\n📴 Nhận ${sig} — đang dừng server...`);
  for (const [pid] of processes) {
    try {
      if (IS_WIN) spawn('taskkill', ['/pid', String(pid), '/f', '/t']);
      else {
        try { process.kill(-pid, 'SIGKILL'); } catch (e) {}
        try { process.kill(pid,  'SIGKILL'); } catch (e) {}
      }
    } catch (e) {}
  }
  server.close(() => {
    console.log('✅ Đã dừng sạch.\n');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', err => {
  console.error('\n💥 Lỗi không bắt được:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', reason => {
  console.error('\n💥 Promise bị reject:', reason);
});