const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

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

  // Tránh trùng tên file
  let baseName = fileName;
  let finalPath = path.join(FINAL_DIR, `${baseName}.glb.gz`);
  let counter = 1;

  while (fs.existsSync(finalPath)) {
    baseName = `${fileName}_${counter}`;
    finalPath = path.join(FINAL_DIR, `${baseName}.glb.gz`);
    counter++;
  }

  // Ghép các chunk lại thành file cuối
  const writeStream = fs.createWriteStream(finalPath);

  for (let i = 0; i < totalChunks; i++) {
    const chunkPath = path.join(chunkDir, `chunk_${i}`);
    if (!fs.existsSync(chunkPath)) {
      return res.status(400).json({ message: `Chunk ${i} bị thiếu.` });
    }
    const data = fs.readFileSync(chunkPath);
    writeStream.write(data);
  }

  writeStream.end(() => {
    // Dọn dẹp chunk tạm
    fs.rmSync(chunkDir, { recursive: true, force: true });
    res.status(200).json({ message: "File đã được ghép và lưu thành công." });
  });
});

// Xem danh sách file đã ghép
app.get("/models", (req, res) => {
  const files = fs
    .readdirSync(FINAL_DIR)
    .filter((name) => name.endsWith(".glb.gz"));
  res.json(files);
});

// Loadfile cho người dùng
app.get("/models/:fileName", (req, res) => {
  const fileName = req.params.fileName;
  const filePath = path.join(FINAL_DIR, fileName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("File không tồn tại.");
  }

  // Nếu là file .gz thì báo cho trình duyệt biết để tự giải nén
  if (fileName.endsWith(".gz")) {
    res.setHeader("Content-Type", "model/gltf-binary");
    res.setHeader("Content-Disposition", `inline; filename="${fileName.replace(/\.gz$/, '')}"`);
  }

  res.sendFile(filePath);
});


// Start server
const PORT = 3000;
app.listen(PORT, () => console.log(`Server chạy ở http://localhost:${PORT}`));
