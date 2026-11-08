/*
 * iPhone/iPad: realidade aumentada pelo AR Quick Look da Apple (ARKit).
 * O Safari não tem WebXR "immersive-ar"; o caminho nativo é abrir um arquivo USDZ
 * com <a rel="ar">. O USDZ é gerado aqui mesmo, a partir do modelo já carregado.
 *
 * Escala: a geometria do app está em METROS e o USDZExporter grava metersPerUnit = 1,
 * então 1 unidade = 1 m → tamanho real. "#allowsContentScaling=0" impede o usuário
 * de redimensionar com pinça dentro do Quick Look (fica travado em 100%).
 * Ancoragem: plano horizontal (chão), feita pelo próprio ARKit.
 */
import * as THREE from 'three';
import { USDZExporter } from 'three/addons/exporters/USDZExporter.js';

export function suportaQuickLook() {
  try {
    const a = document.createElement('a');
    if (a.relList && a.relList.supports && a.relList.supports('ar')) return true;
  } catch (e) { /* ignora */ }
  const ua = navigator.userAgent || '';
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios;
}

/** Monta uma cena só com as malhas visíveis do modelo, em metros, com materiais compatíveis com USDZ. */
export function cenaParaUsdz(modelo) {
  const cena = new THREE.Scene();
  modelo.raiz.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(modelo.raiz.matrixWorld).invert();
  const cacheMat = new Map();
  const conv = (m) => {
    if (cacheMat.has(m.uuid)) return cacheMat.get(m.uuid);
    const s = new THREE.MeshStandardMaterial({
      color: m.color ? m.color.clone() : new THREE.Color(0x9aa4ad),
      metalness: m.metalness != null ? m.metalness : 0.3,
      roughness: m.roughness != null ? m.roughness : 0.6,
      side: THREE.FrontSide
    });
    // Texturas (cor, normal, rugosidade/metálico, oclusão, emissão): sem elas o Quick Look mostra a peça branca,
    // porque em material texturizado a cor base costuma ser 1,1,1 e quem dá a cor é a textura.
    ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap'].forEach(k => { if (m[k]) s[k] = m[k]; });
    if (m.normalScale) s.normalScale.copy(m.normalScale);
    if (m.emissive) s.emissive.copy(m.emissive);
    if (m.transparent && m.opacity < 1) { s.transparent = true; s.opacity = m.opacity; }
    cacheMat.set(m.uuid, s); return s;
  };
  const ignorar = new Set();
  modelo.conteudo.children.forEach(c => { if (c.name === 'destaque') c.traverse(x => ignorar.add(x)); });
  modelo.conteudo.traverseVisible(o => {
    if (!o.isMesh || !o.geometry || ignorar.has(o) || o.userData.ajudante) return;
    let geo = o.geometry;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const lista = [];
    if (Array.isArray(o.material) && geo.groups && geo.groups.length) {
      geo.groups.forEach(g => lista.push({ geo: subGeometria(geo, g), mat: conv(mats[g.materialIndex] || mats[0]) }));
    } else lista.push({ geo, mat: conv(mats[0]) });
    lista.forEach(({ geo, mat }) => {
      if (!geo.attributes.normal) { geo = geo.clone(); geo.computeVertexNormals(); }
      const m = new THREE.Mesh(geo, mat);
      m.matrixAutoUpdate = false;
      m.matrix.multiplyMatrices(inv, o.matrixWorld);
      cena.add(m);
    });
  });
  cena.updateMatrixWorld(true);
  return cena;
}

function subGeometria(geo, g) {
  const nova = new THREE.BufferGeometry();
  for (const k in geo.attributes) nova.setAttribute(k, geo.attributes[k]);
  if (geo.index) {
    const idx = geo.index.array.slice(g.start, g.start + g.count);
    nova.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  return nova;
}

export async function gerarUsdz(modelo) {
  const cena = cenaParaUsdz(modelo);
  const exp = new USDZExporter();
  const bytes = await exp.parse(cena, { quickLookCompatible: true });
  return new Blob([bytes], { type: 'model/vnd.usdz+zip' });
}

/** Abre o AR Quick Look. Precisa ser chamado a partir de um toque do usuário. */
export function abrirQuickLook(blob, nome) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.setAttribute('rel', 'ar');
  a.setAttribute('download', (nome || 'modelo') + '.usdz');
  a.appendChild(document.createElement('img'));   // o Safari exige um <img> filho em <a rel="ar">
  a.href = url + '#allowsContentScaling=0';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); }, 1000);
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}
