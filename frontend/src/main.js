import "./style.css";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { gzip } from "pako";

const CHUNK_SIZE = 1024 * 1024;
const UPLOAD_URL = "http://localhost:3000/upload-chunk";
const FINALIZE_URL = "http://localhost:3000/finalize-upload";

document.querySelector("#app").innerHTML = `
  <div class="container">
    <h1>Upload 3D Model</h1>
    <input type="file" id="fileInput" accept=".glb" />
    <progress id="progressBar" value="0" max="100"></progress>
    <p id="status">Select a GLB file to get started...</p>
    <div id="uploadInfo" class="upload-info hidden">
      <p>File: <span id="fileName"></span></p>
      <p>Size: <span id="fileSize"></span></p>
    </div>
  </div>
  <div class="model-list">
    <h2>📂 Uploaded 3D Models</h2>
    <ul id="modelList"></ul>
    <p id="modelListStatus">Loading models...</p>
  </div>
`;

// Modal viewer
document.body.insertAdjacentHTML(
  "beforeend",
  `
  <div id="modelModal" class="modal hidden">
    <div class="modal-content">
      <span class="close-button">&times;</span>
      <div id="modelInfo" class="model-info">
        <h3 id="modelTitle">Model Name</h3>
        <p>Use WASD to move model, mouse to rotate camera</p>
      </div>
      <canvas id="modelCanvas"></canvas>
      <div id="loadingIndicator" class="loading-indicator hidden">Loading model...</div>
    </div>
  </div>
`
);

const modal = document.getElementById("modelModal");
const canvas = document.getElementById("modelCanvas");
const loadingIndicator = document.getElementById("loadingIndicator");
console.log("Loading Indicator:", loadingIndicator);

const closeButton = modal.querySelector(".close-button");
closeButton.addEventListener("click", () => {
  modal.classList.add("hidden");
  stopRendering();
});

modal.addEventListener("click", (e) => {
  if (e.target === modal) {
    modal.classList.add("hidden");
    stopRendering();
  }
});

