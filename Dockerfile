FROM node:18-slim
RUN apt-get update && apt-get install -y python3-pip ffmpeg && pip3 install --break-system-packages yt-dlp && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/package*.json ./
RUN npm install --production
COPY backend/server.js ./
COPY frontend/index.html ./public/index.html
RUN mkdir -p tmp public
EXPOSE 3000
CMD ["node", "server.js"]
