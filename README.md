# Roblox Audio Uploader Pro - Versi Sempurna

Satu klik deploy ke Railway, Render, atau VPS Docker.

## Isi
- frontend/index.html (UI lengkap)
- backend/server.js (API proxy + downloader)
- Dockerfile (sudah include yt-dlp + ffmpeg)

## Deploy 1-Klik

### Railway.app
1. Fork repo ini ke GitHub
2. Railway → New Project → Deploy from GitHub
3. Otomatis build Docker, dapat domain https
4. Buka domain, langsung pakai (frontend + backend jadi satu)

### Render.com
1. New Web Service → Connect repo
2. Runtime: Docker
3. Deploy

### VPS Docker
```bash
git clone <repo>
cd roblox-uploader-complete
docker-compose up -d
```
Akses http://IP:3000

## Cara Pakai
1. Buka web
2. Backend URL kosongkan (karena sudah satu server) atau isi "/"
3. Masukkan API Key Roblox Open Cloud
4. YouTube/SoundCloud langsung download, edit, upload

Keamanan: API key tidak disimpan server.
