import "./style.css";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { gzip, ungzip } from "pako";

const CHUNK_SIZE = 1024 * 1024;
const UPLOAD_URL = "http://localhost:3000/upload-chunk";
const FINALIZE_URL = "http://localhost:3000/finalize-upload";

// Giao diện
document.querySelector("#app").innerHTML = `
  <div class="container">
    <h1>Upload 3D Model</h1>
    <input type="file" id="fileInput" accept=".glb" />
    <progress id="progressBar" value="0" max="100"></progress>
    <p id="status">Select a file to get started...</p>
  </div>
  <div class="model-list">
    <h2>📂 Uploaded 3D Models</h2>
    <ul id="modelList"></ul>
  </div>
`;

// Modal viewer
document.body.insertAdjacentHTML(
  "beforeend",
  `
  <div id="modelModal" class="modal hidden">
    <div class="modal-content">
      <span class="close-button">&times;</span>
      <canvas id="modelCanvas"></canvas>
    </div>
  </div>
`
);

const modal = document.getElementById("modelModal");
const canvas = document.getElementById("modelCanvas");

const closeButton = modal.querySelector(".close-button");
closeButton.addEventListener("click", () => {
  modal.classList.add("hidden");
  stopRendering();
});

modal.addEventListener("click", (e) => {
  if (e.target === modal) modal.classList.add("hidden");
});

// Upload handler
document.querySelector("#fileInput").addEventListener("change", async () => {
  const fileInput = document.querySelector("#fileInput");
  const file = fileInput.files[0];
  const status = document.querySelector("#status");
  const progressBar = document.querySelector("#progressBar");

  if (!file) {
    status.textContent = "No file selected!";
    return;
  }

  status.textContent = "🔄 Compressing file...";
  const arrayBuffer = await file.arrayBuffer();
  const compressed = gzip(new Uint8Array(arrayBuffer));
  const fileId = crypto.randomUUID();
  const totalChunks = Math.ceil(compressed.length / CHUNK_SIZE);

  for (let i = 0; i < totalChunks; i++) {
    const chunk = compressed.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const form = new FormData();
    form.append("fileId", fileId);
    form.append("chunkIndex", i);
    form.append(
      "chunk",
      new Blob([chunk], { type: "application/octet-stream" })
    );

    await fetch(UPLOAD_URL, { method: "POST", body: form });

    const percent = Math.round(((i + 1) / totalChunks) * 100);
    progressBar.value = percent;
    status.textContent = `📤 	Uploading... ${percent}%`;
  }

  const fileName = file.name.replace(/\.[^/.]+$/, "");
  await fetch(FINALIZE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileId, totalChunks, fileName }),
  });

  status.textContent = "🎉 Upload successful! ";
  progressBar.value = 0;
  await fetchAndDisplayModels();
});

// Danh sách model
async function fetchAndDisplayModels() {
  const res = await fetch("http://localhost:3000/models");
  const files = await res.json();

  const ul = document.getElementById("modelList");
  ul.innerHTML = "";

  files.forEach((file) => {
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.href = "#";
    link.textContent = file;
    link.addEventListener("click", (e) => {
      e.preventDefault();
      loadModelFromServer(file);
    });
    li.appendChild(link);
    ul.appendChild(li);
  });
}

const scene = new THREE.Scene();

// Fallback nếu canvas chưa có kích thước ban đầu
let width = canvas.clientWidth;
let height = canvas.clientHeight;

const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
camera.position.set(0, 1.5, 5);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
});
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(width, height);
renderer.debug.checkShaderErrors = true;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
// Giới hạn góc nhìn để tránh nhìn từ dưới đất
controls.minPolarAngle = 0;

// Keyboard controls
const keyState = {};
window.addEventListener("keydown", (e) => {
  keyState[e.key.toLowerCase()] = true;
});
window.addEventListener("keyup", (e) => {
  keyState[e.key.toLowerCase()] = false;
});

controls.update();

let currentModel = null;

async function loadModelFromServer(fileName) {
  const url = `http://localhost:3000/models/${fileName}`;
  const response = await fetch(url);
  const compressedBuffer = await response.arrayBuffer();
  const decompressed = ungzip(new Uint8Array(compressedBuffer));
  const blob = new Blob([decompressed], { type: "model/gltf-binary" });
  const objectURL = URL.createObjectURL(blob);

  console.log("Compressed size:", compressedBuffer.byteLength);
  console.log("Decompressed size:", decompressed.length);
  console.log("Object URL:", objectURL);

  const loader = new GLTFLoader();

  loader.load(
    "/sporting_village.glb",
    (gltf) => {
      // Xóa model cũ
      if (currentModel) {
        scene.remove(currentModel);
        currentModel.traverse((child) => {
          if (child.isMesh) {
            child.geometry.dispose();
            child.material.dispose();
          }
        });
      }

      // Gán model mới
      currentModel = gltf.scene;
      currentModel.scale.set(1, 1, 1);
      scene.add(currentModel);

      // Camera nhìn từ xa
      camera.position.set(0, 1, 2.5);
      camera.lookAt(0, 0, 0);
      controls.target.set(0, 0, 0);
      controls.update();

      // Hiện khung View Model
      modal.classList.remove("hidden");
      startRendering();
    },
    (xhr) => {
      console.log(`Loading model: ${(xhr.loaded / xhr.total) * 100}% loaded`);
    },
    (error) => {
      console.error("Error loading model:", error);
    }
  );
}

// Resize window
window.addEventListener("resize", () => {
  const newWidth = canvas.clientWidth;
  const newHeight = canvas.clientHeight;

  camera.aspect = newWidth / newHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(newWidth, newHeight);
});

let animationFrameId = null;
let isRendering = false;

function updateMovement() {
  if (!currentModel) return;

  const speed = 0.05;
  const direction = new THREE.Vector3();
  camera.getWorldDirection(direction);
  direction.y = 0;

  const side = new THREE.Vector3();
  side.crossVectors(direction, camera.up).normalize();

  if (keyState["w"])
    currentModel.position.add(direction.clone().multiplyScalar(-speed));
  if (keyState["s"])
    currentModel.position.add(direction.clone().multiplyScalar(speed));
  if (keyState["a"])
    currentModel.position.add(side.clone().multiplyScalar(speed));
  if (keyState["d"])
    currentModel.position.add(side.clone().multiplyScalar(-speed));
}

function animate() {
  if (!isRendering) return;

  animationFrameId = requestAnimationFrame(animate);

  controls.update();
  updateMovement();
  renderer.render(scene, camera);
}

function startRendering() {
  if (!isRendering) {
    isRendering = true;
    animate();
  }
}

function stopRendering() {
  isRendering = false;
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

fetchAndDisplayModels();
