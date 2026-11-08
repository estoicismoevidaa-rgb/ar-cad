/*
 * Biblioteca local de projetos (IndexedDB, no próprio celular).
 *  - projetos: metadados (nome, pasta, categoria, dimensões, miniatura, histórico)
 *  - arquivos: os GLB (detalhe e, se houver, nível leve para carregamento progressivo)
 * Nada é enviado para servidor: os projetos ficam só no aparelho.
 */
const NOME_DB = 'arcad-inspetor';
const VERSAO = 1;
let dbp = null;

function abrir() {
  if (dbp) return dbp;
  dbp = new Promise((ok, erro) => {
    const r = indexedDB.open(NOME_DB, VERSAO);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('projetos')) db.createObjectStore('projetos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('arquivos')) db.createObjectStore('arquivos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('config')) db.createObjectStore('config', { keyPath: 'chave' });
    };
    r.onsuccess = () => {
      const db = r.result;
      // Safari (iOS) pode fechar a conexão sozinho (app em segundo plano, seletor de arquivos, memória).
      db.onclose = () => { dbp = null; };
      db.onversionchange = () => { try { db.close(); } catch (e) {} dbp = null; };
      ok(db);
    };
    r.onerror = () => { dbp = null; erro(r.error); };
    r.onblocked = () => { dbp = null; erro(new Error('Banco local bloqueado. Feche outras abas do app e tente de novo.')); };
  });
  return dbp;
}

function conexaoFechada(e) {
  const m = String((e && (e.name + ' ' + e.message)) || '');
  return /InvalidStateError|closing|closed|connection/i.test(m);
}

async function tx(store, modo, fn, tentativa = 0) {
  try {
    return await txUma(store, modo, fn);
  } catch (e) {
    if (tentativa < 2 && conexaoFechada(e)) {
      dbp = null;                                  // reabre a conexão e tenta de novo
      await new Promise(r => setTimeout(r, 150 * (tentativa + 1)));
      return tx(store, modo, fn, tentativa + 1);
    }
    throw e;
  }
}

function txUma(store, modo, fn) {
  return abrir().then(db => new Promise((ok, erro) => {
    let t;
    try { t = db.transaction(store, modo); } catch (e) { dbp = null; erro(e); return; }
    const s = t.objectStore(store);
    const req = fn(s);
    t.oncomplete = () => ok(req && req.result);
    t.onerror = () => erro(t.error);
    t.onabort = () => erro(t.error || new Error('Transação abortada (espaço de armazenamento cheio?)'));
  }));
}

export const db = {
  listarProjetos: () => tx('projetos', 'readonly', s => s.getAll()),
  obterProjeto: (id) => tx('projetos', 'readonly', s => s.get(id)),
  salvarProjeto: (p) => tx('projetos', 'readwrite', s => s.put(p)),
  excluirProjeto: async (id) => {
    await tx('projetos', 'readwrite', s => s.delete(id));
    await tx('arquivos', 'readwrite', s => s.delete(id));
  },
  obterArquivos: (id) => tx('arquivos', 'readonly', s => s.get(id)),
  async salvarArquivos(reg) {
    try {
      return await tx('arquivos', 'readwrite', s => s.put(reg));
    } catch (e) {
      // Safari às vezes recusa Blob grande no IndexedDB: tenta de novo gravando os bytes (ArrayBuffer).
      const comoBytes = async (b) => (b && b.arrayBuffer) ? await b.arrayBuffer() : b;
      const reg2 = { ...reg, glb: await comoBytes(reg.glb), glbLeve: await comoBytes(reg.glbLeve) };
      return tx('arquivos', 'readwrite', s => s.put(reg2));
    }
  },
  obterConfig: async (chave, padrao) => { const r = await tx('config', 'readonly', s => s.get(chave)); return r ? r.valor : padrao; },
  salvarConfig: (chave, valor) => tx('config', 'readwrite', s => s.put({ chave, valor })),
  async pedirPersistencia() {
    try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) {}
    return false;
  },
  async espaco() {
    try { if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate(); } catch (e) {}
    return null;
  }
};

/** Bytes de um arquivo salvo (Blob ou ArrayBuffer, conforme o navegador aceitou gravar). */
export async function bytesDe(x) {
  if (!x) return null;
  if (x.arrayBuffer) return new Uint8Array(await x.arrayBuffer());
  return new Uint8Array(x);
}

export function novoId() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
