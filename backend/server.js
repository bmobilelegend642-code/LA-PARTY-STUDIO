const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');

const BIN_DIR = path.join(__dirname, 'bin');
const YTDLP_BIN = path.join(BIN_DIR, 'yt-dlp');
process.env.PATH = `${BIN_DIR}:${process.env.PATH || ''}`;

const app = express();
const UPLOAD_DIR = path.join(__dirname, 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(BIN_DIR, { recursive: true });

function getCookiesPath() {
  const candidates = [
    '/etc/secrets/cookies.txt',
    path.join(__dirname, 'cookies.txt')
  ];
  return candidates.find(p => fs.existsSync(p)) || '';
}

function inspectCookies() {
  const p = getCookiesPath();
  if (!p) return { ok: false, label: 'tidak ada' };
  try {
    const raw = fs.readFileSync(p, 'utf8').trim();
    if (!raw) return { ok: false, label: 'file kosong' };
    if (raw.startsWith('[') || raw.startsWith('{')) {
      return { ok: false, label: 'format salah (JSON, wajib Netscape .txt)' };
    }
    const hasYt = /youtube\.com/i.test(raw);
    const hasAuth = /\b(SID|SAPISID|__Secure-1PSID|__Secure-3PSID|LOGIN_INFO)\b/.test(raw);
    if (hasYt && hasAuth) return { ok: true, label: 'valid (login aktif)' };
    if (hasYt) return { ok: false, label: 'belum login YouTube saat export' };
    return { ok: false, label: 'tidak berisi cookie YouTube' };
  } catch (_) {
    return { ok: false, label: 'gagal dibaca' };
  }
}

function hasPython3() {
  return new Promise((resolve) => {
    execFile('python3', ['--version'], { timeout: 3000 }, (err) => resolve(!err));
  });
}

// Unduh yt-dlp zipapp (~3 MB, start 0.4 detik, hemat RAM) sebagai pengganti PyInstaller 35 MB
let ytdlpReadyPromise = null;
function ensureYtdlp() {
  if (fs.existsSync(YTDLP_BIN)) {
    const stat = fs.statSync(YTDLP_BIN);
    // Jika file > 15 MB, itu adalah PyInstaller lama -> ganti dengan zipapp 3 MB
    if (stat.size > 100 * 1024 && stat.size < 15 * 1024 * 1024) {
      return Promise.resolve(YTDLP_BIN);
    }
  }
  if (ytdlpReadyPromise) return ytdlpReadyPromise;

  ytdlpReadyPromise = (async () => {
    const tmpFile = `${YTDLP_BIN}.tmp`;
    try {
      const pyOk = await hasPython3();
      const downloadUrl = pyOk
        ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'
        : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';

      console.log(`⬇️ Mengunduh yt-dlp (${pyOk ? 'fast zipapp 3MB' : 'linux binary'})...`);
      const res = await axios.get(downloadUrl, { responseType: 'stream', timeout: 45000 });
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(tmpFile);
        res.data.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
      });
      fs.renameSync(tmpFile, YTDLP_BIN);
      fs.chmodSync(YTDLP_BIN, 0o755);
      console.log('✅ yt-dlp siap digunakan!');
      return YTDLP_BIN;
    } catch (err) {
      if (fs.existsSync(tmpFile)) {
        try { fs.unlinkSync(tmpFile); } catch (_) {}
      }
      console.error('❌ Gagal mengunduh yt-dlp:', err.message);
      return fs.existsSync(YTDLP_BIN) ? YTDLP_BIN : 'yt-dlp';
    } finally {
      ytdlpReadyPromise = null;
    }
  })();

  return ytdlpReadyPromise;
}

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 400 * 1024 * 1024 }
});

app.use(cors({
  exposedHeaders: ['X-Audio-Title']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function cleanup(...paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch (_) {}
    }
  }
}

function cleanupJobFiles(jobId) {
  try {
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      if (f.startsWith(`dl_${jobId}.`)) {
        cleanup(path.join(UPLOAD_DIR, f));
      }
    }
  } catch (_) {}
}

function jobMetaPath(jobId) {
  if (!/^[a-f0-9-]{36}$/i.test(String(jobId || ''))) return null;
  return path.join(UPLOAD_DIR, `job_${jobId}.json`);
}

