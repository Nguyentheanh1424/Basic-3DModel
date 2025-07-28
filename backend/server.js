const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const { execSync } = require("child_process");
const zlib = require("zlib");

const app = express();
app.use(cors());
app.use(express.json());

const TEMP_DIR = path.join(__dirname, "uploads/tmp");
const FINAL_DIR = path.join(__dirname, "uploads/models");

// Tạo folder nếu chưa tồn tại
fs.mkdirSync(TEMP_DIR, { recursive: true });
fs.mkdirSync(FINAL_DIR, { recursive: true });

// Multer lưu chunk tạm thời trong RAM (buffer)
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Nhận từng chunk
app.post("/upload-chunk", upload.single("chunk"), (req, res) => {
  const { fileId, chunkIndex } = req.body;
  const chunk = req.file;

  if (!fileId || chunkIndex === undefined || !chunk) {
    return res
      .status(400)
      .json({ message: "Thiếu thông tin fileId, chunkIndex hoặc chunk." });
  }

  const chunkDir = path.join(TEMP_DIR, fileId);
  fs.mkdirSync(chunkDir, { recursive: true });

  const chunkPath = path.join(chunkDir, `chunk_${chunkIndex}`);
  fs.writeFileSync(chunkPath, chunk.buffer);

  res.status(200).json({ message: `Chunk ${chunkIndex} uploaded.` });
});

// Ghép file sau khi nhận đủ chunk
app.post("/finalize-upload", async (req, res) => {
  const { fileId, totalChunks, fileName } = req.body;
  const chunkDir = path.join(TEMP_DIR, fileId);

  if (!fileName) return res.status(400).json({ error: "Thiếu filename" });

  if (!fs.existsSync(chunkDir)) {
    return res.status(404).json({ message: "Không tìm thấy folder chunk." });
  }

  let baseName = fileName;
  let tempGzipPath = path.join(TEMP_DIR, `${fileId}_temp.glb`);
  let rawGlbPath = path.join(TEMP_DIR, `${fileId}_raw.glb`);
  let optimizedPath = path.join(FINAL_DIR, `${baseName}.glb`);
  let counter = 1;

  // Tạo unique filename nếu file đã tồn tại
  while (fs.existsSync(optimizedPath)) {
    baseName = `${fileName}_${counter}`;
    optimizedPath = path.join(FINAL_DIR, `${baseName}.glb`);
    counter++;
  }

  try {
    // Ghép chunks
    const writeStream = fs.createWriteStream(tempGzipPath);
    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(chunkDir, `chunk_${i}`);
      if (!fs.existsSync(chunkPath)) {
        throw new Error(`Chunk ${i} bị thiếu.`);
      }
      const data = fs.readFileSync(chunkPath);
      writeStream.write(data);
    }
    writeStream.end();

    // Đợi stream hoàn thành
    await new Promise((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });

    // Decompress client gzip data
    console.log("Decompressing client data...");
    const compressedData = fs.readFileSync(tempGzipPath);
    const decompressed = zlib.gunzipSync(compressedData);
    fs.writeFileSync(rawGlbPath, decompressed);

    // Optimize với gltf-pipeline
    try {
      execSync("gltf-pipeline --version", { stdio: "pipe" });
      console.log("🔧 Optimizing with gltf-pipeline...");

      const pipelineCmd = [
        "gltf-pipeline",
        `-i "${rawGlbPath}"`,
        `-o "${optimizedPath}"`,
        "--draco.compressionLevel 0", // Compression thấp nhất
        "--draco.quantizePositionBits 16", // Precision cao nhất
        "--draco.quantizeNormalBits 16", // Max precision cho normals
        "--draco.quantizeTexcoordBits 16", // Max precision cho UVs
        "--draco.unifiedQuantization false", // Tắt unified quantization
        "--binary", // Đảm bảo GLB output
      ].join(" ");

      execSync(pipelineCmd, { stdio: "pipe" });

      const originalSize = fs.statSync(rawGlbPath).size;
      const optimizedSize = fs.statSync(optimizedPath).size;
      const reduction = Math.round((1 - optimizedSize / originalSize) * 100);

      console.log(
        `✅ Draco optimization completed! Size reduced by ${reduction}%`
      );
      console.log(`   Original: ${(originalSize / 1024 / 1024).toFixed(2)}MB`);
      console.log(
        `   Optimized: ${(optimizedSize / 1024 / 1024).toFixed(2)}MB`
      );
    } catch (err) {
      console.error("❌ Lỗi khi chạy gltf-pipeline:", err.message)
      fs.copyFileSync(rawGlbPath, optimizedPath);
    }

    // Cleanup temp files
    fs.rmSync(chunkDir, { recursive: true, force: true });
    if (fs.existsSync(tempGzipPath)) fs.unlinkSync(tempGzipPath);
    if (fs.existsSync(rawGlbPath)) fs.unlinkSync(rawGlbPath);

    res.status(200).json({
      message: "File uploaded và tối ưu thành công.",
      filename: `${baseName}.glb`,
    });
  } catch (error) {
    console.error("Lỗi khi xử lý file:", error);

    try {
      fs.rmSync(chunkDir, { recursive: true, force: true });
      if (fs.existsSync(tempGzipPath)) fs.unlinkSync(tempGzipPath);
      if (fs.existsSync(rawGlbPath)) fs.unlinkSync(rawGlbPath);
      if (fs.existsSync(optimizedPath)) fs.unlinkSync(optimizedPath);
    } catch (cleanupError) {
      console.error("Cleanup error:", cleanupError);
    }

    res.status(500).json({
      message: "Lỗi khi xử lý file.",
      error: error.message,
    });
  }
});

