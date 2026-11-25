'use strict';
/**
 * LA'PARTY STUDIO - Roblox Audio Uploader Pro v2 (backend)
 *  - Serve frontend (folder ./public) + encoder MP3 (/vendor/lame.min.js)
 *  - Download audio YouTube / SoundCloud via yt-dlp (job + polling, tanpa shell)
 *  - Proxy upload ke Roblox Open Cloud (Assets API) + cek status operation
 */
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ───────────────────────── Konfigurasi ─────────────────────────
const PORT = process.env.PORT || 3000;
const ROBLOX_BASE = (process.env.ROBLOX_BASE || 'https://apis.roblox.com').replace(/\/+$/, '');
const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';
const MAX_AUDIO_SECONDS = Number(process.env.MAX_AUDIO_SECONDS || 3600); // batas durasi download (detik)
const MAX_ROBLOX_BYTES = 20 * 1024 * 1024; // batas Roblox: 20 MB per audio
const MAX_PARALLEL_DOWNLOADS = Number(process.env.MAX_PARALLEL_DOWNLOADS || 2);
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS || 10 * 60 * 1000);
const JOB_TTL_MS = 20 * 60 * 1000;
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS ||
  'youtube.com,youtu.be,youtube-nocookie.com,soundcloud.com,snd.sc')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const TMP_DIR = path.join(process.env.TMPDIR || os.tmpdir(), 'laparty-audio');
fs.mkdirSync(TMP_DIR, { recursive: true });

const app = express();
app.set('trust proxy', 1); // Render / Railway ada di belakang proxy
app.use(cors({ exposedHeaders: ['X-Audio-Title', 'X-Audio-Duration'] }));
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Encoder MP3 (lamejs) disajikan dari node_modules supaya tidak tergantung CDN
try {
  const lameDir = path.dirname(require.resolve('lamejs/package.json'));
  app.use('/vendor', express.static(lameDir, { index: false, dotfiles: 'deny', maxAge: '7d' }));
} catch (e) {
  console.warn('[warn] lamejs tidak ditemukan, frontend akan pakai CDN:', e.message);
}

// ───────────────────────── Util ─────────────────────────
const stripAnsi = s => String(s || '').replace(/\x1b\[[0-9;]*m/g, '');
const safeUnlink = p => { try { if (p) fs.unlinkSync(p); } catch (_) {} };
const clip = (s, n) => Array.from(String(s || '')).slice(0, n).join('');

function findCookiesFile() {
  const cands = [process.env.COOKIES_FILE, '/etc/secrets/cookies.txt', path.join(__dirname, 'cookies.txt')].filter(Boolean);
  for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch (_) {} }
  return null;
}

// rate limit sederhana (per IP)
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip + '|' + req.path;
    const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) {
      return res.status(429).json({ error: 'Terlalu banyak permintaan. Coba lagi beberapa menit lagi.' });
    }
    arr.push(now);
    hits.set(key, arr);
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600e3)) hits.delete(k); }, 10 * 60 * 1000).unref();

// ───────────────────────── yt-dlp ─────────────────────────
let ytdlpInfo = null; // { ok, version, jsRuntimes }
function probeYtdlp() {
  if (ytdlpInfo) return Promise.resolve(ytdlpInfo);
  return new Promise(resolve => {
    execFile(YTDLP_BIN, ['--version'], { timeout: 20000 }, (err, stdout) => {
      if (err) return resolve((ytdlpInfo = { ok: false, error: err.code === 'ENOENT' ? 'yt-dlp tidak terpasang di server' : err.message }));
      const version = String(stdout).trim();
      execFile(YTDLP_BIN, ['--help'], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, (e2, out2) => {
        resolve((ytdlpInfo = { ok: true, version, jsRuntimes: !e2 && String(out2).includes('--js-runtimes') }));
      });
    });
  });
}

// update yt-dlp saat boot (best effort) supaya selalu ikut perubahan YouTube
let updatePromise = Promise.resolve();
if (process.env.YTDLP_AUTO_UPDATE !== '0') {
  updatePromise = new Promise(resolve => {
    execFile(YTDLP_BIN, ['-U'], { timeout: 90000 }, (err, stdout) => {
      if (!err) console.log('[yt-dlp]', stripAnsi(stdout).trim().split('\n').pop());
      ytdlpInfo = null; // probe ulang setelah update
      resolve();
    });
  });
}

