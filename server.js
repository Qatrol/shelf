require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mime = require('mime-types');

// Если AUTH_PASS не задан — генерируем случайный на запуск и показываем его в консоли.
// Так в репозитории не оказывается пароля по умолчанию.
const AUTH_GENERATED = !process.env.AUTH_PASS;

const CONFIG = {
  port: parseInt(process.env.PORT || '47821', 10),
  authPass: process.env.AUTH_PASS || crypto.randomBytes(9).toString('base64url'),
  maxUploadMB: parseInt(process.env.MAX_UPLOAD_MB || '2048', 10),
  sessionTtlMs: 24 * 60 * 60 * 1000,
  baseRoot: process.env.BASE_ROOT || 'D:\\Work',
  mountsRaw: process.env.MOUNTS || ''
};

const BASE_ROOT = path.resolve(CONFIG.baseRoot);
if (!fs.existsSync(BASE_ROOT)) {
  try { fs.mkdirSync(BASE_ROOT, { recursive: true }); }
  catch (e) { console.error('Cannot create BASE_ROOT: ' + BASE_ROOT); process.exit(1); }
}

const mounts = CONFIG.mountsRaw.split(',').map(s => s.trim()).filter(Boolean).map(s => {
  const idx = s.indexOf(':');
  if (idx < 1) return null;
  const name = s.slice(0, idx).trim();
  const p = s.slice(idx + 1).trim();
  const full = path.resolve(p);
  return { name, path: full, exists: fs.existsSync(full) };
}).filter(Boolean);

const collisions = [];
for (const m of mounts) {
  const realFolder = path.join(BASE_ROOT, m.name);
  if (fs.existsSync(realFolder)) collisions.push(m.name);
}
const activeMounts = mounts.filter(m => !collisions.includes(m.name) && m.exists);
for (const m of mounts) {
  if (!m.exists) console.warn('WARN mount not found: ' + m.name + ' -> ' + m.path);
  else if (collisions.includes(m.name)) console.warn('WARN mount "' + m.name + '" collides with real folder');
}

const STORAGE_DIR = path.join(__dirname, 'storage');
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
const ACCESS_LOG = path.join(STORAGE_DIR, 'access.log');

const app = express();
app.use(cors());

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

const rateLimits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimits.entries()) if (now - v.reset > 0) rateLimits.delete(k);
}, 60000);

function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress;
    const key = name + ':' + ip;
    const now = Date.now();
    let entry = rateLimits.get(key);
    if (!entry || now > entry.reset) { entry = { count: 0, reset: now + windowMs }; rateLimits.set(key, entry); }
    entry.count++;
    if (entry.count > max) {
      const wait = Math.ceil((entry.reset - now) / 1000);
      res.setHeader('Retry-After', wait);
      return res.status(429).json({ error: 'Too many attempts. Wait ' + wait + ' sec.' });
    }
    next();
  };
}

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const LC = { reset: '\x1b[0m', gray: '\x1b[90m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', magenta: '\x1b[35m', bold: '\x1b[1m' };
function ts() { const d = new Date(); const p = n => String(n).padStart(2, '0'); return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
function statusColor(c) { if (c >= 500) return LC.red; if (c >= 400) return LC.yellow; if (c >= 300) return LC.cyan; return LC.green; }

app.use((req, res, next) => {
  const start = Date.now();
  const ip = (req.ip || req.socket.remoteAddress || '').replace('::ffff:', '').replace('::1', 'localhost');
  const isNoise = /\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|map)(\?|$)/i.test(req.url);
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (isNoise && res.statusCode < 400) return;
    const method = req.method.padEnd(6);
    const status = res.statusCode;
    const color = statusColor(status);
    let url = req.originalUrl || req.url;
    url = url.replace(/([?&])token=[a-f0-9]+/i, '$1token=***');
    if (url.length > 70) url = url.slice(0, 67) + '...';
    console.log(LC.gray + '[' + ts() + ']' + LC.reset + ' ' + color + method + LC.reset + ' ' + url.padEnd(50) + color + status + LC.reset + ' ' + LC.gray + ms + 'ms' + LC.reset + ' ' + LC.magenta + ip + LC.reset);
  });
  next();
});

const sessions = new Map();
const accessLog = [];
setInterval(() => {
  const now = Date.now();
  for (const [tok, d] of sessions.entries()) if (now - d.createdAt > CONFIG.sessionTtlMs) sessions.delete(tok);
}, 60 * 60 * 1000);