function saveJob(job) {
  const p = jobMetaPath(job.id);
  if (!p) return;
  try { fs.writeFileSync(p, JSON.stringify(job)); } catch (_) {}
}

function loadJob(jobId) {
  const p = jobMetaPath(jobId);
  if (!p || !fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function deleteJob(jobId) {
  cleanup(jobMetaPath(jobId));
  cleanupJobFiles(jobId);
}

setInterval(() => {
  const now = Date.now();
  try {
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      if (f.startsWith('job_') && f.endsWith('.json')) {
        const full = path.join(UPLOAD_DIR, f);
        if (now - fs.statSync(full).mtimeMs > 20 * 60 * 1000) {
          deleteJob(f.slice(4, -5));
        }
      }
    }
  } catch (_) {}
}, 5 * 60 * 1000);

function normalizeMediaUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.replace(/^\/+/, '').split('/')[0];
      if (id) return `https://www.youtube.com/watch?v=${id}`;
    }
    if (u.hostname.includes('youtube.com')) {
      if (u.pathname === '/watch') {
        const v = u.searchParams.get('v');
        if (v) return `https://www.youtube.com/watch?v=${v}`;
      }
      if (u.pathname.startsWith('/shorts/')) {
        const id = u.pathname.split('/')[2];
        if (id) return `https://www.youtube.com/watch?v=${id}`;
      }
    }
  } catch (_) {}
  return rawUrl;
}

function convertToOggVorbis(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-y', '-i', inputPath, '-vn', '-c:a', 'libvorbis', '-q:a', '5', outputPath],
      { maxBuffer: 10 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message));
        if (!fs.existsSync(outputPath)) return reject(new Error('Output OGG tidak terbentuk'));
        resolve(outputPath);
      }
    );
  });
}

function execYtdlpAttempt(ytdlpBin, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      ytdlpBin,
      args,
      { timeout: timeoutMs, maxBuffer: 15 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          error,
          killed: Boolean(error && error.killed),
          stdout: String(stdout || ''),
          stderr: String(stderr || '')
        });
      }
    );
  });
}

async function getYtdlpVersion() {
  const bin = await ensureYtdlp();
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 8000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

// 1. Health Check
app.get('/api/health', async (_req, res) => {
  const ytdlp = await getYtdlpVersion();
  const ck = inspectCookies();
  res.json({
    status: 'online',
    message: "Backend LA'PARTY STUDIO aktif (OGG Vorbis Mode)",
    ytdlp: ytdlp ? `${ytdlp} (${ck.label})` : 'tidak tersedia',
    cookies: ck.ok
  });
});

// 2. Convert Audio -> OGG Vorbis (.ogg)
app.post('/api/convert-ogg', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'File audio tidak ditemukan' });

  const oggPath = `${file.path}.ogg`;
  const baseName = path.parse(file.originalname).name || 'audio';

  try {
    await convertToOggVorbis(file.path, oggPath);
    res.setHeader('Content-Type', 'audio/ogg');
    res.download(oggPath, `${baseName}.ogg`, () => {
      cleanup(file.path, oggPath);
    });
  } catch (err) {
    cleanup(file.path, oggPath);
    res.status(500).json({ error: 'Gagal konversi ke OGG Vorbis: ' + err.message });
  }
});

