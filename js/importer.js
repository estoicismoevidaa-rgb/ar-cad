/*
 * Importação de arquivos para a biblioteca.
 *  STEP/STP, IGES/IGS, BREP  → OpenCascade (worker) → GLB métrico
 *  STL, OBJ                  → three.js; o usuário informa a unidade (sem unidade no arquivo)
 *  GLB, GLTF                 → glTF já é métrico por especificação (metros)
 *  SLDPRT, SLDASM            → formato fechado; instrução de exportação
 */
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

/* global CadCore */
export const FATOR_UNIDADE = { mm: 0.001, cm: 0.01, m: 1, pol: 0.0254 };
export const LIMITE_STEP_CELULAR_MB = 20;

let worker = null; let seq = 0; const pendentes = new Map();
function obterWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./importer-worker.js', import.meta.url));
  worker.onmessage = (ev) => {
    const d = ev.data; const p = pendentes.get(d.id); if (!p) return;
    if (d.etapa) { p.progresso && p.progresso(d.etapa); return; }
    pendentes.delete(d.id);
    d.ok ? p.ok(d.saidas) : p.erro(new Error(d.erro));
  };
  worker.onerror = (e) => {
    pendentes.forEach(p => p.erro(new Error('O conversor travou (memória insuficiente?). Converta este arquivo no PC com o conversor e importe o GLB.')));
    pendentes.clear(); worker.terminate(); worker = null;
  };
  return worker;
}

function converterCadNoWorker(nome, formato, buffer, perfis, progresso) {
  const id = ++seq;
  return new Promise((ok, erro) => {
    pendentes.set(id, { ok, erro, progresso });
    obterWorker().postMessage({ id, nome, formato, buffer, perfis }, [buffer]);
  });
}

function exportarGlb(obj) {
  return new Promise((ok, erro) => new GLTFExporter().parse(obj, r => ok(new Uint8Array(r)), erro, { binary: true }));
}

function resumoDeObjeto(obj, extra) {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const s = box.getSize(new THREE.Vector3());
  let tri = 0, malhas = 0; const pecas = [];
  obj.traverse(o => {
    if (o.isMesh) {
      malhas++;
      const g = o.geometry; const n = g.index ? g.index.count / 3 : g.attributes.position.count / 3; tri += n;
      const b = new THREE.Box3().setFromObject(o); const bs = b.getSize(new THREE.Vector3());
      pecas.push({ indice: pecas.length, nome: o.name || ('Peça ' + (pecas.length + 1)), triangulos: n, tamanhoMm: [bs.x, bs.y, bs.z].map(v => +(v * 1000).toFixed(2)) });
    }
  });
  return Object.assign({ tamanhoMm: [s.x, s.y, s.z].map(v => +(v * 1000).toFixed(2)), totalTriangulos: tri, totalMalhas: malhas, pecas }, extra || {});
}

/** Aplica um fator de escala DIRETAMENTE nos vértices (unidade → metros). */
function assarEscala(obj, fator) {
  obj.updateMatrixWorld(true);
  obj.traverse(o => {
    if (o.isMesh) {
      o.geometry = o.geometry.clone();
      o.geometry.applyMatrix4(o.matrixWorld);
      o.geometry.scale(fator, fator, fator);
      o.position.set(0, 0, 0); o.rotation.set(0, 0, 0); o.scale.set(1, 1, 1);
      o.geometry.computeBoundingBox(); o.geometry.computeBoundingSphere();
    }
  });
  const g = new THREE.Group(); g.name = obj.name || 'Modelo';
  const meshes = []; obj.traverse(o => { if (o.isMesh) meshes.push(o); });
  meshes.forEach(m => g.add(m));
  return g;
}

/**
 * Importa um File. Retorna { glb, glbLeve?, resumo, formato, avisos[] }.
 * opcoes: { unidade: 'mm'|'cm'|'m'|'pol', perfil: 'padrao'|'detalhe', lod: bool, progresso(fn) }
 */