// Upload handler với validation
document.querySelector("#fileInput").addEventListener("change", async () => {
  const fileInput = document.querySelector("#fileInput");
  const file = fileInput.files[0];
  const status = document.querySelector("#status");
  const progressBar = document.querySelector("#progressBar");
  const uploadInfo = document.querySelector("#uploadInfo");
  const fileName = document.querySelector("#fileName");
  const fileSize = document.querySelector("#fileSize");

  if (!file) {
    status.textContent = "No file selected!";
    uploadInfo.classList.add("hidden");
    return;
  }

  // Validation
  if (!file.name.toLowerCase().endsWith(".glb")) {
    status.textContent = "❌ Only .glb files are supported!";
    uploadInfo.classList.add("hidden");
    return;
  }

  // Show file info
  fileName.textContent = file.name;
  fileSize.textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB`;
  uploadInfo.classList.remove("hidden");

  try {
    status.textContent = "🔄 Compressing file...";
    progressBar.value = 0;

    const arrayBuffer = await file.arrayBuffer();
    const compressed = gzip(new Uint8Array(arrayBuffer));
    const fileId = crypto.randomUUID();
    const totalChunks = Math.ceil(compressed.length / CHUNK_SIZE);

    status.textContent = `📤 Uploading ${totalChunks} chunks...`;

    // Upload chunks
    for (let i = 0; i < totalChunks; i++) {
      const chunk = compressed.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const form = new FormData();
      form.append("fileId", fileId);
      form.append("chunkIndex", i);
      form.append(
        "chunk",
        new Blob([chunk], { type: "application/octet-stream" })
      );

      const response = await fetch(UPLOAD_URL, { method: "POST", body: form });

      if (!response.ok) {
        throw new Error(`Upload chunk ${i} failed: ${response.statusText}`);
      }

      const percent = Math.round(((i + 1) / totalChunks) * 100);
      progressBar.value = percent;
      status.textContent = `📤 Uploading... ${percent}%`;
    }

    status.textContent = "🔧 Processing file...";

    // Finalize upload
    const fileBaseName = file.name.replace(/\.[^/.]+$/, "");
    const finalizeResponse = await fetch(FINALIZE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId, totalChunks, fileName: fileBaseName }),
    });

    if (!finalizeResponse.ok) {
      const errorData = await finalizeResponse.json();
      throw new Error(errorData.message || "Finalize upload failed");
    }

    status.textContent = "🎉 Upload successful!";
    progressBar.value = 100;

    // Reset form after short delay
    setTimeout(() => {
      progressBar.value = 0;
      fileInput.value = "";
      uploadInfo.classList.add("hidden");
      status.textContent = "Select a GLB file to get started...";
    }, 2000);

    await fetchAndDisplayModels();
  } catch (error) {
    console.error("Upload failed:", error);
    status.textContent = `❌ Upload failed: ${error.message}`;
    progressBar.value = 0;
  }
});

// Danh sách model với improved display
async function fetchAndDisplayModels() {
  const modelListStatus = document.querySelector("#modelListStatus");

  try {
    modelListStatus.textContent = "Loading models...";
    const res = await fetch("http://localhost:3000/models");

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const files = await res.json();
    const ul = document.getElementById("modelList");
    ul.innerHTML = "";

    if (files.length === 0) {
      modelListStatus.textContent = "No models uploaded yet.";
      return;
    }

    modelListStatus.textContent = `${files.length} model(s) available:`;

    files.forEach((fileInfo) => {
      const li = document.createElement("li");
      li.className = "model-item";

      const fileName = fileInfo.name;
      const fileSize = fileInfo.size
        ? `(${(fileInfo.size / 1024 / 1024).toFixed(2)} MB)`
        : "";
      const uploadDate = fileInfo.uploadDate
        ? new Date(fileInfo.uploadDate).toLocaleDateString()
        : "";

      li.innerHTML = `
        <div class="model-item-content">
          <a href="#" class="model-link">${fileName}</a>
          <span class="model-size">${fileSize}</span>
          <span class="model-date">${uploadDate}</span>
          <button class="delete-btn" data-filename="${fileName}">🗑️</button>
        </div>
      `;

      const link = li.querySelector(".model-link");
      link.addEventListener("click", (e) => {
        e.preventDefault();
        loadModelFromServer(fileName);
      });

      const deleteBtn = li.querySelector(".delete-btn");
      deleteBtn.addEventListener("click", (e) => {
        e.preventDefault();
        deleteModel(fileName);
      });

      ul.appendChild(li);
    });
  } catch (error) {
    console.error("Failed to fetch models:", error);
    modelListStatus.textContent = "Failed to load models.";
  }
}

// Delete model function
async function deleteModel(fileName) {
  if (!confirm(`Are you sure you want to delete "${fileName}"?`)) {
    return;
  }

  try {
    const response = await fetch(
      `http://localhost:3000/models/${encodeURIComponent(fileName)}`,
      {
        method: "DELETE",
      }
    );

    if (response.ok) {
      await fetchAndDisplayModels();
    } else {
      const error = await response.json();
      alert(`Failed to delete: ${error.message}`);
    }
  } catch (error) {
    console.error("Delete failed:", error);
    alert("Failed to delete model.");
  }
}

// Three.js setup
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a1a);

// Add lighting
const ambientLight = new THREE.AmbientLight(0x404040, 0.6);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
directionalLight.position.set(1, 1, 1);
directionalLight.castShadow = true;
scene.add(directionalLight);

let camera, renderer, controls;
let currentModel = null;

// Initialize Three.js components when modal opens
function initializeThreeJS() {
  const rect = canvas.getBoundingClientRect();
  const width = rect.width || 800;
  const height = rect.height || 600;

  camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);

  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(width, height);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;

  camera.position.set(0, 1, 2.5);
  camera.lookAt(0, 0, 0);
  controls.target.set(0, 0, 0);
  controls.update();
}

// Keyboard controls
const keyState = {};
window.addEventListener("keydown", (e) => {
  keyState[e.key.toLowerCase()] = true;
});
window.addEventListener("keyup", (e) => {
  keyState[e.key.toLowerCase()] = false;
});

