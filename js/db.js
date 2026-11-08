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
    r.onsuccess = () => ok(r.result);
    r.onerror = () => erro(r.error);
  });
  return dbp;
}

function tx(store, modo, fn) {
  return abrir().then(db => new Promise((ok, erro) => {
    const t = db.transaction(store, modo);
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
  salvarArquivos: (reg) => tx('arquivos', 'readwrite', s => s.put(reg)),
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

export function novoId() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
