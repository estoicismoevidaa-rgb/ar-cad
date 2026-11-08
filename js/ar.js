/*
 * Sessão de Realidade Aumentada (WebXR "immersive-ar" → ARCore no Android).
 *
 * O que é usado do dispositivo (nada é simulado):
 *  - Rastreamento 6DoF (SLAM visual-inercial do ARCore): posição e orientação reais do celular.
 *  - Hit-test: raio da câmera contra superfícies detectadas (planos/pontos) → onde está o chão.
 *  - Anchors (âncoras espaciais): ponto fixo do mundo que o ARCore corrige continuamente
 *    conforme refina o mapa. O modelo fixado é desenhado na pose da âncora a cada quadro.
 *  - DOM Overlay: os controles HTML ficam por cima da imagem da câmera.
 *
 * Escala: 1 unidade = 1 metro no WebXR e no glTF. O modelo é desenhado com escala 1,0.
 * A escala só muda se o usuário AUTORIZAR explicitamente (e fica destacada em vermelho).
 */
import * as THREE from 'three';
import { luzes, ambiente, fmtMm, tamanhoPecaMm } from './modelo.js';

export const ESTADO = { POSICIONANDO: 'posicionando', FIXADO: 'fixado' };

export async function verificarSuporteAR() {
  if (!window.isSecureContext) return { ok: false, motivo: 'A câmera AR exige HTTPS. Abra o app pelo endereço https:// (ex.: GitHub Pages).' };
  if (!navigator.xr) return { ok: false, motivo: 'Este navegador não tem WebXR. Use o Google Chrome atualizado no Android, com o "Google Play Services para RA" (ARCore) instalado.' };
  try {
    const ok = await navigator.xr.isSessionSupported('immersive-ar');
    return ok ? { ok: true } : { ok: false, motivo: 'Este celular/navegador não suporta AR imersiva. Verifique se o aparelho está na lista de dispositivos compatíveis com ARCore e se o "Google Play Services para RA" está instalado e atualizado.' };
  } catch (e) { return { ok: false, motivo: 'Falha ao consultar WebXR: ' + e.message }; }
}

export class SessaoAR {
  /**
   * @param {HTMLElement} overlay  raiz do DOM overlay (controles por cima da câmera)
   * @param {object} ui            callbacks: estado(e), rastreamento(s), info(obj), peca(p), medida(m), fim()
   */
  constructor(overlay, ui) {
    this.overlay = overlay; this.ui = ui;
    this.estado = ESTADO.POSICIONANDO;
    this.yaw = 0; this.escala = 1; this.visivel = true;
    this.ancora = null; this.ancorasSuportadas = false; this.pedidoFixar = false;
    this.rastreamento = 'iniciando';
    this.modoToque = 'inspecionar';  // 'inspecionar' | 'medir-modelo'
    this.pontosMedida = []; this.trena = [];
    this.ultimoHit = null; this.ultimaPoseCamera = null;
    this._tInfo = 0;
  }

