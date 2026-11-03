import * as THREE from 'three';

export const MODEL_PRESETS = {
  air: {
    id: 'air',
    name: 'XREAL Air / Air 2',
    diagFov: 46,
    aspectW: 16,
    aspectH: 9,
    res: '1920×1080',
    ppd: 49,
    color: 0xff9100,
    hex: '#ff9100'
  },
  ultra: {
    id: 'ultra',
    name: 'XREAL Air 2 Ultra',
    diagFov: 52,
    aspectW: 16,
    aspectH: 9,
    res: '1920×1080',
    ppd: 42,
    color: 0xffea00,
    hex: '#ffea00'
  },
  onepro: {
    id: 'onepro',
    name: 'XREAL One Pro',
    diagFov: 57,
    aspectW: 16,
    aspectH: 9,
    res: '1920×1080',
    ppd: 38,
    color: 0x00e676,
    hex: '#00e676'
  },
  aura: {
    id: 'aura',
    name: 'XREAL Aura',
    diagFov: 70,
    aspectW: 16,
    aspectH: 10,
    res: '1920×1200',
    ppd: 32,
    color: 0x00e5ff,
    hex: '#00e5ff'
  },
  full: {
    id: 'full',
    name: 'Quest Full FOV (Unclipped)',
    diagFov: 120,
    aspectW: 16,
    aspectH: 10,
    res: 'Unclipped',
    ppd: 25,
    color: 0xffffff,
    hex: '#ffffff',
    unclipped: true
  }
};

export const DIMMER_LEVELS = [
  { level: 1, name: 'Lv.1 クリア', opacity: 0.10, percent: '10%' },
  { level: 2, name: 'Lv.2 標準', opacity: 0.35, percent: '35%' },
  { level: 3, name: 'Lv.3 中間', opacity: 0.60, percent: '60%' },
  { level: 4, name: 'Lv.4 濃色', opacity: 0.85, percent: '85%' },
  { level: 5, name: 'Lv.5 没入', opacity: 0.98, percent: '98%' }
];

export function computeFovAngles(diagFovDeg, aspectW, aspectH) {
  const halfDiagRad = THREE.MathUtils.degToRad(diagFovDeg * 0.5);
  const tanDiag = Math.tan(halfDiagRad);
  const norm = Math.hypot(aspectW, aspectH);
  const halfTanH = tanDiag * (aspectW / norm);
  const halfTanV = tanDiag * (aspectH / norm);
  const hFovDeg = THREE.MathUtils.radToDeg(Math.atan(halfTanH) * 2);
  const vFovDeg = THREE.MathUtils.radToDeg(Math.atan(halfTanV) * 2);
  return { halfTanH, halfTanV, hFovDeg, vFovDeg };
}

export class FovSimulator {
  constructor(scene) {
    this.scene = scene;
    this.currentModelKey = 'aura';
    this.currentDimmerIndex = 1; // Lv.2 (35%)

    this.showFrame = true;
    this.showFovBorder = true;
    this.showCompareFrames = false;
    this.showAngleGrid = false;
    this.additiveSim = false;

    // 4 world-space clipping planes (Left, Right, Bottom, Top)
    this.clippingPlanes = [
      new THREE.Plane(),
      new THREE.Plane(),
      new THREE.Plane(),
      new THREE.Plane()
    ];

    // Head-locked container
    this.headGroup = new THREE.Group();
    this.headGroup.name = 'HeadLockedOpticalSystem';
    this.scene.add(this.headGroup);

    // Distance from eye for head-locked HUD overlays (meters)
    this.hudDistance = 0.55;

    // Reusable math temporaries
    this._headPos = new THREE.Vector3();
    this._headQuat = new THREE.Quaternion();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._forward = new THREE.Vector3();
    this._normal = new THREE.Vector3();

    this._buildGlassesAndDimmer();
    this._buildActiveFovBorder();
    this._buildComparisonFrames();
    this._buildAngleGrid();
    this._buildHudStatusBadge();

    this.setModel('aura');
    this.setDimmer(1);
  }

