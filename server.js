const express = require('express');
const fetch = require('node-fetch');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const os = require('os');
const path = require('path');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(express.json({ limit: '200mb' }));

async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Error descargando ${url}: ${res.status} ${res.statusText}`);
  }

  const fileStream = fs.createWriteStream(destPath);
  await new Promise((resolve, reject) => {
    res.body.pipe(fileStream);
    res.body.on('error', reject);
    fileStream.on('finish', resolve);
  });
}

app.post('/merge', async (req, res) => {
  const { video_url, audio_url } = req.body || {};

  if (!video_url || !audio_url) {
    return res.status(400).json({
      error: 'Faltan parámetros: video_url y audio_url son obligatorios'
    });
  }

  const tmpDir = os.tmpdir();
  const videoPath = path.join(tmpDir, `video_${Date.now()}.mp4`);
  const audioPath = path.join(tmpDir, `audio_${Date.now()}.mp3`);
  const outputPath = path.join(tmpDir, `output_${Date.now()}.mp4`);

  try {
    // 1) Descargar archivos
    await downloadFile(video_url, videoPath);
    await downloadFile(audio_url, audioPath);

    // 2) Mezclar con FFmpeg
    ffmpeg(videoPath)
      .addInput(audioPath)
      .outputOptions(['-c:v copy', '-c:a aac', '-shortest'])
      .toFormat('mp4')
      .on('error', (err) => {
        console.error('Error en FFmpeg:', err);
        try {
          fs.unlinkSync(videoPath);
          fs.unlinkSync(audioPath);
          if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        } catch (_) {}
        return res.status(500).json({ error: 'Error procesando el vídeo' });
      })
      .on('end', () => {
        res.setHeader('Content-Type', 'video/mp4');

        const stream = fs.createReadStream(outputPath);
        stream.pipe(res);

        stream.on('close', () => {
          try {
            fs.unlinkSync(videoPath);
            fs.unlinkSync(audioPath);
            fs.unlinkSync(outputPath);
          } catch (_) {}
        });
      })
      .save(outputPath);
  } catch (err) {
    console.error('Error en /merge:', err);
    try {
      if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch (_) {}
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FFmpeg merge API escuchando en puerto ${PORT}`);
});
