// Removal history, stored only in this browser (IndexedDB). Never uploaded.
// Falls back to in-memory storage when IndexedDB is unavailable (some private modes).

import type { Edits } from './editor';

export interface HistoryItem {
  id: string;
  name: string; // Base name for downloads, e.g. "dog"
  createdAt: number;
  width: number; // Cutout size
  height: number;
  png: Blob; // Full-resolution cutout (unedited)
  thumb: Blob; // Small preview of the edited result for the grid
  original?: Blob; // Source photo, so the item can be re-processed later
  edits?: Edits;
  removed?: boolean; // false = base image is the plain photo (square/corners pages)
}

const DB_NAME = 'cutly';
const STORE = 'history';
export const MAX_ITEMS = 30;

// Stored form: raw bytes instead of Blobs, because WebKit's private-mode IndexedDB rejects Blobs.
interface StoredItem extends Omit<HistoryItem, 'png' | 'thumb' | 'original'> {
  png: ArrayBuffer;
  thumb: ArrayBuffer;
  thumbType: string;
  original?: ArrayBuffer;
  originalType?: string;
}

const fromStored = (s: StoredItem): HistoryItem => ({
  ...s,
  png: new Blob([s.png], { type: 'image/png' }),
  thumb: new Blob([s.thumb], { type: s.thumbType }),
  original: s.original ? new Blob([s.original], { type: s.originalType }) : undefined,
});

async function toStored(i: HistoryItem): Promise<StoredItem> {
  return {
    ...i,
    png: await i.png.arrayBuffer(),
    thumb: await i.thumb.arrayBuffer(),
    thumbType: i.thumb.type,
    original: i.original ? await i.original.arrayBuffer() : undefined,
    originalType: i.original?.type,
  };
}

let dbPromise: Promise<IDBDatabase | null> | null = null;
let memory: HistoryItem[] = []; // Fallback store.

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const newestFirst = (a: { createdAt: number }, b: { createdAt: number }) => b.createdAt - a.createdAt;

/** Items saved in IndexedDB, newest first. */
async function listStored(db: IDBDatabase): Promise<HistoryItem[]> {
  try {
    const all = ((await tx(db, 'readonly', (s) => s.getAll())) ?? []) as StoredItem[];
    return all.map(fromStored).sort(newestFirst);
  } catch {
    return [];
  }
}

/** Newest first. Items that didn't fit in storage live in memory for this session. */
export async function listHistory(): Promise<HistoryItem[]> {
  const db = await openDb();
  const stored = db ? await listStored(db) : [];
  return [...stored, ...memory.filter((m) => !stored.some((a) => a.id === m.id))].sort(newestFirst);
}

export async function deleteHistory(id: string): Promise<void> {
  memory = memory.filter((i) => i.id !== id);
  const db = await openDb();
  if (db) await tx(db, 'readwrite', (s) => s.delete(id)).catch(() => {});
}

export async function clearHistory(): Promise<void> {
  memory = [];
  const db = await openDb();
  if (db) await tx(db, 'readwrite', (s) => s.clear()).catch(() => {});
}

/** Save an item, dropping the oldest ones beyond MAX_ITEMS or when storage is full. */
export async function addHistory(item: HistoryItem): Promise<void> {
  const db = await openDb();
  if (!db) {
    memory = [item, ...memory].slice(0, MAX_ITEMS);
    return;
  }
  let items = await listStored(db);
  for (const old of items.slice(MAX_ITEMS - 1)) await deleteHistory(old.id);
  items = items.slice(0, MAX_ITEMS - 1);
  memory = memory.slice(0, Math.max(0, MAX_ITEMS - 1 - items.length));
  const record = await toStored(item);
  for (;;) {
    try {
      await tx(db, 'readwrite', (s) => s.put(record));
      return;
    } catch (err) {
      // Most likely QuotaExceededError: free space by removing the oldest item and retry.
      const oldest = items.pop();
      if (!oldest) {
        memory = [item, ...memory].slice(0, MAX_ITEMS); // Keep it for this session at least.
        console.warn('[cutly] could not save history item', err);
        return;
      }
      await deleteHistory(oldest.id);
    }
  }
}

/** Replace fields of an existing item (e.g. new edits, or a redone cutout). */
export async function updateHistory(id: string, patch: Partial<Omit<HistoryItem, 'id'>>): Promise<void> {
  const mem = memory.find((m) => m.id === id);
  if (mem) Object.assign(mem, patch);
  const db = await openDb();
  if (!db) return;
  try {
    const current = (await tx(db, 'readonly', (s) => s.get(id))) as StoredItem | undefined;
    if (!current) return;
    const record = await toStored({ ...fromStored(current), ...patch });
    await tx(db, 'readwrite', (s) => s.put(record));
  } catch (err) {
    console.warn('[cutly] could not update history item', err);
  }
}