  async iniciar(modelo, cad) {
    this.modelo = modelo; this.cad = cad;
    const canvas = document.createElement('canvas'); canvas.className = 'xr-canvas';
    document.body.appendChild(canvas); this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { xrCompatible: true, antialias: true, alpha: true });
    const r = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true, alpha: true });
    r.setPixelRatio(1); r.outputColorSpace = THREE.SRGBColorSpace;
    r.xr.enabled = true; r.xr.setReferenceSpaceType('local');
    this.renderer = r;

    // Tenta da configuração mais completa para a mais simples (alguns aparelhos recusam uma feature)
    const configs = [
      { requiredFeatures: ['hit-test'], optionalFeatures: ['anchors', 'dom-overlay', 'local-floor'], domOverlay: { root: this.overlay } },
      { optionalFeatures: ['hit-test', 'anchors', 'dom-overlay'], domOverlay: { root: this.overlay } },
      { optionalFeatures: ['hit-test'] },
      {}
    ];
    let sessao = null, ultimoErro = null;
    for (const c of configs) {
      try { sessao = await navigator.xr.requestSession('immersive-ar', c); break; }
      catch (e) { ultimoErro = e; console.warn('AR config recusada', c, e); }
    }
    if (!sessao) {
      const err = new Error((ultimoErro && ultimoErro.message ? ultimoErro.message + ' ' : '') +
        '— O Chrome não conseguiu abrir o ARCore. Instale/atualize "Serviços do Google Play para RA" na Play Store e confirme se o modelo do celular está na lista de aparelhos compatíveis com ARCore.');
      throw err;
    }
    this.sessao = sessao;
    if (this.modoEconomia) r.xr.setFramebufferScaleFactor(0.75);
    await r.xr.setSession(sessao);
    this.ref = r.xr.getReferenceSpace();
    this.viewerSpace = await sessao.requestReferenceSpace('viewer');
    try { this.hitSource = await sessao.requestHitTestSource({ space: this.viewerSpace }); }
    catch (e) { this.hitSource = null; console.warn('hit-test indisponível', e); }
    const feats = sessao.enabledFeatures;  // Chrome informa as features realmente ativas
    this.ancorasSuportadas = feats ? feats.includes('anchors') : (typeof XRFrame !== 'undefined' && 'createAnchor' in XRFrame.prototype);
    this.overlayAtivo = feats ? feats.includes('dom-overlay') : !!sessao.domOverlayState;

    // Cena
    const cena = new THREE.Scene(); this.cena = cena; luzes(cena); if (this.renderer) ambiente(this.renderer, cena);
    this.camera = new THREE.PerspectiveCamera();
    this.reticulo = this._criarReticulo(); cena.add(this.reticulo);
    this.ancoraGrupo = new THREE.Group(); this.ancoraGrupo.matrixAutoUpdate = false; cena.add(this.ancoraGrupo);
    this.pivo = new THREE.Group(); this.ancoraGrupo.add(this.pivo);
    this.pivo.add(modelo.raiz);
    this.contorno = this._criarContornoChao(); this.pivo.add(this.contorno);
    this.marcadores = new THREE.Group(); cena.add(this.marcadores);
    this.raycaster = new THREE.Raycaster();

    sessao.addEventListener('select', (ev) => this._aoTocar(ev));
    sessao.addEventListener('end', () => this._aoEncerrar());
    sessao.addEventListener('visibilitychange', () => {
      if (sessao.visibilityState !== 'visible') this._mudarRastreamento('pausado');
    });
    // Toques nos botões do overlay não devem virar "select" na cena
    this.overlay.addEventListener('beforexrselect', (e) => { if (e.target.closest('[data-ui]')) e.preventDefault(); });
    this._gestos();

    this.ui.estado && this.ui.estado(this.estado, this);
    r.setAnimationLoop((t, frame) => this._quadro(t, frame));
  }

  // ---------------- laço por quadro ----------------
  _quadro(t, frame) {
    if (!frame) return;
    const pose = frame.getViewerPose(this.ref);
    if (!pose) this._mudarRastreamento('perdido');
    else if (pose.emulatedPosition) this._mudarRastreamento('limitado');
    else this._mudarRastreamento('ok');
    if (pose) this.ultimaPoseCamera = pose.transform;

    // Hit-test contínuo (retículo e posicionamento)
    const hits = this.hitSource ? frame.getHitTestResults(this.hitSource) : [];
    if (hits.length && pose) {
      const hp = hits[0].getPose(this.ref);
      this.ultimoHit = hp.transform;
      this.reticulo.visible = true;
      this.reticulo.matrix.fromArray(hp.transform.matrix);
    } else {
      this.reticulo.visible = false;
    }

    // Aparelho sem hit-test: coloca o modelo 2 m à frente, com o chão estimado 1,4 m abaixo do celular
    if (!this.hitSource && pose && !this._jaPosicionou && this.estado === ESTADO.POSICIONANDO) {
      const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
      const pos = new THREE.Vector3().setFromMatrixPosition(m);
      const frente = new THREE.Vector3(0, 0, -1).transformDirection(m); frente.y = 0;
      if (frente.lengthSq() < 1e-6) frente.set(0, 0, -1); frente.normalize();
      const alvo = pos.clone().addScaledVector(frente, 2.0); alvo.y = pos.y - 1.4;
      this.ancoraGrupo.matrix.makeTranslation(alvo.x, alvo.y, alvo.z);
      this._jaPosicionou = true; this.semHitTest = true;
    }

    if (this.estado === ESTADO.POSICIONANDO) {
      if (this.ultimoHit && this.reticulo.visible) {
        const p = this.ultimoHit.position;
        this.ancoraGrupo.matrix.makeTranslation(p.x, p.y, p.z);
        this.ancoraGrupo.visible = this.visivel;
      } else if (!this._jaPosicionou) {
        this.ancoraGrupo.visible = false;  // ainda sem superfície: não desenha "flutuando"
      }
      if (this.ultimoHit && this.reticulo.visible) this._jaPosicionou = true;

      if (this.pedidoFixar && this._jaPosicionou) {
        this.pedidoFixar = false;
        this._criarAncora(frame);
      }
    } else if (this.estado === ESTADO.FIXADO) {
      if (this.ancora) {
        const ap = frame.getPose(this.ancora.anchorSpace, this.ref);
        if (ap) { this.ancoraGrupo.matrix.fromArray(ap.transform.matrix); this.ancoraPerdida = false; }
        else this.ancoraPerdida = true;   // mantém a última pose conhecida até o ARCore relocalizar
      }
      // sem suporte a âncoras: a matriz permanece fixa no espaço de referência "local" (também ancorado ao mundo pelo SLAM)
    }

    this.pivo.rotation.y = this.yaw;
    this.pivo.scale.setScalar(this.escala);
    this.ancoraGrupo.visible = this.visivel && (this._jaPosicionou || this.estado === ESTADO.FIXADO);
    this.reticulo.visible = this.reticulo.visible && (this.estado === ESTADO.POSICIONANDO || this.modoTrena);

    if (t - this._tInfo > 400) { this._tInfo = t; this._emitirInfo(); }
    this.renderer.render(this.cena, this.camera);
  }

  async _criarAncora(frame) {
    const m = this.ancoraGrupo.matrix; const p = new THREE.Vector3().setFromMatrixPosition(m);
    this.estado = ESTADO.FIXADO;
    if (this.ancorasSuportadas && frame.createAnchor) {
      try {
        // Âncora com orientação neutra (eixo Y = vertical do mundo); o giro do usuário fica no pivô.
        const pose = new XRRigidTransform({ x: p.x, y: p.y, z: p.z }, { x: 0, y: 0, z: 0, w: 1 });
        this.ancora = await frame.createAnchor(pose, this.ref);
        this.tipoFixacao = 'ancora';
      } catch (e) {
        this.ancora = null; this.tipoFixacao = 'espaco';
      }
    } else {
      this.tipoFixacao = 'espaco';
    }
    this.ui.estado && this.ui.estado(this.estado, this);
  }

  // ---------------- comandos ----------------
  fixar() { if (this.estado === ESTADO.POSICIONANDO) { if (!this._jaPosicionou) return false; this.pedidoFixar = true; return true; } return false; }
  desafixar() {
    if (this.ancora) { try { this.ancora.delete(); } catch (e) {} this.ancora = null; }
    this.estado = ESTADO.POSICIONANDO; this.tipoFixacao = null;
    this.ui.estado && this.ui.estado(this.estado, this);
  }
  reiniciar() { this.desafixar(); this.yaw = this._yawDaCamera(); this.escala = 1; this.ui.escala && this.ui.escala(1); this.limparMedidas(); }
  girar(graus) { if (this.estado === ESTADO.POSICIONANDO) this.yaw += THREE.MathUtils.degToRad(graus); }
  definirEscala(e) { this.escala = e; }
  alternarVisivel() { this.visivel = !this.visivel; return this.visivel; }
  encerrar() { if (this.sessao) this.sessao.end(); }

  /** Trena no mundo real: marca um ponto na superfície sob o retículo. */
  marcarPontoTrena() {
    if (!this.ultimoHit || !this.reticulo.visible) return null;
    const p = new THREE.Vector3(this.ultimoHit.position.x, this.ultimoHit.position.y, this.ultimoHit.position.z);
    this.trena.push(p); this._marcador(p, 0xffb300);
    if (this.trena.length === 2) {
      const d = this.trena[0].distanceTo(this.trena[1]) * 1000;
      this._linha(this.trena[0], this.trena[1], 0xffb300);
      const r = { tipo: 'trena', mm: d }; this.trena = []; this.ui.medida && this.ui.medida(r); return r;
    }
    return { tipo: 'trena', parcial: true };
  }
  limparMedidas() {
    this.marcadores.children.slice().forEach(c => { this.marcadores.remove(c); c.geometry && c.geometry.dispose(); });
    this.pontosMedida = []; this.trena = [];
  }

  // ---------------- toque na cena (select do WebXR) ----------------
  _aoTocar(ev) {
    if (!this.ref) return;
    const pose = ev.frame.getPose(ev.inputSource.targetRaySpace, this.ref);
    if (!pose) return;
    const o = pose.transform.position, q = pose.transform.orientation;
    const origem = new THREE.Vector3(o.x, o.y, o.z);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
    this.raycaster.set(origem, dir); this.raycaster.near = 0.01; this.raycaster.far = 200;
    this.cena.updateMatrixWorld(true);
    const hit = this.visivel ? this.raycaster.intersectObjects(this.modelo.objetosRaycast, false)[0] : null;

    if (this.modoToque === 'medir-modelo') {
      if (!hit) return;
      this.pontosMedida.push(hit.point.clone()); this._marcador(hit.point, 0x00e5ff);
      if (this.pontosMedida.length === 2) {
        const [a, b] = this.pontosMedida;
        // distância em coordenadas do MODELO (desfaz a escala de exibição) = medida de projeto
        const dMundo = a.distanceTo(b); const dProjeto = dMundo / this.escala;
        this._linha(a, b, 0x00e5ff);
        this.ui.medida && this.ui.medida({ tipo: 'modelo', mm: dProjeto * 1000, mmExibido: dMundo * 1000 });
        this.pontosMedida = [];
      }
      return;
    }
    // inspecionar: identifica a peça tocada
    if (!hit) { this.modelo.destacar(null); this.ui.peca && this.ui.peca(null); return; }
    const peca = this.modelo.seletor(hit);
    this.modelo.destacar(peca);
    if (peca) {
      const cam = this.ultimaPoseCamera ? new THREE.Vector3(this.ultimaPoseCamera.position.x, this.ultimaPoseCamera.position.y, this.ultimaPoseCamera.position.z) : origem;
      this.ui.peca && this.ui.peca({ nome: peca.nome, tamanhoMm: tamanhoPecaMm(peca, 1), distanciaM: cam.distanceTo(hit.point) });
    }
  }

  // ---------------- gestos no overlay ----------------
  _gestos() {
    let x0 = null;
    const zona = this.overlay.querySelector('[data-zona-gesto]') || this.overlay;
    zona.addEventListener('touchstart', (e) => { if (e.touches.length === 1 && !e.target.closest('[data-ui]')) x0 = e.touches[0].clientX; }, { passive: true });
    zona.addEventListener('touchmove', (e) => {
      if (x0 === null || this.estado !== ESTADO.POSICIONANDO) return;
      const x = e.touches[0].clientX; this.yaw += (x - x0) * 0.008; x0 = x;
    }, { passive: true });
    zona.addEventListener('touchend', () => { x0 = null; }, { passive: true });
  }

  // ---------------- informação contínua (escala, distância, rastreamento) ----------------
  _emitirInfo() {
    if (!this.ui.info) return;
    const caixa = new THREE.Box3().setFromObject(this.modelo.conteudo);
    const exib = caixa.getSize(new THREE.Vector3());  // tamanho no MUNDO (já com yaw e escala)
    // tamanho no referencial do modelo = medida exibida sem a rotação do pivô
    const proj = this.modelo.tamanhoM;
    let distancia = null;
    if (this.ultimaPoseCamera && this._jaPosicionou) {
      const c = this.ultimaPoseCamera.position; const cam = new THREE.Vector3(c.x, c.y, c.z);
      const pc = caixa.clampPoint(cam, new THREE.Vector3());
      distancia = cam.distanceTo(pc);
    }
    this.ui.info({
      escala: this.escala,
      projetoMm: [proj.x, proj.y, proj.z].map(v => v * 1000),
      exibidoMm: [proj.x, proj.y, proj.z].map(v => v * 1000 * this.escala),
      caixaMundoMm: [exib.x, exib.y, exib.z].map(v => v * 1000),
      distanciaM: distancia,
      fixacao: this.estado === ESTADO.FIXADO ? (this.tipoFixacao === 'ancora' ? (this.ancoraPerdida ? 'âncora (relocalizando…)' : 'âncora ARCore') : 'espaço de referência (sem âncora)') : 'posicionando',
      superficie: this.reticulo.visible,
      rastreamento: this.rastreamento,
      overlay: this.overlayAtivo
    });
  }

  _mudarRastreamento(s) {
    if (s === this.rastreamento) return;
    this.rastreamento = s; this.ui.rastreamento && this.ui.rastreamento(s);
  }

  _yawDaCamera() {
    if (!this.ultimaPoseCamera) return 0;
    const q = this.ultimaPoseCamera.orientation;
    const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w), 'YXZ');
    return e.y;
  }

  _criarReticulo() {
    const g = new THREE.RingGeometry(0.07, 0.09, 40).rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }));
    const c = new THREE.Mesh(new THREE.CircleGeometry(0.01, 16).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x00e5ff }));
    m.add(c); m.matrixAutoUpdate = false; m.visible = false; return m;
  }
  _criarContornoChao() {
    // Retângulo no chão com a projeção do modelo (ajuda a ver o espaço ocupado em tamanho real)
    const t = this.modelo.tamanhoM; const w = t.x / 2, d = t.z / 2;
    const pts = [[-w, 0.002, -d], [w, 0.002, -d], [w, 0.002, d], [-w, 0.002, d], [-w, 0.002, -d]].map(p => new THREE.Vector3(...p));
    return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x00e5ff }));
  }
  _marcador(p, cor) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.008, 12, 8), new THREE.MeshBasicMaterial({ color: cor, depthTest: false }));
    s.position.copy(p); s.renderOrder = 10; this.marcadores.add(s);
  }
  _linha(a, b, cor) {
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: cor, depthTest: false }));
    l.renderOrder = 10; this.marcadores.add(l);
  }

  _aoEncerrar() {
    this.renderer.setAnimationLoop(null);
    if (this.hitSource) { try { this.hitSource.cancel(); } catch (e) {} }
    if (this.ancora) { try { this.ancora.delete(); } catch (e) {} }
    this.limparMedidas();
    this.modelo.destacar(null);
    if (this.modelo.raiz.parent) this.modelo.raiz.parent.remove(this.modelo.raiz);
    this.renderer.dispose();
    this.canvas.remove();
    this.ui.fim && this.ui.fim();
  }
}

export { fmtMm };
