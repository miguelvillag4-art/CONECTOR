import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";

const app = express();

// Permite JSON grande (base64)
app.use(express.json({ limit: "50mb" }));

app.get("/", (_req, res) => {
  res.status(200).send("OK - FFmpeg service is live");
});

function cleanUrl(u) {
  if (!u) return "";
  let s = String(u).trim();

  // Quita comillas si vienen
  s = s.replace(/^"+|"+$/g, "");
  s = s.replace(/^'+|'+$/g, "");

  // Quita el "=" si viene pegado (tu log mostró "video_url:=https://...")
  if (s.startsWith("=")) s = s.slice(1).trim();

  // Arregla espacios raros
  s = s.replace(/\s+/g, "");

  return s;
}

async function downloadToFile(url, filePath) {
  const r = await fetch(url, {
    redirect: "follow",
    headers: {
      // A veces algunas CDNs se ponen tontas si no hay user-agent
      "User-Agent": "n8n-ffmpeg-connector/1.0",
      "Accept": "*/*",
    },
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Download failed ${r.status} ${r.statusText} :: ${txt.slice(0, 200)}`);
  }

  const ab = await r.arrayBuffer();
  const buf = Buffer.from(ab);

  // 163 bytes = te estaban devolviendo HTML/redirect/una “mini respuesta”, no el mp3 real
  if (buf.length < 5000) {
    throw new Error(`Downloaded file too small (${buf.length} bytes). URL: ${url}`);
  }

  fs.writeFileSync(filePath, buf);
  return buf.length;
}

function decodeBase64ToFile(base64Str, filePath) {
  if (!base64Str) throw new Error("audio_base64 is empty");

  let s = String(base64Str).trim();

  // Si viene como "data:audio/mpeg;base64,AAAA..."
  const comma = s.indexOf(",");
  if (s.startsWith("data:") && comma !== -1) s = s.slice(comma + 1);

  // Tu base64 empieza con "//..." eso es normal.
  const buf = Buffer.from(s, "base64");

  if (buf.length < 5000) {
    throw new Error(`Decoded base64 too small (${buf.length} bytes)`);
  }

  fs.writeFileSync(filePath, buf);
  return buf.length;
}

function runFfmpegMerge(videoPath, audioPath, outPath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i", videoPath,
      "-i", audioPath,
      // Video tal cual, audio a AAC (YouTube/IG felices)
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      outPath,
    ];

    const p = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));

    p.on("error", (err) => reject(err));
    p.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg failed with code ${code}\n${stderr.slice(-2000)}`));
    });
  });
}

app.post("/merge", async (req, res) => {
  const reqId = crypto.randomBytes(6).toString("hex");
  const tmpDir = path.join(os.tmpdir(), `merge_${reqId}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const video_url = cleanUrl(req.body?.video_url);
    const audio_url = cleanUrl(req.body?.audio_url);
    const audio_base64 = req.body?.audio_base64;

    console.log("==> /merge");
    console.log("video_url:", video_url ? video_url.slice(0, 120) : "(no)");
    console.log("audio_url:", audio_url ? audio_url.slice(0, 120) : "(no)");
    console.log("audio_base64:", audio_base64 ? `(yes, ${String(audio_base64).length} chars)` : "(no)");

    if (!video_url) return res.status(400).json({ error: "Missing video_url" });
    if (!audio_url && !audio_base64) {
      return res.status(400).json({ error: "Provide audio_url OR audio_base64" });
    }

    const videoPath = path.join(tmpDir, "in_video.mp4");
    const audioPath = path.join(tmpDir, "in_audio.mp3");
    const outPath = path.join(tmpDir, "out.mp4");

    // Video siempre por URL
    await downloadToFile(video_url, videoPath);

    // Audio: preferimos base64 si viene
    if (audio_base64) {
      decodeBase64ToFile(audio_base64, audioPath);
    } else {
      await downloadToFile(audio_url, audioPath);
    }

    await runFfmpegMerge(videoPath, audioPath, outPath);

    // Responder el MP4
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="merged_${reqId}.mp4"`);

    const stream = fs.createReadStream(outPath);
    stream.on("error", (e) => {
      console.error("ReadStream error:", e);
      res.status(500).end("Failed reading output file");
    });
    stream.pipe(res);

  } catch (err) {
    console.error("❌ Error en /merge:", err);
    res.status(500).json({
      error: "Error procesando el video con ffmpeg",
      details: String(err?.message || err),
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Servidor FFmpeg escuchando en puerto ${PORT}`));
