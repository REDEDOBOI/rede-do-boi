// Armazenamento no aparelho (IndexedDB): cache dos dados, fila de envio e fotos/vídeos ainda não enviados.
const DB_NOME = 'rede-do-boi', DB_VER = 1;
let dbp;
function abrir() {
  if (!dbp) dbp = new Promise((ok, erro) => {
    const r = indexedDB.open(DB_NOME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('fila')) db.createObjectStore('fila', { keyPath: 'seq', autoIncrement: true });
      if (!db.objectStoreNames.contains('arquivos')) db.createObjectStore('arquivos');
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => erro(r.error);
  });
  return dbp;
}
async function tx(store, modo, fn) {
  const db = await abrir();
  return new Promise((ok, erro) => {
    const t = db.transaction(store, modo), s = t.objectStore(store);
    let res; const r = fn(s);
    if (r) r.onsuccess = () => { res = r.result; };
    t.oncomplete = () => ok(res);
    t.onerror = () => erro(t.error);
    t.onabort = () => erro(t.error);
  });
}
export const kv = {
  get: k => tx('kv', 'readonly', s => s.get(k)),
  set: (k, v) => tx('kv', 'readwrite', s => s.put(v, k)),
  del: k => tx('kv', 'readwrite', s => s.delete(k)),
};
// Fotos e vídeos são guardados como bytes (ArrayBuffer): no iPhone, um Blob guardado direto
// pode voltar vazio, e o envio falha com "No content provided".
export const arquivos = {
  get: async k => { const r = await tx('arquivos', 'readonly', s => s.get(k)); return r && r.buf ? new Blob([r.buf], { type: r.type || '' }) : r; },
  set: async (k, blob) => { const buf = await blob.arrayBuffer(); return tx('arquivos', 'readwrite', s => s.put({ buf, type: blob.type || '' }, k)); },
  del: k => tx('arquivos', 'readwrite', s => s.delete(k)),
};
export const fila = {
  todos: () => tx('fila', 'readonly', s => s.getAll()),
  add: item => tx('fila', 'readwrite', s => s.add(item)),
  put: item => tx('fila', 'readwrite', s => s.put(item)),
  del: seq => tx('fila', 'readwrite', s => s.delete(seq)),
  limpar: () => tx('fila', 'readwrite', s => s.clear()),
};
// Pede ao navegador para não apagar os dados do app quando faltar espaço.
export function pedirPersistencia() {
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
}
