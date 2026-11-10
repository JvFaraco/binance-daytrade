// IndexedDB mínimo: um banco, dois armazéns (candles por par e mês; valores avulsos com validade).
// Se o navegador não deixar usar IndexedDB (modo privado restrito), tudo segue só em memória.

const DB_NAME = "binance-daytrade-web";
const DB_VERSION = 1;
export const STORE_KLINES = "klines5m";
export const STORE_KV = "kv";

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_KLINES)) db.createObjectStore(STORE_KLINES);
        if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

const memory = new Map<string, unknown>();

export async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await open();
  if (!db) return memory.get(store + "|" + key) as T | undefined;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(store, "readonly").objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

export async function idbSet(store: string, key: string, value: unknown): Promise<void> {
  const db = await open();
  if (!db) {
    memory.set(store + "|" + key, value);
    return;
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function idbAvailable(): Promise<boolean> {
  return (await open()) !== null;
}