function validateMediaUrl(input) {
  let u;
  try { u = new URL(String(input || '').trim()); } catch (_) { return { error: 'URL tidak valid.' }; }
  if (!/^https?:$/.test(u.protocol)) return { error: 'URL harus diawali http:// atau https://' };
  const host = u.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.some(a => host === a || host.endsWith('.' + a))) {
    return { error: 'Hanya link YouTube / SoundCloud yang didukung.' };
  }
  return { url: u.toString() };
}

function explainYtdlpError(stderr) {
  const text = stripAnsi(stderr);
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const errLine = [...lines].reverse().find(l => l.startsWith('ERROR:')) || lines[lines.length - 1] || 'yt-dlp gagal';
  if (/confirm your age|age-restricted|age restricted/i.test(text)) {
    return { code: 'AGE', status: 403, error: 'Video dibatasi umur, butuh cookies.txt akun yang sudah login.' };
  }
  if (/Sign in to confirm|not a bot|confirm you.re not/i.test(text)) {
    return { code: 'YT_BOT', status: 403, error: 'YouTube memblokir server (anti-bot). Pasang cookies.txt di server atau pakai Upload File / SoundCloud.' };
  }
  if (/Private video|Video unavailable|has been removed|This video is not available/i.test(text)) {
    return { code: 'UNAVAILABLE', status: 404, error: 'Video tidak tersedia / private / dihapus.' };
  }
  if (/ffmpeg|ffprobe/i.test(text) && /not found|not installed/i.test(text)) {
    return { code: 'FFMPEG', status: 500, error: 'ffmpeg belum terpasang di server.' };
  }
  return { code: 'YTDLP', status: 500, error: clip(errLine.replace(/^ERROR:\s*/, ''), 300) };
}

const jobs = new Map();
let running = 0;

function startDownloadJob(url, ip) {
  const id = crypto.randomBytes(8).toString('hex');
  const job = { id, ip, status: 'running', createdAt: Date.now(), title: '', duration: null, file: null, error: null, code: null };
  jobs.set(id, job);
  running++;

  (async () => {
    let child;
    let timer;
    try {
      await updatePromise;
      const info = await probeYtdlp();
      if (!info.ok) throw Object.assign(new Error(info.error), { code: 'NO_YTDLP' });

      const args = [
        '--no-playlist', '--no-warnings', '--no-progress', '--no-simulate',
        '--socket-timeout', '30', '--retries', '3',
        '--match-filters', `!is_live & duration<=?${MAX_AUDIO_SECONDS}`,
        '-f', 'bestaudio[ext=m4a]/bestaudio/best',
        '--print', 'after_move:%(filepath)s<<|>>%(duration)s<<|>>%(title)s',
        '-o', path.join(TMP_DIR, `${id}.%(ext)s`)
      ];
      if (info.jsRuntimes) args.push('--js-runtimes', 'node');

      let cookieCopy = null;
      const cookies = findCookiesFile();
      if (cookies) {
        // salin dulu: yt-dlp menulis ulang file cookies, sedangkan /etc/secrets itu read-only
        cookieCopy = path.join(TMP_DIR, `${id}.cookies.txt`);
        fs.copyFileSync(cookies, cookieCopy);
        args.push('--cookies', cookieCopy);
      }
      args.push('--', url);

      let stdout = '';
      let stderr = '';
      await new Promise((resolve, reject) => {
        child = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} reject(Object.assign(new Error('Download terlalu lama (timeout).'), { code: 'TIMEOUT' })); }, DOWNLOAD_TIMEOUT_MS);
        child.stdout.on('data', d => { stdout += d; if (stdout.length > 200000) stdout = stdout.slice(-100000); });
        child.stderr.on('data', d => { stderr += d; if (stderr.length > 200000) stderr = stderr.slice(-100000); });
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolve() : reject(Object.assign(new Error('yt-dlp exit ' + code), { stderr })));
      });
      safeUnlink(cookieCopy);

      // cari file hasil download
      const printed = stdout.split('\n').map(l => l.trim()).filter(l => l.includes('<<|>>')).pop() || '';
      const [, dur, ...titleParts] = printed.split('<<|>>');
      const files = fs.readdirSync(TMP_DIR).filter(f => f.startsWith(id + '.') && !/\.(part|ytdl|temp|cookies\.txt)$/i.test(f));
      if (!files.length) {
        throw Object.assign(new Error('File audio tidak dihasilkan'), {
          stderr: stderr || 'Video tidak lolos filter (live stream atau durasi > ' + Math.round(MAX_AUDIO_SECONDS / 60) + ' menit).',
          tooLong: true
        });
      }
      job.file = path.join(TMP_DIR, files[0]);
      job.title = (titleParts.join('<<|>>') || '').trim();
      job.duration = dur && dur !== 'NA' ? Number(dur) : null;
      job.status = 'done';
    } catch (err) {
      job.status = 'error';
      if (err.code === 'TIMEOUT' || err.code === 'NO_YTDLP') {
        job.error = err.message; job.code = err.code;
      } else if (err.tooLong) {
        job.error = `Video tidak bisa diambil (live stream atau durasi > ${Math.round(MAX_AUDIO_SECONDS / 60)} menit).`; job.code = 'TOO_LONG';
      } else {
        const x = explainYtdlpError(err.stderr || err.message);
        job.error = x.error; job.code = x.code;
      }
      console.error('[download]', job.code, job.error);
      for (const f of fs.readdirSync(TMP_DIR)) if (f.startsWith(id + '.')) safeUnlink(path.join(TMP_DIR, f));
    } finally {
      clearTimeout(timer);
      running--;
    }
  })();

  return job;
}