function safeResolve(relPath) {
  const cleaned = String(relPath || '').replace(/^[\\\/]+/, '');
  if (!cleaned) return path.resolve(BASE_ROOT);
  const parts = cleaned.split('/');
  const first = parts[0];
  const rest = parts.slice(1).join('/');
  let basePath, subPath;
  const realInBase = path.join(BASE_ROOT, first);
  const isRealBase = fs.existsSync(realInBase);
  if (isRealBase) {
    basePath = BASE_ROOT; subPath = cleaned;
  } else {
    const mount = activeMounts.find(m => m.name === first);
    if (mount) { basePath = mount.path; subPath = rest; }
    else { basePath = BASE_ROOT; subPath = cleaned; }
  }
  const full = path.resolve(basePath, subPath);
  const rel = path.relative(basePath, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Access denied');
  if (fs.existsSync(full)) {
    let real;
    try { real = fs.realpathSync(full); } catch (e) { throw new Error('Cannot resolve path'); }
    const realRel = path.relative(basePath, real);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) throw new Error('Symlink outside root');
    try { const lst = fs.lstatSync(full); if (lst.isSymbolicLink()) throw new Error('Symlinks forbidden'); }
    catch (e) { if (e.message === 'Symlinks forbidden') throw e; }
  }
  return full;
}

function toRel(full) {
  const baseRel = path.relative(BASE_ROOT, full);
  if (!baseRel.startsWith('..') && !path.isAbsolute(baseRel)) return baseRel.split(path.sep).join('/');
  for (const m of activeMounts) {
    const rel = path.relative(m.path, full);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return m.name + (rel ? '/' + rel.split(path.sep).join('/') : '');
  }
  throw new Error('Outside known roots');
}

function log(action, req, details) {
  const e = { ts: new Date().toISOString(), action, ip: req.ip || req.socket.remoteAddress, details: details || {} };
  accessLog.push(e);
  if (accessLog.length > 5000) accessLog.shift();
  try { fs.appendFileSync(ACCESS_LOG, JSON.stringify(e) + '\n'); } catch (err) {}
}

function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (token && sessions.has(token)) return next();
  return res.status(401).json({ error: 'Auth required' });
}

app.post('/api/login', rateLimit('login', 5, 60000), (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== CONFIG.authPass) {
    log('login_failed', req, {});
    console.log(LC.red + '  X WRONG PASSWORD' + LC.reset + ' - IP: ' + (req.ip || '').replace('::ffff:', ''));
    return res.status(401).json({ error: 'Wrong password' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { createdAt: Date.now(), ip: req.ip });
  log('login_ok', req, {});
  console.log(LC.green + '  OK LOGIN' + LC.reset + ' - IP: ' + (req.ip || '').replace('::ffff:', '') + '  token: ' + token.slice(0, 8) + '...');
  res.json({ token });
});

app.post('/api/logout', (req, res) => {
  const t = req.headers['x-auth-token'];
  if (t) sessions.delete(t);
  res.json({ ok: true });
});

app.get('/api/check', rateLimit('check', 60, 60000), (req, res) => {
  const t = req.headers['x-auth-token'];
  res.json({ ok: !!(t && sessions.has(t)) });
});

async function listDir(dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const items = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    try { const lst = await fs.promises.lstat(full); if (lst.isSymbolicLink()) continue; } catch { continue; }
    let s;
    try { s = await fs.promises.stat(full); } catch { continue; }
    try {
      const real = await fs.promises.realpath(full);
      const rel = path.relative(dir, real);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    } catch { continue; }
    items.push({
      name: e.name, path: toRel(full), isDir: e.isDirectory(),
      size: s.size, mtime: s.mtimeMs,
      ext: path.extname(e.name).toLowerCase().slice(1),
      mime: e.isDirectory() ? null : (mime.lookup(e.name) || 'application/octet-stream')
    });
  }
  items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, 'ru');
  });
  return items;
}

