import express from "express";
import cors from "cors";
import multer from "multer";
import pkg from "yt-dlp-wrap";
const { YtDlp } = pkg;
import fs from "fs";
import fetch from "node-fetch";
import FormData from "form-data";

const app = express();
const upload = multer({ dest: "tmp/" });
const PORT = process.env.PORT || 3000;
const ytDlp = new YtDlp();

app.use(cors({ origin: true }));
app.use(express.json());
app.use(express.static("public"));

app.get("/api/download/youtube", async (req, res) => {
  const url = req.query.url;
  if (!url || (!url.includes("youtube.com") &&!url.includes("youtu.be"))) {
    return res.status(400).json({ error: "URL YouTube tidak valid" });
  }
  try {
    const id = Date.now();
    const outPath = `tmp/${id}.mp3`;
    await ytDlp.execPromise([url, "-x", "--audio-format", "mp3", "-o", outPath]);
    res.download(outPath, "youtube_audio.mp3", () => fs.unlinkSync(outPath));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/download/soundcloud", async (req, res) => {
  const url = req.query.url;
  if (!url ||!url.includes("soundcloud.com")) {
    return res.status(400).json({ error: "URL tidak valid" });
  }
  try {
    const id = Date.now();
    const outPath = `tmp/${id}.mp3`;
    await ytDlp.execPromise([url, "-x", "--audio-format", "mp3", "-o", outPath]);
    res.download(outPath, "soundcloud_audio.mp3", () => fs.unlinkSync(outPath));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/roblox/upload", upload.single("file"), async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return res.status(401).json({ error: "API Key hilang" });
  const { name, description, userId, isGroup } = req.body;
  try {
    const form = new FormData();
    form.append("request", JSON.stringify({
      assetType: "Audio",
      displayName: name,
      description: description || "",
      creationContext: { creator: isGroup === "true"? { groupId: Number(userId) } : { userId: Number(userId) } }
    }), { contentType: "application/json" });
    form.append("fileContent", fs.createReadStream(req.file.path), { filename: req.file.originalname });
    const rbx = await fetch("https://apis.roblox.com/assets/v1/assets", {
      method: "POST",
      headers: { "x-api-key": apiKey,...form.getHeaders() },
      body: form
    });
    const data = await rbx.json();
    fs.unlinkSync(req.file.path);
    if (!rbx.ok) return res.status(rbx.status).json(data);
    res.json({ assetId: data.path?.split("/")[1],...data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/roblox/status", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  const id = req.query.id;
  try {
    const r = await fetch(`https://apis.roblox.com/assets/v1/assets/${id}`, { headers: { "x-api-key": apiKey } });
    const data = await r.json();
    res.json({ id, status: data.moderationResult?.moderationState || "Pending", name: data.displayName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Server jalan di port ${PORT}`));