// bersihkan job & file lama
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) {
      safeUnlink(job.file);
      jobs.delete(id);
    }
  }
}, 60 * 1000).unref();

// ───────────────────────── Routes: health ─────────────────────────
app.get('/api/health', async (req, res) => {
  const y = await probeYtdlp();
  res.json({
    ok: true,
    status: 'online',
    message: "Backend LA'PARTY STUDIO aktif!",
    ytdlp: y.ok ? y.version : false,
    cookies: !!findCookiesFile()
  });
});

// ───────────────────────── Routes: download audio ─────────────────────────
app.post('/api/download', rateLimit(30, 10 * 60 * 1000), (req, res) => {
  const v = validateMediaUrl(req.body && req.body.url);
  if (v.error) return res.status(400).json({ error: v.error });
  if (running >= MAX_PARALLEL_DOWNLOADS) {
    return res.status(429).json({ error: 'Server lagi memproses download lain. Coba lagi sebentar.' });
  }
  const job = startDownloadJob(v.url, req.ip);
  res.status(202).json({ jobId: job.id });
});

app.get('/api/download/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job tidak ditemukan / sudah kedaluwarsa.' });
  res.json({
    status: job.status,
    title: job.title,
    duration: job.duration,
    error: job.error,
    code: job.code
  });
});

const MIME = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.webm': 'audio/webm', '.opus': 'audio/ogg', '.ogg': 'audio/ogg', '.aac': 'audio/aac', '.wav': 'audio/wav', '.flac': 'audio/flac' };

app.get('/api/download/:id/file', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done' || !job.file || !fs.existsSync(job.file)) {
    return res.status(404).json({ error: 'File tidak tersedia.' });
  }
  const ext = path.extname(job.file).toLowerCase();
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  res.setHeader('X-Audio-Title', encodeURIComponent(job.title || ''));
  res.setHeader('X-Audio-Duration', String(job.duration == null ? '' : job.duration));
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(job.file, { dotfiles: 'allow' }, err => {
    safeUnlink(job.file);
    jobs.delete(job.id);
    if (err && !res.headersSent) res.status(500).json({ error: 'Gagal mengirim file.' });
  });
});

// ───────────────────────── Routes: Roblox ─────────────────────────
const upload = multer({ dest: TMP_DIR, limits: { fileSize: 30 * 1024 * 1024, files: 1 } });

function explainRobloxError(status, data) {
  const raw = data && (data.message || data.error || (Array.isArray(data.errors) && data.errors[0] && data.errors[0].message));
  const msg = typeof raw === 'string' ? raw : (raw ? JSON.stringify(raw) : '');
  if (status === 401 || status === 403) {
    return `Ditolak Roblox (${status}). Cek API key: izin Assets (Read + Write), IP 0.0.0.0/0, dan pemilik key harus sama dengan User/Komunitas ID yang dipilih.${msg ? ' Detail: ' + clip(msg, 200) : ''}`;
  }
  if (status === 429) return 'Kena rate limit Roblox. Tunggu sebentar lalu coba lagi.';
  return clip(msg || ('Roblox menolak upload (HTTP ' + status + ')'), 400);
}

const contentTypeFor = name => ({ '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac' }[path.extname(name || '').toLowerCase()] || 'audio/mpeg');

