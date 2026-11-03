import * as THREE from 'three';
import { MODEL_PRESETS, DIMMER_LEVELS, computeFovAngles } from './fovSimulator.js';

export class AndroidXRWorkspace {
  constructor(scene, fovSimulator, onStateChange) {
    this.scene = scene;
    this.fovSimulator = fovSimulator;
    this.onStateChange = onStateChange;

    this.rootGroup = new THREE.Group();
    this.rootGroup.name = 'AndroidXRWorkspace';
    this.scene.add(this.rootGroup);

    // Anchor modes: 'world' (6DoF), 'smooth' (lazy follow), 'head' (0DoF)
    this.anchorMode = 'world';
    this.workspaceDistance = 1.8; // meters
    this.centerScreenScale = 1.0; // 1.0 = ~115 inch at 1.8m, 0.78 = 85", 1.35 = 155"
    this.additiveBlending = false;

    this.interactiveMeshes = [];
    this.clippedMaterials = [];
    this.windowEntries = [];

    // Media player state
    this.isPlaying = true;
    this.mediaTime = 0;
    this.geminiCardIndex = 0;
    this.rightTabIndex = 0;

    // Target pose for smooth follow / world anchor
    this.targetPosition = new THREE.Vector3(0, 1.5, -this.workspaceDistance);
    this.targetQuaternion = new THREE.Quaternion();
    this.hasInitializedPose = false;

    this._buildWorkspaceWindows();
    this._buildXRControlDock();
  }

  _registerClippedMaterial(mat) {
    mat.clippingPlanes = this.fovSimulator.clippingPlanes;
    mat.clipShadows = true;
    this.clippedMaterials.push(mat);
    return mat;
  }

  setAdditiveSim(enabled) {
    this.additiveBlending = enabled;
    for (const mat of this.clippedMaterials) {
      mat.blending = enabled ? THREE.AdditiveBlending : THREE.NormalBlending;
      mat.opacity = enabled ? 0.90 : 0.96;
      mat.needsUpdate = true;
    }
  }

  _buildWorkspaceWindows() {
    this.windowsGroup = new THREE.Group();
    this.rootGroup.add(this.windowsGroup);

    // 1. Center Window: Android XR Spatial Cinema & FOV Fit Analyzer (16:10 aspect)
    this.centerWin = this._createCanvasWindow({
      id: 'center-cinema',
      width: 1.44,
      height: 0.90,
      canvasW: 1024,
      canvasH: 640,
      pos: new THREE.Vector3(0, 0.06, 0),
      rotY: 0,
      rotX: 0
    });
    this.windowsGroup.add(this.centerWin.group);

    // 2. Left Window: Gemini Live + Spatial Maps
    this.leftWin = this._createCanvasWindow({
      id: 'left-gemini',
      width: 0.96,
      height: 0.84,
      canvasW: 768,
      canvasH: 672,
      pos: new THREE.Vector3(-1.18, 0.06, 0.28),
      rotY: THREE.MathUtils.degToRad(24),
      rotX: 0
    });
    this.windowsGroup.add(this.leftWin.group);

    // 3. Right Window: Android XR Chrome & FOV Spec Telemetry
    this.rightWin = this._createCanvasWindow({
      id: 'right-telemetry',
      width: 0.96,
      height: 0.84,
      canvasW: 768,
      canvasH: 672,
      pos: new THREE.Vector3(1.18, 0.06, 0.28),
      rotY: THREE.MathUtils.degToRad(-24),
      rotX: 0
    });
    this.windowsGroup.add(this.rightWin.group);

    // Initial draw of static/semi-static windows
    this._drawLeftWindow();
    this._drawRightWindow();
    this._drawCenterWindow(0);
  }

