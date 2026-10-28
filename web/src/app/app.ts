import { DatePipe } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AgentService, WsjtxDecode, WsjtxService } from 'ngx-kel-agent';
import { interval } from 'rxjs';

const CALLSIGN_TTL_MS = 5 * 60 * 1000;

export interface HeardCallsign {
  callsign: string;
  signalStrength: number;
  lastHeard: number;
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
  private readonly destroyRef = inject(DestroyRef);
  private readonly settingsDialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('settingsDialog');

  protected readonly heardCallsigns = signal<HeardCallsign[]>([]);
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

  constructor() {
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
    this.settingsDialog().nativeElement.showModal();
  }

  protected closeSettings(): void {
    this.settingsDialog().nativeElement.close();
  }

  protected saveSettings(): void {
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
    this.closeSettings();
  }

  private recordDecode(decode: WsjtxDecode): void {
    const callsign = extractCallsign(decode.message, this.wsjtx.status()?.deCall);
    if (!callsign) {
      return;
    }

    const now = Date.now();
    this.heardCallsigns.update((current) => [
      {
        callsign,
        signalStrength: decode.snr,
        lastHeard: now,
      },
      ...current.filter((heard) => heard.callsign !== callsign),
    ]);
  }

  private removeExpiredCallsigns(): void {
    const cutoff = Date.now() - CALLSIGN_TTL_MS;
    this.heardCallsigns.update((current) => current.filter((heard) => heard.lastHeard > cutoff));
  }
}
