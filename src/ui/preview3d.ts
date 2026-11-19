import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { backlitBrightness } from '../core/litho';

export type Finish = 'clay' | 'wood' | 'aluminum' | 'backlit';

const FINISHES: Record<Exclude<Finish, 'backlit'>, { color: number; roughness: number; metalness: number }> = {
  clay: { color: 0xd9d4cc, roughness: 0.95, metalness: 0 },
  wood: { color: 0xc8a175, roughness: 0.85, metalness: 0 },
  aluminum: { color: 0xc4c8cc, roughness: 0.45, metalness: 0.85 },
};

/**
 * Shaded 3D preview of the machining heightfield with a movable raking light.
 * Coordinates: x right, y up, z = height (mm); the part is centred on the origin.
 */
export class ReliefPreview {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private light = new THREE.DirectionalLight(0xffffff, 2.6);
  private fill = new THREE.HemisphereLight(0xffffff, 0x404040, 0.25);
  private mesh: THREE.Mesh | null = null;
  private skirt: THREE.Mesh | null = null;
  private material = new THREE.MeshStandardMaterial({ ...FINISHES.clay, flatShading: false });
  /** lithophane view: light shining through the plate, brightness from the thickness */
  private backlitMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  private edgeMat = new THREE.MeshBasicMaterial({ color: 0x2a2620 });
  /** vertex-coloured relief for the "can't reach" view */
  private reachMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  private reach: Float32Array | null = null;
  /** lithophane mesh: picture surface (smooth) and the rest (flat-shaded walls and back) */
  private lithoTop: THREE.Mesh | null = null;
  private lithoRest: THREE.Mesh | null = null;
  private lithoH: Float32Array | null = null;
  private finish: Finish = 'clay';
  private lastZ: { z: Float32Array; nx: number; ny: number } | null = null;
  private size = { w: 100, h: 100, d: 0 };
  private azimuth = 135;
  private elevation = 25;
  private ro: ResizeObserver;
  private frame = 0;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    host.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x1b1c1e);
    this.camera = new THREE.PerspectiveCamera(30, 1, 1, 10000);
    this.camera.up.set(0, 1, 0);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener('change', () => this.requestRender());
    this.scene.add(this.light, this.light.target, this.fill);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.resetView();
    const tick = () => {
      this.frame = requestAnimationFrame(tick);
      if (this.controls.update()) this.render();
    };
    tick();
  }

  setFinish(f: Finish) {
    this.finish = f;
    if (f !== 'backlit') {
      this.material.color.setHex(FINISHES[f].color);
      this.material.roughness = FINISHES[f].roughness;
      this.material.metalness = FINISHES[f].metalness;
    }
    this.applyMaterials();
    this.requestRender();
  }

  private applyMaterials() {
    const lit = this.finish === 'backlit';
    if (this.mesh) {
      if (lit) this.updateBacklitColors();
      else if (this.reach) this.updateReachColors();
      this.mesh.material = lit ? this.backlitMat : this.reach ? this.reachMat : this.material;
    }
    if (this.skirt) this.skirt.material = lit ? this.edgeMat : this.material;
    if (this.lithoTop) {
      if (lit) this.updateLithoColors();
      this.lithoTop.material = lit ? this.backlitMat : this.material;
    }
    if (this.lithoRest) this.lithoRest.material = lit ? this.edgeMat : this.material;
    this.scene.background = new THREE.Color(lit ? 0x0c0c0d : 0x1b1c1e);
  }

  /** highlights material the cutter cannot reach (mm left per grid point), or null to clear */
  setReach(left: Float32Array | null) {
    this.reach = left;
    this.applyMaterials();
    this.requestRender();
  }

  private updateReachColors() {
    if (!this.mesh || !this.lastZ || !this.reach) return;
    const { nx, ny } = this.lastZ;
    const geom = this.mesh.geometry as THREE.BufferGeometry;
    const n = nx * ny;
    let col = geom.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!col || col.count !== n) {
      col = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
      geom.setAttribute('color', col);
    }
    const base = this.finish === 'backlit' ? new THREE.Color(FINISHES.clay.color) : new THREE.Color(FINISHES[this.finish].color);
    const hot = new THREE.Color(0xe8432e);
    const c = new THREE.Color();
    for (let iy = 0; iy < ny; iy++) {
      const j = ny - 1 - iy;
      for (let ix = 0; ix < nx; ix++) {
        const v = this.reach[j * nx + ix];
        // nothing below 0.02 mm (grid noise); full red at 0.5 mm left
        const t = Math.min(1, Math.max(0, (v - 0.02) / 0.48));
        c.copy(base).lerp(hot, t > 0 ? 0.35 + 0.65 * t : 0);
        col.setXYZ(iy * nx + ix, c.r, c.g, c.b);
      }
    }
    col.needsUpdate = true;
    this.reachMat.metalness = this.finish === 'aluminum' ? 0.6 : 0;
    this.reachMat.roughness = this.finish === 'aluminum' ? 0.5 : 0.9;
  }

  private updateLithoColors() {
    if (!this.lithoTop || !this.lithoH) return;
    const h = this.lithoH;
    let lo = Infinity, hi = -Infinity;
    for (const v of h) {
      if (v < 0) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const geom = this.lithoTop.geometry as THREE.BufferGeometry;
    let col = geom.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!col || col.count !== h.length) {
      col = new THREE.BufferAttribute(new Float32Array(h.length * 3), 3);
      geom.setAttribute('color', col);
    }
    for (let k = 0; k < h.length; k++) {
      const b = h[k] < 0 ? 0 : backlitBrightness(h[k], lo, hi);
      col.setXYZ(k, b, b * 0.93, b * 0.8);
    }
    col.needsUpdate = true;
  }

  /** shows or hides the relief heightfield objects vs the lithophane mesh */
  private showLitho(on: boolean) {
    if (this.mesh) this.mesh.visible = !on;
    if (this.skirt) this.skirt.visible = !on;
    if (this.lithoTop) this.lithoTop.visible = on;
    if (this.lithoRest) this.lithoRest.visible = on;
  }

  /**
   * Lithophane preview from its printable mesh (see core/mesh). Flat ones lie picture-up; upright
   * ones (curved, lamp shade) stand on Z = 0 and are turned so the picture faces the camera.
   */
  setLithoMesh(pos: Float32Array, idx: Uint32Array, h: Float32Array, topTris: number, upright: boolean) {
    const p = new Float32Array(pos.length);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < pos.length; k += 3) {
      const x = pos[k], y = upright ? pos[k + 2] : pos[k + 1], zz = upright ? -pos[k + 1] : pos[k + 2];
      p[k] = x; p[k + 1] = y; p[k + 2] = zz;
      for (let c = 0; c < 3; c++) {
        lo[c] = Math.min(lo[c], p[k + c]);
        hi[c] = Math.max(hi[c], p[k + c]);
      }
    }
    // centre in x / y; flat parts keep the back at z = 0 like the relief view
    const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2, cz = upright ? (lo[2] + hi[2]) / 2 : 0;
    for (let k = 0; k < p.length; k += 3) {
      p[k] -= cx; p[k + 1] -= cy; p[k + 2] -= cz;
    }
    const w = hi[0] - lo[0], hh = hi[1] - lo[1];
    const sizeChanged = Math.abs(w - this.size.w) > 1e-3 || Math.abs(hh - this.size.h) > 1e-3;
    this.size = { w, h: hh, d: upright ? hi[2] - lo[2] : 0 };

    const top = new THREE.BufferGeometry();
    top.setAttribute('position', new THREE.BufferAttribute(p, 3));
    top.setIndex(new THREE.BufferAttribute(idx.slice(0, topTris * 3), 1));
    top.computeVertexNormals();
    const restIdx = idx.subarray(topTris * 3);
    const rp = new Float32Array(restIdx.length * 3);
    for (let t = 0; t < restIdx.length; t++) {
      const v = restIdx[t] * 3;
      rp[t * 3] = p[v]; rp[t * 3 + 1] = p[v + 1]; rp[t * 3 + 2] = p[v + 2];
    }
    const rest = new THREE.BufferGeometry();
    rest.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    rest.computeVertexNormals();
    if (!this.lithoTop) {
      this.lithoTop = new THREE.Mesh(top, this.material);
      this.lithoRest = new THREE.Mesh(rest, this.material);
      this.scene.add(this.lithoTop, this.lithoRest);
    } else {
      this.lithoTop.geometry.dispose();
      this.lithoRest!.geometry.dispose();
      this.lithoTop.geometry = top;
      this.lithoRest!.geometry = rest;
    }
    this.lithoH = h;
    this.showLitho(true);
    this.applyMaterials();
    this.placeLight();
    if (sizeChanged) this.resetView();
    this.requestRender();
  }

  /** slowly turns the view around the part (lamp shades) */
  setSpin(on: boolean) {
    this.controls.autoRotate = on;
    this.controls.autoRotateSpeed = 6;
  }

  private updateBacklitColors() {
    if (!this.mesh || !this.lastZ) return;
    const { z, nx, ny } = this.lastZ;
    let lo = Infinity, hi = -Infinity;
    for (const v of z) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const geom = this.mesh.geometry as THREE.BufferGeometry;
    const n = nx * ny;
    let col = geom.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!col || col.count !== n) {
      col = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
      geom.setAttribute('color', col);
    }
    // warm white light through white PLA
    for (let iy = 0; iy < ny; iy++) {
      const j = ny - 1 - iy;
      for (let ix = 0; ix < nx; ix++) {
        const b = backlitBrightness(z[j * nx + ix], lo, hi);
        col.setXYZ(iy * nx + ix, b, b * 0.93, b * 0.8);
      }
    }
    col.needsUpdate = true;
  }

  setLight(azimuthDeg: number, elevationDeg: number) {
    this.azimuth = azimuthDeg;
    this.elevation = elevationDeg;
    this.placeLight();
    this.requestRender();
  }

  private placeLight() {
    const az = (this.azimuth * Math.PI) / 180;
    const el = (this.elevation * Math.PI) / 180;
    const R = Math.max(this.size.w, this.size.h) * 2;
    this.light.position.set(R * Math.cos(el) * Math.cos(az), R * Math.cos(el) * Math.sin(az), R * Math.sin(el));
    this.light.target.position.set(0, 0, 0);
  }

  /**
   * z: CAD-oriented heightfield (row 0 = bottom edge), in mm.
   */
  setHeightfield(z: Float32Array, nx: number, ny: number, widthMm: number, heightMm: number) {
    const bendRadius = 0;
    this.showLitho(false);
    const sizeChanged = Math.abs(widthMm - this.size.w) > 1e-6 || Math.abs(heightMm - this.size.h) > 1e-6;
    this.size = { w: widthMm, h: heightMm, d: 0 };
    let geom = this.mesh?.geometry as THREE.PlaneGeometry | undefined;
    const p = geom?.parameters;
    if (!geom || !p || p.widthSegments !== nx - 1 || p.heightSegments !== ny - 1 || p.width !== widthMm || p.height !== heightMm) {
      geom?.dispose();
      geom = new THREE.PlaneGeometry(widthMm, heightMm, nx - 1, ny - 1);
      if (!this.mesh) {
        this.mesh = new THREE.Mesh(geom, this.material);
        this.scene.add(this.mesh);
      } else this.mesh.geometry = geom;
    }
    const pos = geom.attributes.position as THREE.BufferAttribute;
    const map = this.bendMap(bendRadius);
    // PlaneGeometry rows go from top (iy=0) to bottom
    for (let iy = 0; iy < ny; iy++) {
      const j = ny - 1 - iy;
      const y = heightMm / 2 - (iy * heightMm) / (ny - 1);
      for (let ix = 0; ix < nx; ix++) {
        const [X, Y, Z] = map(-widthMm / 2 + (ix * widthMm) / (nx - 1), y, z[j * nx + ix]);
        pos.setXYZ(iy * nx + ix, X, Y, Z);
      }
    }
    pos.needsUpdate = true;
    geom.computeVertexNormals();
    geom.computeBoundingSphere();
    this.updateSkirt(z, nx, ny, widthMm, heightMm, map);
    this.lastZ = { z: new Float32Array(z), nx, ny };
    this.applyMaterials();
    this.placeLight();
    if (sizeChanged) this.resetView();
    this.requestRender();
  }

  /**
   * Side walls (top edge of the relief straight down to Z = 0) and the flat bottom, so the
   * preview shows the full block, base thickness included, like the STEP solid and STL exports.
   */
  /** (x, y centred on the part, h) → display coordinates; identity when flat */
  private bendMap(R: number): (x: number, y: number, h: number) => [number, number, number] {
    if (!(R > 0)) return (x, y, h) => [x, y, h];
    return (x, y, h) => {
      const th = x / R;
      const r = R + h;
      return [r * Math.sin(th), y, r * Math.cos(th) - R];
    };
  }

  private updateSkirt(
    z: Float32Array,
    nx: number,
    ny: number,
    W: number,
    H: number,
    map: (x: number, y: number, h: number) => [number, number, number],
  ) {
    const X = (i: number) => -W / 2 + (i * W) / (nx - 1);
    const Y = (j: number) => -H / 2 + (j * H) / (ny - 1);
    // boundary loop counter-clockwise seen from above: bottom edge, right, top, left
    const loop: [number, number][] = [];
    for (let i = 0; i < nx - 1; i++) loop.push([i, 0]);
    for (let j = 0; j < ny - 1; j++) loop.push([nx - 1, j]);
    for (let i = nx - 1; i > 0; i--) loop.push([i, ny - 1]);
    for (let j = ny - 1; j > 0; j--) loop.push([0, j]);
    const tris = loop.length * 2 + (nx - 1) * 2;
    const p = new Float32Array(tris * 9);
    let o = 0;
    const v = (x: number, y: number, h: number) => {
      const q = map(x, y, h);
      p[o++] = q[0];
      p[o++] = q[1];
      p[o++] = q[2];
    };
    for (let k = 0; k < loop.length; k++) {
      const [ai, aj] = loop[k];
      const [bi, bj] = loop[(k + 1) % loop.length];
      const ax = X(ai), ay = Y(aj), az = z[aj * nx + ai];
      const bx = X(bi), by = Y(bj), bz = z[bj * nx + bi];
      // outward-facing quad: a_bottom, b_bottom, b_top / a_bottom, b_top, a_top
      v(ax, ay, 0); v(bx, by, 0); v(bx, by, bz);
      v(ax, ay, 0); v(bx, by, bz); v(ax, ay, az);
    }
    // back (facing away), one strip per column so it follows a bend
    for (let i = 0; i < nx - 1; i++) {
      const a = X(i), b = X(i + 1);
      v(a, -H / 2, 0); v(b, H / 2, 0); v(b, -H / 2, 0);
      v(a, -H / 2, 0); v(a, H / 2, 0); v(b, H / 2, 0);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(p, 3));
    geom.computeVertexNormals(); // non-indexed: flat normals per triangle
    if (!this.skirt) {
      this.skirt = new THREE.Mesh(geom, this.material);
      this.scene.add(this.skirt);
    } else {
      this.skirt.geometry.dispose();
      this.skirt.geometry = geom;
    }
  }

  resetView() {
    // a standing part (curved, lamp) comes towards the camera by half its depth
    const d = (Math.max(this.size.w, this.size.h) / (2 * Math.tan((this.camera.fov * Math.PI) / 360))) * 1.25 + this.size.d / 2;
    this.camera.position.set(0, -d * 0.12, d);
    this.camera.near = d / 100;
    this.camera.far = d * 10;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    this.requestRender();
  }

  private resize() {
    const r = this.host.getBoundingClientRect();
    const w = Math.max(1, r.width);
    const h = Math.max(1, r.height);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  private pending = false;
  requestRender() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.render();
    });
  }

  private render() {
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.ro.disconnect();
    this.renderer.dispose();
  }
}
