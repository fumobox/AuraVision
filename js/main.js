import * as THREE from 'three';
import { FovSimulator, MODEL_PRESETS, DIMMER_LEVELS } from './fovSimulator.js';
import { AndroidXRWorkspace } from './androidXRWorkspace.js';
import { XRInputManager } from './xrInput.js';

class AuraVisionApp {
  constructor() {
    this.container = document.getElementById('canvas-container');
    this.clock = new THREE.Clock();

    // 1. Scene & Camera (Wide FOV on desktop so you can see outside the 70° glasses frame)
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      85,
      window.innerWidth / window.innerHeight,
      0.05,
      50
    );
    this.camera.position.set(0, 1.6, 0);

    // Desktop head rotation state (Euler YX)
    this.headYaw = 0;
    this.headPitch = 0;

    // 2. Renderer with alpha=true (for Quest AR Passthrough) & localClippingEnabled=true
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local-floor');
    this.container.appendChild(this.renderer.domElement);

    // 3. Simulated Room Backdrop (Only shown on Desktop Preview; hidden in Quest AR Passthrough)
    this._buildDesktopSimulatedRoom();

    // 4. Core XREAL Aura Optical FOV & Dimmer Simulator
    this.fovSimulator = new FovSimulator(this.scene);

    // 5. Android XR Spatial Multi-Window Workspace
    this.workspace = new AndroidXRWorkspace(
      this.scene,
      this.fovSimulator,
      () => this.sync2DHudFromState()
    );

    // 6. XR Controllers, Hand Tracking & Desktop Input
    this.xrInput = new XRInputManager(
      this.renderer,
      this.scene,
      this.camera,
      this.workspace,
      this.fovSimulator,
      () => this.sync2DHudFromState()
    );

    this._setupDesktopInteraction();
    this._setup2DHudEvents();
    this._checkWebXRSupport();

    window.addEventListener('resize', () => this._onResize());

