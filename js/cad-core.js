/*
 * cad-core.js — núcleo de conversão CAD → GLB (glTF 2.0 binário).
 * Usado em três lugares com o MESMO código:
 *   1) Web Worker do app (importScripts)
 *   2) Conversor de linha de comando no PC (Node.js, require)
 *   3) Testes automatizados
 *
 * Entrada: resultado do occt-import-js (OpenCascade compilado para WebAssembly)
 *          lido com linearUnit = 'meter'  →  coordenadas já em METROS.
 * Saída:   GLB com:
 *   - um nó por componente da montagem (nome preservado, hierarquia preservada)
 *   - posições em float32, em metros (unidade oficial do glTF) — sem escala aplicada
 *   - cores das peças/faces vindas do STEP (XCAF) como materiais PBR
 *   - asset.extras.cad = metadados dimensionais (bbox em mm, contagens, origem)
 *
 * Precisão: float32 em metros tem resolução ≈ 0,5 µm até 8 m e ≈ 1 µm até 16 m.
 * Isso é muito abaixo da tolerância de fabricação; a geometria NÃO é reescalada.
 * A única aproximação é a triangulação das superfícies curvas (deflexão configurável).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CadCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Perfis de triangulação. Valores absolutos em METROS (linearUnit = meter).
  // 'detalhe' é o padrão para inspeção de perto; 'leve' é o nível grosseiro do LOD.
  const PERFIS = {
    leve:    { linearUnit: 'meter', linearDeflectionType: 'absolute_value', linearDeflection: 0.005,  angularDeflection: 1.0 },
    padrao:  { linearUnit: 'meter', linearDeflectionType: 'absolute_value', linearDeflection: 0.001,  angularDeflection: 0.5 },
    detalhe: { linearUnit: 'meter', linearDeflectionType: 'absolute_value', linearDeflection: 0.0003, angularDeflection: 0.3 }
  };

  function formatoPorNome(nome) {
    const ext = (nome.split('.').pop() || '').toLowerCase();
    if (ext === 'step' || ext === 'stp') return 'step';
    if (ext === 'iges' || ext === 'igs') return 'iges';
    if (ext === 'brep' || ext === 'brp') return 'brep';
    if (ext === 'sldprt' || ext === 'sldasm' || ext === 'slddrw') return 'solidworks-nativo';
    if (ext === 'stl') return 'stl';
    if (ext === 'obj') return 'obj';
    if (ext === 'glb') return 'glb';
    if (ext === 'gltf') return 'gltf';
    return 'desconhecido';
  }

  function corHex(c) {
    if (!c) return null;
    return c.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
  }

  /** Converte o resultado do occt-import-js em GLB. */
  function occtParaGlb(res, info) {
    info = info || {};
    if (!res || !res.success) throw new Error('O arquivo CAD não pôde ser lido (OpenCascade retornou falha).');

    const corPadrao = [0.62, 0.64, 0.68];
    const materiais = [];          // {key, color}
    const matIndex = new Map();
    function material(c) {
      const cc = c || corPadrao;
      const key = corHex(cc);
      if (!matIndex.has(key)) { matIndex.set(key, materiais.length); materiais.push({ key, color: cc }); }
      return matIndex.get(key);
    }

    // Buffer binário: lista de pedaços (cada um alinhado a 4 bytes)
    const pedacos = []; let offset = 0;
    const bufferViews = []; const accessors = [];
    function addView(typed, target) {
      const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
      const pad = (4 - (bytes.byteLength % 4)) % 4;
      bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, target });
      pedacos.push(bytes); if (pad) pedacos.push(new Uint8Array(pad));
      offset += bytes.byteLength + pad;
      return bufferViews.length - 1;
    }

    const gMin = [Infinity, Infinity, Infinity], gMax = [-Infinity, -Infinity, -Infinity];
    let totalTri = 0;
    const meshesGltf = [];
    const pecas = [];   // metadados por malha (para inspeção e lista de peças)

    res.meshes.forEach((m, mi) => {
      const pos = m.attributes.position.array;
      const P = pos instanceof Float32Array ? pos : Float32Array.from(pos);
      const N = m.attributes.normal ? Float32Array.from(m.attributes.normal.array) : null;
      const I = Uint32Array.from(m.index.array);
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) {
        const v = P[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v;
      }
      for (let k = 0; k < 3; k++) { gMin[k] = Math.min(gMin[k], mn[k]); gMax[k] = Math.max(gMax[k], mx[k]); }
      totalTri += I.length / 3;

      const pv = addView(P, 34962);
      accessors.push({ bufferView: pv, componentType: 5126, count: P.length / 3, type: 'VEC3', min: mn, max: mx });
      const posAcc = accessors.length - 1;
      let nAcc;
      if (N) { const nv = addView(N, 34962); accessors.push({ bufferView: nv, componentType: 5126, count: N.length / 3, type: 'VEC3' }); nAcc = accessors.length - 1; }

      // Primitivas: separa por cor de face quando o STEP traz cores por face
      const prims = [];
      const faces = m.brep_faces || [];
      const temCorFace = faces.some(f => f.color);
      if (temCorFace) {
        const grupos = new Map();   // cor → lista de triângulos
        faces.forEach(f => {
          const c = f.color || m.color || null; const k = corHex(c) || 'x';
          if (!grupos.has(k)) grupos.set(k, { c, tris: [] });
          grupos.get(k).tris.push([f.first, f.last]);
        });
        grupos.forEach(g => {
          let n = 0; g.tris.forEach(([a, b]) => n += (b - a + 1));
          const sub = new Uint32Array(n * 3); let o = 0;
          g.tris.forEach(([a, b]) => { sub.set(I.subarray(a * 3, (b + 1) * 3), o); o += (b - a + 1) * 3; });
          const iv = addView(sub, 34963);
          accessors.push({ bufferView: iv, componentType: 5125, count: sub.length, type: 'SCALAR' });
          const attrs = { POSITION: posAcc }; if (nAcc !== undefined) attrs.NORMAL = nAcc;
          prims.push({ attributes: attrs, indices: accessors.length - 1, material: material(g.c) });
        });
      } else {
        const iv = addView(I, 34963);
        accessors.push({ bufferView: iv, componentType: 5125, count: I.length, type: 'SCALAR' });
        const attrs = { POSITION: posAcc }; if (nAcc !== undefined) attrs.NORMAL = nAcc;
        prims.push({ attributes: attrs, indices: accessors.length - 1, material: material(m.color) });
      }
      const tamanhoMm = [0, 1, 2].map(k => +((mx[k] - mn[k]) * 1000).toFixed(2));
      meshesGltf.push({ name: m.name || ('Peça ' + (mi + 1)), primitives: prims });
      pecas.push({ indice: mi, nome: m.name || ('Peça ' + (mi + 1)), triangulos: I.length / 3, tamanhoMm, cor: corHex(m.color) });
    });

    // Hierarquia da montagem
    const nodes = [];
    function addNode(n) {
      const idx = nodes.length; const node = { name: n.name || '' }; nodes.push(node);
      const filhos = [];
      (n.meshes || []).forEach(mi => {
        const ci = nodes.length;
        nodes.push({ name: (res.meshes[mi].name || n.name || ('Peça ' + (mi + 1))), mesh: mi, extras: { pecaIndice: mi } });
        filhos.push(ci);
      });
      (n.children || []).forEach(c => filhos.push(addNode(c)));
      if (filhos.length) node.children = filhos;
      return idx;
    }
    const raiz = addNode(res.root || { name: 'Modelo', meshes: res.meshes.map((_, i) => i) });

    const tamanhoMm = [0, 1, 2].map(k => +((gMax[k] - gMin[k]) * 1000).toFixed(2));
    const gltf = {
      asset: {
        version: '2.0', generator: 'AR-CAD Inspetor (OpenCascade/occt-import-js)',
        extras: { cad: {
          unidadeArquivo: 'm (glTF)', origem: info.origem || '', formatoOrigem: info.formato || '',
          perfilTriangulacao: info.perfil || '', tamanhoMm, minM: gMin, maxM: gMax,
          totalTriangulos: totalTri, totalMalhas: res.meshes.length, pecas
        } }
      },
      scene: 0, scenes: [{ name: info.nome || 'Modelo', nodes: [raiz] }],
      nodes, meshes: meshesGltf,
      materials: materiais.map(m => ({ name: '#' + m.key, pbrMetallicRoughness: { baseColorFactor: [m.color[0], m.color[1], m.color[2], 1], metallicFactor: 0.35, roughnessFactor: 0.55 }, doubleSided: true })),
      accessors, bufferViews, buffers: [{ byteLength: offset }]
    };
    return { glb: montarGlb(gltf, pedacos, offset), resumo: gltf.asset.extras.cad };
  }

  function montarGlb(gltf, pedacos, binLen) {
    const enc = new TextEncoder();
    let json = enc.encode(JSON.stringify(gltf));
    const jPad = (4 - (json.length % 4)) % 4;
    const jsonLen = json.length + jPad;
    const total = 12 + 8 + jsonLen + 8 + binLen;
    const out = new Uint8Array(total); const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546C67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
    dv.setUint32(12, jsonLen, true); dv.setUint32(16, 0x4E4F534A, true);
    out.set(json, 20); for (let i = 0; i < jPad; i++) out[20 + json.length + i] = 0x20;
    let o = 20 + jsonLen;
    dv.setUint32(o, binLen, true); dv.setUint32(o + 4, 0x004E4942, true); o += 8;
    pedacos.forEach(p => { out.set(p, o); o += p.byteLength; });
    return out;
  }

  /** Lê o JSON de um GLB (para validar metadados sem carregar a geometria). */
  function lerJsonGlb(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (dv.getUint32(0, true) !== 0x46546C67) throw new Error('Não é um GLB válido.');
    const len = dv.getUint32(12, true);
    return JSON.parse(new TextDecoder().decode(u8.subarray(20, 20 + len)));
  }

  return { PERFIS, formatoPorNome, occtParaGlb, lerJsonGlb };
});
