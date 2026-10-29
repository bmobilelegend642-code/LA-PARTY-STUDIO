// backend/server.js - LA'PARTY STUDIO Audio Uploader Pro v2 (ESM)
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

// ── HELPER: FETCH AUDIO STREAM DARI URL ───────────────────────────────────────
async function fetchAudioBuffer(downloadUrl) {
  const response = await axios.get(downloadUrl, {
    responseType: 'arraybuffer',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    timeout: 60000
  });
  return Buffer.from(response.data);
}

// ── YOUTUBE DOWNLOAD (MULTI-INSTANCE FALLBACK) ────────────────────────────────
app.post('/api/youtube', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL diperlukan' });

  const outputPath = `/tmp/${Date.now()}.mp3`;

  // 1. CUBA YT-DLP DAHULU
  try {
    const cmd = `yt-dlp -x --audio-format mp3 --no-playlist \
      --extractor-args "youtube:player_client=android,ios,web" \
      --no-check-certificates \
      --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
      -o "${outputPath}" "${url}"`;

    await execAsync(cmd, { timeout: 120000 });
    const fileBuffer = fs.readFileSync(outputPath);
    fs.unlinkSync(outputPath);
    return res.json({ success: true, audio: fileBuffer.toString('base64'), filename: 'youtube_audio.mp3' });
  } catch (err) {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    console.log('[YT-DLP 429] Terkena sekatan IP YouTube. Mencuba pelayan cadangan...');
  }

  // 2. CADANGAN A: COBALT INSTANCES
  const cobaltInstances = [
    'https://api.cobalt.tools/',
    'https://cobalt-api.kwippy.com/',
    'https://cobalt.yokai.zone/'
  ];

  for (const instance of cobaltInstances) {
    try {
      const response = await axios.post(instance, {
        url: url,
        downloadMode: 'audio',
        audioFormat: 'mp3'
      }, {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        timeout: 15000
      });

      const audioUrl = response.data?.url || response.data?.picker?.[0]?.url;
      if (audioUrl) {
        const fileBuffer = await fetchAudioBuffer(audioUrl);
        return res.json({ success: true, audio: fileBuffer.toString('base64'), filename: 'youtube_audio.mp3' });
      }
    } catch (e) {
      console.log(`[COBALT FAILED] ${instance}: ${e.message}`);
    }
  }

  // 3. CADANGAN B: PIPED API (MEMOTONG PENYEKATAN YOUTUBE)
  try {
    const videoId = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/)?.[1];
    if (videoId) {
      const pipedRes = await axios.get(`https://pipedapi.kavin.rocks/streams/${videoId}`, { timeout: 15000 });
      const audioStreams = pipedRes.data?.audioStreams || [];
      if (audioStreams.length > 0) {
        const bestStream = audioStreams[0].url;
        const fileBuffer = await fetchAudioBuffer(bestStream);
        return res.json({ success: true, audio: fileBuffer.toString('base64'), filename: 'youtube_audio.mp3' });
      }
    }
  } catch (e) {
    console.log(`[PIPED FAILED]: ${e.message}`);
  }

  // JIKA SEMUA PELAYAN GAGAL DITERIMA
  return res.status(500).json({
    error: 'IP Pelayan disekat sementara oleh YouTube. Sila muat naik fail audio secara manual melalui tab "Upload File".'
  });
});

// ── SOUNDCLOUD DOWNLOAD ───────────────────────────────────────────────────────
app.post('/api/soundcloud', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL diperlukan' });

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
    if (!apiKey)   return res.status(400).json({ error: 'API Key diperlukan' });
    if (!filePath) return res.status(400).json({ error: 'Fail audio diperlukan' });

    const fileData = fs.readFileSync(filePath);
    const fileName = req.file.originalname ||
