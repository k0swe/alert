import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QrzLookupError, QrzService } from './qrz.service';

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
    TestBed.configureTestingModule({});
    service = TestBed.inject(QrzService);
  });

  it('stores credentials in browser local storage', () => {
    service.setCredentials({ username: ' k0swe ', password: 'secret' });

    expect(service.getCredentials()).toEqual({ username: 'k0swe', password: 'secret' });
    expect(service.hasCredentials()).toBe(true);
  });

  it('logs in and maps a callsign directory record', async () => {
    service.setCredentials({ username: 'k0swe', password: 'secret' });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(xmlResponse(sessionXml))
      .mockResolvedValueOnce(xmlResponse(callsignXml));

    await expect(service.lookup('w1aw')).resolves.toEqual({
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

    await expect(service.lookup('W1AW')).resolves.toMatchObject({ callsign: 'W1AW', state: 'CT' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('shares one login when several lookups start together', async () => {
    service.setCredentials({ username: 'k0swe', password: 'secret' });
    const w2Xml = callsignXml
      .replaceAll('W1AW', 'W2ABC')
      .replace('<state>CT</state>', '<state>NY</state>');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(xmlResponse(sessionXml))
      .mockResolvedValueOnce(xmlResponse(callsignXml))
      .mockResolvedValueOnce(xmlResponse(w2Xml));

    const [w1, w2] = await Promise.all([service.lookup('W1AW'), service.lookup('W2ABC')]);

    expect(w1.callsign).toBe('W1AW');
    expect(w2.callsign).toBe('W2ABC');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requestBody(fetchMock, 0).has('username')).toBe(true);
  });

  it('caches directory records for repeated callsigns', async () => {
    service.setCredentials({ username: 'k0swe', password: 'secret' });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(xmlResponse(sessionXml))
      .mockResolvedValueOnce(xmlResponse(callsignXml));

    const first = await service.lookup('W1AW');
    const second = await service.lookup('W1AW');

    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports a useful error when credentials are not configured', async () => {
    await expect(service.lookup('W1AW')).rejects.toEqual(
      new QrzLookupError('Configure QRZ.com credentials to enable directory lookups.'),
    );
  });
});

function xmlResponse(xml: string): Response {
  return new Response(xml, {
    status: 200,
    headers: { 'Content-Type': 'application/xml' },
  });
}

function requestBody(fetchMock: ReturnType<typeof vi.spyOn>, callIndex: number): URLSearchParams {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
  return init.body as URLSearchParams;
}
