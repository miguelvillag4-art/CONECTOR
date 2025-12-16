// server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const app = express();

// IMPORTANTE en Render / proxy
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json({ limit: "200mb" })); // sube si tu audio_base64 es grande

app.get("/", (_req, res) => {
  res.status(200).send("OK - FFmpeg merge service is live");
});

// Carpeta temporal para guardar videos servibles por URL
const STORE_DIR = path.join(os.tmpdir(), "merged-store");
async function ensureStoreDir() {
  try {
    await fsp.mkdir(STORE_DIR, { recursive: true });
  } catch {}
}
ensureStoreDir();

// TTL para links (en ms). 30 min:
const FILE_TTL_MS = 30 * 60 * 1000;

// Para poder borrar luego
const timers = new Map();

async function downloadToFile(url, outPath) {
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

  if (buf.length < 1024) {
    throw new Error(`Downloaded file too small (${buf.length} bytes). URL: ${url}`);
  }

  await fsp.writeFile(outPath, buf);
  return outPath;
}

function writeBase64ToFile(base64Str, outPath) {
  const cleaned = base64Str
    .replace(/^data:.*?;base64,/, "")
    .replace(/\s/g, "");

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
      reject(new Error(`ffmpeg failed (code ${code}): ${stderr.slice(0, 4000)}`));
    });
  });
}

function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

async function buildMergedVideo({ video_url, audio_url, audio_base64 }) {
  video_url = (video_url || "").toString().trim().replace(/^=+/, "");
  audio_url = (audio_url || "").toString().trim().replace(/^=+/, "");

  if (!video_url) throw new Error("video_url is required");
  if (!audio_url && !audio_base64) throw new Error("Provide audio_url OR audio_base64");

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "merge-"));
  const inVideo = path.join(tmpDir, "video.mp4");
  const inAudio = path.join(tmpDir, "audio.mp3");
  const outVideo = path.join(tmpDir, "out.mp4");

  // 1) bajar video
  await downloadToFile(video_url, inVideo);

  // 2) audio
  if (audio_base64) {
    writeBase64ToFile(audio_base64, inAudio);
  } else {
    await downloadToFile(audio_url, inAudio);
  }

  // 3) merge IG-friendly (RE-ENCODE)
  await runFfmpeg([
    "-y",
    "-i", inVideo,
    "-i", inAudio,

    "-map", "0:v:0",
    "-map", "1:a:0",

    // Video IG-friendly
    "-c:v", "libx264",
    "-profile:v", "high",
    "-level", "4.1",
    "-pix_fmt", "yuv420p",
    "-r", "30",

    // Audio IG-friendly
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "44100",
    "-ac", "2",

    "-shortest",
    "-movflags", "+faststart",

    outVideo,
  ]);

  const stat = await fsp.stat(outVideo);
  if (stat.size < 1024 * 50) {
    throw new Error(`Output too small (${stat.size} bytes)`);
  }

  return { tmpDir, outVideo };
}

/**
 * Endpoint A: devuelve BINARIO (para Facebook/YouTube)
 */
app.post("/merge", async (req, res) => {
  let tmpDir = null;
  try {
    const { video_url, audio_url, audio_base64 } = req.body || {};
    const built = await buildMergedVideo({ video_url, audio_url, audio_base64 });
    tmpDir = built.tmpDir;

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="merged.mp4"');
    fs.createReadStream(built.outVideo).pipe(res);

    res.on("finish", async () => {
      try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch {}
    });
  } catch (err) {
    console.error("❌ /merge error:", err);
    if (tmpDir) {
      try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch {}
    }
    res.status(500).json({ error: "Error procesando el video con ffmpeg", details: String(err.message || err) });
  }
});

/**
 * Opción B1: devuelve URL pública temporal (para Instagram)
 * POST /merge_url -> { file_url, id, expires_at }
 */
app.post("/merge_url", async (req, res) => {
  let tmpDir = null;
  try {
    const { video_url, audio_url, audio_base64 } = req.body || {};
    const built = await buildMergedVideo({ video_url, audio_url, audio_base64 });
    tmpDir = built.tmpDir;

    // Guardamos el outVideo en STORE_DIR con un id
    const id = crypto.randomBytes(10).toString("hex");
    const storedPath = path.join(STORE_DIR, `${id}.mp4`);
    await fsp.copyFile(built.outVideo, storedPath);

    // Limpiamos el tmpDir (ya no lo necesitamos)
    try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch {}

    // Programamos borrado por TTL
    const expiresAt = Date.now() + FILE_TTL_MS;
    if (timers.has(id)) clearTimeout(timers.get(id));

    const t = setTimeout(async () => {
      try { await fsp.unlink(storedPath); } catch {}
      timers.delete(id);
    }, FILE_TTL_MS);

    timers.set(id, t);

    const baseUrl = getBaseUrl(req);
    const file_url = `${baseUrl}/files/${id}.mp4`;

    res.json({
      id,
      file_url,
      expires_at: new Date(expiresAt).toISOString(),
    });
  } catch (err) {
    console.error("❌ /merge_url error:", err);
    if (tmpDir) {
      try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch {}
    }
    res.status(500).json({ error: "Error creando file_url", details: String(err.message || err) });
  }
});

/**
 * Sirve el MP4 temporal para IG
 */
app.get("/files/:id.mp4", async (req, res) => {
  try {
    const id = (req.params.id || "").replace(/[^a-f0-9]/gi, "");
    const filePath = path.join(STORE_DIR, `${id}.mp4`);

    // si no existe
    await fsp.access(filePath).catch(() => {
      throw new Error("File not found or expired");
    });

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Cache-Control", "public, max-age=60"); // cache pequeñita
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    res.status(404).json({ error: "Not found", details: String(err.message || err) });
  }
});

// Render usa PORT
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Servidor FFmpeg escuchando en puerto ${PORT}`);
});
