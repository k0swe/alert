import { Injectable } from '@angular/core';
import { normalizePersonName } from './person-name';

const QRZ_ENDPOINT = 'https://xmldata.qrz.com/xml/current/';
const QRZ_USERNAME_KEY = 'qrz-username';
const QRZ_PASSWORD_KEY = 'qrz-password';
const QRZ_CACHE_KEY = 'qrz-directory-cache-v1';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const BATCH_DELAY_MS = 2_000;
const REQUEST_SPACING_MS = 1_000;

export interface QrzCredentials {
  username: string;
  password: string;
}

export interface QrzCallsign {
  callsign: string;
  state: string | null;
  country: string | null;
  name: string | null;
  grid: string | null;
}

interface CachedCallsign {
  cachedAt: number;
  record: QrzCallsign;
}

interface QrzCache {
  entries: Record<string, CachedCallsign>;
}

interface QueuedLookup {
  callsign: string;
  resolve: (record: QrzCallsign) => void;
  reject: (error: unknown) => void;
}

export class QrzLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QrzLookupError';
  }
}

@Injectable({ providedIn: 'root' })
export class QrzService {
  private sessionKey: string | null = null;
  private sessionPromise: Promise<string> | null = null;
  private readonly memoryCache = new Map<string, CachedCallsign>();
  private readonly pendingLookups = new Map<string, Promise<QrzCallsign>>();
  private readonly queue: QueuedLookup[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private processingQueue = false;

  getCredentials(): QrzCredentials {
    return {
      username: localStorage.getItem(QRZ_USERNAME_KEY) ?? '',
      password: localStorage.getItem(QRZ_PASSWORD_KEY) ?? '',
    };
  }

  hasCredentials(): boolean {
    const credentials = this.getCredentials();
    return Boolean(credentials.username && credentials.password);
  }

  setCredentials(credentials: QrzCredentials): void {
    localStorage.setItem(QRZ_USERNAME_KEY, credentials.username.trim());
    localStorage.setItem(QRZ_PASSWORD_KEY, credentials.password);
    this.resetSession();
    this.memoryCache.clear();
  }

  lookup(callsign: string): Promise<QrzCallsign> {
    const normalizedCallsign = callsign.trim().toUpperCase();
    const cached = this.getCached(normalizedCallsign);
    if (cached) {
      return Promise.resolve(cached);
    }

    const pending = this.pendingLookups.get(normalizedCallsign);
    if (pending) {
      return pending;
    }

    const lookup = new Promise<QrzCallsign>((resolve, reject) => {
      this.queue.push({ callsign: normalizedCallsign, resolve, reject });
    });
    this.pendingLookups.set(normalizedCallsign, lookup);
    this.scheduleBatch();
    return lookup;
  }

  reset(): void {
    this.resetSession();
    this.memoryCache.clear();
  }

  private scheduleBatch(): void {
    if (this.batchTimer || this.processingQueue) {
      return;
    }
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      void this.processQueue();
    }, BATCH_DELAY_MS);
  }

  private async processQueue(): Promise<void> {
    if (this.processingQueue) {
      return;
    }
    this.processingQueue = true;

    try {
      while (this.queue.length > 0) {
        const queued = this.queue.shift();
        if (!queued) {
          break;
        }

        try {
          const record = await this.lookupWithRetry(queued.callsign, true);
          this.storeCached(queued.callsign, record);
          queued.resolve(record);
        } catch (error) {
          queued.reject(error);
        } finally {
          this.pendingLookups.delete(queued.callsign);
        }

        if (this.queue.length > 0) {
          await this.delay(REQUEST_SPACING_MS);
        }
      }
    } finally {
      this.processingQueue = false;
      if (this.queue.length > 0) {
        this.scheduleBatch();
      }
    }
  }

  private async lookupWithRetry(callsign: string, allowRelogin: boolean): Promise<QrzCallsign> {
    const sessionKey = await this.getSessionKey();
    const document = await this.request({ s: sessionKey, callsign });
    const returnedKey = this.text(document, 'Session', 'Key');
    if (returnedKey) {
      this.sessionKey = returnedKey;
    }

    const callsignNode = document.getElementsByTagName('Callsign').item(0);
    if (callsignNode) {
      return {
        callsign: this.childText(callsignNode, 'call') ?? callsign,
        state: this.childText(callsignNode, 'state'),
        country: this.childText(callsignNode, 'country'),
        name: this.formatName(callsignNode),
        grid: this.childText(callsignNode, 'grid'),
      };
    }

    const error =
      this.text(document, 'Session', 'Error') ?? 'QRZ did not return a callsign record.';
    if (allowRelogin && this.isSessionError(error)) {
      this.resetSession();
      return this.lookupWithRetry(callsign, false);
    }
    throw new QrzLookupError(error);
  }

  private async getSessionKey(): Promise<string> {
    if (this.sessionKey) {
      return this.sessionKey;
    }

    if (!this.sessionPromise) {
      this.sessionPromise = this.login();
    }

    try {
      return await this.sessionPromise;
    } finally {
      this.sessionPromise = null;
    }
  }

  private async login(): Promise<string> {
    const credentials = this.getCredentials();
    if (!credentials.username || !credentials.password) {
      throw new QrzLookupError('Configure QRZ.com credentials to enable directory lookups.');
    }

    const document = await this.request({
      username: credentials.username,
      password: credentials.password,
      agent: 'k0swe-alert-0.1',
    });
    const key = this.text(document, 'Session', 'Key');
    if (!key) {
      throw new QrzLookupError(
        this.text(document, 'Session', 'Error') ?? 'QRZ.com did not return a session key.',
      );
    }
    this.sessionKey = key;
    return key;
  }

  private async request(parameters: Record<string, string>): Promise<Document> {
    let response: Response;
    try {
      response = await fetch(QRZ_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: new URLSearchParams(parameters),
      });
    } catch {
      throw new QrzLookupError('Unable to reach the QRZ.com directory service.');
    }

    if (!response.ok) {
      throw new QrzLookupError(`QRZ.com returned HTTP ${response.status}.`);
    }

    const document = new DOMParser().parseFromString(await response.text(), 'application/xml');
    if (document.getElementsByTagName('parsererror').length > 0) {
      throw new QrzLookupError('QRZ.com returned an invalid XML response.');
    }
    return document;
  }

  private getCached(callsign: string): QrzCallsign | null {
    const memoryEntry = this.memoryCache.get(callsign);
    if (memoryEntry && Date.now() - memoryEntry.cachedAt < CACHE_TTL_MS) {
      const record = this.normalizeCachedRecord(memoryEntry.record);
      memoryEntry.record = record;
      return record;
    }
    if (memoryEntry) {
      this.memoryCache.delete(callsign);
    }

    const cache = this.readCache();
    const entry = cache.entries[this.cacheEntryKey(callsign)];
    if (!entry) {
      return null;
    }
    if (Date.now() - entry.cachedAt >= CACHE_TTL_MS) {
      delete cache.entries[this.cacheEntryKey(callsign)];
      this.writeCache(cache);
      return null;
    }

    const record = this.normalizeCachedRecord(entry.record);
    if (record !== entry.record) {
      entry.record = record;
      this.writeCache(cache);
    }
    this.memoryCache.set(callsign, entry);
    return record;
  }

  private normalizeCachedRecord(record: QrzCallsign): QrzCallsign {
    if (!record.name) {
      return record;
    }
    const name = normalizePersonName(record.name);
    return name === record.name ? record : { ...record, name };
  }

  private storeCached(callsign: string, record: QrzCallsign): void {
    const entry = { cachedAt: Date.now(), record };
    this.memoryCache.set(callsign, entry);
    const cache = this.readCache();
    cache.entries[this.cacheEntryKey(callsign)] = entry;

    const entries = Object.entries(cache.entries);
    if (entries.length > MAX_CACHE_ENTRIES) {
      entries
        .sort(([, left], [, right]) => left.cachedAt - right.cachedAt)
        .slice(0, entries.length - MAX_CACHE_ENTRIES)
        .forEach(([key]) => delete cache.entries[key]);
    }
    this.writeCache(cache);
  }

  private cacheEntryKey(callsign: string): string {
    return `${this.getCredentials().username.trim().toUpperCase()}:${callsign}`;
  }

  private readCache(): QrzCache {
    try {
      const stored = JSON.parse(localStorage.getItem(QRZ_CACHE_KEY) ?? '{}') as Partial<QrzCache>;
      return {
        entries:
          stored.entries && typeof stored.entries === 'object'
            ? (stored.entries as Record<string, CachedCallsign>)
            : {},
      };
    } catch {
      return { entries: {} };
    }
  }

  private writeCache(cache: QrzCache): void {
    try {
      localStorage.setItem(QRZ_CACHE_KEY, JSON.stringify(cache));
    } catch {
      // A full or disabled local storage cache should not prevent live lookups.
    }
  }

  private resetSession(): void {
    this.sessionKey = null;
    this.sessionPromise = null;
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private text(document: Document, parentName: string, childName: string): string | null {
    const parent = document.getElementsByTagName(parentName).item(0);
    return parent ? this.childText(parent, childName) : null;
  }

  private childText(parent: Element, childName: string): string | null {
    const value = parent.getElementsByTagName(childName).item(0)?.textContent?.trim();
    return value || null;
  }

  private formatName(callsignNode: Element): string | null {
    const formatted = this.childText(callsignNode, 'name_fmt');
    if (formatted) {
      return normalizePersonName(formatted);
    }
    const name = [this.childText(callsignNode, 'fname'), this.childText(callsignNode, 'name')]
      .filter(Boolean)
      .join(' ');
    return name ? normalizePersonName(name) : null;
  }

  private isSessionError(error: string): boolean {
    return /session|key/i.test(error);
  }
}
