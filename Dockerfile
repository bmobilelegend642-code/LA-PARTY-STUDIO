FROM node:20-slim
RUN apt-get update && apt-get install -y ffmpeg curl && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp
WORKDIR /app
COPY backend/package.json ./
RUN npm install --omit=dev
COPY backend/server.js ./
COPY frontend ./public
RUN mkdir -p tmp
EXPOSE 3000
CMD ["node", "server.js"]
