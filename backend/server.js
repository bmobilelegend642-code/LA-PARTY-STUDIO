// backend/server.js - Roblox Audio Uploader Pro v2
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const axios = require('axios');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: '/tmp/' });

// === HEALTH CHECK ===
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), version: 'v2' });
});

// === YOUTUBE DOWNLOAD ===
app.post('/api/youtube', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });
    
    const outputPath = `/tmp/${Date.now()}.mp3`;
    // pakai yt-dlp (sudah ada di Railway kalau kamu tambah di nixpacks)
    await execAsync(`yt-dlp -x --audio-format mp3 -o "${outputPath}" "${url}"`);
    
    const fileBuffer = fs.readFileSync(outputPath);
    fs.unlinkSync(outputPath);
    
    res.json({ 
      success: true, 
      audio: fileBuffer.toString('base64'),
      filename: 'youtube_audio.mp3'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === SOUNDCLOUD DOWNLOAD ===
app.post('/api/soundcloud', async (req, res) => {
  try {
    const { url } = req.body;
    const outputPath = `/tmp/${Date.now()}.mp3`;
    await execAsync(`yt-dlp -x --audio-format mp3 -o "${outputPath}" "${url}"`);
    
    const fileBuffer = fs.readFileSync(outputPath);
    fs.unlinkSync(outputPath);
    
    res.json({ success: true, audio: fileBuffer.toString('base64') });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === UPLOAD KE ROBLOX ===
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const { apiKey, userId, name, description } = req.body;
    const filePath = req.file.path;
    
    const fileData = fs.readFileSync(filePath);
    
    // Roblox Open Cloud API
    const response = await axios.post(
      `https://apis.roblox.com/assets/v1/assets`,
      fileData,
      {
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'audio/mpeg',
          'Roblox-Asset-Type': 'Audio'
        },
        params: {
          assetType: 'Audio',
          name: name || 'Uploaded Audio',
          description: description || '',
          creatorTargetId: userId,
          creatorType: 'User'
        },
        maxBodyLength: Infinity
      }
    );
    
    fs.unlinkSync(filePath);
    res.json({ success: true, assetId: response.data.assetId });
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

// Fallback ke index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server jalan di port ${PORT}`);
});
