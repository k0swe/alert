import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QrzLookupError, QrzService } from './qrz.service';

const BATCH_DELAY_MS = 200;
const REQUEST_SPACING_MS = 200;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const sessionXml = `<?xml version="1.0"?>
<QRZDatabase><Session><Key>session-key</Key><Count>1</Count></Session></QRZDatabase>`;
const callsignXml = `<?xml version="1.0"?>
<QRZDatabase>
  <Callsign>
    <call>W1AW</call><fname>FRED L</fname><name>LLOYD</name><state>CT</state>
    <country>United States</country><grid>FN31pr</grid>
  </Callsign>
  <Session><Key>session-key</Key><Count>2</Count></Session>
</QRZDatabase>`;

describe('QrzService', () => {
  let service: QrzService;

  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T18:00:00Z'));
    TestBed.configureTestingModule({});
    service = TestBed.inject(QrzService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores credentials in browser local storage', () => {
    service.setCredentials({ username: ' k0swe ', password: 'secret' });

    expect(service.getCredentials()).toEqual({ username: 'k0swe', password: 'secret' });
    expect(service.hasCredentials()).toBe(true);
  });

  it('logs in and maps a callsign directory record after the batch delay', async () => {
    service.setCredentials({ username: 'k0swe', password: 'secret' });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(xmlResponse(sessionXml))
      .mockResolvedValueOnce(xmlResponse(callsignXml));

    const lookup = service.lookup('w1aw');
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(BATCH_DELAY_MS + REQUEST_SPACING_MS);

    await expect(lookup).resolves.toEqual({
      callsign: 'W1AW',
      state: 'CT',
      country: 'United States',
      name: 'Fred L Lloyd',
      grid: 'FN31pr',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBody(fetchMock, 0).get('username')).toBe('k0swe');
    expect(requestBody(fetchMock, 0).get('password')).toBe('secret');
    expect(requestBody(fetchMock, 1).get('s')).toBe('session-key');
    expect(requestBody(fetchMock, 1).get('callsign')).toBe('W1AW');
  });

  it('logs in again once when a session expires', async () => {
    service.setCredentials({ username: 'k0swe', password: 'secret' });
    const expiredSessionXml = `<?xml version="1.0"?>
      <QRZDatabase><Session><Error>Session Timeout</Error></Session></QRZDatabase>`;
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(xmlResponse(sessionXml))
      .mockResolvedValueOnce(xmlResponse(expiredSessionXml))
      .mockResolvedValueOnce(xmlResponse(sessionXml))
      .mockResolvedValueOnce(xmlResponse(callsignXml));

    const lookup = service.lookup('W1AW');
    await vi.advanceTimersByTimeAsync(BATCH_DELAY_MS + REQUEST_SPACING_MS * 3);

    await expect(lookup).resolves.toMatchObject({ callsign: 'W1AW', state: 'CT' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('deduplicates callsigns and serializes a burst with spacing', async () => {
    service.setCredentials({ username: 'k0swe', password: 'secret' });
    const w2Xml = callsignXml
      .replaceAll('W1AW', 'W2ABC')
      .replace('<state>CT</state>', '<state>NY</state>');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(xmlResponse(sessionXml))
      .mockResolvedValueOnce(xmlResponse(callsignXml))
      .mockResolvedValueOnce(xmlResponse(w2Xml));

    const w1First = service.lookup('W1AW');
    const w1Duplicate = service.lookup('w1aw');
    const w2 = service.lookup('W2ABC');
    expect(w1Duplicate).toBe(w1First);

    await vi.advanceTimersByTimeAsync(BATCH_DELAY_MS + REQUEST_SPACING_MS);
    await expect(w1First).resolves.toMatchObject({ callsign: 'W1AW' });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(REQUEST_SPACING_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(w2).resolves.toMatchObject({ callsign: 'W2ABC', state: 'NY' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('honors HTTP 429 Retry-After and logs structured diagnostics', async () => {
    service.setCredentials({ username: 'k0swe', password: '***' });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(xmlResponse(sessionXml))
      .mockResolvedValueOnce(rateLimitResponse(2))
      .mockResolvedValueOnce(xmlResponse(callsignXml));

    const lookup = service.lookup('W1AW');
    await vi.advanceTimersByTimeAsync(BATCH_DELAY_MS + REQUEST_SPACING_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(
      '[QRZ] Rate limited; adaptive backoff applied.',
      expect.objectContaining({
        callsign: 'W1AW',
        signal: 'http',
        httpStatus: 429,
        serverRetryAfterMs: 2_000,
        nextRequestSpacingMs: 2_000,
        retry: 1,
        willRetry: true,
      }),
    );

    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(lookup).resolves.toMatchObject({ callsign: 'W1AW' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('backs off on a QRZ session error and recovers toward 5 QPS after successes', async () => {
    service.setCredentials({ username: 'k0swe', password: '***' });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rateLimitedXml = `<?xml version="1.0"?>
      <QRZDatabase><Session><Error>Too many requests; please slow down</Error></Session></QRZDatabase>`;
    const w2Xml = callsignXml.replaceAll('W1AW', 'W2ABC');
    const w3Xml = callsignXml.replaceAll('W1AW', 'W3XYZ');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(xmlResponse(sessionXml))
      .mockResolvedValueOnce(xmlResponse(rateLimitedXml))
      .mockResolvedValueOnce(xmlResponse(callsignXml))
      .mockResolvedValueOnce(xmlResponse(w2Xml))
      .mockResolvedValueOnce(xmlResponse(w3Xml));

    const w1 = service.lookup('W1AW');
    const w2 = service.lookup('W2ABC');
    const w3 = service.lookup('W3XYZ');

    await vi.advanceTimersByTimeAsync(BATCH_DELAY_MS + REQUEST_SPACING_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(
      '[QRZ] Rate limited; adaptive backoff applied.',
      expect.objectContaining({
        signal: 'session',
        httpStatus: null,
        nextRequestSpacingMs: 400,
      }),
    );

    await vi.advanceTimersByTimeAsync(399);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(w1).resolves.toMatchObject({ callsign: 'W1AW' });

    await vi.advanceTimersByTimeAsync(399);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    await expect(w2).resolves.toMatchObject({ callsign: 'W2ABC' });

    await vi.advanceTimersByTimeAsync(299);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    await expect(w3).resolves.toMatchObject({ callsign: 'W3XYZ' });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('uses the memory cache for repeated callsigns', async () => {
    service.setCredentials({ username: 'k0swe', password: 'secret' });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(xmlResponse(sessionXml))
      .mockResolvedValueOnce(xmlResponse(callsignXml));

    const firstLookup = service.lookup('W1AW');
    await vi.advanceTimersByTimeAsync(BATCH_DELAY_MS + REQUEST_SPACING_MS);
    const first = await firstLookup;
    const second = await service.lookup('W1AW');

    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses the persistent cache in a new service instance', async () => {
    service.setCredentials({ username: 'k0swe', password: 'secret' });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(xmlResponse(sessionXml))
      .mockResolvedValueOnce(xmlResponse(callsignXml));

    const firstLookup = service.lookup('W1AW');
    await vi.advanceTimersByTimeAsync(BATCH_DELAY_MS + REQUEST_SPACING_MS);
    await firstLookup;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const newService = TestBed.inject(QrzService);

    await expect(newService.lookup('W1AW')).resolves.toMatchObject({
      callsign: 'W1AW',
      state: 'CT',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('normalizes names already stored in the persistent cache', async () => {
    service.setCredentials({ username: 'k0swe', password: '***' });
    localStorage.setItem(
      'qrz-directory-cache-v1',
      JSON.stringify({
        entries: {
          'K0SWE:W1AW': {
            cachedAt: Date.now(),
            record: {
              callsign: 'W1AW',
              state: 'CT',
              country: 'United States',
              name: 'JAMES N "Noel" WARF',
              grid: 'FN31pr',
            },
          },
        },
      }),
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(service.lookup('W1AW')).resolves.toMatchObject({
      name: 'James N "Noel" Warf',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem('qrz-directory-cache-v1')).toContain('James N');
  });

  it('refreshes a persistent cache entry after seven days', async () => {
    service.setCredentials({ username: 'k0swe', password: 'secret' });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(xmlResponse(sessionXml))
      .mockResolvedValueOnce(xmlResponse(callsignXml))
      .mockResolvedValueOnce(xmlResponse(callsignXml));

    const firstLookup = service.lookup('W1AW');
    await vi.advanceTimersByTimeAsync(BATCH_DELAY_MS + REQUEST_SPACING_MS);
    await firstLookup;
    vi.setSystemTime(Date.now() + CACHE_TTL_MS);

    const refreshedLookup = service.lookup('W1AW');
    await vi.advanceTimersByTimeAsync(BATCH_DELAY_MS);
    await refreshedLookup;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('scopes persistent cache entries by QRZ username', async () => {
    service.setCredentials({ username: 'k0swe', password: 'secret' });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(xmlResponse(sessionXml))
      .mockResolvedValueOnce(xmlResponse(callsignXml))
      .mockResolvedValueOnce(xmlResponse(sessionXml))
      .mockResolvedValueOnce(xmlResponse(callsignXml));

    const firstLookup = service.lookup('W1AW');
    await vi.advanceTimersByTimeAsync(BATCH_DELAY_MS + REQUEST_SPACING_MS);
    await firstLookup;
    service.setCredentials({ username: 'another-user', password: 'secret' });
    const secondLookup = service.lookup('W1AW');
    await vi.advanceTimersByTimeAsync(BATCH_DELAY_MS + REQUEST_SPACING_MS);
    await secondLookup;

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('reports a useful error when credentials are not configured', async () => {
    const lookup = service.lookup('W1AW');
    const expectation = expect(lookup).rejects.toEqual(
      new QrzLookupError('Configure QRZ.com credentials to enable directory lookups.'),
    );
    await vi.advanceTimersByTimeAsync(BATCH_DELAY_MS);

    await expectation;
  });
});

function xmlResponse(xml: string): Response {
  return new Response(xml, {
    status: 200,
    headers: { 'Content-Type': 'application/xml' },
  });
}

function rateLimitResponse(retryAfterSeconds: number): Response {
  return new Response('Too many requests', {
    status: 429,
    headers: { 'Retry-After': String(retryAfterSeconds) },
  });
}

function requestBody(fetchMock: ReturnType<typeof vi.spyOn>, callIndex: number): URLSearchParams {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
  return init.body as URLSearchParams;
}
