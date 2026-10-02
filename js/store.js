// Local-first storage on IndexedDB. Two stores:
//   kv      — settings, tags, misc (key -> value)
//   flights — flight records (keyPath "id"), used from M2 on.

const DB_NAME = "contrail";
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("flights")) {
        const s = db.createObjectStore("flights", { keyPath: "id" });
        s.createIndex("startedAt", "startedAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((err) => {
    console.warn("IndexedDB unavailable, falling back to memory", err);
    return null;
  });
  return dbPromise;
}

const memory = new Map();

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result && "result" in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function kvGet(key, fallback) {
  const db = await open();
  if (!db) return memory.has(key) ? memory.get(key) : fallback;
  const v = await tx(db, "kv", "readonly", (s) => s.get(key));
  return v === undefined ? fallback : v;
}

export async function kvSet(key, value) {
  const db = await open();
  if (!db) { memory.set(key, value); return; }
  await tx(db, "kv", "readwrite", (s) => s.put(value, key));
}

export async function flightsPut(record) {
  const db = await open();
  if (!db) return;
  await tx(db, "flights", "readwrite", (s) => s.put(record));
}

export async function flightsAll() {
  const db = await open();
  if (!db) return [];
  return (await tx(db, "flights", "readonly", (s) => s.getAll())) || [];
}
