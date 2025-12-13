import express from "express";
import fs from "fs";
import { writeFile } from "fs/promises";
import { exec } from "child_process";
import fetch from "node-fetch"; // SOLO si ya lo tenías instalado
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

const app = express();
app.use(express.json({ limit: "50mb" }));

const TMP_DIR = "/tmp";

// ==========================
// DESCARGAR VIDEO (Node 18 OK)
// ==========================
async function downloadToFile(url, outputPath) {
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`No se pudo descargar el archivo: ${res.status}`);
  }

  const nodeStream = Readable.fromWeb(res.body);
  await pipeline(nodeStream, fs.createWriteStream(outputPath));
}

// ==========================
// MERGE CON FFMPEG
// ==========================
app.post("/merge", async (req, res) => {
  try {
    const { video_url, audio_base64 } = req.body;

    if (!video_url || !audio_base64) {
      return res.status(400).json({
        error: "video_url y audio_base64 son obligatorios",
      });
    }

    console.log("▶ video_url:", video_url);
    console.log("▶ audio_base64 recibido");

    const videoPath = path.join(TMP_DIR, "video.mp4");
    const audioPath = path.join(TMP_DIR, "audio.mp3");
    const outputPath = path.join(TMP_DIR, "final.mp4");

    // Guardar audio
    const audioBuffer = Buffer.from(audio_base64, "base64");
    await writeFile(audioPath, audioBuffer);

    // Descargar video
    await downloadToFile(video_url, videoPath);

    // Ejecutar FFmpeg
    const cmd = `
      ffmpeg -y \
      -i ${videoPath} \
      -i ${audioPath} \
      -c:v copy \
      -c:a aac \
      -shortest \
      ${outputPath}
    `;

    await new Promise((resolve, reject) => {
      exec(cmd, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    // Enviar video final
    res.setHeader("Content-Type", "video/mp4");
    res.send(fs.readFileSync(outputPath));
  } catch (err) {
    console.error("❌ Error en /merge:", err);
    res.status(500).json({ error: "Error procesando el video con ffmpeg" });
  }
});

// ==========================
// SERVER
// ==========================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor FFmpeg escuchando en puerto ${PORT}`);
});
