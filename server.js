// server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" })); // sube/baja si tu base64 es muy grande

app.get("/", (_req, res) => {
  res.status(200).send("OK - FFmpeg merge service is live");
});

async function downloadToFile(url, outPath) {
  // IMPORTANTE: usa arrayBuffer para evitar .pipe
  const resp = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "n8n-ffmpeg-merge/1.0",
      "Accept": "*/*",
    },
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Download failed (${resp.status}) ${url} :: ${txt.slice(0, 200)}`);
  }

  const ab = await resp.arrayBuffer();
  const buf = Buffer.from(ab);

  // Si te baja 100-300 bytes, casi seguro es HTML/redirect/login, etc.
  if (buf.length < 1024) {
    throw new Error(`Downloaded file too small (${buf.length} bytes). URL: ${url}`);
  }

  await fsp.writeFile(outPath, buf);
  return outPath;
}

function writeBase64ToFile(base64Str, outPath) {
  // Limpia prefijos tipo "data:audio/mp3;base64,"
  const cleaned = base64Str
    .replace(/^data:.*?;base64,/, "")
    .replace(/\s/g, ""); // quita saltos de línea/espacios

  if (!cleaned || cleaned.length < 200) {
    throw new Error("audio_base64 is empty/too short after cleaning");
  }

  const buf = Buffer.from(cleaned, "base64");

  if (buf.length < 1024) {
    throw new Error(`Decoded audio too small (${buf.length} bytes)`);
  }

  fs.writeFileSync(outPath, buf);
  return outPath;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));

    p.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg failed (code ${code}): ${stderr.slice(0, 2000)}`));
    });
  });
}

app.post("/merge", async (req, res) => {
  try {
    let { video_url, audio_url, audio_base64 } = req.body || {};

    // Evita el bug de URLs con "=" o "\n" adelante
    video_url = (video_url || "").toString().trim().replace(/^=+/, "");
    audio_url = (audio_url || "").toString().trim().replace(/^=+/, "");

    if (!video_url) return res.status(400).json({ error: "video_url is required" });
    if (!audio_url && !audio_base64) {
      return res.status(400).json({ error: "Provide audio_url OR audio_base64" });
    }

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "merge-"));
    const inVideo = path.join(tmpDir, "video.mp4");
    const inAudio = path.join(tmpDir, "audio.mp3");
    const outVideo = path.join(tmpDir, "out.mp4");

    // 1) bajar video
    await downloadToFile(video_url, inVideo);

    // 2) audio: base64 (preferido) o url
    if (audio_base64) {
      writeBase64ToFile(audio_base64, inAudio);
    } else {
      await downloadToFile(audio_url, inAudio);
    }

    // 3) merge con ffmpeg (reemplaza audio)
    await runFfmpeg([
      "-y",
      "-i", inVideo,
      "-i", inAudio,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "copy",
      "-c:a", "aac",
      "-shortest",
      outVideo,
    ]);

    const stat = await fsp.stat(outVideo);
    if (stat.size < 1024 * 50) {
      throw new Error(`Output too small (${stat.size} bytes)`);
    }

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="merged.mp4"');
    fs.createReadStream(outVideo).pipe(res);

    // Limpieza “best effort”
    res.on("finish", async () => {
      try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch {}
    });
  } catch (err) {
    console.error("❌ /merge error:", err);
    res.status(500).json({ error: "Error procesando el video con ffmpeg", details: String(err.message || err) });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Servidor FFmpeg escuchando en puerto ${port}`));
