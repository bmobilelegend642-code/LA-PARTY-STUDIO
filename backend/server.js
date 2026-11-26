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

function getYtdlpBin() {
  return fs.existsSync(YTDLP_BIN) ? YTDLP_BIN : 'yt-dlp';
}

// Otomatis unduh binary yt-dlp_linux jika belum ada di server Render
let ytdlpReadyPromise = null;
function ensureYtdlp() {
  if (fs.existsSync(YTDLP_BIN)) return Promise.resolve(YTDLP_BIN);
  if (ytdlpReadyPromise) return ytdlpReadyPromise;

  ytdlpReadyPromise = (async () => {
    const tmpFile = `${YTDLP_BIN}.tmp`;
    try {
      console.log('⬇️ Mengunduh yt-dlp_linux untuk server...');
      const res = await axios.get(
        'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux',
        { responseType: 'stream', timeout: 60000 }
      );
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(tmpFile);
        res.data.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
      });
      fs.renameSync(tmpFile, YTDLP_BIN);
      fs.chmodSync(YTDLP_BIN, 0o755);
      console.log('✅ yt-dlp_linux berhasil dipasang!');
      return YTDLP_BIN;
    } catch (err) {
      if (fs.existsSync(tmpFile)) {
        try { fs.unlinkSync(tmpFile); } catch (_) {}
      }
      console.error('❌ Gagal mengunduh yt-dlp:', err.message);
      return 'yt-dlp';
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

const downloadJobs = new Map();

function cleanup(...paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch (_) {}
    }
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of downloadJobs.entries()) {
    if (now - job.createdAt > 20 * 60 * 1000) {
      cleanup(job.filePath);
      downloadJobs.delete(id);
    }
  }
}, 5 * 60 * 1000);

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
  res.json({
    status: 'online',
    message: "Backend LA'PARTY STUDIO aktif (OGG Vorbis Mode)",
    ytdlp: ytdlp || 'tidak tersedia',
    cookies: Boolean(getCookiesPath())
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

// 3. Download Audio dari URL (YouTube / SoundCloud) -> Job Async
app.post('/api/download', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'URL tidak valid' });
  }

  const ytdlpBin = await ensureYtdlp();
  const jobId = crypto.randomUUID();
  const outTemplate = path.join(UPLOAD_DIR, `dl_${jobId}.%(ext)s`);
  const expectedOgg = path.join(UPLOAD_DIR, `dl_${jobId}.ogg`);

  const job = {
    id: jobId,
    status: 'downloading',
    title: '',
    filePath: expectedOgg,
    error: '',
    createdAt: Date.now()
  };
  downloadJobs.set(jobId, job);

  const baseArgs = ['--no-playlist', '--no-warnings', '--js-runtimes', 'node'];
  const cookiesPath = getCookiesPath();
  if (cookiesPath) {
    baseArgs.push('--cookies', cookiesPath);
  }

  execFile(ytdlpBin, [...baseArgs, '--print', '%(title)s', url], { timeout: 25000 }, (err, stdout) => {
    if (!err && stdout) {
      job.title = stdout.trim().split('\n')[0] || '';
    }
  });

  const dlArgs = [
    ...baseArgs,
    '-x',
    '--audio-format', 'vorbis',
    '--audio-quality', '5',
    '-o', outTemplate,
    url
  ];

  execFile(ytdlpBin, dlArgs, { timeout: 10 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 }, async (error, _stdout, stderr) => {
    if (error) {
      cleanup(expectedOgg);
      job.status = 'error';
      const rawErr = String(stderr || error.message || 'Gagal mengunduh audio dari URL');
      const errIdx = rawErr.indexOf('ERROR:');
      job.error = (errIdx !== -1 ? rawErr.slice(errIdx) : rawErr).trim().slice(0, 300);
      return;
    }

    if (fs.existsSync(expectedOgg)) {
      job.status = 'done';
      return;
    }

    const found = fs.readdirSync(UPLOAD_DIR).find(f => f.startsWith(`dl_${jobId}.`));
    if (found) {
      const rawFile = path.join(UPLOAD_DIR, found);
      try {
        await convertToOggVorbis(rawFile, expectedOgg);
        cleanup(rawFile);
        job.status = 'done';
      } catch (convErr) {
        cleanup(rawFile, expectedOgg);
        job.status = 'error';
        job.error = convErr.message.slice(0, 300);
      }
      return;
    }

    job.status = 'error';
    job.error = 'File hasil download tidak ditemukan di server';
  });

  res.status(202).json({ jobId });
});

// 4. Cek Status Job Download URL
app.get('/api/download/:jobId', (req, res) => {
  const job = downloadJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job download tidak ditemukan atau sudah kedaluwarsa' });

  res.json({
    status: job.status,
    title: job.title,
    error: job.error
  });
});

// 5. Ambil File Hasil Download URL (.ogg)
app.get('/api/download/:jobId/file', (req, res) => {
  const job = downloadJobs.get(req.params.jobId);
  if (!job || job.status !== 'done' || !fs.existsSync(job.filePath)) {
    return res.status(404).json({ error: 'File audio belum siap atau sudah dihapus' });
  }

  res.setHeader('Content-Type', 'audio/ogg');
  if (job.title) {
    res.setHeader('X-Audio-Title', encodeURIComponent(job.title));
  }

  res.sendFile(job.filePath, () => {
    cleanup(job.filePath);
    downloadJobs.delete(job.id);
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