  /**
   * Builds the physical XREAL Aura outer sunglass lens (electrochromic dimmer)
   * and dark titanium frame silhouette around the user's vision.
   */
  _buildGlassesAndDimmer() {
    this.glassesGroup = new THREE.Group();
    this.headGroup.add(this.glassesGroup);

    const d = this.hudDistance;
    // Outer electrochromic lens covers ~96 deg horizontal x 56 deg vertical
    const lensW = d * Math.tan(THREE.MathUtils.degToRad(48)) * 2;
    const lensH = d * Math.tan(THREE.MathUtils.degToRad(28)) * 2;
    const r = 0.09 * d;

    // Custom glasses silhouette with rounded corners & nose bridge arch
    const lensShape = new THREE.Shape();
    const hw = lensW * 0.5;
    const hh = lensH * 0.5;
    const noseW = 0.11 * d;
    const noseH = 0.13 * d;

    lensShape.moveTo(-hw + r, hh);
    lensShape.lineTo(hw - r, hh);
    lensShape.quadraticCurveTo(hw, hh, hw, hh - r);
    lensShape.lineTo(hw * 0.92, -hh + r);
    lensShape.quadraticCurveTo(hw * 0.90, -hh, noseW, -hh);
    // Nose bridge arch in the bottom center
    lensShape.quadraticCurveTo(noseW * 0.55, -hh + noseH, 0, -hh + noseH);
    lensShape.quadraticCurveTo(-noseW * 0.55, -hh + noseH, -noseW, -hh);
    lensShape.lineTo(-hw * 0.90, -hh);
    lensShape.quadraticCurveTo(-hw * 0.92, -hh, -hw * 0.92, -hh + r);
    lensShape.lineTo(-hw, hh - r);
    lensShape.quadraticCurveTo(-hw, hh, -hw + r, hh);

    const lensGeo = new THREE.ShapeGeometry(lensShape, 24);
    this.dimmerMaterial = new THREE.MeshBasicMaterial({
      color: 0x05080f,
      transparent: true,
      opacity: DIMMER_LEVELS[this.currentDimmerIndex].opacity,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide
    });

    this.dimmerMesh = new THREE.Mesh(lensGeo, this.dimmerMaterial);
    this.dimmerMesh.position.z = -d;
    this.dimmerMesh.renderOrder = -20;
    this.glassesGroup.add(this.dimmerMesh);

    // Outer Titanium Brow Bar & Frame Rim
    const outerFrameShape = new THREE.Shape();
    const pad = 0.032 * d;
    const padTop = 0.055 * d; // Thicker brow bar housing the X Prism optics
    const fhw = hw + pad;
    const fhhTop = hh + padTop;
    const fhhBot = hh + pad * 0.65;

    outerFrameShape.moveTo(-fhw + r, fhhTop);
    outerFrameShape.lineTo(fhw - r, fhhTop);
    outerFrameShape.quadraticCurveTo(fhw, fhhTop, fhw, fhhTop - r);
    outerFrameShape.lineTo(fhw * 0.93, -fhhBot + r);
    outerFrameShape.quadraticCurveTo(fhw * 0.91, -fhhBot, noseW * 1.15, -fhhBot);
    outerFrameShape.quadraticCurveTo(noseW * 0.6, -fhhBot + noseH, 0, -fhhBot + noseH);
    outerFrameShape.quadraticCurveTo(-noseW * 0.6, -fhhBot + noseH, -noseW * 1.15, -fhhBot);
    outerFrameShape.lineTo(-fhw * 0.91, -fhhBot);
    outerFrameShape.quadraticCurveTo(-fhw * 0.93, -fhhBot, -fhw * 0.93, -fhhBot + r);
    outerFrameShape.lineTo(-fhw, fhhTop - r);
    outerFrameShape.quadraticCurveTo(-fhw, fhhTop, -fhw + r, fhhTop);

    // Punch hole for the lens
    outerFrameShape.holes.push(lensShape);

    const frameGeo = new THREE.ShapeGeometry(outerFrameShape, 24);
    const frameMat = new THREE.MeshBasicMaterial({
      color: 0x10141d,
      transparent: true,
      opacity: 0.92,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide
    });

    this.frameRimMesh = new THREE.Mesh(frameGeo, frameMat);
    this.frameRimMesh.position.z = -d + 0.001;
    this.frameRimMesh.renderOrder = -19;
    this.glassesGroup.add(this.frameRimMesh);
  }

  /**
   * Builds the active optical prism FOV boundary frame & subtle optical prism sheen.
   */
  _buildActiveFovBorder() {
    this.activeBorderGroup = new THREE.Group();
    this.headGroup.add(this.activeBorderGroup);
  }

