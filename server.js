// server.js
// Micro-API para mezclar VIDEO + AUDIO usando FFmpeg en Render

const express = require("express");
const bodyParser = require("body-parser");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Decirle a fluent-ffmpeg dónde está el binario de ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(bodyParser.json({ limit: "50mb" })); // aceptamos JSON grande

// Carpeta temporal (en Render es /tmp)
const TMP_DIR = os.tmpdir();

// --------- Ruta de prueba rápida (healthcheck) ----------
app.get("/health", (req, res) => {
  res.send("ok");
});

// --------- Función para descargar un archivo a disco ----------
async function downloadToFile(url, destPath) {
  const response = await fetch(url); // fetch nativo de Node 18 en Render

  if (!response.ok) {
    throw new Error(`Error descargando ${url} – HTTP ${response.status}`);
  }

  await new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(destPath);
    response.body.pipe(fileStream);
    response.body.on("error", reject);
    fileStream.on("finish", resolve);
  });

  return destPath;
}

// --------- Función para mezclar video + audio con FFmpeg ----------
function mergeVideoAndAudio(videoPath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .input(audioPath)
      // Copiamos el vídeo, re-codificamos el audio y usamos la duración más corta
      .outputOptions(["-c:v copy", "-c:a aac", "-shortest"])
      .on("end", () => resolve(outputPath))
      .on("error", (err) => reject(err))
      .save(outputPath);
  });
}

// --------- Endpoint principal: POST /merge ----------
app.post("/merge", async (req, res) => {
  const { video_url, audio_url } = req.body || {};

  if (!video_url || !audio_url) {
    return res.status(400).json({
      ok: false,
      error: "Faltan parámetros. Necesito video_url y audio_url en el body.",
    });
  }

  console.log("📥 Petición /merge");
  console.log("   video_url:", video_url);
  console.log("   audio_url:", audio_url);

  // Rutas temporales dentro de /tmp
  const videoPath = path.join(TMP_DIR, `video_${Date.now()}.mp4`);
  const audioPath = path.join(TMP_DIR, `audio_${Date.now()}.mp3`);
  const outputPath = path.join(TMP_DIR, `output_${Date.now()}.mp4`);

  try {
    // 1) Descargar archivos al disco del servidor
    await downloadToFile(video_url, videoPath);
    await downloadToFile(audio_url, audioPath);

    // 2) Mezclar con ffmpeg
    await mergeVideoAndAudio(videoPath, audioPath, outputPath);

    console.log("✅ Mezcla completada en", outputPath);

    // 3) Devolver respuesta a n8n
    //   De momento solo devolvemos un OK + la ruta local.
    //   Más adelante, si quieres, lo subimos a Upload.io desde aquí.
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
    // Limpieza básica de archivos temporales
    for (const p of [videoPath, audioPath]) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch (_) {}
    }
  }
});

// --------- Arrancar servidor ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor FFmpeg escuchando en puerto ${PORT}`);
});