app.get('/api/list', requireAuth, async (req, res) => {
  try {
    const rel = req.query.path || '';
    if (!rel) {
      const items = await listDir(BASE_ROOT);
      const mountItems = [];
      for (const m of activeMounts) {
        if (items.find(i => i.name === m.name && i.isDir)) continue;
        let s;
        try { s = await fs.promises.stat(m.path); } catch { continue; }
        mountItems.push({
          name: m.name, path: m.name, isDir: true, isMount: true,
          mountTarget: m.path, size: 0, mtime: s.mtimeMs, ext: '', mime: null
        });
      }
      return res.json({ path: '', items: [...mountItems, ...items], isRoot: true });
    }
    const dir = safeResolve(rel);
    const st = await fs.promises.stat(dir);
    if (!st.isDirectory()) return res.status(400).json({ error: 'Not a folder' });
    const items = await listDir(dir);
    res.json({ path: rel, items, isRoot: false });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/download', requireAuth, async (req, res) => {
  try {
    const full = safeResolve(req.query.path);
    const st = await fs.promises.stat(full);
    if (!st.isFile()) return res.status(400).json({ error: 'Not a file' });
    log('download', req, { path: req.query.path, size: st.size });
    console.log(LC.cyan + '  DL' + LC.reset + ' ' + path.basename(full) + ' (' + (st.size/1024).toFixed(1) + ' KB)');
    res.download(full, path.basename(full));
  } catch (e) { res.status(404).json({ error: e.message }); }
});

app.get('/api/raw', requireAuth, async (req, res) => {
  try {
    const full = safeResolve(req.query.path);
    const st = await fs.promises.stat(full);
    if (!st.isFile()) return res.status(400).json({ error: 'Not a file' });
    res.setHeader('Content-Type', mime.lookup(full) || 'application/octet-stream');
    res.setHeader('Content-Length', st.size);
    fs.createReadStream(full).pipe(res);
  } catch (e) { res.status(404).json({ error: e.message }); }
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const dir = safeResolve(req.query.path || '');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    } catch (e) { cb(e); }
  },
  filename: (req, file, cb) => {
    const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, path.basename(original));
  }
});
const upload = multer({ storage: storage, limits: { fileSize: CONFIG.maxUploadMB * 1024 * 1024 } });

app.post('/api/upload', requireAuth, upload.array('files', 100), (req, res) => {
  const files = (req.files || []).map(f => ({ name: path.basename(f.path), path: toRel(f.path), size: f.size }));
  log('upload', req, { path: req.query.path || '', count: files.length });
  const totalMB = (files.reduce((s, f) => s + f.size, 0) / 1048576).toFixed(2);
  console.log(LC.green + '  UP' + LC.reset + ' ' + files.length + ' files, ' + totalMB + ' MB -> ' + (req.query.path || 'root'));
  res.json({ ok: true, files: files });
});

app.delete('/api/delete', requireAuth, async (req, res) => {
  const reqPath = req.query.path;
  const ip = (req.ip || '').replace('::ffff:', '');
  console.log('');
  console.log(LC.red + '[DELETE] START' + LC.reset + ' path="' + reqPath + '" IP=' + ip);

  try {
    // 1. Проверяем, что path передан
    if (!reqPath) {
      console.log(LC.red + '[DELETE] ERROR:' + LC.reset + ' path пустой');
      return res.status(400).json({ error: 'path обязателен' });
    }

    // 2. Резолвим путь
    let full;
    try {
      full = safeResolve(reqPath);
      console.log(LC.gray + '[DELETE] resolved: ' + full + LC.reset);
    } catch (e) {
      console.log(LC.red + '[DELETE] ERROR safeResolve:' + LC.reset + ' ' + e.message);
      return res.status(400).json({ error: 'Путь не разрешён: ' + e.message });
    }

    // 3. Проверяем существование
    if (!fs.existsSync(full)) {
      console.log(LC.red + '[DELETE] ERROR:' + LC.reset + ' файл не существует: ' + full);
      return res.status(404).json({ error: 'Файл не найден' });
    }

    // 4. Получаем статистику
    let st;
    try {
      st = await fs.promises.stat(full);
    } catch (e) {
      console.log(LC.red + '[DELETE] ERROR stat:' + LC.reset + ' ' + e.message);
      return res.status(400).json({ error: 'Не могу прочитать файл: ' + e.message });
    }

    console.log(LC.gray + '[DELETE] type: ' + (st.isDirectory() ? 'DIR' : 'FILE') + ', size: ' + st.size + ' bytes' + LC.reset);
    console.log(LC.gray + '[DELETE] readonly: ' + (st.mode & 0o200 ? 'no' : 'YES (read-only!)') + LC.reset);

    // 5. Проверяем, не открыт ли файл другим процессом (Windows)
    if (process.platform === 'win32') {
      try {
        const fd = await fs.promises.open(full, 'r+');
        await fd.close();
        console.log(LC.gray + '[DELETE] файл доступен для записи' + LC.reset);
      } catch (e) {
        console.log(LC.red + '[DELETE] ERROR:' + LC.reset + ' файл занят другим процессом или защищён: ' + e.message);
        // Всё равно пробуем удалить  может, сработает
      }
    }

    // 6. Снимаем read-only атрибут (на всякий случай)
    if (process.platform === 'win32' && !(st.mode & 0o200)) {
      try {
        await fs.promises.chmod(full, 0o666);
        console.log(LC.yellow + '[DELETE] снят read-only атрибут' + LC.reset);
      } catch (e) {
        console.log(LC.yellow + '[DELETE] не удалось снять read-only: ' + e.message + LC.reset);
      }
    }

    // 7. Удаляем
    if (st.isDirectory()) {
      console.log(LC.gray + '[DELETE] удаляю папку рекурсивно...' + LC.reset);
      await fs.promises.rm(full, { recursive: true, force: true });
    } else {
      console.log(LC.gray + '[DELETE] удаляю файл...' + LC.reset);
      await fs.promises.unlink(full);
    }

    // 8. Проверяем, что удалилось
    if (fs.existsSync(full)) {
      console.log(LC.red + '[DELETE] ERROR:' + LC.reset + ' файл всё ещё существует после удаления!');
      return res.status(500).json({ error: 'Не удалось удалить (файл занят или нет прав)' });
    }

    log('delete', req, { path: reqPath, type: st.isDirectory() ? 'dir' : 'file' });
    console.log(LC.green + '[DELETE] OK' + LC.reset + ' ' + path.basename(full) + (st.isDirectory() ? ' (папка)' : ' (' + (st.size/1024).toFixed(1) + ' KB)'));
    console.log('');
    res.json({ ok: true });

  } catch (e) {
    console.log(LC.red + '[DELETE] EXCEPTION:' + LC.reset + ' ' + e.message);
    console.log(LC.red + '[DELETE] STACK:' + LC.reset);
    console.log(e.stack);
    console.log('');
    log('delete_error', req, { path: reqPath, error: e.message });
    res.status(500).json({ error: 'Ошибка удаления: ' + e.message });
  }
});

