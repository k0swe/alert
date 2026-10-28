import { Injectable } from '@angular/core';

const QRZ_ENDPOINT = 'https://xmldata.qrz.com/xml/current/';
const QRZ_USERNAME_KEY = 'qrz-username';
const QRZ_PASSWORD_KEY = 'qrz-password';

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
  private readonly cache = new Map<string, QrzCallsign>();

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
    this.reset();
  }

  async lookup(callsign: string): Promise<QrzCallsign> {
    const normalizedCallsign = callsign.trim().toUpperCase();
    const cached = this.cache.get(normalizedCallsign);
    if (cached) {
      return cached;
    }

    const result = await this.lookupWithRetry(normalizedCallsign, true);
    this.cache.set(normalizedCallsign, result);
    return result;
  }

  reset(): void {
    this.sessionKey = null;
    this.sessionPromise = null;
    this.cache.clear();
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
      this.sessionKey = null;
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
      return formatted;
    }
    const name = [this.childText(callsignNode, 'fname'), this.childText(callsignNode, 'name')]
      .filter(Boolean)
      .join(' ');
    return name || null;
  }

  private isSessionError(error: string): boolean {
    return /session|key/i.test(error);
  }
}
