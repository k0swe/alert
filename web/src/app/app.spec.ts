import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AgentService, WsjtxDecode, WsjtxService } from 'ngx-kel-agent';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { App, extractCallsign } from './app';

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
    status,
  };

  beforeEach(async () => {
    agentConnected.set(false);
    wsjtxConnected.set(false);
    vi.clearAllMocks();
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        { provide: AgentService, useValue: agent },
        { provide: WsjtxService, useValue: wsjtx },
      ],
    }).compileComponents();
  });

  it('initializes the agent and shows the disconnected state', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    expect(agent.init).toHaveBeenCalledOnce();
    const statusElement = fixture.nativeElement.querySelector('.connection-status');
    expect(statusElement.textContent).toContain('Disconnected');
    fixture.destroy();
  });

  it('adds and updates heard callsigns from decodes', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    decode$.next(makeDecode('CQ W1AW FN31', -14));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.callsign').textContent).toContain('W1AW');
    expect(fixture.nativeElement.querySelector('.signal').textContent).toContain('-14 dB');

    decode$.next(makeDecode('CQ W1AW FN31', -7));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('.signal').textContent).toContain('-7 dB');
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