// Load model function
async function loadModelFromServer(fileName) {
  try {
    // Show modal and loading indicator
    modal.classList.remove("hidden");
    loadingIndicator.classList.remove("hidden");
    document.getElementById("modelTitle").textContent = fileName;

    // Initialize Three.js if not already done
    if (!renderer) {
      initializeThreeJS();
    }

    const objectURL = `http://localhost:3000/models/${encodeURIComponent(
      fileName
    )}`;

    // Setup GLTF loader with specific compatible Draco version
    const loader = new GLTFLoader();

    // Setup DRACOLoader with specific version that works with gltf-pipeline
    const dracoLoader = new DRACOLoader();

    dracoLoader.setDecoderPath(
      "https://www.gstatic.com/draco/versioned/decoders/1.5.6/"
    );

    dracoLoader.setDecoderConfig({
      type: "js",
    });

    loader.setDRACOLoader(dracoLoader);

    // Setup MeshoptDecoder
    loader.setMeshoptDecoder(MeshoptDecoder);

    const gltf = await new Promise((resolve, reject) => {
      console.log(`🔄 Attempting to load: ${objectURL}`);

      loader.load(
        objectURL,
        (loadedGltf) => {
          console.log("✅ Model loaded successfully with Draco");
          console.log("Model info:", {
            scenes: loadedGltf.scenes.length,
            animations: loadedGltf.animations.length,
            cameras: loadedGltf.cameras.length,
          });
          resolve(loadedGltf);
        },
        (xhr) => {
          if (xhr.lengthComputable) {
            const percent = Math.round((xhr.loaded / xhr.total) * 100);
            console.log(`Loading model: ${percent}% loaded`);
          }
        },
        (error) => {
          console.error("❌ Draco loading failed:", error);

          // If Draco fails, try loading without Draco
          console.log("🔄 Retrying without Draco compression...");

          const fallbackLoader = new GLTFLoader();
          fallbackLoader.setMeshoptDecoder(MeshoptDecoder);

          fallbackLoader.load(
            objectURL,
            (fallbackGltf) => {
              console.log("✅ Model loaded successfully without Draco");
              resolve(fallbackGltf);
            },
            (xhr2) => {
              if (xhr2.lengthComputable) {
                const percent = Math.round((xhr2.loaded / xhr2.total) * 100);
                console.log(`Fallback loading: ${percent}% loaded`);
              }
            },
            (fallbackError) => {
              console.error(
                "❌ Both Draco and fallback loading failed:",
                fallbackError
              );
              reject(fallbackError);
            }
          );
        }
      );
    });

    // Dispose previous model
    if (currentModel) {
      scene.remove(currentModel);
      currentModel.traverse((child) => {
        if (child.isMesh) {
          child.geometry?.dispose();
          if (Array.isArray(child.material)) {
            child.material.forEach((mat) => mat?.dispose());
          } else {
            child.material?.dispose();
          }
        }
      });
    }

    // Add new model
    currentModel = gltf.scene;
    currentModel.scale.set(1, 1, 1);
    scene.add(currentModel);

    // Hide loading indicator
    loadingIndicator.classList.add("hidden");
    loadingIndicator.textContent = "Loading model...";
    loadingIndicator.style.backgroundColor = "rgba(0, 0, 0, 0.75)";

    // Reset camera position
    camera.position.set(0, 1, 2.5);
    camera.lookAt(0, 0, 0);
    controls.target.set(0, 0, 0);
    controls.update();

    startRendering();
  } catch (error) {
    console.error("Error loading model:", error);
    loadingIndicator.textContent = `Failed to load model: ${error.message}`;
    loadingIndicator.style.backgroundColor = "#a00";

    setTimeout(() => {
      modal.classList.add("hidden");
      loadingIndicator.classList.add("hidden");
      loadingIndicator.textContent = "Loading model...";
      loadingIndicator.style.backgroundColor = "rgba(0, 0, 0, 0.75)";
    }, 3000);
  }
}

// Resize handling
window.addEventListener("resize", () => {
  if (modal.classList.contains("hidden") || !renderer || !camera) return;

  const rect = canvas.getBoundingClientRect();
  const newWidth = rect.width;
  const newHeight = rect.height;

  if (newWidth > 0 && newHeight > 0) {
    camera.aspect = newWidth / newHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(newWidth, newHeight);
  }
});

// Animation and controls
let animationFrameId = null;
let isRendering = false;

function updateMovement() {
  if (!currentModel) return;

  const speed = 0.05;
  const direction = new THREE.Vector3();
  camera.getWorldDirection(direction);
  direction.y = 0;
  direction.normalize();

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
  if (keyState["q"]) currentModel.position.y += speed;
  if (keyState["e"]) currentModel.position.y -= speed;
}

function animate() {
  if (!isRendering || !renderer || !controls) return;

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

  // Dispose current model when closing
  if (currentModel) {
    scene.remove(currentModel);
    currentModel.traverse((child) => {
      if (child.isMesh) {
        child.geometry?.dispose();
        if (Array.isArray(child.material)) {
          child.material.forEach((mat) => mat?.dispose());
        } else {
          child.material?.dispose();
        }
      }
    });
    currentModel = null;
  }
}

// Initialize
fetchAndDisplayModels();
