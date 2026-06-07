// backend/server.js - Roblox Audio Uploader Pro v2 (ESM fix)
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

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: '/tmp/' });

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), version: 'v2' });
});

// ── YOUTUBE DOWNLOAD ──────────────────────────────────────────────────────────
app.post('/api/youtube', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const outputPath = `/tmp/${Date.now()}.mp3`;
  try {
    await execAsync(`yt-dlp -x --audio-format mp3 --no-playlist -o "${outputPath}" "${url}"`);
    const fileBuffer = fs.readFileSync(outputPath);
    fs.unlinkSync(outputPath);
    res.json({ success: true, audio: fileBuffer.toString('base64'), filename: 'youtube_audio.mp3' });
  } catch (err) {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    res.status(500).json({ error: err.message });
  }
});

// ── SOUNDCLOUD DOWNLOAD ───────────────────────────────────────────────────────
app.post('/api/soundcloud', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const outputPath = `/tmp/${Date.now()}.mp3`;
  try {
    await execAsync(`yt-dlp -x --audio-format mp3 --no-playlist -o "${outputPath}" "${url}"`);
    const fileBuffer = fs.readFileSync(outputPath);
    fs.unlinkSync(outputPath);
    res.json({ success: true, audio: fileBuffer.toString('base64'), filename: 'soundcloud_audio.mp3' });
  } catch (err) {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    res.status(500).json({ error: err.message });
  }
});

// ── UPLOAD KE ROBLOX ─────────────────────────────────────────────────────────
// Roblox Open Cloud /assets/v1/assets butuh multipart/form-data:
//   - field "request"     → JSON metadata
//   - field "fileContent" → binary audio
app.post('/api/upload', upload.single('file'), async (req, res) => {
  const filePath = req.file?.path;
  try {
    const { apiKey, name, description } = req.body;
    if (!apiKey)   return res.status(400).json({ error: 'apiKey required' });
    if (!filePath) return res.status(400).json({ error: 'file required' });

    const fileData = fs.readFileSync(filePath);
    const fileName = req.file.originalname || 'audio.mp3';
    const mimeType = req.file.mimetype     || 'audio/mpeg';

    const form = new FormData();
    form.append('request', JSON.stringify({
      assetType:   'Audio',
      displayName: name        || 'Uploaded Audio',
      description: description || 'Uploaded via Roblox Audio Studio',
      creationContext: { creator: {} }
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

    // Roblox kadang return operationId, poll sampai dapat assetId
    const data = response.data;
    let assetId = data.assetId || data.id;

    if (!assetId && (data.operationId || data.path)) {
      const opId = data.operationId || data.path?.split('/').pop();
      assetId = await pollOperation(apiKey, opId);
    }

    res.json({ success: true, assetId });
  } catch (err) {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    const detail = err.response?.data || err.message;
    console.error('[UPLOAD ERROR]', detail);
    res.status(500).json({ error: detail });
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
        throw new Error(data.error?.message || 'Asset processing failed');
    } catch (e) {
      if (e.message.includes('FAILED') || e.message.includes('failed')) throw e;
    }
  }
  throw new Error('Upload timeout — cek Creator Hub secara manual');
}

// ── PROXY UPLOAD (dari browser langsung, tanpa file upload) ──────────────────
// HTML tool kita kirim multipart dari browser ke sini, kita forward ke Roblox
app.post('/api/proxy-upload', express.raw({ type: '*/*', limit: '100mb' }), async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(400).json({ error: 'Missing x-api-key' });

  try {
    const response = await axios.post(
      'https://apis.roblox.com/assets/v1/assets',
      req.body,
      {
        headers: {
          'x-api-key':    apiKey,
          'Content-Type': req.headers['content-type']
        },
        maxBodyLength:    Infinity,
        maxContentLength: Infinity
      }
    );

    const data    = response.data;
    let assetId   = data.assetId || data.id;

    if (!assetId && (data.operationId || data.path)) {
      const opId = data.operationId || data.path?.split('/').pop();
      assetId    = await pollOperation(apiKey, opId);
    }

    res.json({ success: true, assetId, raw: data });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('[PROXY-UPLOAD ERROR]', detail);
    res.status(err.response?.status || 500).json({ error: detail });
  }
});

// ── POLL ENDPOINT (dari browser) ─────────────────────────────────────────────
app.get('/api/operation/:opId', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(400).json({ error: 'Missing x-api-key' });

  try {
    const { data } = await axios.get(
      `https://apis.roblox.com/assets/v1/operations/${req.params.opId}`,
      { headers: { 'x-api-key': apiKey } }
    );
    res.json(data);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// ── VALIDATE API KEY ──────────────────────────────────────────────────────────
app.get('/api/validate', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(400).json({ error: 'Missing x-api-key' });

  try {
    const { data, status } = await axios.get(
      'https://apis.roblox.com/assets/v1/assets?assetType=Audio&limit=1',
      { headers: { 'x-api-key': apiKey }, validateStatus: () => true }
    );
    res.status(status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── FALLBACK → index.html ─────────────────────────────────────────────────────
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('index.html not found in /public');
  }
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Roblox Audio Studio server jalan di port ${PORT}`);
});
