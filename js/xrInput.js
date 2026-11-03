import * as THREE from 'three';

export class XRInputManager {
  constructor(renderer, scene, camera, workspace, fovSimulator, onStateChange) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.workspace = workspace;
    this.fovSimulator = fovSimulator;
    this.onStateChange = onStateChange;

    this.raycaster = new THREE.Raycaster();
    this.tempMatrix = new THREE.Matrix4();
    this.controllers = [];
    this.grabState = null;

    // Button edge-detection state for Quest gamepad buttons (A/B/X/Y)
    this.prevButtonState = {
      0: {},
      1: {}
    };

    // Hover reticle dot
    const cursorGeo = new THREE.RingGeometry(0.008, 0.015, 24);
    const cursorMat = new THREE.MeshBasicMaterial({
      color: 0x00e5ff,
      side: THREE.DoubleSide,
      depthTest: false
    });
    this.cursorMesh = new THREE.Mesh(cursorGeo, cursorMat);
    this.cursorMesh.visible = false;
    this.cursorMesh.renderOrder = 20;
    this.scene.add(this.cursorMesh);

    this._setupXRControllers();
  }

  _setupXRControllers() {
    for (let i = 0; i < 2; i++) {
      const controller = this.renderer.xr.getController(i);

      // Laser ray line
      const rayGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -2.5)
      ]);
      const rayMat = new THREE.LineBasicMaterial({
        color: 0x00e5ff,
        transparent: true,
        opacity: 0.7
      });
      const rayLine = new THREE.Line(rayGeo, rayMat);
      controller.add(rayLine);

      controller.addEventListener('selectstart', () => this._onControllerSelectStart(controller));
      controller.addEventListener('selectend', () => this._onControllerSelectEnd(controller));
      controller.addEventListener('squeezestart', () => {
        // Grip button recenters the workspace in front of the user
        this.workspace.recenter(this.camera);
      });

      this.scene.add(controller);
      this.controllers.push({ controller, rayLine });
    }
  }

  _raycastFromController(controller) {
    this.tempMatrix.identity().extractRotation(controller.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tempMatrix);
    return this.raycaster.intersectObjects(this.workspace.interactiveMeshes, false);
  }

  _onControllerSelectStart(controller) {
    const hits = this._raycastFromController(controller);
    if (hits.length === 0) return;

    const hit = hits[0];
    const obj = hit.object;

    if (obj.userData.isGrabBar && obj.userData.draggableGroup) {
      const group = obj.userData.draggableGroup;
      this.grabState = {
        controller,
        group,
        distance: hit.distance
      };
      return;
    }

    if (obj.userData.onClick && hit.uv) {
      obj.userData.onClick(hit.uv);
    }
  }

  _onControllerSelectEnd(controller) {
    if (this.grabState && this.grabState.controller === controller) {
      this.grabState = null;
    }
  }

  /**
   * Polls Quest Touch controller thumbstick/A/B/X/Y buttons and updates raycast cursor.
   */
  update() {
    // Handle window dragging if grabbed
    if (this.grabState) {
      const { controller, group, distance } = this.grabState;
      this.tempMatrix.identity().extractRotation(controller.matrixWorld);
      const origin = new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld);
      const dir = new THREE.Vector3(0, 0, -1).applyMatrix4(this.tempMatrix);
      const worldTarget = origin.addScaledVector(dir, distance);

      if (group.parent) {
        group.parent.worldToLocal(worldTarget);
        group.position.copy(worldTarget);
        // Face center toward local origin (viewer)
        group.rotation.y = Math.atan2(-group.position.x, -group.position.z);
      }
    }

    // Check hover & gamepad buttons in XR session
    const session = this.renderer.xr.getSession();
    if (!session) {
      this.cursorMesh.visible = false;
      return;
    }

    let closestHit = null;
    for (const item of this.controllers) {
      const hits = this._raycastFromController(item.controller);
      if (hits.length > 0) {
        item.rayLine.scale.z = hits[0].distance / 2.5;
        if (!closestHit || hits[0].distance < closestHit.distance) {
          closestHit = hits[0];
        }
      } else {
        item.rayLine.scale.z = 1.0;
      }
    }

    if (closestHit) {
      this.cursorMesh.visible = true;
      this.cursorMesh.position.copy(closestHit.point);
      this.cursorMesh.quaternion.copy(this.camera.quaternion);
    } else {
      this.cursorMesh.visible = false;
    }

    // Poll Quest Controller A/X (button 4) and B/Y (button 5) for quick FOV & Dimmer cycling
    const sources = session.inputSources || [];
    sources.forEach((source, idx) => {
      if (!source.gamepad) return;
      const buttons = source.gamepad.buttons;
      const stateMap = this.prevButtonState[idx] || (this.prevButtonState[idx] = {});

      // Button 4 = A / X -> Cycle FOV Model (46° / 52° / 57° / 70° / Full)
      if (buttons[4]) {
        const pressed = buttons[4].pressed;
        if (pressed && !stateMap[4]) {
          this.fovSimulator.cycleModel();
          this.workspace.refreshAllUI();
          if (this.onStateChange) this.onStateChange();
        }
        stateMap[4] = pressed;
      }

      // Button 5 = B / Y -> Cycle 5-stage Electrochromic Dimmer
      if (buttons[5]) {
        const pressed = buttons[5].pressed;
        if (pressed && !stateMap[5]) {
          this.fovSimulator.cycleDimmer();
          this.workspace.refreshAllUI();
          if (this.onStateChange) this.onStateChange();
        }
        stateMap[5] = pressed;
      }
    });
  }
}

