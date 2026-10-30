# Signal Bell

Signal Bell watches amateur-radio activity and calls attention to stations the operator wants to work. It currently receives live WSJT-X decodes through [`kel-agent`](https://github.com/k0swe/kel-agent), enriches callsigns with the QRZ.com XML directory, and alerts on selected US states.

## Current capabilities

- Live WSJT-X connection and decode status
- Heard-callsign list with signal report and UTC time
- QRZ.com directory lookup with local caching and adaptive rate limiting
- Configurable wanted-state alerts with sound and desktop notifications
- Alerted rows pinned until they age off
- WSJT-X callsign highlighting and an explicit **Call** action for actionable CQ/QRZ decodes
- QRZ profile links and an alert-aware bell favicon

## Repository layout

- `web/` — Angular browser application
- `docs/` — product and architecture notes

## Development

```bash
cd web
npm ci
npm start
```

Open <http://localhost:4200/>.

## Verification

```bash
cd web
npm run test:ci
npm run build
```

Signal Bell is licensed under the Apache License 2.0.
