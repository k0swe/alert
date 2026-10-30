import { DatePipe, DOCUMENT } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AgentService, WsjtxDecode, WsjtxService } from 'ngx-kel-agent';
import { interval } from 'rxjs';
import { QrzLookupError, QrzService } from './qrz.service';
import { StateAlertService, US_STATES } from './state-alert.service';

const CALLSIGN_TTL_MS = 5 * 60 * 1000;

export interface HeardCallsign {
  callsign: string;
  signalStrength: number;
  lastHeard: number;
  qrzStatus: 'loading' | 'found' | 'error' | 'unconfigured';
  state: string | null;
  country: string | null;
  name: string | null;
  qrzError: string | null;
  alerted: boolean;
}

const CALLSIGN_PATTERN = /^(?=.{3,15}$)(?=.*[A-Z])(?=.*\d)[A-Z0-9]+(?:\/[A-Z0-9]+)*$/;
const GRID_PATTERN = /^[A-R]{2}\d{2}(?:[A-X]{2})?$/;
const NON_CALLSIGN_TOKENS = new Set(['CQ', 'DE', 'DX', 'QRZ', 'RR73', 'RRR', '73', 'POTA', 'SOTA']);

/** Extract the transmitting station from a standard WSJT-X free-text decode. */
export function extractCallsign(message: string, ownCallsign = ''): string | null {
  const tokens = message
    .toUpperCase()
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^[<({\[]+|[>)}\],;:]+$/g, ''))
    .filter(Boolean);

  const callsigns = tokens.filter(
    (token) =>
      CALLSIGN_PATTERN.test(token) &&
      !GRID_PATTERN.test(token) &&
      !NON_CALLSIGN_TOKENS.has(token) &&
      !/^[+-]?\d+$/.test(token),
  );

  if (callsigns.length === 0) {
    return null;
  }

  if (tokens[0] === 'CQ' || tokens[0] === 'QRZ' || tokens[0] === 'DE') {
    return callsigns[0];
  }

  const normalizedOwnCallsign = ownCallsign.toUpperCase();
  if (callsigns.length > 1) {
    const sender = callsigns[1];
    return sender === normalizedOwnCallsign ? callsigns[0] : sender;
  }

  return callsigns[0] === normalizedOwnCallsign ? null : callsigns[0];
}

type ConnectionLevel = 'disconnected' | 'agent' | 'wsjtx';

