/**
 * IndexedDB layer cache.
 *
 * Caches fetched .gjbf + .grid buffers so repeated runs don't re-fetch.
 * Entries expire after 24h (configurable).
 */

const DB_NAME = "GeoJoinerCache";
const DB_VERSION = 1;
const STORE_NAME = "layers";

interface CacheEntry {
  key: string;
  gjbf?: ArrayBuffer;
  grid?: ArrayBuffer;
  expiry: number; // epoch ms
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("expiry", "expiry", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Default TTL: 24 hours */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export async function cacheLayer(
  key: string,
  data: { gjbf?: ArrayBuffer; grid?: ArrayBuffer },
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put({ key, gjbf: data.gjbf, grid: data.grid, expiry: Date.now() + ttlMs } satisfies CacheEntry);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Non-fatal — cache is a bonus
  }
}

export async function getCachedLayer(
  key: string,
): Promise<{ gjbf?: ArrayBuffer; grid?: ArrayBuffer } | null> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);
    const entry = await new Promise<CacheEntry | undefined>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();

    if (!entry) return null;
    if (Date.now() > entry.expiry) {
      // Expired — clean up async
      removeCachedLayer(key).catch(() => {});
      return null;
    }
    return { gjbf: entry.gjbf, grid: entry.grid };
  } catch {
    return null;
  }
}

async function removeCachedLayer(key: string): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(key);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch { /* non-fatal */ }
}