app.post('/api/rename', requireAuth, async (req, res) => {
  try {
    const rel = req.body.path, newName = req.body.newName;
    if (!rel || !newName) return res.status(400).json({ error: 'path and newName required' });
    if (newName.indexOf('/') >= 0 || newName.indexOf('\\') >= 0) return res.status(400).json({ error: 'Invalid name' });
    const full = safeResolve(rel);
    const newFull = path.join(path.dirname(full), newName);
    if (fs.existsSync(newFull)) return res.status(400).json({ error: 'Already exists' });
    await fs.promises.rename(full, newFull);
    log('rename', req, { from: rel, to: toRel(newFull) });
    console.log(LC.yellow + '  REN' + LC.reset + ' ' + path.basename(full) + ' -> ' + newName);
    res.json({ ok: true, path: toRel(newFull) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/mkdir', requireAuth, async (req, res) => {
  try {
    const rel = req.body.path || '';
    const name = req.body.name;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const parent = safeResolve(rel);
    const full = path.join(parent, name);
    safeResolve(toRel(full));
    await fs.promises.mkdir(full, { recursive: false });
    log('mkdir', req, { path: toRel(full) });
    console.log(LC.yellow + '  MKDIR' + LC.reset + ' ' + name);
    res.json({ ok: true, path: toRel(full) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

async function walkSearch(dir, q, results, max) {
  if (results.length >= max) return;
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (results.length >= max) return;
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    try { const lst = await fs.promises.lstat(full); if (lst.isSymbolicLink()) continue; } catch { continue; }
    const _nl = e.name.toLowerCase().normalize('NFC'); if (_nl.indexOf(q) >= 0) {
      let s;
      try { s = await fs.promises.stat(full); } catch { continue; }
      results.push({ name: e.name, path: toRel(full), isDir: e.isDirectory(), size: s.size, mtime: s.mtimeMs, ext: path.extname(e.name).toLowerCase().slice(1) });
    }
    if (e.isDirectory()) await walkSearch(full, q, results, max);
  }
}

app.get('/api/search', requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase().normalize('NFC').trim();
    if (!q) return res.json({ items: [] });
    console.log(LC.yellow + '  SEARCH' + LC.reset + ' "' + q + '"');
    const results = [];
    const max = 2000;
    await walkSearch(BASE_ROOT, q, results, max);
    for (const m of activeMounts) { if (results.length >= max) break; await walkSearch(m.path, q, results, max); }
    res.json({ items: results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function walkStats(dir, acc) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    try { const lst = await fs.promises.lstat(full); if (lst.isSymbolicLink()) continue; } catch { continue; }
    if (e.isDirectory()) { acc.dirs++; await walkStats(full, acc); }
    else { try { const s = await fs.promises.stat(full); acc.files++; acc.total += s.size; } catch {} }
  }
}

app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const acc = { files: 0, dirs: 0, total: 0 };
    await walkStats(BASE_ROOT, acc);
    for (const m of activeMounts) await walkStats(m.path, acc);
    res.json({ files: acc.files, dirs: acc.dirs, totalSize: acc.total, totalSizeMB: (acc.total / 1048576).toFixed(2), root: BASE_ROOT, mounts: activeMounts.map(m => ({ name: m.name, path: m.path })), logCount: accessLog.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/logs', requireAuth, (req, res) => res.json({ logs: accessLog.slice(-200).reverse() }));

const libre = require('libreoffice-convert');
const conversionQueue = [];
let conversionBusy = false;
function runConversion(buffer) {
  return new Promise((resolve, reject) => {
    conversionQueue.push({ buffer, resolve, reject });
    processQueue();
  });
}
async function processQueue() {
  if (conversionBusy || conversionQueue.length === 0) return;
  conversionBusy = true;
  const job = conversionQueue.shift();
  try {
    const result = await new Promise((resolve, reject) => {
      libre.convert(job.buffer, '.pdf', undefined, (err, done) => { if (err) return reject(err); resolve(done); });
    });
    job.resolve(result);
  } catch (e) { job.reject(e); }
  finally { conversionBusy = false; setImmediate(processQueue); }
}

app.get('/api/preview', requireAuth, async (req, res) => {
  try {
    const rel = req.query.path;
    const full = safeResolve(rel);
    const st = await fs.promises.stat(full);
    if (!st.isFile()) return res.status(400).json({ error: 'Not a file' });
    const ext = path.extname(full).toLowerCase().replace('.', '');
    const officeExts = ['doc', 'docx', 'rtf', 'odt', 'xls', 'xlsx', 'ods', 'csv', 'ppt', 'pptx', 'odp'];
    if (!officeExts.includes(ext)) return res.status(400).json({ error: 'Format not supported' });
    console.log(LC.magenta + '  CONVERT' + LC.reset + ' ' + path.basename(full) + ' -> PDF');
    const docBuf = await fs.promises.readFile(full);
    const pdfBuf = await runConversion(docBuf);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Content-Length', pdfBuf.length);
    res.end(pdfBuf);
    log('preview', req, { path: rel, size: st.size });
  } catch (e) {
    console.error('[preview]', e.message);
    res.status(500).json({ error: 'Conversion error: ' + e.message });
  }
});

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.use((err, req, res, next) => {
  if (err) { console.error('[error]', err.message); return res.status(500).json({ error: err.message }); }
  next();
});

const server = app.listen(CONFIG.port, '0.0.0.0', () => {
  const os = require('os');
  const ifs = os.networkInterfaces();
  console.log('');
  console.log(LC.cyan + '========================================' + LC.reset);
  console.log(LC.bold + '   FILE ONLINE MANAGER' + LC.reset);
  console.log(LC.cyan + '========================================' + LC.reset);
  console.log('  Port: ' + CONFIG.port);
  console.log('  Password: ' + (AUTH_GENERATED
    ? CONFIG.authPass + '   (сгенерирован — задайте AUTH_PASS в .env)'
    : 'из .env (AUTH_PASS)'));
  console.log('  Root: ' + BASE_ROOT);
  if (activeMounts.length) {
    console.log('  Virtual folders (' + activeMounts.length + '):');
    for (const m of activeMounts) console.log('    [DIR] ' + m.name + '  ->  ' + m.path);
  }
  console.log('');
  console.log('  Access:');
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name]) {
      if (i.family === 'IPv4' && !i.internal) console.log('    http://' + i.address + ':' + CONFIG.port);
    }
  }
  console.log('    http://localhost:' + CONFIG.port);
  console.log(LC.cyan + '========================================' + LC.reset);
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error('Port ' + CONFIG.port + ' is busy'); process.exit(1); }
  throw e;
});
process.on('SIGINT', () => { console.log('\nStopping...'); process.exit(0); });
process.on('unhandledRejection', (e) => console.error('rejection:', e && e.message));
process.on('uncaughtException', (e) => console.error('exception:', e && e.message));