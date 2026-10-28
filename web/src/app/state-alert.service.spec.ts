import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateAlertService, US_STATES } from './state-alert.service';

class NotificationMock {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn(async () => NotificationMock.permission);
  static instances: NotificationMock[] = [];

  constructor(
    readonly title: string,
    readonly options?: NotificationOptions,
  ) {
    NotificationMock.instances.push(this);
  }
}

class AudioContextMock {
  state: AudioContextState = 'running';
  currentTime = 0;
  destination = {} as AudioDestinationNode;
  resume = vi.fn(async () => undefined);
  createGain = vi.fn(() => ({
    gain: {
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
  }));
  createOscillator = vi.fn(() => ({
    type: 'sine',
    frequency: { setValueAtTime: vi.fn() },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }));
}

describe('StateAlertService', () => {
  let service: StateAlertService;

  beforeEach(() => {
    localStorage.clear();
    NotificationMock.permission = 'granted';
    NotificationMock.instances = [];
    NotificationMock.requestPermission.mockClear();
    vi.stubGlobal('Notification', NotificationMock);
    vi.stubGlobal('AudioContext', AudioContextMock);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T18:00:00Z'));
    TestBed.configureTestingModule({});
    service = TestBed.inject(StateAlertService);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('provides all 50 states without territories or DC', () => {
    expect(US_STATES).toHaveLength(50);
    expect(US_STATES.map(({ code }) => code)).toContain('AK');
    expect(US_STATES.map(({ code }) => code)).not.toContain('DC');
  });

  it('stores selected states in canonical order and ignores invalid values', () => {
    service.setSelectedStates(['WY', 'XX', 'CO']);

    expect(service.getSelectedStates()).toEqual(['CO', 'WY']);
  });

  it('alerts only for selected states', () => {
    service.setSelectedStates(['CT']);

    expect(service.alertIfNeeded(makeAlert('MA'))).toBe(false);
    expect(service.alertIfNeeded(makeAlert('CT'))).toBe(true);
    expect(NotificationMock.instances).toHaveLength(1);
    expect(NotificationMock.instances[0].title).toBe('CT heard: W1AW');
    expect(NotificationMock.instances[0].options?.body).toContain('-14 dB');
  });

  it('suppresses repeat alerts for the same callsign and state for five minutes', () => {
    service.setSelectedStates(['CT']);

    expect(service.alertIfNeeded(makeAlert('CT'))).toBe(true);
    expect(service.alertIfNeeded(makeAlert('CT'))).toBe(false);
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(service.alertIfNeeded(makeAlert('CT'))).toBe(true);
    expect(NotificationMock.instances).toHaveLength(2);
  });

  it('allows an alert to fire again after its recent-alert state is cleared', () => {
    service.setSelectedStates(['CT']);

    expect(service.alertIfNeeded(makeAlert('CT'))).toBe(true);
    expect(service.alertIfNeeded(makeAlert('CT'))).toBe(false);
    service.clearRecentAlert('W1AW', 'CT');
    expect(service.alertIfNeeded(makeAlert('CT'))).toBe(true);
  });

  it('requests notification permission when preparing alerts', async () => {
    NotificationMock.permission = 'default';
    NotificationMock.requestPermission.mockImplementationOnce(async () => {
      NotificationMock.permission = 'granted';
      return 'granted';
    });

    await expect(service.prepare()).resolves.toBe('granted');
    expect(NotificationMock.requestPermission).toHaveBeenCalledOnce();
  });
});

function makeAlert(state: string) {
  return {
    callsign: 'W1AW',
    state,
    name: 'ARRL HQ',
    signalStrength: -14,
  };
}
