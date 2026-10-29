// backend/server.js - Localhost Version
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
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '100mb' }));

const upload = multer({ dest: '/tmp/' });

// Health Check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), version: 'v2-local' });
});

// YouTube Download (Local yt-dlp)
app.post('/api/youtube', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL diperlukan' });

  const outputPath = path.join(__dirname, `${Date.now()}.mp3`);
  try {
    const cmd = `yt-dlp -x --audio-format mp3 --no-playlist \
      --extractor-args "youtube:player_client=android,ios,web" \
      --no-check-certificates \
      -o "${outputPath}" "${url}"`;

    await execAsync(cmd, { timeout: 180000 });
    const fileBuffer = fs.readFileSync(outputPath);
    fs.unlinkSync(outputPath);
    return res.json({ success: true, audio: fileBuffer.toString('base64'), filename: 'youtube_audio.mp3' });
  } catch (err) {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    return res.status(500).json({ error: 'Gagal mengunduh YouTube: ' + err.message });
  }
});

// SoundCloud Download
app.post('/api/soundcloud', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL diperlukan' });

  const outputPath = path.join(__dirname, `${Date.now()}.mp3`);
  try {
    await execAsync(`yt-dlp -x --audio-format mp3 --no-playlist -o "${outputPath}" "${url}"`, { timeout: 180000 });
    const fileBuffer = fs.readFileSync(outputPath);
    fs.unlinkSync(outputPath);
    res.json({ success: true, audio: fileBuffer.toString('base64'), filename: 'soundcloud_audio.mp3' });
  } catch (err) {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    res.status(500).json({ error: err.message });
  }
});

// Upload ke Roblox Open Cloud
app.post('/api/upload', upload.single('file'), async (req, res) => {
  const filePath = req.file?.path;
  try {
    const { apiKey, name, description, userId, isGroup } = req.body;
    if (!apiKey)   return res.status(400).json({ error: 'API Key diperlukan' });
    if (!filePath) return res.status(400).json({ error: 'Fail audio diperlukan' });

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

    res.json({ success: true, assetId });
  } catch (err) {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    let errorDetail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    res.status(500).json({ error: errorDetail });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Backend Localhost berjalan di http://localhost:${PORT}`);
});
