/*
 * Visualização 3D comum (sem câmera): pré-visualização, inspeção e geração de miniatura.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { luzes, ambiente } from './modelo.js';

export class Visualizador3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.cena = new THREE.Scene(); this.cena.background = new THREE.Color(0x14181f);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.005, 2000);
    this.controles = new OrbitControls(this.camera, canvas); this.controles.enableDamping = true;
    luzes(this.cena); ambiente(this.renderer, this.cena);
    this.grade = null; this.modelo = null; this.rodando = false;
    this.raycaster = new THREE.Raycaster();
    this._loop = this._loop.bind(this);
    new ResizeObserver(() => this.redimensionar()).observe(canvas);
  }
  redimensionar() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight; if (!w || !h) return;
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }
  mostrar(modelo) {
    if (this.modelo) this.cena.remove(this.modelo.raiz);
    if (this.grade) this.cena.remove(this.grade);
    this.modelo = modelo; this.cena.add(modelo.raiz);
    const t = modelo.tamanhoM; const maior = Math.max(t.x, t.y, t.z);
    // Grade de 1 m (ou 10 cm para peças pequenas) para referência de tamanho
    const passo = maior > 2 ? 1 : maior > 0.2 ? 0.1 : 0.01;
    const lado = Math.ceil((maior * 1.6) / passo) * passo;
    this.grade = new THREE.GridHelper(lado, Math.round(lado / passo), 0x3a4a5e, 0x26303d); this.cena.add(this.grade);
    this.controles.target.set(0, t.y / 2, 0);
    this.camera.position.set(maior * 1.1, maior * 0.8, maior * 1.3);
    this.camera.near = Math.max(0.001, maior / 2000); this.camera.far = maior * 50; this.camera.updateProjectionMatrix();
    this.controles.update();
    this.redimensionar();
    if (!this.rodando) { this.rodando = true; this.renderer.setAnimationLoop(this._loop); }
  }
  _loop() { this.controles.update(); this.renderer.render(this.cena, this.camera); }
  parar() { this.rodando = false; this.renderer.setAnimationLoop(null); }
  selecionar(evento) {
    if (!this.modelo) return null;
    const r = this.canvas.getBoundingClientRect();
    const p = new THREE.Vector2(((evento.clientX - r.left) / r.width) * 2 - 1, -((evento.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(p, this.camera);
    const hit = this.raycaster.intersectObjects(this.modelo.objetosRaycast, false)[0];
    if (!hit) return null;
    return { peca: this.modelo.seletor(hit), ponto: hit.point };
  }
  liberar() { this.parar(); if (this.modelo) this.cena.remove(this.modelo.raiz); this.modelo = null; }
}

/** Gera miniatura (data URL WebP/JPEG) do modelo. */
export function gerarMiniatura(modelo, largura = 360, altura = 240) {
  const canvas = document.createElement('canvas'); canvas.width = largura; canvas.height = altura;
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  r.outputColorSpace = THREE.SRGBColorSpace;
  const cena = new THREE.Scene(); cena.background = new THREE.Color(0x1c222b); luzes(cena); ambiente(r, cena);
  const pai = modelo.raiz.parent; cena.add(modelo.raiz);
  const t = modelo.tamanhoM; const maior = Math.max(t.x, t.y, t.z);
  const cam = new THREE.PerspectiveCamera(40, largura / altura, maior / 1000, maior * 20);
  cam.position.set(maior * 1.05, maior * 0.75, maior * 1.25); cam.lookAt(0, t.y / 2, 0);
  r.render(cena, cam);
  let url = canvas.toDataURL('image/webp', 0.8); if (!url.startsWith('data:image/webp')) url = canvas.toDataURL('image/jpeg', 0.82);
  cena.remove(modelo.raiz); if (pai) pai.add(modelo.raiz);
  r.dispose(); r.forceContextLoss();
  return url;
}