// Xem danh sách file đã upload
app.get("/models", (req, res) => {
  try {
    const files = fs
      .readdirSync(FINAL_DIR)
      .filter((name) => name.endsWith(".glb"))
      .map((filename) => {
        const filePath = path.join(FINAL_DIR, filename);
        const stats = fs.statSync(filePath);
        return {
          name: filename,
          size: stats.size,
          uploadDate: stats.mtime,
        };
      })
      .sort((a, b) => b.uploadDate - a.uploadDate); // Sort by newest first

    res.json(files);
  } catch (error) {
    console.error("Error reading models directory:", error);
    res.status(500).json({ message: "Lỗi khi đọc danh sách models." });
  }
});

// Serve model files
app.get("/models/:fileName", (req, res) => {
  const fileName = req.params.fileName;

  // Security: prevent path traversal
  if (
    fileName.includes("..") ||
    fileName.includes("/") ||
    fileName.includes("\\")
  ) {
    return res.status(400).send("Invalid filename.");
  }

  const filePath = path.join(FINAL_DIR, fileName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("File không tồn tại.");
  }

  // Set appropriate headers for GLB files
  res.setHeader("Content-Type", "model/gltf-binary");
  res.setHeader("Cache-Control", "public, max-age=31536000"); // Cache 1 year
  res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);

  // Enable CORS for model loading
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  res.sendFile(filePath);
});

// Delete model endpoint
app.delete("/models/:fileName", (req, res) => {
  const fileName = req.params.fileName;

  // Security check
  if (
    fileName.includes("..") ||
    fileName.includes("/") ||
    fileName.includes("\\")
  ) {
    return res.status(400).json({ message: "Invalid filename." });
  }

  const filePath = path.join(FINAL_DIR, fileName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ message: "File không tồn tại." });
  }

  try {
    fs.unlinkSync(filePath);
    res.json({ message: `File ${fileName} đã được xóa.` });
  } catch (error) {
    console.error("Error deleting file:", error);
    res.status(500).json({ message: "Lỗi khi xóa file." });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`📁 Models directory: ${FINAL_DIR}`);
});
