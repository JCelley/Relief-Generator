import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type Finish = 'clay' | 'wood' | 'aluminum';

const FINISHES: Record<Finish, { color: number; roughness: number; metalness: number }> = {
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
  private material = new THREE.MeshStandardMaterial({ ...FINISHES.clay, flatShading: false });
  private size = { w: 100, h: 100 };
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
    this.material.color.setHex(FINISHES[f].color);
    this.material.roughness = FINISHES[f].roughness;
    this.material.metalness = FINISHES[f].metalness;
    this.requestRender();
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

  /** z: CAD-oriented heightfield (row 0 = bottom edge), in mm. */
  setHeightfield(z: Float32Array, nx: number, ny: number, widthMm: number, heightMm: number) {
    const sizeChanged = Math.abs(widthMm - this.size.w) > 1e-6 || Math.abs(heightMm - this.size.h) > 1e-6;
    this.size = { w: widthMm, h: heightMm };
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
    // PlaneGeometry rows go from top (iy=0) to bottom
    for (let iy = 0; iy < ny; iy++) {
      const j = ny - 1 - iy;
      for (let ix = 0; ix < nx; ix++) pos.setZ(iy * nx + ix, z[j * nx + ix]);
    }
    pos.needsUpdate = true;
    geom.computeVertexNormals();
    geom.computeBoundingSphere();
    this.placeLight();
    if (sizeChanged) this.resetView();
    this.requestRender();
  }

  resetView() {
    const d = Math.max(this.size.w, this.size.h) / (2 * Math.tan((this.camera.fov * Math.PI) / 360)) * 1.15;
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
