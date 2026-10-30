import { Injectable } from '@angular/core';
import { normalizePersonName } from './person-name';

const QRZ_ENDPOINT = 'https://xmldata.qrz.com/xml/current/';
const QRZ_USERNAME_KEY = 'qrz-username';
const QRZ_PASSWORD_KEY = 'qrz-password';
const QRZ_CACHE_KEY = 'qrz-directory-cache-v1';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const BATCH_DELAY_MS = 200;
const INITIAL_REQUEST_SPACING_MS = 200;
const MAX_REQUEST_SPACING_MS = 30_000;
const RATE_LIMIT_RETRIES = 5;
const SUCCESS_RECOVERY_MS = 100;

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
  rateLimitRetries: number;
  resolve: (record: QrzCallsign) => void;
  reject: (error: unknown) => void;
}

export class QrzLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QrzLookupError';
  }
}

export class QrzRateLimitError extends QrzLookupError {
  constructor(
    message: string,
    readonly retryAfterMs: number | null = null,
    readonly signal: 'http' | 'session' = 'session',
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = 'QrzRateLimitError';
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
  private requestSpacingMs = INITIAL_REQUEST_SPACING_MS;
  private nextRequestAt = 0;

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
    this.resetRequestRate();
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
      this.queue.push({ callsign: normalizedCallsign, rateLimitRetries: 0, resolve, reject });
    });
    this.pendingLookups.set(normalizedCallsign, lookup);
    this.scheduleBatch();
    return lookup;
  }

  reset(): void {
    this.resetSession();
    this.resetRequestRate();
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

        let completed = true;
        try {
          const record = await this.lookupWithRetry(queued.callsign, true);
          this.storeCached(queued.callsign, record);
          this.recoverRequestRate();
          queued.resolve(record);
        } catch (error) {
          if (error instanceof QrzRateLimitError) {
            const willRetry = queued.rateLimitRetries < RATE_LIMIT_RETRIES;
            if (willRetry) {
              queued.rateLimitRetries += 1;
              this.applyRateLimitBackoff(error.retryAfterMs);
              this.queue.unshift(queued);
              completed = false;
            }
            this.logRateLimit(queued, error, willRetry);
            if (!willRetry) {
              queued.reject(error);
            }
          } else {
            queued.reject(error);
          }
        } finally {
          if (completed) {
            this.pendingLookups.delete(queued.callsign);
          }
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
    const message = this.text(document, 'Session', 'Message');
    const rateLimitMessage = [error, message].find(
      (value) => value && this.isRateLimitMessage(value),
    );
    if (rateLimitMessage) {
      throw new QrzRateLimitError(rateLimitMessage, null, 'session');
    }
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
      agent: 'k0swe-signal-bell-0.1',
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
    await this.waitForRequestSlot();

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

    const body = await response.text();
    if (response.status === 429 || (!response.ok && this.isRateLimitMessage(body))) {
      throw new QrzRateLimitError(
        `QRZ.com rate limited this client (HTTP ${response.status}).`,
        this.retryAfterMilliseconds(response.headers.get('Retry-After')),
        'http',
        response.status,
      );
    }
    if (!response.ok) {
      throw new QrzLookupError(`QRZ.com returned HTTP ${response.status}.`);
    }

    const document = new DOMParser().parseFromString(body, 'application/xml');
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

  private async waitForRequestSlot(): Promise<void> {
    const waitMs = Math.max(0, this.nextRequestAt - Date.now());
    if (waitMs > 0) {
      await this.delay(waitMs);
    }
    this.nextRequestAt = Date.now() + this.requestSpacingMs;
  }

  private applyRateLimitBackoff(retryAfterMs: number | null): void {
    this.requestSpacingMs = Math.min(
      MAX_REQUEST_SPACING_MS,
      Math.max(this.requestSpacingMs * 2, retryAfterMs ?? 0),
    );
    this.nextRequestAt = Math.max(this.nextRequestAt, Date.now() + this.requestSpacingMs);
  }

  private recoverRequestRate(): void {
    this.requestSpacingMs = Math.max(
      INITIAL_REQUEST_SPACING_MS,
      this.requestSpacingMs - SUCCESS_RECOVERY_MS,
    );
  }

  private resetRequestRate(): void {
    this.requestSpacingMs = INITIAL_REQUEST_SPACING_MS;
    this.nextRequestAt = 0;
  }

  private logRateLimit(queued: QueuedLookup, error: QrzRateLimitError, willRetry: boolean): void {
    console.warn('[QRZ] Rate limited; adaptive backoff applied.', {
      callsign: queued.callsign,
      signal: error.signal,
      httpStatus: error.httpStatus,
      message: error.message,
      serverRetryAfterMs: error.retryAfterMs,
      retry: queued.rateLimitRetries,
      maxRetries: RATE_LIMIT_RETRIES,
      nextRequestSpacingMs: this.requestSpacingMs,
      queuedLookups: this.queue.length,
      willRetry,
      observedAt: new Date().toISOString(),
    });
  }

  private retryAfterMilliseconds(value: string | null): number | null {
    if (!value) {
      return null;
    }
    const seconds = Number(value);
    if (Number.isFinite(seconds)) {
      return Math.max(0, seconds * 1000);
    }
    const date = Date.parse(value);
    return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
  }

  private isRateLimitMessage(message: string): boolean {
    return /rate[ -]?limit|too many (?:requests|queries|lookups)|excessive (?:requests|queries|lookups)|throttl|(?:query|request) limit/i.test(
      message,
    );
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