  _rebuildActiveFovGeometry() {
    while (this.activeBorderGroup.children.length > 0) {
      const child = this.activeBorderGroup.children[0];
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
      this.activeBorderGroup.remove(child);
    }

    const preset = MODEL_PRESETS[this.currentModelKey];
    if (preset.unclipped) return;

    const d = this.hudDistance;
    const { halfTanH, halfTanV, hFovDeg, vFovDeg } = computeFovAngles(
      preset.diagFov,
      preset.aspectW,
      preset.aspectH
    );

    const w = d * halfTanH * 2;
    const h = d * halfTanV * 2;

    // Subtle X-Prism optical combiner tint inside the active display region
    const prismPlaneGeo = new THREE.PlaneGeometry(w, h);
    const prismPlaneMat = new THREE.MeshBasicMaterial({
      color: preset.color,
      transparent: true,
      opacity: 0.025,
      depthTest: false,
      depthWrite: false
    });
    const prismMesh = new THREE.Mesh(prismPlaneGeo, prismPlaneMat);
    prismMesh.position.z = -d + 0.002;
    prismMesh.renderOrder = -18;
    this.activeBorderGroup.add(prismMesh);

    // Crisp FOV border rectangle + corner brackets
    const hw = w * 0.5;
    const hh = h * 0.5;
    const pts = [
      new THREE.Vector3(-hw, hh, -d + 0.003),
      new THREE.Vector3(hw, hh, -d + 0.003),
      new THREE.Vector3(hw, -hh, -d + 0.003),
      new THREE.Vector3(-hw, -hh, -d + 0.003),
      new THREE.Vector3(-hw, hh, -d + 0.003)
    ];
    const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
    const lineMat = new THREE.LineBasicMaterial({
      color: preset.color,
      transparent: true,
      opacity: 0.75,
      depthTest: false,
      depthWrite: false
    });
    const borderLine = new THREE.Line(lineGeo, lineMat);
    borderLine.renderOrder = -15;
    this.activeBorderGroup.add(borderLine);

    // Top-right FOV label sprite attached to the optical border
    const labelTex = this._createLabelTexture(
      `${preset.name} • 対角 ${preset.diagFov}° (${hFovDeg.toFixed(1)}°×${vFovDeg.toFixed(1)}° | ${preset.res})`,
      preset.hex
    );
    const labelGeo = new THREE.PlaneGeometry(0.24, 0.026);
    const labelMat = new THREE.MeshBasicMaterial({
      map: labelTex,
      transparent: true,
      depthTest: false,
      depthWrite: false
    });
    const labelMesh = new THREE.Mesh(labelGeo, labelMat);
    labelMesh.position.set(0, hh + 0.016, -d + 0.003);
    labelMesh.renderOrder = -14;
    this.activeBorderGroup.add(labelMesh);
  }