@Component({
  imports: [DatePipe, FormsModule],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  private readonly agent = inject(AgentService);
  private readonly wsjtx = inject(WsjtxService);
  private readonly qrz = inject(QrzService);
  private readonly stateAlerts = inject(StateAlertService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  private readonly settingsDialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('settingsDialog');
  private readonly actionableDecodes = new Map<string, WsjtxDecode>();

  protected readonly heardCallsigns = signal<HeardCallsign[]>([]);
  protected readonly hasActiveWantedCallsigns = computed(() =>
    this.heardCallsigns().some((heard) => heard.alerted),
  );
  protected readonly usStates = US_STATES;
  protected readonly connectionLevel = computed<ConnectionLevel>(() => {
    if (!this.agent.connected()) {
      return 'disconnected';
    }
    return this.wsjtx.connected() ? 'wsjtx' : 'agent';
  });
  protected readonly connectionLabel = computed(() => {
    switch (this.connectionLevel()) {
      case 'wsjtx':
        return 'WSJT-X connected';
      case 'agent':
        return 'Waiting for WSJT-X';
      default:
        return 'Disconnected';
    }
  });
  protected readonly connectionDetails = computed(() => {
    const endpoint = `${this.agent.getHost()}:${this.agent.getPort()}`;
    switch (this.connectionLevel()) {
      case 'wsjtx': {
        const heartbeat = this.wsjtx.heartbeat();
        const client = heartbeat?.id ?? this.wsjtx.status()?.id ?? 'WSJT-X';
        const version = heartbeat?.version ? ` ${heartbeat.version}` : '';
        return `Connected to ${client}${version} through kel-agent at ${endpoint}.`;
      }
      case 'agent':
        return `Connected to kel-agent at ${endpoint}, but no WSJT-X messages have arrived in the last 15 seconds.`;
      default:
        return `Not connected to kel-agent at ${endpoint}. Retrying automatically.`;
    }
  });

  protected configHost = '';
  protected configPort = 8081;
  protected qrzUsername = '';
  protected qrzPassword = '';
  protected configAlertStates: string[] = [];
  protected notificationStatus = '';

  constructor() {
    effect(() => this.updateFavicon(this.hasActiveWantedCallsigns()));
    this.agent.init();
    this.wsjtx.decode$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((decode) => this.recordDecode(decode));
    interval(1000)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.removeExpiredCallsigns());
  }

  protected openSettings(): void {
    this.configHost = this.agent.getHost();
    this.configPort = this.agent.getPort();
    const credentials = this.qrz.getCredentials();
    this.qrzUsername = credentials.username;
    this.qrzPassword = credentials.password;
    this.configAlertStates = this.stateAlerts.getSelectedStates();
    this.notificationStatus = this.getNotificationStatus();
    this.settingsDialog().nativeElement.showModal();
  }

  protected closeSettings(): void {
    this.settingsDialog().nativeElement.close();
  }

  protected toggleAlertState(state: string, selected: boolean): void {
    const states = new Set(this.configAlertStates);
    selected ? states.add(state) : states.delete(state);
    this.configAlertStates = US_STATES.map(({ code }) => code).filter((code) => states.has(code));
  }

  protected toggleAllAlertStates(selected: boolean): void {
    this.configAlertStates = selected ? US_STATES.map(({ code }) => code) : [];
  }

  protected allAlertStatesSelected(): boolean {
    return this.configAlertStates.length === US_STATES.length;
  }

  protected someAlertStatesSelected(): boolean {
    return this.configAlertStates.length > 0 && !this.allAlertStatesSelected();
  }

  protected async testAlert(): Promise<void> {
    await this.stateAlerts.test();
    this.notificationStatus = this.getNotificationStatus();
  }

  protected canCall(callsign: string): boolean {
    return this.actionableDecodes.has(callsign);
  }

  protected callStation(callsign: string): void {
    const decode = this.actionableDecodes.get(callsign);
    if (decode) {
      this.wsjtx.reply(decode);
    }
  }

  protected async saveSettings(): Promise<void> {
    const host = this.configHost.trim();
    const port = Number(this.configPort);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      return;
    }

    const hostChanged = host !== this.agent.getHost();
    const portChanged = port !== this.agent.getPort();
    if (hostChanged) {
      this.agent.setHost(host);
    }
    if (portChanged) {
      this.agent.setPort(port);
    }
    if (!hostChanged && !portChanged) {
      this.agent.connect();
    }

    const oldCredentials = this.qrz.getCredentials();
    const qrzChanged =
      oldCredentials.username !== this.qrzUsername.trim() ||
      oldCredentials.password !== this.qrzPassword;
    this.stateAlerts.setSelectedStates(this.configAlertStates);
    const selectedStates = new Set(this.configAlertStates);
    if (selectedStates.size > 0) {
      await this.stateAlerts.prepare();
    }
    for (const heard of this.heardCallsigns()) {
      if (!heard.state) {
        continue;
      }
      if (heard.alerted && !selectedStates.has(heard.state.toUpperCase())) {
        this.clearStateAlert(heard);
      } else if (
        selectedStates.has(heard.state.toUpperCase()) &&
        this.triggerStateAlert(heard, heard.state, heard.name)
      ) {
        this.updateCallsign(heard.callsign, { alerted: true });
      }
    }

    if (qrzChanged) {
      this.qrz.setCredentials({
        username: this.qrzUsername,
        password: this.qrzPassword,
      });
      for (const heard of this.heardCallsigns()) {
        if (this.qrz.hasCredentials()) {
          void this.lookupCallsign(heard.callsign);
        } else {
          this.updateCallsign(heard.callsign, {
            qrzStatus: 'unconfigured',
            state: null,
            country: null,
            name: null,
            qrzError: null,
          });
        }
      }
    }
    this.closeSettings();
  }

  private recordDecode(decode: WsjtxDecode): void {
    const callsign = extractCallsign(decode.message, this.wsjtx.status()?.deCall);
    if (!callsign) {
      return;
    }

    const now = Date.now();
    if (/^(?:CQ|QRZ)\b/i.test(decode.message.trim())) {
      this.actionableDecodes.set(callsign, decode);
    }
    const existing = this.heardCallsigns().find((heard) => heard.callsign === callsign);
    this.heardCallsigns.update((current) =>
      this.sortHeardCallsigns([
        {
          callsign,
          signalStrength: decode.snr,
          lastHeard: now,
          qrzStatus:
            existing?.qrzStatus ?? (this.qrz.hasCredentials() ? 'loading' : 'unconfigured'),
          state: existing?.state ?? null,
          country: existing?.country ?? null,
          name: existing?.name ?? null,
          qrzError: existing?.qrzError ?? null,
          alerted: existing?.alerted ?? false,
        },
        ...current.filter((heard) => heard.callsign !== callsign),
      ]),
    );

    if (!existing && this.qrz.hasCredentials()) {
      void this.lookupCallsign(callsign);
    }
  }

  private async lookupCallsign(callsign: string): Promise<void> {
    this.updateCallsign(callsign, { qrzStatus: 'loading', qrzError: null });
    try {
      const record = await this.qrz.lookup(callsign);
      const heard = this.heardCallsigns().find((entry) => entry.callsign === callsign);
      const alerted = Boolean(
        record.state && heard && this.triggerStateAlert(heard, record.state, record.name),
      );
      this.updateCallsign(callsign, {
        qrzStatus: 'found',
        state: record.state,
        country: record.country,
        name: record.name,
        qrzError: null,
        alerted: heard?.alerted || alerted,
      });
    } catch (error) {
      this.updateCallsign(callsign, {
        qrzStatus: 'error',
        qrzError: error instanceof QrzLookupError ? error.message : 'QRZ lookup failed.',
      });
    }
  }

  private triggerStateAlert(heard: HeardCallsign, state: string, name: string | null): boolean {
    const alerted = this.stateAlerts.alertIfNeeded({
      callsign: heard.callsign,
      state,
      name,
      signalStrength: heard.signalStrength,
    });
    if (alerted) {
      this.wsjtx.highlightCallsign({
        id: '',
        callsign: heard.callsign,
        backgroundColor: '#800020',
        foregroundColor: '#ffffff',
        highlightLast: false,
        reset: false,
      });
    }
    return alerted;
  }

  private clearStateAlert(heard: HeardCallsign): void {
    if (!heard.state) {
      return;
    }
    this.stateAlerts.clearRecentAlert(heard.callsign, heard.state);
    this.wsjtx.highlightCallsign({
      id: '',
      callsign: heard.callsign,
      backgroundColor: '',
      foregroundColor: '',
      highlightLast: false,
      reset: true,
    });
    this.updateCallsign(heard.callsign, { alerted: false });
  }

  private updateCallsign(callsign: string, changes: Partial<HeardCallsign>): void {
    this.heardCallsigns.update((current) =>
      this.sortHeardCallsigns(
        current.map((heard) => (heard.callsign === callsign ? { ...heard, ...changes } : heard)),
      ),
    );
  }

  private sortHeardCallsigns(callsigns: HeardCallsign[]): HeardCallsign[] {
    return callsigns.sort(
      (left, right) =>
        Number(right.alerted) - Number(left.alerted) || right.lastHeard - left.lastHeard,
    );
  }

  private updateFavicon(hasActiveAlerts: boolean): void {
    this.document
      .getElementById('alert-favicon')
      ?.setAttribute('href', hasActiveAlerts ? 'favicon-alert.svg' : 'favicon.svg');
  }

  private getNotificationStatus(): string {
    if (!('Notification' in globalThis)) {
      return 'Desktop notifications are unavailable in this browser; sound alerts may still work.';
    }
    switch (Notification.permission) {
      case 'granted':
        return 'Desktop notifications are enabled.';
      case 'denied':
        return 'Desktop notifications are blocked; sound alerts may still work.';
      default:
        return 'Your browser will ask for notification permission when alert states are saved.';
    }
  }

  private removeExpiredCallsigns(): void {
    const cutoff = Date.now() - CALLSIGN_TTL_MS;
    this.heardCallsigns.update((current) => {
      const active = current.filter((heard) => heard.lastHeard > cutoff);
      const activeCallsigns = new Set(active.map((heard) => heard.callsign));
      for (const callsign of this.actionableDecodes.keys()) {
        if (!activeCallsigns.has(callsign)) {
          this.actionableDecodes.delete(callsign);
        }
      }
      return active;
    });
  }
}
