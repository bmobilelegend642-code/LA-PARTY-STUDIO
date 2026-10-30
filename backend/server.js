const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());

// Endpoint Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'online', message: 'Backend LA'PARTY STUDIO aktif!' });
});

// Endpoint Download YouTube Audio
app.post('/api/youtube', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: 'URL tidak boleh kosong' });

  const outputId = Date.now();
  const outputPath = path.join(__dirname, 'uploads', `${outputId}.mp3`);

  // Perintah yt-dlp untuk mengambil audio berformat MP3
  const cmd = `yt-dlp -x --audio-format mp3 --no-playlist -o "${outputPath}" "${url}"`;

  exec(cmd, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error yt-dlp: ${error.message}`);
      return res.status(500).json({ success: false, error: 'Gagal mendownload audio dari YouTube via backend' });
    }

    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ success: false, error: 'File audio gagal diproses oleh server' });
    }

    try {
      const fileBuffer = fs.readFileSync(outputPath);
      const base64Audio = fileBuffer.toString('base64');

      // Hapus file sementara dari server
      fs.unlinkSync(outputPath);

      res.json({
        success: true,
        audio: base64Audio,
        filename: `youtube_audio_${outputId}.mp3`
      });
    } catch (err) {
      res.status(500).json({ success: false, error: 'Gagal membaca file audio di server' });
    }
  });
});

// Endpoint Upload ke Roblox Open Cloud
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const { name, description, apiKey, userId, isGroup } = req.body;

    if (!file || !apiKey) {
      if (file && file.path) fs.unlinkSync(file.path);
      return res.status(400).json({ error: 'File audio atau API Key tidak lengkap' });
    }

    const fileStream = fs.createReadStream(file.path);
    const stats = fs.statSync(file.path);

    // Payload metadata untuk Roblox Open Cloud Asset API
    const assetRequest = {
      assetType: "Audio",
      displayName: name || "LA'PARTY Audio",
      description: description || "Uploaded via LA'PARTY STUDIO Pro v2",
      creationContext: {
        creator: {
          [isGroup === 'true' ? 'groupId' : 'userId']: userId || "8377415030"
        }
      }
    };

    const form = new (require('form-data'))();
    form.append('request', JSON.stringify(assetRequest));
    form.append('fileContent', fileStream, {
      filename: file.originalname,
      contentType: 'audio/wav',
      knownLength: stats.size
    });

    const response = await axios.post('https://apis.roblox.com/assets/v1/assets', form, {
      headers: {
        'x-api-key': apiKey,
        ...form.getHeaders()
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });

    // Hapus file upload lokal setelah selesai
    fs.unlinkSync(file.path);

    const operationId = response.data.operationId;
    
    // Kirim kembali operationId atau assetId ke frontend
    res.json({ success: true, assetId: response.data.assetId || operationId });

  } catch (err) {
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    const errorMsg = err.response?.data || err.message;
    console.error('Upload Error:', errorMsg);
    res.status(500).json({ error: errorMsg });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Backend server berjalan di port ${PORT}`);
});