  /**
   * Builds simultaneous comparison outlines for Air (46°), Ultra (52°), One Pro (57°), and Aura (70°).
   */
  _buildComparisonFrames() {
    this.compareGroup = new THREE.Group();
    this.compareGroup.visible = this.showCompareFrames;
    this.headGroup.add(this.compareGroup);

    const d = this.hudDistance;
    const models = ['air', 'ultra', 'onepro', 'aura'];

    models.forEach((key, idx) => {
      const preset = MODEL_PRESETS[key];
      const { halfTanH, halfTanV } = computeFovAngles(
        preset.diagFov,
        preset.aspectW,
        preset.aspectH
      );
      const hw = d * halfTanH;
      const hh = d * halfTanV;

      const pts = [
        new THREE.Vector3(-hw, hh, -d + 0.004),
        new THREE.Vector3(hw, hh, -d + 0.004),
        new THREE.Vector3(hw, -hh, -d + 0.004),
        new THREE.Vector3(-hw, -hh, -d + 0.004),
        new THREE.Vector3(-hw, hh, -d + 0.004)
      ];
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({
        color: preset.color,
        transparent: true,
        opacity: 0.65,
        depthTest: false,
        depthWrite: false
      });
      const line = new THREE.Line(geo, mat);
      line.renderOrder = -13;
      this.compareGroup.add(line);

      // Small corner tag
      const tagTex = this._createLabelTexture(
        `${preset.name} (${preset.diagFov}°)`,
        preset.hex
      );
      const tagMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(0.13, 0.018),
        new THREE.MeshBasicMaterial({
          map: tagTex,
          transparent: true,
          depthTest: false,
          depthWrite: false
        })
      );
      tagMesh.position.set(-hw + 0.068, -hh + 0.012 + idx * 0.002, -d + 0.004);
      tagMesh.renderOrder = -12;
      this.compareGroup.add(tagMesh);
    });
  }

  /**
   * Builds a 10-degree angular ruler grid so the user can verify exact FOV angles.
   */
  _buildAngleGrid() {
    this.angleGridGroup = new THREE.Group();
    this.angleGridGroup.visible = this.showAngleGrid;
    this.headGroup.add(this.angleGridGroup);

    const d = this.hudDistance;
    const maxDegH = 35;
    const maxDegV = 25;

    const lineMat = new THREE.LineBasicMaterial({
      color: 0x70b5ff,
      transparent: true,
      opacity: 0.28,
      depthTest: false,
      depthWrite: false
    });

    // Vertical angle lines every 10 deg
    for (let deg = -30; deg <= 30; deg += 10) {
      const x = d * Math.tan(THREE.MathUtils.degToRad(deg));
      const yMax = d * Math.tan(THREE.MathUtils.degToRad(maxDegV));
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x, -yMax, -d + 0.002),
        new THREE.Vector3(x, yMax, -d + 0.002)
      ]);
      const line = new THREE.Line(geo, lineMat);
      line.renderOrder = -16;
      this.angleGridGroup.add(line);

      if (deg !== 0) {
        const lbl = this._createLabelTexture(`${deg > 0 ? '+' : ''}${deg}°`, '#88ccff');
        const m = new THREE.Mesh(
          new THREE.PlaneGeometry(0.036, 0.015),
          new THREE.MeshBasicMaterial({
            map: lbl,
            transparent: true,
            depthTest: false,
            depthWrite: false
          })
        );
        m.position.set(x, 0.01, -d + 0.003);
        m.renderOrder = -15;
        this.angleGridGroup.add(m);
      }
    }

    // Horizontal angle lines every 10 deg
    for (let deg = -20; deg <= 20; deg += 10) {
      const y = d * Math.tan(THREE.MathUtils.degToRad(deg));
      const xMax = d * Math.tan(THREE.MathUtils.degToRad(maxDegH));
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-xMax, y, -d + 0.002),
        new THREE.Vector3(xMax, y, -d + 0.002)
      ]);
      const line = new THREE.Line(geo, lineMat);
      line.renderOrder = -16;
      this.angleGridGroup.add(line);
    }
  }

  _buildHudStatusBadge() {
    this.hudBadgeCanvas = document.createElement('canvas');
    this.hudBadgeCanvas.width = 512;
    this.hudBadgeCanvas.height = 64;
    this.hudBadgeTex = new THREE.CanvasTexture(this.hudBadgeCanvas);
    this.hudBadgeTex.colorSpace = THREE.SRGBColorSpace;

    const geo = new THREE.PlaneGeometry(0.22, 0.0275);
    const mat = new THREE.MeshBasicMaterial({
      map: this.hudBadgeTex,
      transparent: true,
      depthTest: false,
      depthWrite: false
    });
    this.hudBadgeMesh = new THREE.Mesh(geo, mat);
    this.hudBadgeMesh.position.set(0, -0.215, -this.hudDistance + 0.004);
    this.hudBadgeMesh.renderOrder = -11;
    this.headGroup.add(this.hudBadgeMesh);
    this._updateHudBadge();
  }

  _updateHudBadge() {
    if (!this.hudBadgeCanvas) return;
    const ctx = this.hudBadgeCanvas.getContext('2d');
    ctx.clearRect(0, 0, 512, 64);

    ctx.fillStyle = 'rgba(10, 16, 28, 0.78)';
    ctx.beginPath();
    ctx.roundRect(4, 4, 504, 56, 28);
    ctx.fill();

    const preset = MODEL_PRESETS[this.currentModelKey];
    const dimmer = DIMMER_LEVELS[this.currentDimmerIndex];

    ctx.strokeStyle = preset.hex;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 21px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      `${preset.name} (${preset.diagFov}°)  |  調光: ${dimmer.name} (${dimmer.percent})`,
      256,
      32
    );
    this.hudBadgeTex.needsUpdate = true;
  }

  _createLabelTexture(text, borderColor = '#00e5ff') {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = 'rgba(8, 13, 24, 0.82)';
    ctx.beginPath();
    ctx.roundRect(4, 6, 504, 52, 14);
    ctx.fill();

    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.fillStyle = '#f2f7ff';
    ctx.font = 'bold 23px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 256, 33);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  setModel(modelKey) {
    if (!MODEL_PRESETS[modelKey]) return;
    this.currentModelKey = modelKey;
    this._rebuildActiveFovGeometry();
    this._updateHudBadge();
  }

  cycleModel() {
    const keys = ['air', 'ultra', 'onepro', 'aura', 'full'];
    const nextIdx = (keys.indexOf(this.currentModelKey) + 1) % keys.length;
    this.setModel(keys[nextIdx]);
    return this.currentModelKey;
  }

  setDimmer(index) {
    const clamped = Math.max(0, Math.min(DIMMER_LEVELS.length - 1, index));
    this.currentDimmerIndex = clamped;
    if (this.dimmerMaterial) {
      this.dimmerMaterial.opacity = DIMMER_LEVELS[clamped].opacity;
    }
    this._updateHudBadge();
  }

  cycleDimmer() {
    const next = (this.currentDimmerIndex + 1) % DIMMER_LEVELS.length;
    this.setDimmer(next);
    return this.currentDimmerIndex;
  }

  setShowFrame(visible) {
    this.showFrame = visible;
    this.glassesGroup.visible = visible;
  }

  setShowFovBorder(visible) {
    this.showFovBorder = visible;
    this.activeBorderGroup.visible = visible;
  }

  setShowCompareFrames(visible) {
    this.showCompareFrames = visible;
    this.compareGroup.visible = visible;
  }

  setShowAngleGrid(visible) {
    this.showAngleGrid = visible;
    this.angleGridGroup.visible = visible;
  }

  getActiveSpecSummary() {
    const preset = MODEL_PRESETS[this.currentModelKey];
    const { hFovDeg, vFovDeg } = computeFovAngles(
      preset.diagFov,
      preset.aspectW,
      preset.aspectH
    );
    return {
      ...preset,
      hFovDeg,
      vFovDeg,
      dimmer: DIMMER_LEVELS[this.currentDimmerIndex]
    };
  }

  /**
   * Synchronizes the head-locked optical frame and updates the 4 world-space
   * FOV clipping planes based on the current head pose.
   */
  update(camera) {
    camera.matrixWorld.decompose(this._headPos, this._headQuat, this._up);

    // Sync headGroup to viewer head pose
    this.headGroup.position.copy(this._headPos);
    this.headGroup.quaternion.copy(this._headQuat);
    this.headGroup.updateMatrixWorld(true);

    const preset = MODEL_PRESETS[this.currentModelKey];
    if (preset.unclipped) {
      for (let i = 0; i < 4; i++) {
        this.clippingPlanes[i].normal.set(0, 0, -1);
        this.clippingPlanes[i].constant = 1e6;
      }
      return;
    }

    const { halfTanH, halfTanV } = computeFovAngles(
      preset.diagFov,
      preset.aspectW,
      preset.aspectH
    );

    // Extract head basis vectors in world space
    this._right.set(1, 0, 0).applyQuaternion(this._headQuat).normalize();
    this._up.set(0, 1, 0).applyQuaternion(this._headQuat).normalize();
    this._forward.set(0, 0, -1).applyQuaternion(this._headQuat).normalize();

    // 1. Left clipping plane: inward normal = normalize(R + halfTanH * F)
    this._normal
      .copy(this._right)
      .addScaledVector(this._forward, halfTanH)
      .normalize();
    this.clippingPlanes[0].setFromNormalAndCoplanarPoint(this._normal, this._headPos);

    // 2. Right clipping plane: inward normal = normalize(-R + halfTanH * F)
    this._normal
      .copy(this._right)
      .negate()
      .addScaledVector(this._forward, halfTanH)
      .normalize();
    this.clippingPlanes[1].setFromNormalAndCoplanarPoint(this._normal, this._headPos);

    // 3. Bottom clipping plane: inward normal = normalize(U + halfTanV * F)
    this._normal
      .copy(this._up)
      .addScaledVector(this._forward, halfTanV)
      .normalize();
    this.clippingPlanes[2].setFromNormalAndCoplanarPoint(this._normal, this._headPos);

    // 4. Top clipping plane: inward normal = normalize(-U + halfTanV * F)
    this._normal
      .copy(this._up)
      .negate()
      .addScaledVector(this._forward, halfTanV)
      .normalize();
    this.clippingPlanes[3].setFromNormalAndCoplanarPoint(this._normal, this._headPos);
  }
}