// 3. Download Audio Langsung dari URL (Fast Mode <= 25s max)
app.post('/api/download', async (req, res) => {
  const rawUrl = String(req.body?.url || '').trim();
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
    return res.status(400).json({ error: 'URL tidak valid' });
  }

  const url = normalizeMediaUrl(rawUrl);
  const isYouTube = /youtu\.be|youtube\.com/i.test(url);
  const ytdlpBin = await ensureYtdlp();
  const jobId = crypto.randomUUID();
  const outTemplate = path.join(UPLOAD_DIR, `dl_${jobId}.%(ext)s`);

  const job = {
    id: jobId,
    status: 'downloading',
    title: '',
    filePath: '',
    error: '',
    createdAt: Date.now()
  };
  saveJob(job);

  res.status(202).json({ jobId });

  (async () => {
    const commonArgs = [
      '-4',
      '--no-playlist',
      '--no-warnings',
      '--no-cache-dir',
      '--no-check-certificates',
      '--socket-timeout', '10',
      '--retries', '1',
      '--fragment-retries', '1',
      '--no-simulate',
      '--print', 'before_dl:TITLE:%(title)s',
      '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
      '-o', outTemplate
    ];

    const strategies = [];
    const cookiesPath = getCookiesPath();
    const ck = inspectCookies();

    if (isYouTube) {
      if (cookiesPath && ck.ok) {
        // Strategi 1: Cookies login aktif + JS runtime Node
        strategies.push([
          ...commonArgs,
          '--js-runtimes', 'node',
          '--cookies', cookiesPath,
          url
        ]);
      }
      // Strategi 2: Client tanpa cookies (android_vr / web)
      strategies.push([
        ...commonArgs,
        '--js-runtimes', 'node',
        '--extractor-args', 'youtube:player_client=android_vr,web',
        url
      ]);
    } else {
      strategies.push([...commonArgs, url]);
    }

    let lastError = 'Gagal mengunduh audio dari URL';

    for (let i = 0; i < strategies.length; i++) {
      cleanupJobFiles(jobId);
      const result = await execYtdlpAttempt(ytdlpBin, strategies[i], 25 * 1000);

      const titleLine = result.stdout.split('\n').find(l => l.startsWith('TITLE:'));
      if (titleLine) {
        job.title = titleLine.slice(6).trim();
        saveJob(job);
      }

      if (!result.error) {
        const found = fs.readdirSync(UPLOAD_DIR).find(
          f => f.startsWith(`dl_${jobId}.`) && !f.endsWith('.part') && !f.endsWith('.ytdl')
        );
        if (found) {
          job.filePath = path.join(UPLOAD_DIR, found);
          job.status = 'done';
          saveJob(job);
          return;
        }
      } else if (result.killed) {
        lastError = 'Timeout (25 dtk) — YouTube membatasi koneksi server ini.';
      } else {
        const rawErr = result.stderr || result.error.message || lastError;
        const errIdx = rawErr.indexOf('ERROR:');
        const cleanMsg = (errIdx !== -1 ? rawErr.slice(errIdx) : rawErr).split('\n')[0].trim();
        if (/Sign in to confirm|bot|player response/i.test(cleanMsg)) {
          lastError = `Ditolak YouTube (status cookie: ${ck.label}). Export ulang cookies.txt dari mode Incognito saat login YouTube lalu simpan ke Secret Files Render.`;
        } else {
          lastError = cleanMsg;
        }
      }
    }

    cleanupJobFiles(jobId);
    job.status = 'error';
    job.error = lastError.slice(0, 300);
    saveJob(job);
  })();
});

// 4. Cek Status Job Download URL
app.get('/api/download/:jobId', (req, res) => {
  const job = loadJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({
      error: 'Server baru saja restart/deploy ulang. Silakan klik Ambil Audio sekali lagi.'
    });
  }

  res.json({
    status: job.status,
    title: job.title,
    error: job.error
  });
});

// 5. Ambil File Hasil Download URL
app.get('/api/download/:jobId/file', (req, res) => {
  const job = loadJob(req.params.jobId);
  if (!job || job.status !== 'done' || !job.filePath || !fs.existsSync(job.filePath)) {
    return res.status(404).json({ error: 'File audio belum siap atau sudah dihapus' });
  }

  if (job.title) {
    res.setHeader('X-Audio-Title', encodeURIComponent(job.title));
  }

  res.sendFile(job.filePath, () => {
    deleteJob(job.id);
  });
});

