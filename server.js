// server.js
// Micro-API para mezclar VIDEO + AUDIO usando FFmpeg en Render (audio por BASE64 o por URL)

const express = require("express");
const bodyParser = require("body-parser");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");
const os = require("os");

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(bodyParser.json({ limit: "100mb" })); // subimos el límite por el base64

const TMP_DIR = os.tmpdir();

app.get("/health", (req, res) => res.send("ok"));

function safeUrl(u) {
  if (!u) return u;
  // Por si llega con "=" al inicio (como te pasó en logs)
  return String(u).trim().replace(/^=+/, "");
}

async function downloadToFile(url, destPath) {
  const clean = safeUrl(url);
  const response = await fetch(clean, { redirect: "follow" });

  if (!response.ok) {
    throw new Error(`Error descargando ${clean} – HTTP ${response.status}`);
  }

  await new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(destPath);
    response.body.pipe(fileStream);
    response.body.on("error", reject);
    fileStream.on("finish", resolve);
  });

  return destPath;
}

function writeBase64ToFile(base64, destPath) {
  const clean = String(base64 || "").trim();

  // Por si viene como data:audio/mp3;base64,XXXX
  const justB64 = clean.includes("base64,") ? clean.split("base64,").pop() : clean;

  const buf = Buffer.from(justB64, "base64");

  if (!buf || buf.length < 5000) {
    // 5KB mínimo para evitar “basura” como tus 163 bytes
    throw new Error(`Audio base64 demasiado pequeño (${buf?.length || 0} bytes).`);
  }

  fs.writeFileSync(destPath, buf);
  return destPath;
}

function mergeVideoAndAudio(videoPath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .input(audioPath)
      .outputOptions([
        "-c:v copy",
        "-c:a aac",
        "-shortest",
        "-movflags +faststart",
      ])
      .on("end", () => resolve(outputPath))
      .on("error", (err) => reject(err))
      .save(outputPath);
  });
}

app.post("/merge", async (req, res) => {
  const { video_url, audio_url, audio_base64 } = req.body || {};

  const vUrl = safeUrl(video_url);
  const aUrl = safeUrl(audio_url);

  if (!vUrl) {
    return res.status(400).json({ ok: false, error: "Falta video_url" });
  }
  if (!audio_base64 && !aUrl) {
    return res.status(400).json({ ok: false, error: "Falta audio_base64 o audio_url" });
  }

  console.log("📥 /merge");
  console.log("   video_url:", vUrl);
  console.log("   audio_url:", aUrl ? aUrl : "(no)");
  console.log("   audio_base64:", audio_base64 ? `(sí, ${String(audio_base64).length} chars)` : "(no)");

  const videoPath = path.join(TMP_DIR, `video_${Date.now()}.mp4`);
  const audioPath = path.join(TMP_DIR, `audio_${Date.now()}.mp3`);
  const outputPath = path.join(TMP_DIR, `output_${Date.now()}.mp4`);

  try {
    await downloadToFile(vUrl, videoPath);

    if (audio_base64) {
      writeBase64ToFile(audio_base64, audioPath);
    } else {
      await downloadToFile(aUrl, audioPath);
      const stats = fs.statSync(audioPath);
      if (stats.size < 5000) {
        throw new Error(`Audio descargado demasiado pequeño (${stats.size} bytes). No es un MP3 válido.`);
      }
    }

    await mergeVideoAndAudio(videoPath, audioPath, outputPath);

    console.log("✅ Mezcla OK:", outputPath);

    return res.json({
      ok: true,
      message: "Vídeo mezclado correctamente",
      output_path: outputPath,
    });
  } catch (err) {
    console.error("❌ Error en /merge:", err);
    return res.status(500).json({
      ok: false,
      error: "Error procesando el vídeo con ffmpeg",
      details: err.message || String(err),
    });
  } finally {
    for (const p of [videoPath, audioPath]) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
    }
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Servidor FFmpeg escuchando en puerto ${PORT}`));