export async function importarArquivo(file, opcoes) {
  opcoes = opcoes || {};
  const formato = CadCore.formatoPorNome(file.name);
  const avisos = [];
  const progresso = opcoes.progresso || (() => {});

  if (formato === 'solidworks-nativo') {
    throw new Error('SLDPRT/SLDASM é um formato fechado da Dassault Systèmes e não pode ser lido fora do SolidWorks (nem por bibliotecas abertas). No SolidWorks use Arquivo › Salvar como › STEP AP214 (*.step) — ele preserva dimensões, cores, nomes e a árvore da montagem — e importe o STEP aqui.');
  }

  if (formato === 'step' || formato === 'iges' || formato === 'brep') {
    const mb = file.size / 1048576;
    if (mb > LIMITE_STEP_CELULAR_MB) avisos.push(`Arquivo de ${mb.toFixed(0)} MB: converter no celular pode demorar muito ou faltar memória. Recomendado: usar o conversor no PC e importar o GLB.`);
    progresso('Lendo arquivo…');
    const buf = await file.arrayBuffer();
    const perfis = opcoes.lod ? ['leve', opcoes.perfil || 'padrao'] : [opcoes.perfil || 'padrao'];
    const saidas = await converterCadNoWorker(file.name, formato, buf, perfis, progresso);
    const det = saidas[opcoes.perfil || 'padrao'];
    return {
      formato, avisos,
      glb: det.glb, glbLeve: saidas.leve ? saidas.leve.glb : null,
      resumo: Object.assign({ unidadeOrigem: 'unidade do STEP (convertida para metros pelo OpenCascade)' }, det.resumo)
    };
  }

  if (formato === 'stl' || formato === 'obj') {
    const unidade = opcoes.unidade || 'mm';
    const fator = FATOR_UNIDADE[unidade];
    progresso('Lendo malha…');
    let obj;
    if (formato === 'stl') {
      const geo = new STLLoader().parse(await file.arrayBuffer());
      if (!geo.attributes.normal) geo.computeVertexNormals();
      obj = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x9ea3ad, metalness: 0.35, roughness: 0.55 }));
      obj.name = file.name.replace(/\.[^.]+$/, '');
    } else {
      obj = new OBJLoader().parse(await file.text());
      obj.traverse(o => { if (o.isMesh && !o.material) o.material = new THREE.MeshStandardMaterial({ color: 0x9ea3ad }); });
    }
    const g = assarEscala(obj, fator);
    avisos.push(`${formato.toUpperCase()} não guarda unidade: foi interpretado em ${unidade}. Confira as dimensões abaixo.`);
    if (formato === 'stl') avisos.push('STL não tem cores, nomes de peças nem árvore de montagem. Para isso use STEP.');
    progresso('Gerando GLB…');
    const glb = await exportarGlb(g);
    return { formato, avisos, glb, glbLeve: null, resumo: resumoDeObjeto(g, { unidadeOrigem: unidade }) };
  }

  if (formato === 'glb' || formato === 'gltf') {
    progresso('Lendo glTF…');
    const loader = new GLTFLoader();
    const data = formato === 'glb' ? await file.arrayBuffer() : await file.text();
    const gltf = await new Promise((ok, erro) => loader.parse(data, '', ok, erro));
    const cena = gltf.scene;
    let glb;
    if (formato === 'glb') glb = new Uint8Array(data);
    else glb = await exportarGlb(cena);   // gltf com buffers embutidos → GLB
    const extrasCad = gltf.asset && gltf.asset.extras && gltf.asset.extras.cad;
    const resumo = extrasCad ? Object.assign({ unidadeOrigem: 'metros (glTF)' }, extrasCad) : resumoDeObjeto(cena, { unidadeOrigem: 'metros (glTF)' });
    const maior = Math.max(...resumo.tamanhoMm);
    if (maior > 100000) avisos.push('O modelo tem mais de 100 m. Provavelmente foi exportado em milímetros sem conversão. Ajuste a escala no projeto só se tiver certeza.');
    if (maior < 1) avisos.push('O modelo tem menos de 1 mm. Provavelmente foi exportado com unidade errada.');
    return { formato, avisos, glb, glbLeve: null, resumo };
  }

  throw new Error('Formato não suportado: ' + file.name + '. Use STEP, IGES, STL, OBJ, GLB ou GLTF.');
}
