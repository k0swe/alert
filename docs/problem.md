# Problem Description

## Background

The operator is working toward the ARRL Worked All States (WAS) award for USA 250 and has only a few states left to confirm. WSJT-X exposes live decode and contact activity, but spotting a needed state in time currently requires continuous manual attention.

## Goal

Build a local Angular application that watches the operator's WSJT-X feed and provides an immediate alert when a decoded amateur-radio callsign appears to be in a state that is still needed for WAS.

## Intended workflow

1. Receive live WSJT-X activity through [`ngx-kel-agent`](https://github.com/k0swe/ngx-kel-agent).
2. Extract callsigns from relevant decodes or spots.
3. Query QRZ.com for callsign details, including the associated US state.
4. Compare the returned state with the operator's configurable list of needed states.
5. When a needed state is found, show a desktop notification and play an audible alert.

## Initial scope

- A browser-based Angular user interface under `web/`.
- Local configuration for the WSJT-X feed connection and needed-state list.
- QRZ.com lookup integration.
- Duplicate suppression or a cooldown so repeated decodes do not create an alert storm.
- Desktop notifications and an optional notification sound.
- Clear connection and lookup status in the UI.

## Constraints and open questions

- QRZ.com credentials and API subscription requirements must be handled without exposing secrets in browser code or source control.
- Browser notification and audio permissions require an explicit user interaction and may vary by platform.
- The precise `ngx-kel-agent` event shape and connection lifecycle need to be validated during integration.
- Callsign records may be missing, stale, portable, or associated with a mailing address that differs from the station's current transmitting location; alerts should therefore be treated as leads rather than guarantees.
- Persistence for settings and worked/needed-state data remains to be selected.
