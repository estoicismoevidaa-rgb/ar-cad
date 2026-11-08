/*
 * Carregamento do modelo (GLB) + otimização para celular + seleção de peças.
 *
 * Regra de ouro: NENHUMA operação aqui altera a escala da geometria.
 *  - "Assentar no chão" só TRANSLADA o modelo (base do bbox em y=0, centro em x=z=0).
 *  - "Eixo vertical Z" só ROTACIONA 90° (não altera distâncias).
 *  - A fusão de malhas copia vértices com a matriz do nó (rotação+translação do CAD,
 *    que é rígida) e mantém uma tabela de faixas de triângulos → peça, para a seleção.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const LIMITE_MALHAS_SEM_FUSAO = 150;

export async function carregarGlb(bytes) {
  const buf = bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
  const gltf = await new Promise((ok, erro) => new GLTFLoader().parse(buf, '', ok, erro));
  const cad = (gltf.asset && gltf.asset.extras && gltf.asset.extras.cad) || null;
  return { cena: gltf.scene, cad };
}

/**
 * Prepara o modelo para exibição. Retorna:
 *  { raiz (Group com o modelo assentado), pecas[], tamanhoM (Vector3), seletor(intersecao)→peca, destacar(peca), descartar() }
 */
export function prepararModelo(cena, opcoes) {
  opcoes = opcoes || {};
  const raiz = new THREE.Group(); raiz.name = 'raiz-modelo';
  const conteudo = new THREE.Group(); conteudo.name = 'conteudo';
  raiz.add(conteudo);
  conteudo.add(cena);

  if (opcoes.eixoVertical === 'Z') cena.rotation.x = -Math.PI / 2;   // Z-up → Y-up (rígido)
  cena.updateMatrixWorld(true);

  // Lista de peças (cada mesh do GLB = um corpo/componente do CAD)
  const malhas = [];
  cena.traverse(o => { if (o.isMesh) malhas.push(o); });
  const pecas = malhas.map((m, i) => ({
    id: i, nome: nomePeca(m), malhaOriginal: m,
    box: new THREE.Box3().setFromObject(m)
  }));

  // Material: preserva a cor do CAD; liga double-side (CAD exporta superfícies abertas)
  const cacheMat = new Map();
  malhas.forEach(m => {
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    mats.forEach(mt => { if (mt) { mt.side = THREE.DoubleSide; if (!cacheMat.has(mt.uuid)) cacheMat.set(mt.uuid, mt); } });
  });

  let seletor, destacar, objetosRaycast;
  const destaque = new THREE.Group(); destaque.name = 'destaque'; conteudo.add(destaque);
  const matDestaque = new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.55, depthTest: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });

  if (malhas.length > LIMITE_MALHAS_SEM_FUSAO && !opcoes.semFusao) {
    // ---------- Fusão por material (reduz draw calls de milhares para dezenas) ----------
    const grupos = new Map();   // material.uuid → { mat, partes:[{peca, geo}] }
    pecas.forEach(p => {
      const m = p.malhaOriginal;
      const geo = m.geometry.index ? m.geometry : m.geometry.toNonIndexed();
      const grupoGeo = m.geometry.groups && m.geometry.groups.length && Array.isArray(m.material) ? m.geometry.groups : [{ start: 0, count: (geo.index ? geo.index.count : geo.attributes.position.count), materialIndex: 0 }];
      grupoGeo.forEach(gr => {
        const mat = Array.isArray(m.material) ? m.material[gr.materialIndex] : m.material;
        if (!grupos.has(mat.uuid)) grupos.set(mat.uuid, { mat, partes: [] });
        grupos.get(mat.uuid).partes.push({ peca: p, geo, matriz: m.matrixWorld.clone(), start: gr.start, count: gr.count });
      });
    });
    const fundidas = [];
    grupos.forEach(({ mat, partes }) => {
      let nV = 0, nI = 0;
      partes.forEach(pt => { nV += pt.geo.attributes.position.count; nI += pt.count; });
      const pos = new Float32Array(nV * 3), nor = new Float32Array(nV * 3);
      const idx = nV > 65535 ? new Uint32Array(nI) : new Uint16Array(nI);
      const faixas = [];   // [triInicio, triFim, pecaId]
      let oV = 0, oI = 0; const v = new THREE.Vector3(); const nm = new THREE.Matrix3();
      partes.forEach(pt => {
        const P = pt.geo.attributes.position, N = pt.geo.attributes.normal; nm.getNormalMatrix(pt.matriz);
        for (let i = 0; i < P.count; i++) {
          v.fromBufferAttribute(P, i).applyMatrix4(pt.matriz); pos.set([v.x, v.y, v.z], (oV + i) * 3);
          if (N) { v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); nor.set([v.x, v.y, v.z], (oV + i) * 3); }
        }
        const I = pt.geo.index;
        for (let k = 0; k < pt.count; k++) idx[oI + k] = (I ? I.getX(pt.start + k) : pt.start + k) + oV;
        faixas.push([oI / 3, (oI + pt.count) / 3 - 1, pt.peca.id]);
        oV += P.count; oI += pt.count;
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeBoundingBox(); g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, mat); mesh.userData.faixas = faixas; mesh.name = 'fundida:' + mat.name;
      fundidas.push(mesh);
    });
    // Substitui a cena original pelas malhas fundidas (libera a memória das originais)
    conteudo.remove(cena);
    malhas.forEach(m => { m.geometry.dispose(); });
    const fusao = new THREE.Group(); fusao.name = 'modelo-fundido';
    fundidas.forEach(f => fusao.add(f));
    conteudo.add(fusao);
    pecas.forEach(p => { p.malhaOriginal = null; });
    objetosRaycast = fundidas;

    seletor = (hit) => {
      const f = hit.object.userData.faixas; if (!f) return null;
      const t = hit.faceIndex; let a = 0, b = f.length - 1;
      while (a <= b) { const c = (a + b) >> 1; if (t < f[c][0]) b = c - 1; else if (t > f[c][1]) a = c + 1; else return pecas[f[c][2]]; }
      return null;
    };
    destacar = (peca) => {
      limparDestaque();
      if (!peca) return;
      fundidas.forEach(fm => {
        fm.userData.faixas.forEach(([t0, t1, pid]) => {
          if (pid !== peca.id) return;
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', fm.geometry.attributes.position);
          const I = fm.geometry.index; const sub = new Uint32Array((t1 - t0 + 1) * 3);
          for (let k = 0; k < sub.length; k++) sub[k] = I.getX(t0 * 3 + k);
          g.setIndex(new THREE.BufferAttribute(sub, 1));
          destaque.add(new THREE.Mesh(g, matDestaque));
        });
      });
    };
  } else {
    objetosRaycast = malhas;
    malhas.forEach((m, i) => { m.userData.pecaId = i; });
    seletor = (hit) => (hit.object.userData.pecaId !== undefined ? pecas[hit.object.userData.pecaId] : null);
    destacar = (peca) => {
      limparDestaque();
      if (!peca) return;
      const m = peca.malhaOriginal; const d = new THREE.Mesh(m.geometry, matDestaque);
      d.matrixAutoUpdate = false; d.matrix.copy(m.matrixWorld); destaque.add(d);
    };
  }

  function limparDestaque() {
    destaque.children.slice().forEach(c => { destaque.remove(c); if (c.geometry && c.geometry.index && c.geometry !== (c.userData.geoOriginal)) { /* geometria compartilhada: não descartar atributos */ } });
  }

  // Assentar: base do modelo no chão (y=0), centro em x=z=0. Só translação.
  conteudo.updateMatrixWorld(true);
  const caixa = new THREE.Box3().setFromObject(conteudo);
  const centro = caixa.getCenter(new THREE.Vector3());
  conteudo.position.set(-centro.x, -caixa.min.y, -centro.z);
  conteudo.updateMatrixWorld(true);
  const tamanhoM = caixa.getSize(new THREE.Vector3());

  function descartar() {
    raiz.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
    });
    matDestaque.dispose();
  }

  return {
    raiz, conteudo, pecas, tamanhoM, objetosRaycast,
    totalMalhasOriginais: malhas.length, fundido: malhas.length > LIMITE_MALHAS_SEM_FUSAO && !opcoes.semFusao,
    seletor, destacar, descartar,
    drawCalls: objetosRaycast.length
  };
}

function nomePeca(m) {
  // GLTFLoader pode renomear (ex.: "Peça_1"); sobe na hierarquia até achar um nome útil
  let o = m; const nomes = [];
  while (o && nomes.length < 3) { if (o.name && !/^(mesh|node|Object)_?\d*$/i.test(o.name)) nomes.push(o.name.replace(/_/g, ' ')); o = o.parent; }
  return nomes[0] || 'Peça sem nome';
}

/** Tamanho (mm) de uma peça na escala atual do modelo. */
export function tamanhoPecaMm(peca, escala) {
  const s = peca.box.getSize(new THREE.Vector3());
  return [s.x, s.y, s.z].map(v => v * 1000 * (escala || 1));
}

export function fmtMm(v) {
  if (v >= 1000) return (v / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + ' m';
  return v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' mm';
}

export function luzes(cena) {
  const h = new THREE.HemisphereLight(0xffffff, 0x666655, 1.6); cena.add(h);
  const d = new THREE.DirectionalLight(0xffffff, 1.8); d.position.set(3, 8, 4); cena.add(d);
  return { h, d };
}
