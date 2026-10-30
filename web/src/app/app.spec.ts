import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AgentService, WsjtxDecode, WsjtxService } from 'ngx-kel-agent';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { App, extractCallsign } from './app';
import { QrzService } from './qrz.service';
import { StateAlertService } from './state-alert.service';

describe('extractCallsign', () => {
  it.each([
    ['CQ K0SWE DM79', '', 'K0SWE'],
    ['CQ POTA W1AW FN31', '', 'W1AW'],
    ['K0SWE W1AW -12', 'K0SWE', 'W1AW'],
    ['W1AW K0SWE R-09', 'K0SWE', 'W1AW'],
    ['<W1AW> RR73', '', 'W1AW'],
  ])('extracts a callsign from %s', (message, ownCallsign, expected) => {
    expect(extractCallsign(message, ownCallsign)).toBe(expected);
  });

  it('ignores messages without a callsign', () => {
    expect(extractCallsign('TNX 73')).toBeNull();
  });
});

describe('App', () => {
  const decode$ = new Subject<WsjtxDecode>();
  const agentConnected = signal(false);
  const wsjtxConnected = signal(false);
  const status = signal(null);
  const heartbeat = signal(null);

  const agent = {
    connected: agentConnected,
    connect: vi.fn(),
    getHost: vi.fn(() => 'localhost'),
    getPort: vi.fn(() => 8081),
    init: vi.fn(),
    setHost: vi.fn(),
    setPort: vi.fn(),
  };
  const wsjtx = {
    connected: wsjtxConnected,
    decode$,
    heartbeat,
    highlightCallsign: vi.fn(),
    reply: vi.fn(),
    status,
  };
  const qrz = {
    getCredentials: vi.fn(() => ({ username: '', password: '' })),
    hasCredentials: vi.fn(() => false),
    lookup: vi.fn(),
    setCredentials: vi.fn(),
  };
  const stateAlerts = {
    alertIfNeeded: vi.fn((_alert: { state: string }) => false),
    clearRecentAlert: vi.fn(),
    getSelectedStates: vi.fn((): string[] => []),
    prepare: vi.fn(async () => 'granted'),
    setSelectedStates: vi.fn(),
    test: vi.fn(async () => undefined),
  };

  beforeEach(async () => {
    document.getElementById('alert-favicon')?.remove();
    const favicon = document.createElement('link');
    favicon.id = 'alert-favicon';
    favicon.rel = 'icon';
    favicon.href = 'favicon.svg';
    document.head.append(favicon);
    agentConnected.set(false);
    wsjtxConnected.set(false);
    vi.clearAllMocks();
    qrz.getCredentials.mockReturnValue({ username: '', password: '' });
    qrz.hasCredentials.mockReturnValue(false);
    stateAlerts.alertIfNeeded.mockReturnValue(false);
    stateAlerts.getSelectedStates.mockReturnValue([]);
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        { provide: AgentService, useValue: agent },
        { provide: WsjtxService, useValue: wsjtx },
        { provide: QrzService, useValue: qrz },
        { provide: StateAlertService, useValue: stateAlerts },
      ],
    }).compileComponents();
  });

  it('initializes the agent and shows the disconnected state', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    expect(agent.init).toHaveBeenCalledOnce();
    expect(fixture.nativeElement.querySelector('h1').textContent).toContain('Signal Bell');
    const statusElement = fixture.nativeElement.querySelector('.connection-status');
    expect(statusElement.textContent).toContain('Disconnected');
    expect(faviconHref()).toBe('favicon.svg');
    fixture.destroy();
  });

  it('distinguishes an agent connection from a full WSJT-X connection', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const connectionStatus = () =>
      fixture.nativeElement.querySelector('.connection-status') as HTMLElement;

    agentConnected.set(true);
    fixture.detectChanges();
    expect(connectionStatus().textContent).toContain('Waiting for WSJT-X');
    expect(connectionStatus().classList).toContain('connection-status--agent');
    expect(connectionStatus().title).toContain('no WSJT-X messages');

    wsjtxConnected.set(true);
    fixture.detectChanges();
    expect(connectionStatus().textContent).toContain('WSJT-X connected');
    expect(connectionStatus().classList).toContain('connection-status--wsjtx');
    expect(connectionStatus().title).toContain('through kel-agent');
    fixture.destroy();
  });

  it('adds and updates heard callsigns from decodes', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    decode$.next(makeDecode('CQ W1AW FN31', -14));
    fixture.detectChanges();
    const callsignLink = fixture.nativeElement.querySelector('.callsign') as HTMLAnchorElement;
    expect(callsignLink.textContent).toContain('W1AW');
    expect(callsignLink.href).toBe('https://www.qrz.com/db/W1AW');
    expect(callsignLink.hasAttribute('target')).toBe(false);
    expect(fixture.nativeElement.querySelector('.signal').textContent).toContain('-14 dB');

    decode$.next(makeDecode('CQ W1AW FN31', -7));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('.signal').textContent).toContain('-7 dB');
    fixture.destroy();
  });

  it('renders last-heard times as 24-hour UTC regardless of local timezone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-29T01:05:09-06:00'));
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    decode$.next(makeDecode('CQ W1AW FN31', -14));
    fixture.detectChanges();

    const time = fixture.nativeElement.querySelector('time') as HTMLTimeElement;
    expect(time.textContent?.trim()).toBe('07:05:09');
    expect(time.dateTime).toBe('2026-10-29T07:05:09Z');
    expect(fixture.nativeElement.querySelector('th:last-child').textContent).toContain('UTC');

    fixture.destroy();
    vi.useRealTimers();
  });

  it('enriches a heard callsign with its QRZ directory result', async () => {
    qrz.hasCredentials.mockReturnValue(true);
    qrz.lookup.mockResolvedValue({
      callsign: 'W1AW',
      state: 'CT',
      country: 'United States',
      name: 'ARRL HQ',
      grid: 'FN31',
    });
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    decode$.next(makeDecode('CQ W1AW FN31', -14));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(qrz.lookup).toHaveBeenCalledWith('W1AW');
    expect(fixture.nativeElement.querySelector('.directory-cell').textContent).toContain('CT');
    expect(fixture.nativeElement.querySelector('.directory-cell').textContent).toContain('ARRL HQ');
    fixture.destroy();
  });

  it('triggers and marks an alert when QRZ returns a selected state', async () => {
    qrz.hasCredentials.mockReturnValue(true);
    qrz.lookup.mockResolvedValue({
      callsign: 'W1AW',
      state: 'CT',
      country: 'United States',
      name: 'ARRL HQ',
      grid: 'FN31',
    });
    stateAlerts.alertIfNeeded.mockReturnValue(true);
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    decode$.next(makeDecode('CQ W1AW FN31', -14));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(stateAlerts.alertIfNeeded).toHaveBeenCalledWith({
      callsign: 'W1AW',
      state: 'CT',
      name: 'ARRL HQ',
      signalStrength: -14,
    });
    expect(wsjtx.highlightCallsign).toHaveBeenCalledWith({
      id: '',
      callsign: 'W1AW',
      backgroundColor: '#800020',
      foregroundColor: '#ffffff',
      highlightLast: false,
      reset: false,
    });
    expect(fixture.nativeElement.querySelector('.alert-badge').textContent).toContain('Alerted');
    expect(faviconHref()).toBe('favicon-alert.svg');
    const callButton = fixture.nativeElement.querySelector('.call-button') as HTMLButtonElement;
    expect(callButton.disabled).toBe(false);
    callButton.click();
    expect(wsjtx.reply).toHaveBeenCalledWith(makeDecode('CQ W1AW FN31', -14));
    fixture.destroy();
  });

  it('disables calling when the alert did not come from CQ or QRZ', async () => {
    qrz.hasCredentials.mockReturnValue(true);
    qrz.lookup.mockResolvedValue({
      callsign: 'W1AW',
      state: 'CT',
      country: 'United States',
      name: 'ARRL HQ',
      grid: 'FN31',
    });
    stateAlerts.alertIfNeeded.mockReturnValue(true);
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    decode$.next(makeDecode('K0SWE W1AW -12', -14));
    await fixture.whenStable();
    fixture.detectChanges();

    const callButton = fixture.nativeElement.querySelector('.call-button') as HTMLButtonElement;
    expect(callButton.disabled).toBe(true);
    callButton.click();
    expect(wsjtx.reply).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('clears an existing alert and WSJT-X highlight when its state is deselected', async () => {
    qrz.hasCredentials.mockReturnValue(true);
    qrz.lookup.mockResolvedValue({
      callsign: 'W1AW',
      state: 'CT',
      country: 'United States',
      name: 'ARRL HQ',
      grid: 'FN31',
    });
    stateAlerts.getSelectedStates.mockReturnValue(['CT']);
    stateAlerts.alertIfNeeded.mockReturnValue(true);
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    decode$.next(makeDecode('CQ W1AW FN31', -14));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.alert-badge')).not.toBeNull();

    const app = fixture.componentInstance as any;
    app.configHost = 'localhost';
    app.configPort = 8081;
    app.configAlertStates = [];
    fixture.nativeElement.querySelector('dialog').close = vi.fn();
    await app.saveSettings();
    fixture.detectChanges();

    expect(stateAlerts.clearRecentAlert).toHaveBeenCalledWith('W1AW', 'CT');
    expect(wsjtx.highlightCallsign).toHaveBeenLastCalledWith({
      id: '',
      callsign: 'W1AW',
      backgroundColor: '',
      foregroundColor: '',
      highlightLast: false,
      reset: true,
    });
    expect(fixture.nativeElement.querySelector('.alert-badge')).toBeNull();
    expect(faviconHref()).toBe('favicon.svg');
    fixture.destroy();
  });

  it('does not highlight a callsign when its state does not alert', async () => {
    qrz.hasCredentials.mockReturnValue(true);
    qrz.lookup.mockResolvedValue({
      callsign: 'W1AW',
      state: 'CT',
      country: 'United States',
      name: null,
      grid: 'FN31',
    });
    stateAlerts.alertIfNeeded.mockReturnValue(false);
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    decode$.next(makeDecode('CQ W1AW FN31', -14));
    await fixture.whenStable();

    expect(wsjtx.highlightCallsign).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('keeps alerted rows above newer non-alerted rows', async () => {
    qrz.hasCredentials.mockReturnValue(true);
    qrz.lookup.mockImplementation(async (callsign: string) => ({
      callsign,
      state: callsign === 'W1AW' ? 'CT' : 'MA',
      country: 'United States',
      name: null,
      grid: 'FN31',
    }));
    stateAlerts.alertIfNeeded.mockImplementation(({ state }: { state: string }) => state === 'CT');
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    decode$.next(makeDecode('CQ W1AW FN31', -14));
    await fixture.whenStable();
    decode$.next(makeDecode('CQ W2ABC FN42', -9));
    await fixture.whenStable();
    fixture.detectChanges();

    const rows = [...fixture.nativeElement.querySelectorAll('tbody tr')] as HTMLElement[];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('W1AW');
    expect(rows[0].textContent).toContain('Alerted');
    expect(rows[1].textContent).toContain('W2ABC');
    fixture.destroy();
  });

  it('removes callsigns after five minutes without another decode', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T17:00:00Z'));
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    decode$.next(makeDecode('CQ W1AW FN31', -14));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('tbody tr')).toHaveLength(1);

    vi.advanceTimersByTime(5 * 60 * 1000 + 1000);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('tbody tr')).toHaveLength(0);

    fixture.destroy();
    vi.useRealTimers();
  });
});

function faviconHref(): string | null {
  return document.getElementById('alert-favicon')?.getAttribute('href') ?? null;
}

function makeDecode(message: string, snr: number): WsjtxDecode {
  return {
    deltaFrequency: 1200,
    deltaTime: 0.1,
    id: 'WSJT-X',
    lowConfidence: false,
    message,
    mode: 'FT8',
    new: true,
    offAir: false,
    snr,
    time: 0,
  };
}