    // Start main render loop
    this.renderer.setAnimationLoop(() => this._render());
  }

  /**
   * Creates a bright, realistic living-room/office wireframe + subtle lit environment
   * for Desktop preview so the user can test the 5-stage Electrochromic Dimmer on PC.
   * Automatically hidden when entering Meta Quest `immersive-ar` passthrough.
   */
  _buildDesktopSimulatedRoom() {
    this.desktopRoomGroup = new THREE.Group();
    this.desktopRoomGroup.name = 'DesktopSimulatedPassthroughRoom';
    this.scene.add(this.desktopRoomGroup);

    // Warm indoor ambient backdrop sphere
    const skyGeo = new THREE.SphereGeometry(18, 32, 24);
    const skyCanvas = document.createElement('canvas');
    skyCanvas.width = 512;
    skyCanvas.height = 256;
    const ctx = skyCanvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#3a4b6e');
    grad.addColorStop(0.48, '#697d9c');
    grad.addColorStop(0.5, '#4c596e');
    grad.addColorStop(1, '#262e3d');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 512, 256);

    const skyTex = new THREE.CanvasTexture(skyCanvas);
    skyTex.colorSpace = THREE.SRGBColorSpace;
    this.roomSkyMat = new THREE.MeshBasicMaterial({
      map: skyTex,
      side: THREE.BackSide,
      depthWrite: false
    });
    this.roomSkyMesh = new THREE.Mesh(skyGeo, this.roomSkyMat);
    this.roomSkyMesh.renderOrder = -50;
    this.desktopRoomGroup.add(this.roomSkyMesh);

    // Floor & Spatial Reference Grid
    const grid = new THREE.GridHelper(16, 32, 0x88aaff, 0x556b8f);
    grid.position.y = 0;
    grid.material.transparent = true;
    grid.material.opacity = 0.45;
    this.desktopRoomGroup.add(grid);

    // Reference room walls / window frame markers at 2.5m so user can judge real-world scale & dimmer
    const roomRings = new THREE.Group();
    const ringMat = new THREE.LineBasicMaterial({
      color: 0xaaccff,
      transparent: true,
      opacity: 0.25
    });
    for (let r = 1.5; r <= 4.5; r += 1.5) {
      const circleGeo = new THREE.BufferGeometry().setFromPoints(
        new THREE.Path().absarc(0, 0, r, 0, Math.PI * 2, false).getPoints(64)
      );
      circleGeo.rotateX(Math.PI * 0.5);
      const line = new THREE.Line(circleGeo, ringMat);
      line.position.y = 0.01;
      roomRings.add(line);
    }
    this.desktopRoomGroup.add(roomRings);
  }

  /**
   * Optional PC Webcam backdrop for testing real-world camera feed on Desktop
   */
  async _toggleWebcamBackground() {
    const video = document.getElementById('webcam-video');
    const btn = document.getElementById('btn-webcam');

    if (this.webcamActive) {
      if (video.srcObject) {
        video.srcObject.getTracks().forEach((t) => t.stop());
        video.srcObject = null;
      }
      this.webcamActive = false;
      this.desktopRoomGroup.visible = !this.renderer.xr.isPresenting;
      this.scene.background = null;
      btn.textContent = '📷 PC背景カメラ: OFF';
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720, facingMode: 'environment' },
        audio: false
      });
      video.srcObject = stream;
      await video.play();
      const videoTex = new THREE.VideoTexture(video);
      videoTex.colorSpace = THREE.SRGBColorSpace;
      this.scene.background = videoTex;
      this.desktopRoomGroup.visible = false;
      this.webcamActive = true;
      btn.textContent = '📷 PC背景カメラ: ON';
    } catch (err) {
      alert('Webカメラの起動に失敗しました: ' + err.message);
    }
  }

  /**
   * Checks WebXR `immersive-ar` support for Meta Quest Passthrough
   */
  async _checkWebXRSupport() {
    const btnEnterAr = document.getElementById('btn-enter-ar');
    const statusMsg = document.getElementById('xr-status-msg');

    if (!('xr' in navigator)) {
      statusMsg.textContent =
        '※ 現在のブラウザはWebXR非対応です（PCプレビューモードで動作中。Meta Quest Browserから開くとパススルーARが起動します）';
      btnEnterAr.disabled = true;
      return;
    }

    try {
      const supported = await navigator.xr.isSessionSupported('immersive-ar');
      if (supported) {
        statusMsg.textContent =
          '✅ WebXR パススルー (immersive-ar) 対応デバイスを検出しました！ボタンを押して開始してください。';
        btnEnterAr.disabled = false;
        btnEnterAr.addEventListener('click', () => this._toggleXRSession());
      } else {
        statusMsg.textContent =
          '💡 PCプレビューモードで動作中（マウスドラッグで首振り・視野角70°クリッピングを確認可能。Meta Questで開くとARパススルーが有効になります）';
        btnEnterAr.disabled = true;
      }
    } catch (e) {
      statusMsg.textContent = 'WebXR確認エラー: ' + e.message;
      btnEnterAr.disabled = true;
    }
  }

  async _toggleXRSession() {
    const currentSession = this.renderer.xr.getSession();
    if (currentSession) {
      await currentSession.end();
      return;
    }

    try {
      const sessionInit = {
        requiredFeatures: ['local-floor'],
        optionalFeatures: ['hand-tracking', 'bounded-floor']
      };

      const session = await navigator.xr.requestSession('immersive-ar', sessionInit);
      this.renderer.xr.setSession(session);

      // Hide simulated desktop room and 2D panel so Quest Passthrough shows the real physical world
      this.desktopRoomGroup.visible = false;
      this.scene.background = null;
      document.getElementById('ui-overlay').style.display = 'none';

      // Recenter workspace right in front of the user shortly after XR session starts
      setTimeout(() => {
        const xrCam = this.renderer.xr.getCamera();
        this.workspace.recenter(xrCam);
      }, 250);

      session.addEventListener('end', () => {
        this.desktopRoomGroup.visible = !this.webcamActive;
        document.getElementById('ui-overlay').style.display = 'flex';
      });
    } catch (err) {
      alert('WebXR ARセッションを開始できませんでした: ' + err.message);
    }
  }

  /**
   * Sets up Desktop Mouse Look (head rotation simulation) & 3D UI click raycasting
   */
  _setupDesktopInteraction() {
    const dom = this.renderer.domElement;
    const mouse = new THREE.Vector2();
    const raycaster = new THREE.Raycaster();

    let isDraggingLook = false;
    let draggedWindowGroup = null;
    let dragDistance = 1.8;
    let pointerDownPos = { x: 0, y: 0 };
    let prevPointerPos = { x: 0, y: 0 };

    dom.addEventListener('pointerdown', (e) => {
      if (this.renderer.xr.isPresenting) return;

      pointerDownPos = { x: e.clientX, y: e.clientY };
      prevPointerPos = { x: e.clientX, y: e.clientY };

      mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
      raycaster.setFromCamera(mouse, this.camera);

      const hits = raycaster.intersectObjects(this.workspace.interactiveMeshes, false);
      if (hits.length > 0 && hits[0].object.userData.isGrabBar) {
        draggedWindowGroup = hits[0].object.userData.draggableGroup;
        dragDistance = hits[0].distance;
        return;
      }

      isDraggingLook = true;
    });

    window.addEventListener('pointermove', (e) => {
      if (this.renderer.xr.isPresenting) return;

      if (draggedWindowGroup) {
        mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
        raycaster.setFromCamera(mouse, this.camera);
        const targetWorld = raycaster.ray.origin
          .clone()
          .addScaledVector(raycaster.ray.direction, dragDistance);
        if (draggedWindowGroup.parent) {
          draggedWindowGroup.parent.worldToLocal(targetWorld);
          draggedWindowGroup.position.copy(targetWorld);
          draggedWindowGroup.rotation.y = Math.atan2(
            -draggedWindowGroup.position.x,
            -draggedWindowGroup.position.z
          );
        }
        return;
      }

      if (!isDraggingLook) return;
      const dx = e.clientX - prevPointerPos.x;
      const dy = e.clientY - prevPointerPos.y;
      prevPointerPos = { x: e.clientX, y: e.clientY };

      this.headYaw -= dx * 0.0045;
      this.headPitch = THREE.MathUtils.clamp(
        this.headPitch - dy * 0.0045,
        -Math.PI * 0.42,
        Math.PI * 0.42
      );

      const euler = new THREE.Euler(this.headPitch, this.headYaw, 0, 'YXZ');
      this.camera.quaternion.setFromEuler(euler);
      this.camera.updateMatrixWorld(true);
    });

    window.addEventListener('pointerup', (e) => {
      if (this.renderer.xr.isPresenting) return;

      const moveDist = Math.hypot(
        e.clientX - pointerDownPos.x,
        e.clientY - pointerDownPos.y
      );

      if (moveDist < 6 && !draggedWindowGroup) {
        mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
        raycaster.setFromCamera(mouse, this.camera);
        const hits = raycaster.intersectObjects(this.workspace.interactiveMeshes, false);
        if (hits.length > 0 && hits[0].object.userData.onClick && hits[0].uv) {
          hits[0].object.userData.onClick(hits[0].uv);
        }
      }

      isDraggingLook = false;
      draggedWindowGroup = null;
    });

    // Keyboard shortcuts for quick testing
    window.addEventListener('keydown', (e) => {
      const keyMap = {
        Digit1: 'air',
        Digit2: 'ultra',
        Digit3: 'onepro',
        Digit4: 'aura',
        Digit5: 'full'
      };
      if (keyMap[e.code]) {
        this.fovSimulator.setModel(keyMap[e.code]);
        this.workspace.refreshAllUI();
        this.sync2DHudFromState();
      } else if (e.code === 'KeyD') {
        this.fovSimulator.cycleDimmer();
        this.workspace.refreshAllUI();
        this.sync2DHudFromState();
      } else if (e.code === 'KeyR') {
        this.headYaw = 0;
        this.headPitch = 0;
        this.camera.quaternion.identity();
        this.camera.updateMatrixWorld(true);
        this.workspace.recenter(this.camera);
      } else if (e.code === 'KeyG') {
        this.fovSimulator.setShowAngleGrid(!this.fovSimulator.showAngleGrid);
        this.sync2DHudFromState();
      } else if (e.code === 'KeyC') {
        this.fovSimulator.setShowCompareFrames(!this.fovSimulator.showCompareFrames);
        this.workspace.refreshAllUI();
        this.sync2DHudFromState();
      }
    });
  }

  /**
   * Wires up the 2D HTML Control Panel buttons and checkboxes
   */
  _setup2DHudEvents() {
    // Toggle HUD collapse
    const btnToggleHud = document.getElementById('btn-toggle-hud');
    const panel = document.getElementById('control-panel');
    btnToggleHud.addEventListener('click', () => {
      const collapsed = panel.classList.toggle('collapsed');
      btnToggleHud.textContent = collapsed ? 'パネルを表示' : 'パネルを隠す';
    });

    // Webcam toggle
    document.getElementById('btn-webcam').addEventListener('click', () => {
      this._toggleWebcamBackground();
    });

    // Model buttons
    document.querySelectorAll('#model-buttons .preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const model = btn.dataset.model;
        this.fovSimulator.setModel(model);
        this.workspace.refreshAllUI();
        this.sync2DHudFromState();
      });
    });

    // Dimmer buttons
    document.querySelectorAll('#dimmer-buttons .preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.dimmer, 10);
        this.fovSimulator.setDimmer(idx);
        this.workspace.refreshAllUI();
        this.sync2DHudFromState();
      });
    });

    // Anchor buttons
    document.querySelectorAll('#anchor-buttons .preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.anchor;
        this.workspace.setAnchorMode(mode);
        this.workspace.refreshAllUI();
        this.sync2DHudFromState();
      });
    });

    // Distance buttons
    document.querySelectorAll('#distance-buttons .preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const dist = parseFloat(btn.dataset.dist);
        const activeCam = this.renderer.xr.isPresenting
          ? this.renderer.xr.getCamera()
          : this.camera;
        this.workspace.setWorkspaceDistance(dist, activeCam);
        this.sync2DHudFromState();
      });
    });

    // Checkboxes
    document.getElementById('chk-frame').addEventListener('change', (e) => {
      this.fovSimulator.setShowFrame(e.target.checked);
    });
    document.getElementById('chk-fov-border').addEventListener('change', (e) => {
      this.fovSimulator.setShowFovBorder(e.target.checked);
    });
    document.getElementById('chk-compare-frames').addEventListener('change', (e) => {
      this.fovSimulator.setShowCompareFrames(e.target.checked);
      this.workspace.refreshAllUI();
    });
    document.getElementById('chk-angle-grid').addEventListener('change', (e) => {
      this.fovSimulator.setShowAngleGrid(e.target.checked);
    });
    document.getElementById('chk-additive-sim').addEventListener('change', (e) => {
      this.workspace.setAdditiveSim(e.target.checked);
    });

    // Recenter button
    document.getElementById('btn-recenter').addEventListener('click', () => {
      this.headYaw = 0;
      this.headPitch = 0;
      this.camera.quaternion.identity();
      this.camera.updateMatrixWorld(true);
      const activeCam = this.renderer.xr.isPresenting
        ? this.renderer.xr.getCamera()
        : this.camera;
      this.workspace.recenter(activeCam);
    });

    this.sync2DHudFromState();
  }

  sync2DHudFromState() {
    const spec = this.fovSimulator.getActiveSpecSummary();

    // Update active state on Model buttons
    document.querySelectorAll('#model-buttons .preset-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.model === this.fovSimulator.currentModelKey);
    });

    const fovReadout = document.getElementById('fov-readout');
    if (spec.unclipped) {
      fovReadout.textContent = '制限なし (Quest全域パススルー表示)';
    } else {
      fovReadout.textContent = `対角 ${spec.diagFov}° (${spec.hFovDeg.toFixed(1)}° × ${spec.vFovDeg.toFixed(1)}° / ${spec.aspectW}:${spec.aspectH})`;
    }

    // Update active state on Dimmer buttons
    document.querySelectorAll('#dimmer-buttons .preset-btn').forEach((btn) => {
      btn.classList.toggle(
        'active',
        parseInt(btn.dataset.dimmer, 10) === this.fovSimulator.currentDimmerIndex
      );
    });

    const dimmerReadout = document.getElementById('dimmer-readout');
    dimmerReadout.textContent = `${spec.dimmer.name} (${spec.dimmer.percent} 透過減衰)`;

    // Update Anchor buttons
    document.querySelectorAll('#anchor-buttons .preset-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.anchor === this.workspace.anchorMode);
    });

    // Update Distance buttons
    document.querySelectorAll('#distance-buttons .preset-btn').forEach((btn) => {
      btn.classList.toggle(
        'active',
        Math.abs(parseFloat(btn.dataset.dist) - this.workspace.workspaceDistance) < 0.05
      );
    });

    // Sync checkboxes
    document.getElementById('chk-frame').checked = this.fovSimulator.showFrame;
    document.getElementById('chk-fov-border').checked = this.fovSimulator.showFovBorder;
    document.getElementById('chk-compare-frames').checked = this.fovSimulator.showCompareFrames;
    document.getElementById('chk-angle-grid').checked = this.fovSimulator.showAngleGrid;
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  _render() {
    const dt = Math.min(this.clock.getDelta(), 0.1);

    // Get active viewer camera (WebXR stereo center pose when in Quest AR, or desktop camera)
    const activeCamera = this.renderer.xr.isPresenting
      ? this.renderer.xr.getCamera()
      : this.camera;

    activeCamera.updateMatrixWorld(true);

    // 1. Update Head-Locked XREAL Aura FOV Clipping Planes & Glasses Frame
    this.fovSimulator.update(activeCamera);

    // 2. Update Android XR Spatial Workspace
    this.workspace.update(dt, activeCamera);

    // 3. Update XR Controller / Hand Tracking Raycasting
    this.xrInput.update();

    // 4. Render frame
    this.renderer.render(this.scene, this.camera);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.auraVisionApp = new AuraVisionApp();
});

