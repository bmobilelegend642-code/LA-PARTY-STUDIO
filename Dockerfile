FROM node:20-slim

# ffmpeg + yt-dlp (binary standalone: tidak butuh Python)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
 && curl -fL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY backend/server.js ./
COPY frontend ./public

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