  _createCanvasWindow({ id, width, height, canvasW, canvasH, pos, rotY = 0, rotX = 0 }) {
    const group = new THREE.Group();
    group.position.copy(pos);
    group.rotation.set(rotX, rotY, 0);

    const canvas = document.createElement('canvas');
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext('2d');

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;

    const mat = this._registerClippedMaterial(
      new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: 0.96,
        side: THREE.DoubleSide
      })
    );

    const geo = new THREE.PlaneGeometry(width, height);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData = {
      windowId: id,
      canvasW,
      canvasH,
      width,
      height,
      parentGroup: group,
      hitRegions: [],
      onClick: (uv) => this._handleWindowClick(id, uv)
    };
    group.add(mesh);
    this.interactiveMeshes.push(mesh);

    // Android XR bottom grab pill bar
    const pillGeo = new THREE.PlaneGeometry(width * 0.28, 0.022);
    const pillMat = this._registerClippedMaterial(
      new THREE.MeshBasicMaterial({
        color: 0xd0e4ff,
        transparent: true,
        opacity: 0.75,
        side: THREE.DoubleSide
      })
    );
    const pillMesh = new THREE.Mesh(pillGeo, pillMat);
    pillMesh.position.set(0, -height * 0.5 - 0.028, 0.002);
    pillMesh.userData = {
      isGrabBar: true,
      draggableGroup: group
    };
    group.add(pillMesh);
    this.interactiveMeshes.push(pillMesh);

    const entry = {
      id,
      group,
      mesh,
      canvas,
      ctx,
      texture,
      width,
      height,
      canvasW,
      canvasH,
      initialPos: pos.clone(),
      initialRotX: rotX,
      initialRotY: rotY
    };
    this.windowEntries.push(entry);
    return entry;
  }

  /**
   * Builds the floating 3D Android XR Quick Control Dock below the main workspace
   * so users inside Meta Quest can switch FOV models, dimmer levels, and distance effortlessly.
   */
  _buildXRControlDock() {
    this.dockWin = this._createCanvasWindow({
      id: 'xr-dock',
      width: 1.36,
      height: 0.34,
      canvasW: 1088,
      canvasH: 272,
      pos: new THREE.Vector3(0, -0.58, 0.18),
      rotY: 0,
      rotX: THREE.MathUtils.degToRad(-16)
    });
    this.windowsGroup.add(this.dockWin.group);
    this._drawDockWindow();
  }

  /**
   * Draws the Center Android XR Spatial Cinema & Real-Time FOV Fit Calculator
   */
  _drawCenterWindow(dt) {
    const { ctx, canvasW: w, canvasH: h, texture, mesh } = this.centerWin;
    mesh.userData.hitRegions = [];

    ctx.clearRect(0, 0, w, h);

    // Outer glassmorphic card
    this._drawGlassCard(ctx, 8, 8, w - 16, h - 16, 28, '#00e5ff');

    // Top bar
    ctx.fillStyle = '#9bc0ff';
    ctx.font = 'bold 20px "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('▶  Android XR Spatial Cinema  •  16:10 WUXGA (1920×1200)', 36, 46);

    // Calculate current angular span of this center window relative to the viewer
    const actualWidth = this.centerWin.width * this.centerScreenScale;
    const actualHeight = this.centerWin.height * this.centerScreenScale;
    const dist = this.workspaceDistance;
    const spanHDeg = THREE.MathUtils.radToDeg(Math.atan((actualWidth * 0.5) / dist) * 2);
    const spanVDeg = THREE.MathUtils.radToDeg(Math.atan((actualHeight * 0.5) / dist) * 2);

    const spec = this.fovSimulator.getActiveSpecSummary();
    const fitsH = spec.unclipped || spanHDeg <= spec.hFovDeg;
    const fitsV = spec.unclipped || spanVDeg <= spec.vFovDeg;
    const fitsAll = fitsH && fitsV;

    // Fit badge on top right
    ctx.fillStyle = fitsAll ? 'rgba(0, 230, 118, 0.22)' : 'rgba(255, 145, 0, 0.25)';
    ctx.beginPath();
    ctx.roundRect(w - 350, 20, 320, 38, 19);
    ctx.fill();
    ctx.strokeStyle = fitsAll ? '#00e676' : '#ff9100';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = fitsAll ? '#69f0ae' : '#ffd180';
    ctx.font = 'bold 17px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      fitsAll
        ? `✓ ${spec.name} 視野内に全体収容`
        : `⚠ ${spec.name} 視野枠で端が見切れ中`,
      w - 190,
      44
    );

    // Animated Spatial Video Viewport
    const vx = 32;
    const vy = 72;
    const vw = w - 64;
    const vh = 395;

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(vx, vy, vw, vh, 18);
    ctx.clip();

    // Animated aurora gradient background
    const t = this.mediaTime;
    const grad = ctx.createLinearGradient(vx, vy, vx + vw, vy + vh);
    grad.addColorStop(0, `hsl(${(195 + Math.sin(t * 0.7) * 20) | 0}, 85%, 16%)`);
    grad.addColorStop(0.5, `hsl(${(225 + Math.cos(t * 0.5) * 25) | 0}, 78%, 22%)`);
    grad.addColorStop(1, `hsl(${(175 + Math.sin(t * 0.9) * 20) | 0}, 90%, 18%)`);
    ctx.fillStyle = grad;
    ctx.fillRect(vx, vy, vw, vh);

    // Animated 3D horizon grid inside video
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.28)';
    ctx.lineWidth = 1.5;
    const horizonY = vy + vh * 0.58;
    for (let i = -8; i <= 8; i++) {
      ctx.beginPath();
      ctx.moveTo(vx + vw * 0.5 + i * 28, horizonY);
      ctx.lineTo(vx + vw * 0.5 + i * 135, vy + vh);
      ctx.stroke();
    }
    const scrollOffset = (t * 40) % 32;
    for (let y = horizonY; y < vy + vh; y += 32) {
      const py = y + scrollOffset * ((y - horizonY) / (vh * 0.42));
      if (py <= vy + vh) {
        ctx.beginPath();
        ctx.moveTo(vx, py);
        ctx.lineTo(vx + vw, py);
        ctx.stroke();
      }
    }

    // Glowing holographic orb & waveform in center of video
    const cx = vx + vw * 0.5;
    const cy = vy + vh * 0.44;
    const orbR = 64 + Math.sin(t * 2.2) * 6;
    const radGrad = ctx.createRadialGradient(cx, cy, 8, cx, cy, orbR * 1.6);
    radGrad.addColorStop(0, 'rgba(0, 229, 255, 0.95)');
    radGrad.addColorStop(0.45, 'rgba(79, 140, 255, 0.45)');
    radGrad.addColorStop(1, 'rgba(0, 229, 255, 0)');
    ctx.fillStyle = radGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, orbR * 1.6, 0, Math.PI * 2);
    ctx.fill();

    // Overlay FOV comparison guides inside the video player so user can see what fits
    ctx.fillStyle = 'rgba(8, 12, 22, 0.72)';
    ctx.beginPath();
    ctx.roundRect(vx + 20, vy + 18, 470, 82, 12);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 20px "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    const eqDiagInch = Math.round(Math.hypot(actualWidth, actualHeight) * 39.37 * (2.5 / dist));
    ctx.fillText(
      `ウインドウ視野角: ${spanHDeg.toFixed(1)}° × ${spanVDeg.toFixed(1)}° (${eqDiagInch}インチ相当)`,
      vx + 36,
      vy + 48
    );
    ctx.fillStyle = '#9ce5ff';
    ctx.font = '16px "Segoe UI", sans-serif';
    ctx.fillText(
      `現在アクティブ: ${spec.name} (水平 ${spec.hFovDeg.toFixed(1)}° × 垂直 ${spec.vFovDeg.toFixed(1)}°)`,
      vx + 36,
      vy + 78
    );

    ctx.restore();

    // Bottom interactive toolbar inside Center Window (Play/Pause + Screen Size Presets)
    const barY = 488;
    const playLabel = this.isPlaying ? '⏸ 一時停止' : '▶ 再生';
    this._addHitButton(
      ctx,
      mesh.userData.hitRegions,
      32,
      barY,
      155,
      54,
      playLabel,
      this.isPlaying,
      () => {
        this.isPlaying = !this.isPlaying;
      }
    );

    const sizePresets = [
      { label: '画面: 85" (小)', scale: 0.78 },
      { label: '画面: 115" (標準)', scale: 1.0 },
      { label: '画面: 150" (大)', scale: 1.32 },
      { label: '画面: 190" (超大)', scale: 1.65 }
    ];

    sizePresets.forEach((p, idx) => {
      const bx = 205 + idx * 196;
      const isSelected = Math.abs(this.centerScreenScale - p.scale) < 0.05;
      this._addHitButton(
        ctx,
        mesh.userData.hitRegions,
        bx,
        barY,
        186,
        54,
        p.label,
        isSelected,
        () => {
          this.centerScreenScale = p.scale;
          this.centerWin.group.scale.setScalar(p.scale);
          this._drawCenterWindow(0);
        }
      );
    });

    // Footer tip
    ctx.fillStyle = '#8aa4cc';
    ctx.font = '16px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      '💡 頭を上下左右に動かすと、70° X-Prism 光学領域の境界で仮想画面がクリッピングされる様子を確認できます',
      w * 0.5,
      h - 32
    );

    texture.needsUpdate = true;
  }

  /**
   * Draws Left Window: Android XR Gemini Live & Spatial Navigation
   */
  _drawLeftWindow() {
    const { ctx, canvasW: w, canvasH: h, texture, mesh } = this.leftWin;
    mesh.userData.hitRegions = [];

    ctx.clearRect(0, 0, w, h);
    this._drawGlassCard(ctx, 8, 8, w - 16, h - 16, 28, '#7c4dff');

    // Header
    ctx.fillStyle = '#d1c4e9';
    ctx.font = 'bold 21px "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('✦  Gemini Live on Android XR', 34, 48);

    // Simulated Spatial Navigation Radar Card
    const mapX = 32;
    const mapY = 72;
    const mapW = w - 64;
    const mapH = 270;

    ctx.fillStyle = 'rgba(12, 22, 38, 0.85)';
    ctx.beginPath();
    ctx.roundRect(mapX, mapY, mapW, mapH, 18);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Draw stylized 3D map streets & AR route arrow
    ctx.strokeStyle = 'rgba(90, 140, 220, 0.25)';
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.moveTo(mapX + 60, mapY + mapH - 25);
    ctx.lineTo(mapX + mapW * 0.48, mapY + mapH * 0.45);
    ctx.lineTo(mapX + mapW - 70, mapY + 45);
    ctx.stroke();

    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(mapX + 60, mapY + mapH - 25);
    ctx.lineTo(mapX + mapW * 0.48, mapY + mapH * 0.45);
    ctx.lineTo(mapX + mapW - 70, mapY + 45);
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 19px "Segoe UI", sans-serif';
    ctx.fillText('📍 Google Maps AR ナビゲーション (16:10 縦余裕検証)', mapX + 22, mapY + 36);
    ctx.fillStyle = '#80d8ff';
    ctx.font = '16px "Segoe UI", sans-serif';
    ctx.fillText('次の交差点まで 120m • 視界下部にAR矢印を重ねても上方が見切れない', mapX + 22, mapY + 64);

    // Gemini Multimodal AI Context Cards
    const prompts = [
      {
        title: 'AI 視界アシスタント: マルチウインドウ配置検証',
        body: 'XREAL Aura の対角70° (水平61.4°×垂直40.7°) では、正面ウインドウの隣り合うサブウインドウの約35%が同時に視野に入り、首振り量を大幅に削減します。'
      },
      {
        title: 'AI リアルタイム翻訳・字幕 オーバーレイ検証',
        body: '1920×1200 (16:10) の縦方向 +120px 拡張により、相手の顔を見ながら視界下部にリアルタイム翻訳字幕を表示しても圧迫感がありません。'
      },
      {
        title: 'エレクトロクロミック 5段階調光とコントラスト',
        body: '明るい室内や屋外では Lv.3〜Lv.4 (60〜85%) に調光することで、1050 nits マイクロOLEDの空間UIがくっきりと浮かび上がります。'
      }
    ];

    const activePrompt = prompts[this.geminiCardIndex % prompts.length];

    ctx.fillStyle = 'rgba(42, 32, 78, 0.65)';
    ctx.beginPath();
    ctx.roundRect(32, 362, w - 64, 195, 18);
    ctx.fill();
    ctx.strokeStyle = '#b388ff';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#eadbff';
    ctx.font = 'bold 20px "Segoe UI", sans-serif';
    ctx.fillText(`✦ ${activePrompt.title}`, 52, 402);

    this._wrapText(ctx, activePrompt.body, 52, 440, w - 104, 28, '#d0dcf5', '17.5px "Segoe UI", sans-serif');

    this._addHitButton(
      ctx,
      mesh.userData.hitRegions,
      32,
      578,
      w - 64,
      54,
      '✦ Gemini インサイトを切り替え (クリック)',
      true,
      () => {
        this.geminiCardIndex = (this.geminiCardIndex + 1) % prompts.length;
        this._drawLeftWindow();
      }
    );

    texture.needsUpdate = true;
  }

  /**
   * Draws Right Window: XREAL Aura vs Legacy FOV Comparison & Telemetry
   */
  _drawRightWindow() {
    const { ctx, canvasW: w, canvasH: h, texture, mesh } = this.rightWin;
    mesh.userData.hitRegions = [];

    ctx.clearRect(0, 0, w, h);
    this._drawGlassCard(ctx, 8, 8, w - 16, h - 16, 28, '#00e676');

    ctx.fillStyle = '#b9f6ca';
    ctx.font = 'bold 21px "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('📊  XREAL 光学FOV・表示面積 比較インスペクタ', 34, 48);

    const activeKey = this.fovSimulator.currentModelKey;
    const models = ['air', 'ultra', 'onepro', 'aura'];

    // Visual nested FOV rectangles comparison diagram
    const diagX = 32;
    const diagY = 70;
    const diagW = w - 64;
    const diagH = 260;

    ctx.fillStyle = 'rgba(10, 16, 28, 0.88)';
    ctx.beginPath();
    ctx.roundRect(diagX, diagY, diagW, diagH, 16);
    ctx.fill();

    const cx = diagX + diagW * 0.5;
    const cy = diagY + diagH * 0.52;
    const scale = 330; // px per unit tan

    const reversedModels = models.slice().reverse();
    reversedModels.forEach((k, idx) => {
      const p = MODEL_PRESETS[k];
      const { halfTanH, halfTanV, hFovDeg, vFovDeg } = computeFovAngles(p.diagFov, p.aspectW, p.aspectH);
      const rw = halfTanH * scale * 2;
      const rh = halfTanV * scale * 2;
      const isCurr = k === activeKey;

      ctx.fillStyle = isCurr ? `${p.hex}33` : `${p.hex}12`;
      ctx.strokeStyle = p.hex;
      ctx.lineWidth = isCurr ? 3.5 : 1.8;
      ctx.beginPath();
      ctx.roundRect(cx - rw * 0.5, cy - rh * 0.5, rw, rh, 8);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = p.hex;
      ctx.font = isCurr ? 'bold 14.5px "Segoe UI", sans-serif' : '13.5px "Segoe UI", sans-serif';
      ctx.textAlign = 'left';
      // Stagger vertical label positions inside the nested boxes so they never overlap
      const labelY = cy - rh * 0.5 + 17 + (idx > 0 ? idx * 8 : 0);
      ctx.fillText(
        `${p.name} ${p.diagFov}° (${hFovDeg.toFixed(0)}°×${vFovDeg.toFixed(0)}°)`,
        cx - rw * 0.5 + 10,
        labelY
      );
    });

    // Spec comparison rows (clickable to switch active model directly!)
    let rowY = 348;
    const baseArea = 40.6 * 23.5; // Air 46° area reference

    models.forEach((k) => {
      const p = MODEL_PRESETS[k];
      const { hFovDeg, vFovDeg } = computeFovAngles(p.diagFov, p.aspectW, p.aspectH);
      const areaRatio = ((hFovDeg * vFovDeg) / baseArea).toFixed(2);
      const isSelected = activeKey === k;

      this._addHitButton(
        ctx,
        mesh.userData.hitRegions,
        32,
        rowY,
        w - 64,
        64,
        `${p.name}  |  対角 ${p.diagFov}° (${p.aspectW}:${p.aspectH})  |  面積比 ${areaRatio}x`,
        isSelected,
        () => {
          this.fovSimulator.setModel(k);
          this.refreshAllUI();
          if (this.onStateChange) this.onStateChange();
        },
        p.hex
      );
      rowY += 74;
    });

    texture.needsUpdate = true;
  }

  /**
   * Draws the Bottom Floating 3D Control Dock for easy interaction inside Quest AR
   */
  _drawDockWindow() {
    const { ctx, canvasW: w, canvasH: h, texture, mesh } = this.dockWin;
    mesh.userData.hitRegions = [];

    ctx.clearRect(0, 0, w, h);
    this._drawGlassCard(ctx, 6, 6, w - 12, h - 12, 32, '#00e5ff');

    // Row 1: FOV Model Quick Switch
    ctx.fillStyle = '#9ec3ff';
    ctx.font = 'bold 18px "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('FOV モデル:', 28, 52);

    const modelList = [
      { key: 'air', label: 'Air 46°' },
      { key: 'ultra', label: 'Ultra 52°' },
      { key: 'onepro', label: 'OnePro 57°' },
      { key: 'aura', label: '★ Aura 70°' },
      { key: 'full', label: '制限なし' }
    ];

    modelList.forEach((m, i) => {
      const bx = 148 + i * 182;
      const active = this.fovSimulator.currentModelKey === m.key;
      this._addHitButton(
        ctx,
        mesh.userData.hitRegions,
        bx,
        22,
        172,
        50,
        m.label,
        active,
        () => {
          this.fovSimulator.setModel(m.key);
          this.refreshAllUI();
          if (this.onStateChange) this.onStateChange();
        }
      );
    });

    // Row 2: 5-Stage Electrochromic Dimmer
    ctx.fillStyle = '#9ec3ff';
    ctx.font = 'bold 18px "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('5段階調光:', 28, 122);

    DIMMER_LEVELS.forEach((d, idx) => {
      const bx = 148 + idx * 182;
      const active = this.fovSimulator.currentDimmerIndex === idx;
      this._addHitButton(
        ctx,
        mesh.userData.hitRegions,
        bx,
        92,
        172,
        50,
        `${d.name} (${d.percent})`,
        active,
        () => {
          this.fovSimulator.setDimmer(idx);
          this.refreshAllUI();
          if (this.onStateChange) this.onStateChange();
        }
      );
    });

    // Row 3: Anchor Mode + Compare Guides + Recenter
    ctx.fillStyle = '#9ec3ff';
    ctx.font = 'bold 18px "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('空間設定:', 28, 194);

    const anchorModes = [
      { key: 'world', label: '6DoF 空間固定' },
      { key: 'smooth', label: 'Smooth 追従' },
      { key: 'head', label: '0DoF 頭部固定' }
    ];

    anchorModes.forEach((a, idx) => {
      const bx = 148 + idx * 182;
      const active = this.anchorMode === a.key;
      this._addHitButton(
        ctx,
        mesh.userData.hitRegions,
        bx,
        164,
        172,
        50,
        a.label,
        active,
        () => {
          this.setAnchorMode(a.key);
          this.refreshAllUI();
          if (this.onStateChange) this.onStateChange();
        }
      );
    });

    // Compare Outline toggle button
    this._addHitButton(
      ctx,
      mesh.userData.hitRegions,
      694,
      164,
      172,
      50,
      this.fovSimulator.showCompareFrames ? '比較枠: ON' : '比較枠: OFF',
      this.fovSimulator.showCompareFrames,
      () => {
        this.fovSimulator.setShowCompareFrames(!this.fovSimulator.showCompareFrames);
        this.refreshAllUI();
        if (this.onStateChange) this.onStateChange();
      }
    );

    // Recenter button
    this._addHitButton(
      ctx,
      mesh.userData.hitRegions,
      876,
      164,
      182,
      50,
      '🎯 正面リセット',
      false,
      () => {
        this.recenterRequested = true;
      },
      '#00e5ff'
    );

    // Bottom helper line
    ctx.fillStyle = '#8aa4cc';
    ctx.font = '15px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      '各ウインドウ下の白バーをレーザーまたはピンチで掴んで3D空間内を自由に移動できます',
      w * 0.5,
      246
    );

    texture.needsUpdate = true;
  }

  _drawGlassCard(ctx, x, y, w, h, radius, accentHex) {
    const grad = ctx.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, 'rgba(18, 25, 42, 0.92)');
    grad.addColorStop(1, 'rgba(10, 14, 26, 0.95)');

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.fill();

    ctx.strokeStyle = accentHex || 'rgba(120, 170, 255, 0.4)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  _addHitButton(ctx, hitRegions, x, y, w, h, label, active, callback, customBorder = null) {
    ctx.fillStyle = active
      ? 'rgba(0, 229, 255, 0.26)'
      : 'rgba(34, 46, 74, 0.85)';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 12);
    ctx.fill();

    ctx.strokeStyle = customBorder || (active ? '#00e5ff' : 'rgba(130, 165, 255, 0.32)');
    ctx.lineWidth = active ? 2.5 : 1.5;
    ctx.stroke();

    ctx.fillStyle = active ? '#ffffff' : '#d2def5';
    ctx.font = active ? 'bold 17px "Segoe UI", sans-serif' : '16.5px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + w * 0.5, y + h * 0.5);

    hitRegions.push({ x, y, w, h, callback });
  }

  _wrapText(ctx, text, x, y, maxWidth, lineHeight, color, font) {
    ctx.fillStyle = color;
    ctx.font = font;
    ctx.textAlign = 'left';
    let line = '';
    let currY = y;
    for (let i = 0; i < text.length; i++) {
      const testLine = line + text[i];
      if (ctx.measureText(testLine).width > maxWidth && line.length > 0) {
        ctx.fillText(line, x, currY);
        line = text[i];
        currY += lineHeight;
      } else {
        line = testLine;
      }
    }
    if (line) ctx.fillText(line, x, currY);
  }

  _handleWindowClick(windowId, uv) {
    const winMap = {
      'center-cinema': this.centerWin,
      'left-gemini': this.leftWin,
      'right-telemetry': this.rightWin,
      'xr-dock': this.dockWin
    };
    const win = winMap[windowId];
    if (!win) return;

    const px = uv.x * win.canvasW;
    const py = (1 - uv.y) * win.canvasH;

    for (const region of win.mesh.userData.hitRegions) {
      if (
        px >= region.x &&
        px <= region.x + region.w &&
        py >= region.y &&
        py <= region.y + region.h
      ) {
        region.callback();
        break;
      }
    }
  }

  refreshAllUI() {
    this._drawCenterWindow(0);
    this._drawLeftWindow();
    this._drawRightWindow();
    this._drawDockWindow();
  }

  setAnchorMode(mode) {
    this.anchorMode = mode;
  }

  setWorkspaceDistance(distMeters, camera) {
    this.workspaceDistance = distMeters;
    if (camera) {
      this.recenter(camera, false);
    }
    this._drawCenterWindow(0);
  }

  /**
   * Recenters the workspace directly in front of the user's current horizontal gaze.
   * When resetWindows is true, also restores individual windows to their default arc layout.
   */
  recenter(camera, resetWindows = false) {
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    camera.matrixWorld.decompose(pos, quat, scale);

    // Keep horizon level for 6DoF & Smooth Follow
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
    forward.y = 0;
    if (forward.lengthSq() < 1e-4) forward.set(0, 0, -1);
    forward.normalize();

    this.targetPosition.copy(pos).addScaledVector(forward, this.workspaceDistance);
    const lookMat = new THREE.Matrix4().lookAt(pos, this.targetPosition, new THREE.Vector3(0, 1, 0));
    this.targetQuaternion.setFromRotationMatrix(lookMat);

    this.rootGroup.position.copy(this.targetPosition);
    this.rootGroup.quaternion.copy(this.targetQuaternion);
    this.hasInitializedPose = true;

    if (resetWindows) {
      for (const entry of this.windowEntries) {
        entry.group.position.copy(entry.initialPos);
        entry.group.rotation.set(entry.initialRotX, entry.initialRotY, 0);
      }
    }
  }

  update(dt, camera) {
    if (!this.hasInitializedPose || this.recenterRequested) {
      const shouldResetWindows = this.recenterRequested;
      this.recenterRequested = false;
      this.recenter(camera, shouldResetWindows);
    }

    const headPos = new THREE.Vector3();
    const headQuat = new THREE.Quaternion();
    const s = new THREE.Vector3();
    camera.matrixWorld.decompose(headPos, headQuat, s);

    if (this.anchorMode === 'head') {
      // 0DoF Head-locked mode: workspace moves rigidly with the head
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(headQuat);
      this.rootGroup.position.copy(headPos).addScaledVector(forward, this.workspaceDistance);
      this.rootGroup.quaternion.copy(headQuat);
    } else if (this.anchorMode === 'smooth') {
      // Smooth Follow mode (like XREAL Beam / Nebula Smooth Follow)
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(headQuat);
      this.targetPosition.copy(headPos).addScaledVector(forward, this.workspaceDistance);
      this.targetQuaternion.copy(headQuat);

      const lerpAlpha = 1 - Math.exp(-dt * 4.2);
      this.rootGroup.position.lerp(this.targetPosition, lerpAlpha);
      this.rootGroup.quaternion.slerp(this.targetQuaternion, lerpAlpha);
    }
    // In 'world' (6DoF) mode, rootGroup stays anchored in 3D space!

    if (this.isPlaying) {
      this.mediaTime += dt;
      this._drawCenterWindow(dt);
    }
  }
}
