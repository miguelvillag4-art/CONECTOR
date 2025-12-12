// server.js
// Micro-API para mezclar VIDEO + AUDIO usando FFmpeg en Render (Node 18+)

const express = require("express");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Decirle a fluent-ffmpeg dónde está el binario de ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(express.json({ limit: "5mb" })); // aquí solo recibimos URLs, no archivos

const TMP_DIR = os.tmpdir();

// Healthcheck
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

// Descarga segura (binario real)
async function downloadToFile(url, destPath) {
  const cleanUrl = String(url || "").trim();

  const res = await fetch(cleanUrl, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Error descargando ${cleanUrl} – HTTP ${res.status}`);
  }

  const contentType = res.headers.get("content-type") || "";
  // Si te devuelve HTML, casi seguro es un 404 “bonito” o página, no un mp3/mp4
  if (contentType.includes("text/html")) {
    throw new Error(`La URL devolvió HTML (no archivo). URL: ${cleanUrl}`);
  }

  const arr = await res.arrayBuffer();
  const buf = Buffer.from(arr);

  if (!buf || buf.length < 1000) {
    throw new Error(`Archivo descargado demasiado pequeño (${buf.length} bytes). URL: ${cleanUrl}`);
  }

  fs.writeFileSync(destPath, buf);
  return destPath;
}

// Merge con ffmpeg
function mergeVideoAndAudio(videoPath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .input(audioPath)
      .outputOptions([
        "-c:v copy",
        "-c:a aac",
        "-shortest"
      ])
      .on("end", () => resolve(outputPath))
      .on("error", (err) => reject(err))
      .save(outputPath);
  });
}

// POST /merge
app.post("/merge", async (req, res) => {
  const video_url = String(req.body?.video_url || "").trim();
  const audio_url = String(req.body?.audio_url || "").trim();

  if (!video_url || !audio_url) {
    return res.status(400).json({
      ok: false,
      error: "Faltan parámetros. Necesito video_url y audio_url en el body."
    });
  }

  console.log("📥 /merge");
  console.log("video_url:", video_url);
  console.log("audio_url:", audio_url);

  const ts = Date.now();
  const videoPath = path.join(TMP_DIR, `video_${ts}.mp4`);
  const audioPath = path.join(TMP_DIR, `audio_${ts}.mp3`);
  const outputPath = path.join(TMP_DIR, `output_${ts}.mp4`);

  try {
    await downloadToFile(video_url, videoPath);
    await downloadToFile(audio_url, audioPath);

    await mergeVideoAndAudio(videoPath, audioPath, outputPath);

    console.log("✅ Merge OK:", outputPath);

    // Devolvemos el archivo como descarga directa (para test rápido)
    // n8n puede consumirlo si luego haces un HTTP Download de este endpoint (te digo cómo si quieres)
    return res.status(200).sendFile(outputPath);
  } catch (err) {
    console.error("❌ Error en /merge:", err);
    return res.status(500).json({
      ok: false,
      error: "Error procesando el vídeo con ffmpeg",
      details: err.message || String(err)
    });
  } finally {
    // limpia inputs (el output no lo borramos en finally porque lo estamos enviando)
    for (const p of [videoPath, audioPath]) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
    }
    // borramos el output después de un ratito (evita llenar /tmp)
    setTimeout(() => {
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
    }, 60_000);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor FFmpeg escuchando en puerto ${PORT}`);
});