app.post('/api/upload', upload.single('file'), async (req, res) => {
  const file = req.file;
  try {
    const apiKey = String(req.headers['x-api-key'] || (req.body && req.body.apiKey) || '').trim();
    const ownerType = String((req.body && req.body.ownerType) || 'user');
    const ownerId = String((req.body && req.body.ownerId) || '').trim();

    if (!file) return res.status(400).json({ error: 'File audio tidak ada.' });
    if (!apiKey) return res.status(400).json({ error: 'API key kosong.' });
    if (!['user', 'group'].includes(ownerType)) return res.status(400).json({ error: 'Tipe pemilik harus user atau group.' });
    if (!/^\d{1,20}$/.test(ownerId)) return res.status(400).json({ error: ownerType === 'group' ? 'ID Komunitas/Group harus angka.' : 'User ID harus angka.' });
    if (file.size > MAX_ROBLOX_BYTES) {
      return res.status(413).json({ error: `Ukuran file ${(file.size / 1048576).toFixed(1)} MB, melebihi batas Roblox 20 MB.` });
    }

    const displayName = clip(String((req.body && req.body.name) || '').trim(), 50) || 'Untitled';
    const description = clip(String((req.body && req.body.description) || '').trim(), 1000);
    const filename = clip((file.originalname || 'audio.mp3').replace(/[^\w.\- ()\[\]]+/g, '_'), 80) || 'audio.mp3';

    const form = new FormData();
    form.append('request', JSON.stringify({
      assetType: 'Audio',
      displayName,
      description,
      creationContext: { creator: ownerType === 'group' ? { groupId: ownerId } : { userId: ownerId } }
    }), { contentType: 'application/json' });
    form.append('fileContent', fs.createReadStream(file.path), {
      filename,
      contentType: contentTypeFor(filename),
      knownLength: file.size
    });

    const r = await axios.post(`${ROBLOX_BASE}/assets/v1/assets`, form, {
      headers: { 'x-api-key': apiKey, ...form.getHeaders() },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120000,
      validateStatus: () => true
    });

    if (r.status >= 400) {
      console.error('[upload] roblox', r.status, JSON.stringify(r.data).slice(0, 300));
      return res.status(r.status === 429 ? 429 : (r.status >= 500 ? 502 : r.status)).json({ error: explainRobloxError(r.status, r.data) });
    }

    const d = r.data || {};
    const operationId = d.operationId || String(d.path || '').split('/').pop() || null;
    const assetId = d.done && d.response && d.response.assetId ? String(d.response.assetId) : null;
    // PENTING: operationId BUKAN asset ID. Asset ID baru ada setelah operation selesai.
    res.json({ success: true, operationId, assetId });
  } catch (err) {
    const msg = err.code === 'ECONNABORTED' ? 'Upload ke Roblox timeout.' : (err.message || 'Upload gagal');
    console.error('[upload]', msg);
    res.status(500).json({ error: msg });
  } finally {
    if (file) safeUnlink(file.path);
  }
});

app.get('/api/operation/:id', async (req, res) => {
  const apiKey = String(req.headers['x-api-key'] || '').trim();
  if (!apiKey) return res.status(400).json({ error: 'API key kosong.' });
  if (!/^[\w-]{4,100}$/.test(req.params.id)) return res.status(400).json({ error: 'Operation ID tidak valid.' });
  try {
    const r = await axios.get(`${ROBLOX_BASE}/assets/v1/operations/${encodeURIComponent(req.params.id)}`, {
      headers: { 'x-api-key': apiKey }, timeout: 30000, validateStatus: () => true
    });
    if (r.status >= 400) {
      return res.status(r.status === 429 ? 429 : (r.status >= 500 ? 502 : r.status)).json({ error: explainRobloxError(r.status, r.data) });
    }
    const d = r.data || {};
    const resp = d.response || null;
    let error = null;
    if (d.error) error = clip(d.error.message || JSON.stringify(d.error), 400);
    const mod = resp && resp.moderationResult && resp.moderationResult.moderationState
      ? String(resp.moderationResult.moderationState).replace(/^MODERATION_STATE_/, '') : null;
    res.json({
      done: !!d.done,
      assetId: resp && resp.assetId ? String(resp.assetId) : null,
      moderation: mod,
      error
    });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Gagal menghubungi Roblox' });
  }
});

// ───────────────────────── Error handler & start ─────────────────────────
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File terlalu besar (maks 30 MB).' });
  console.error('[error]', err && err.message);
  res.status(500).json({ error: (err && err.message) || 'Server error' });
});

process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ LA'PARTY STUDIO backend jalan di port ${PORT}`);
  probeYtdlp().then(y => console.log('[yt-dlp]', y.ok ? 'v' + y.version : y.error));
});