// 6. Upload ke Roblox Open Cloud (Selalu OGG Vorbis)
app.post('/api/upload', upload.single('file'), async (req, res) => {
  const file = req.file;
  const isAlreadyOgg = file && path.extname(file.originalname).toLowerCase() === '.ogg';
  const oggPath = file ? (isAlreadyOgg ? file.path : `${file.path}.ogg`) : null;

  try {
    const apiKey = String(req.headers['x-api-key'] || req.body.apiKey || '').trim();
    const { name, description, ownerType, ownerId, userId, isGroup } = req.body;

    if (!file || !apiKey) {
      cleanup(file?.path);
      return res.status(400).json({ success: false, error: 'File audio atau API Key tidak lengkap' });
    }

    if (!isAlreadyOgg) {
      await convertToOggVorbis(file.path, oggPath);
    }

    const stats = fs.statSync(oggPath);
    const fileStream = fs.createReadStream(oggPath);
    const targetIsGroup = ownerType ? ownerType === 'group' : isGroup === 'true';
    const targetId = String(ownerId || userId || '8377415030').trim();

    const assetRequest = {
      assetType: 'Audio',
      displayName: String(name || "LA'PARTY Audio").slice(0, 50),
      description: String(description || "Uploaded via LA'PARTY STUDIO Pro v2").slice(0, 1000),
      creationContext: {
        creator: {
          [targetIsGroup ? 'groupId' : 'userId']: targetId
        }
      }
    };

    const baseName = path.parse(file.originalname).name || 'audio';
    const form = new FormData();
    form.append('request', JSON.stringify(assetRequest));
    form.append('fileContent', fileStream, {
      filename: `${baseName}.ogg`,
      contentType: 'audio/ogg',
      knownLength: stats.size
    });

    const response = await axios.post('https://apis.roblox.com/assets/v1/assets', form, {
      headers: {
        'x-api-key': apiKey,
        ...form.getHeaders()
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120000
    });

    cleanup(file.path, oggPath);

    const rawOp = response.data?.operationId || response.data?.path || '';
    const operationId = String(rawOp).replace(/^operations\//, '');
    const assetResp = response.data?.response || response.data || {};
    const rawAsset = assetResp.assetId || '';
    const rawMod = assetResp.moderationResult?.moderationState || '';
    const moderation = rawMod.replace(/^MODERATION_STATE_/, '');

    res.json({
      success: true,
      operationId,
      assetId: String(rawAsset),
      moderation
    });
  } catch (err) {
    cleanup(file?.path, oggPath);
    const apiErr = err.response?.data;
    const errorMsg = apiErr?.message || (typeof apiErr === 'string' ? apiErr : JSON.stringify(apiErr)) || err.message;
    console.error('Upload Error:', errorMsg);
    res.status(err.response?.status || 500).json({ success: false, error: errorMsg });
  }
});

// 7. Cek Status Operasi Roblox Open Cloud
app.get('/api/operation/:operationId', async (req, res) => {
  const apiKey = String(req.headers['x-api-key'] || '').trim();
  const operationId = String(req.params.operationId || '').replace(/^operations\//, '').trim();

  if (!apiKey || !operationId) {
    return res.status(400).json({ error: 'API Key atau Operation ID tidak lengkap' });
  }

  try {
    const response = await axios.get(`https://apis.roblox.com/assets/v1/operations/${encodeURIComponent(operationId)}`, {
      headers: { 'x-api-key': apiKey },
      timeout: 25000
    });

    const data = response.data || {};
    if (data.error) {
      return res.json({
        done: true,
        error: data.error.message || 'Operasi gagal di server Roblox'
      });
    }

    const assetResp = data.response || {};
    const assetId = assetResp.assetId || String(assetResp.path || '').replace(/^assets\//, '');
    const rawMod = assetResp.moderationResult?.moderationState || '';
    const moderation = rawMod.replace(/^MODERATION_STATE_/, '');

    res.json({
      done: Boolean(data.done),
      assetId: assetId || '',
      moderation
    });
  } catch (err) {
    const apiErr = err.response?.data;
    const errorMsg = apiErr?.message || err.message;
    res.status(err.response?.status || 500).json({ error: errorMsg });
  }
});

// 8. Cek Status Moderasi Asset secara Berkala (REVIEWING -> APPROVED / REJECTED)
app.get('/api/asset/:assetId', async (req, res) => {
  const apiKey = String(req.headers['x-api-key'] || '').trim();
  const assetId = String(req.params.assetId || '').replace(/^assets\//, '').trim();

  if (!apiKey || !assetId) {
    return res.status(400).json({ error: 'API Key atau Asset ID tidak lengkap' });
  }

  try {
    const response = await axios.get(`https://apis.roblox.com/assets/v1/assets/${encodeURIComponent(assetId)}`, {
      headers: { 'x-api-key': apiKey },
      timeout: 25000
    });

    const data = response.data || {};
    const rawMod = data.moderationResult?.moderationState || '';
    const moderation = rawMod.replace(/^MODERATION_STATE_/, '');

    res.json({
      assetId: String(data.assetId || assetId),
      moderation
    });
  } catch (err) {
    const apiErr = err.response?.data;
    const errorMsg = apiErr?.message || err.message;
    res.status(err.response?.status || 500).json({ error: errorMsg });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Backend LA'PARTY STUDIO berjalan di port ${PORT} (OGG Vorbis)`);
  ensureYtdlp();
});
