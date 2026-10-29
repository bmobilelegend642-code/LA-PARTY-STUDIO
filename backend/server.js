// backend/server.js - Roblox Audio Uploader Pro v2 (ESM)
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import util from 'util';
import axios from 'axios';
import multer from 'multer';
import FormData from 'form-data';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const execAsync  = util.promisify(exec);

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: '/tmp/' });

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), version: 'v2' });
});

// ── YOUTUBE DOWNLOAD (AUTO FALLBACK JIKA HIT ERROR 429) ───────────────────────
app.post('/api/youtube', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL dibutuhkan' });

  const outputPath = `/tmp/${Date.now()}.mp3`;

  // 1. Coba yt-dlp secara langsung
  try {
    const cmd = `yt-dlp -x --audio-format mp3 --no-playlist \
      --extractor-args "youtube:player_client=android,ios,web" \
      --no-check-certificates \
      --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
      -o "${outputPath}" "${url}"`;

    await execAsync(cmd, { timeout: 180000 });
    const fileBuffer = fs.readFileSync(outputPath);
    fs.unlinkSync(outputPath);
    return res.json({ success: true, audio: fileBuffer.toString('base64'), filename: 'youtube_audio.mp3' });
  } catch (err) {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    console.log('[YT-DLP 429] Mengalihkan ke API Cadangan (Cobalt)...');

    // 2. Jalur Cadangan (Bypass Error 429 Render)
    try {
      const cobaltRes = await axios.post('https://api.cobalt.tools/', {
        url: url,
        downloadMode: 'audio',
        audioFormat: 'mp3'
      }, {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });

      const audioUrl = cobaltRes.data?.url || cobaltRes.data?.picker?.[0]?.url;
      if (!audioUrl) throw new Error('Cobalt API tidak mengembalikan link audio');

      const streamRes = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 60000 });
      const fileBuffer = Buffer.from(streamRes.data);

      return res.json({
        success: true,
        audio: fileBuffer.toString('base64'),
        filename: 'youtube_audio.mp3'
      });
    } catch (fallbackErr) {
      console.error('[FALLBACK ERROR]', fallbackErr.message);
      return res.status(500).json({
        error: 'IP Server terkena limit YouTube (429). Silakan coba lagi beberapa saat lagi atau gunakan tab "Upload File" lokal.'
      });
    }
  }
});

// ── SOUNDCLOUD DOWNLOAD ───────────────────────────────────────────────────────
app.post('/api/soundcloud', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL dibutuhkan' });

  const outputPath = `/tmp/${Date.now()}.mp3`;
  try {
    await execAsync(`yt-dlp -x --audio-format mp3 --no-playlist -o "${outputPath}" "${url}"`, { timeout: 180000 });
    const fileBuffer = fs.readFileSync(outputPath);
    fs.unlinkSync(outputPath);
    res.json({ success: true, audio: fileBuffer.toString('base64'), filename: 'soundcloud_audio.mp3' });
  } catch (err) {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    res.status(500).json({ error: (err.message || '').split('\n').slice(0,2).join(' ') });
  }
});

// ── UPLOAD KE ROBLOX OPEN CLOUD ───────────────────────────────────────────────
app.post('/api/upload', upload.single('file'), async (req, res) => {
  const filePath = req.file?.path;
  try {
    const { apiKey, name, description, userId, isGroup } = req.body;
    if (!apiKey)   return res.status(400).json({ error: 'API Key dibutuhkan' });
    if (!filePath) return res.status(400).json({ error: 'File audio dibutuhkan' });

    const fileData = fs.readFileSync(filePath);
    const fileName = req.file.originalname || 'audio.wav';
    const mimeType = req.file.mimetype     || 'audio/wav';

    const creatorObj = {};
    if (userId) {
      if (isGroup === 'true' || isGroup === true) {
        creatorObj.groupId = String(userId);
      } else {
        creatorObj.userId = String(userId);
      }
    }

    const form = new FormData();
    form.append('request', JSON.stringify({
      assetType:   'Audio',
      displayName: name        || 'Uploaded Audio',
      description: description || 'Uploaded via LA\'PARTY STUDIO',
      creationContext: { creator: creatorObj }
    }), { contentType: 'application/json' });

    form.append('fileContent', fileData, {
      filename:    fileName,
      contentType: mimeType
    });

    const response = await axios.post(
      'https://apis.roblox.com/assets/v1/assets',
      form,
      {
        headers: {
          'x-api-key': apiKey,
          ...form.getHeaders()
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      }
    );

    fs.unlinkSync(filePath);

    const data = response.data;
    let assetId = data.assetId || data.id;

    if (!assetId && (data.operationId || data.path)) {
      const opId = data.operationId || data.path?.split('/').pop();
      assetId = await pollOperation(apiKey, opId);
    }

    res.json({ success: true, assetId });
  } catch (err) {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    let errorDetail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('[UPLOAD ERROR]', errorDetail);
    res.status(500).json({ error: errorDetail });
  }
});

// ── POLL OPERATION ────────────────────────────────────────────────────────────
async function pollOperation(apiKey, opId, maxTries = 40) {
  for (let i = 0; i < maxTries; i++) {
    await new Promise(r => setTimeout(r, 2500));
    try {
      const { data } = await axios.get(
        `https://apis.roblox.com/assets/v1/operations/${opId}`,
        { headers: { 'x-api-key': apiKey } }
      );
      if (data.done && data.response?.assetId) return data.response.assetId;
      if (data.done && data.response?.Id)      return data.response.Id;
      if (data.response?.assetId)              return data.response.assetId;
      if (data.status === 'FAILED' || data.error)
        throw new Error(JSON.stringify(data.error) || 'Gagal memproses asset di Roblox');
    } catch (e) {
      if (e.message.includes('FAILED') || e.message.includes('failed')) throw e;
    }
  }
  throw new Error('Upload timeout — cek Roblox Creator Dashboard');
}

// ── FALLBACK → index.html ─────────────────────────────────────────────────────
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('index.html tidak ditemukan');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server LA'PARTY STUDIO berjalan di port ${PORT}`);
});
