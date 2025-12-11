const express = require("express");
const bodyParser = require("body-parser");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");
const os = require("os");

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(bodyParser.json({ limit: "50mb" }));

// Ruta de prueba rápida: para ver si el servidor está vivo
app.get("/health", (req, res) => {
  res.send("ok");
});

// Función para descargar un archivo (video / audio) a un fichero temporal
async function downloadToFile(url, dest) {
  const response = await fetch(url); // fetch nativo de Node 18
  if (!response.ok) {
    throw new Error(
      `Error descargando ${url}: ${response.status} ${response.statusText}`
    );
  }

  const fileStream = fs.createWriteStream(dest);
  await new Promise((resolve, reject) => {
    response.body.pipe(fileStream);
    response.body.on("error", reject);
    fileStream.on("finish", resolve);
  });
}

// Ruta que mezcla VIDEO + AUDIO
app.post("/merge", async (req, res) => {
  try {
    // Aceptamos los dos formatos de nombre, por si acaso:
    const videoUrl = req.body.video_url || req.body.videoUrl;
    const audioUrl = req.body.audio_url || req.body.audioUrl;

    if (!videoUrl || !audioUrl) {
      return res
        .status(400)
        .json({ error: "Falta video_url o audio_url en el cuerpo de la petición" });
    }

    const tmp = os.tmpdir();
    const videoPath = path.join(tmp, `video-${Date.now()}.mp4`);
    const audioPath = path.join(tmp, `audio-${Date.now()}.mp3`);
    const outPath = path.join(tmp, `out-${Date.now()}.mp4`);

    console.log("Descargando video:", videoUrl);
    await downloadToFile(videoUrl, videoPath);

    console.log("Descargando audio:", audioUrl);
    await downloadToFile(audioUrl, audioPath);

    console.log("Lanzando ffmpeg...");
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .addInput(audioPath)
        .videoCodec("copy")       // no reencodea el video
        .audioCodec("aac")        // audio compatible con la mayoría de plataformas
        .outputOptions("-shortest") // para que no se alargue más que el audio/vídeo
        .on("end", () => {
          console.log("FFmpeg terminó OK");
          resolve();
        })
        .on("error", (err) => {
          console.error("Error en ffmpeg:", err);
          reject(err);
        })
        .save(outPath);
    });

    // Devolvemos el vídeo mezclado directamente como archivo
    res.setHeader("Content-Type", "video/mp4");

    const stream = fs.createReadStream(outPath);
    stream.on("close", () => {
      // Limpiar temporales
      fs.unlink(videoPath, () => {});
      fs.unlink(audioPath, () => {});
      fs.unlink(outPath, () => {});
    });
    stream.pipe(res);
  } catch (err) {
    console.error("Error en /merge:", err);
    res
      .status(500)
      .json({ error: "Error procesando el video", detail: err.message });
  }
});

// Render te da el puerto en process.env.PORT
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor escuchando en puerto ${port}`);
});
