import { Injectable } from '@angular/core';

const ALERT_STATES_KEY = 'alert-states-v1';
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;

export interface UsState {
  code: string;
  name: string;
}

export interface StateAlert {
  callsign: string;
  state: string;
  name: string | null;
  signalStrength: number;
}

export const US_STATES: readonly UsState[] = [
  ['AL', 'Alabama'],
  ['AK', 'Alaska'],
  ['AZ', 'Arizona'],
  ['AR', 'Arkansas'],
  ['CA', 'California'],
  ['CO', 'Colorado'],
  ['CT', 'Connecticut'],
  ['DE', 'Delaware'],
  ['FL', 'Florida'],
  ['GA', 'Georgia'],
  ['HI', 'Hawaii'],
  ['ID', 'Idaho'],
  ['IL', 'Illinois'],
  ['IN', 'Indiana'],
  ['IA', 'Iowa'],
  ['KS', 'Kansas'],
  ['KY', 'Kentucky'],
  ['LA', 'Louisiana'],
  ['ME', 'Maine'],
  ['MD', 'Maryland'],
  ['MA', 'Massachusetts'],
  ['MI', 'Michigan'],
  ['MN', 'Minnesota'],
  ['MS', 'Mississippi'],
  ['MO', 'Missouri'],
  ['MT', 'Montana'],
  ['NE', 'Nebraska'],
  ['NV', 'Nevada'],
  ['NH', 'New Hampshire'],
  ['NJ', 'New Jersey'],
  ['NM', 'New Mexico'],
  ['NY', 'New York'],
  ['NC', 'North Carolina'],
  ['ND', 'North Dakota'],
  ['OH', 'Ohio'],
  ['OK', 'Oklahoma'],
  ['OR', 'Oregon'],
  ['PA', 'Pennsylvania'],
  ['RI', 'Rhode Island'],
  ['SC', 'South Carolina'],
  ['SD', 'South Dakota'],
  ['TN', 'Tennessee'],
  ['TX', 'Texas'],
  ['UT', 'Utah'],
  ['VT', 'Vermont'],
  ['VA', 'Virginia'],
  ['WA', 'Washington'],
  ['WV', 'West Virginia'],
  ['WI', 'Wisconsin'],
  ['WY', 'Wyoming'],
].map(([code, name]) => ({ code, name }));

@Injectable({ providedIn: 'root' })
export class StateAlertService {
  private readonly recentAlerts = new Map<string, number>();
  private audioContext: AudioContext | null = null;

  getSelectedStates(): string[] {
    try {
      const stored = JSON.parse(localStorage.getItem(ALERT_STATES_KEY) ?? '[]');
      if (!Array.isArray(stored)) {
        return [];
      }
      const validCodes = new Set(US_STATES.map((state) => state.code));
      return stored.filter(
        (code): code is string => typeof code === 'string' && validCodes.has(code),
      );
    } catch {
      return [];
    }
  }

  setSelectedStates(states: readonly string[]): void {
    const selected = new Set(states);
    localStorage.setItem(
      ALERT_STATES_KEY,
      JSON.stringify(US_STATES.map((state) => state.code).filter((code) => selected.has(code))),
    );
  }

  async prepare(): Promise<NotificationPermission | 'unsupported'> {
    this.prepareAudio();
    if (!('Notification' in globalThis)) {
      return 'unsupported';
    }
    if (Notification.permission === 'default') {
      return Notification.requestPermission();
    }
    return Notification.permission;
  }

  alertIfNeeded(alert: StateAlert): boolean {
    const normalizedAlert = { ...alert, state: alert.state.toUpperCase() };
    if (!this.getSelectedStates().includes(normalizedAlert.state)) {
      return false;
    }

    const key = `${normalizedAlert.callsign}:${normalizedAlert.state}`;
    const lastAlert = this.recentAlerts.get(key) ?? 0;
    if (Date.now() - lastAlert < ALERT_COOLDOWN_MS) {
      return false;
    }
    this.recentAlerts.set(key, Date.now());
    this.pruneRecentAlerts();

    this.playSound();
    this.showNotification(normalizedAlert);
    return true;
  }

  async test(): Promise<void> {
    await this.prepare();
    this.playSound();
    if ('Notification' in globalThis && Notification.permission === 'granted') {
      new Notification('Alert is ready', {
        body: 'Desktop notifications and sound are enabled.',
        tag: 'alert-test',
      });
    }
  }

  private showNotification(alert: StateAlert): void {
    if (!('Notification' in globalThis) || Notification.permission !== 'granted') {
      return;
    }
    const operator = alert.name ? ` — ${alert.name}` : '';
    new Notification(`${alert.state} heard: ${alert.callsign}`, {
      body: `${alert.callsign}${operator} at ${this.formatSignal(alert.signalStrength)}`,
      tag: `state-alert-${alert.callsign}-${alert.state}`,
    });
  }

  private prepareAudio(): void {
    const AudioContextConstructor = globalThis.AudioContext;
    if (!AudioContextConstructor) {
      return;
    }
    this.audioContext ??= new AudioContextConstructor();
    if (this.audioContext.state === 'suspended') {
      void this.audioContext.resume();
    }
  }

  private playSound(): void {
    this.prepareAudio();
    const context = this.audioContext;
    if (!context || context.state === 'closed') {
      return;
    }

    const now = context.currentTime;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
    gain.connect(context.destination);

    for (const [frequency, offset] of [
      [659.25, 0],
      [880, 0.16],
    ] as const) {
      const oscillator = context.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, now + offset);
      oscillator.connect(gain);
      oscillator.start(now + offset);
      oscillator.stop(now + offset + 0.32);
    }
  }

  private formatSignal(signalStrength: number): string {
    return `${signalStrength > 0 ? '+' : ''}${signalStrength} dB`;
  }

  private pruneRecentAlerts(): void {
    const cutoff = Date.now() - ALERT_COOLDOWN_MS;
    for (const [key, alertedAt] of this.recentAlerts) {
      if (alertedAt < cutoff) {
        this.recentAlerts.delete(key);
      }
    }
  }
}
