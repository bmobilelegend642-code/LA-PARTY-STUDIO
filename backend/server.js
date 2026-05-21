import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import fetch from "node-fetch";
import FormData from "form-data";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const app = express();
const upload = multer({ dest: "tmp/" });
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: true }));
app.use(express.json());
app.use(express.static("public"));

// YouTube
app.get("/api/download/youtube", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "URL kosong" });
  try {
    const out = `tmp/${Date.now()}.mp3`;
    await execFileAsync("yt-dlp", [url, "-x", "--audio-format", "mp3", "-o", out]);
    res.download(out, "youtube.mp3", () => fs.unlinkSync(out));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SoundCloud
app.get("/api/download/soundcloud", async (req, res) => {
  const url = req.query.url;
  try {
    const out = `tmp/${Date.now()}.mp3`;
    await execFileAsync("yt-dlp", [url, "-x", "--audio-format", "mp3", "-o", out]);
    res.download(out, "soundcloud.mp3", () => fs.unlinkSync(out));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload Roblox
app.post("/api/roblox/upload", upload.single("file"), async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  const { name, description, userId, isGroup } = req.body;
  try {
    const form = new FormData();
    form.append("request", JSON.stringify({
      assetType: "Audio",
      displayName: name,
      description: description || "",
      creationContext: { creator: isGroup === "true" ? { groupId: Number(userId) } : { userId: Number(userId) } }
    }), { contentType: "application/json" });
    form.append("fileContent", fs.createReadStream(req.file.path));
    const r = await fetch("https://apis.roblox.com/assets/v1/assets", {
      method: "POST",
      headers: { "x-api-key": apiKey, ...form.getHeaders() },
      body: form
    });
    const data = await r.json();
    fs.unlinkSync(req.file.path);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/roblox/status", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  const id = req.query.id;
  const r = await fetch(`https://apis.roblox.com/assets/v1/assets/${id}`, { headers: { "x-api-key": apiKey } });
  const data = await r.json();
  res.json({ status: data.moderationResult?.moderationState || "Pending" });
});

app.listen(PORT, () => console.log("Running"));
