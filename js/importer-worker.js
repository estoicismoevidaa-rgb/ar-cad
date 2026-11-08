/*
 * Worker de importação CAD. Roda fora da thread da interface para o app não travar.
 * Lê STEP / IGES / BREP com OpenCascade (occt-import-js, WebAssembly) e devolve GLB.
 */
/* global occtimportjs, CadCore */
importScripts('../vendor/occt/occt-import-js.js', 'cad-core.js');

let occtPronto = null;
function occt() {
  if (!occtPronto) {
    occtPronto = occtimportjs({
      locateFile: (p) => new URL('../vendor/occt/' + p, self.location.href).href
    });
  }
  return occtPronto;
}

self.onmessage = async (ev) => {
  const { id, nome, formato, buffer, perfis } = ev.data;
  try {
    self.postMessage({ id, etapa: 'Carregando o motor OpenCascade…' });
    const o = await occt();
    const bytes = new Uint8Array(buffer);
    const saidas = {};
    for (const perfil of perfis) {
      self.postMessage({ id, etapa: `Triangulando (${perfil})… isso pode levar alguns minutos em montagens grandes.` });
      const res = o.ReadFile(formato, bytes, CadCore.PERFIS[perfil]);
      if (!res || !res.success) throw new Error('O OpenCascade não conseguiu ler o arquivo. Exporte novamente como STEP AP214.');
      if (!res.meshes || !res.meshes.length) throw new Error('O arquivo foi lido, mas não contém sólidos ou superfícies.');
      self.postMessage({ id, etapa: 'Gerando GLB…' });
      saidas[perfil] = CadCore.occtParaGlb(res, { nome, origem: nome, formato, perfil });
    }
    const transfer = Object.values(saidas).map(s => s.glb.buffer);
    self.postMessage({ id, ok: true, saidas }, transfer);
  } catch (e) {
    self.postMessage({ id, ok: false, erro: (e && e.message) || String(e) });
  }
};
