# v2 input routes

Start the existing host with `npm run start:host`, then open
`http://127.0.0.1:8787`. The default source is **ブラウザー操作**. Select
**Proコントローラー** to forward the first Gamepad API device visible to the
browser. On Windows, connect the Pro Controller over Bluetooth and press a
button after opening the page. The diagnostics show the device ID, raw button
indices, raw axes and the translated state. Adjust button indices in the
existing gamepad bindings panel if they differ. Stick axes use axes 0–3;
the browser must expose at least 16 buttons and four axes. No additional
driver or Node package is required for this route. Browser implementations
may map Nintendo face buttons differently. Verify the raw and translated
values before testing on a console.

The browser, Pro Controller and automation sources are exclusive. Switching
sources clears queued frames and sends a neutral frame before the next source
can send input. Closing the controller page, disconnecting the gamepad, or
losing input for 1.2 seconds sends neutral. The firmware's own 1.2-second
watchdog remains a second layer of protection.

## Local automation interface

The host already has one serial owner. A future DQM3 process connects to
`ws://127.0.0.1:8787/automation`; it never opens COM3. The controller page
must select **自動操作（ローカル）** first. Only one automation WebSocket is
accepted. The HTTP server and both WebSocket routes bind to loopback and
reject non-loopback peers. There is no authentication beyond local-machine
access; any local process able to connect can supply input while this source
is selected. Do not forward port 8787.

Send JSON at least every 1.2 seconds while active:

```json
{"type":"input","state":{"buttons":0,"hat":8,"lx":128,"ly":128,"rx":128,"ry":128}}
```

`buttons` is a 16-bit mask. Bits 0–13 are Y, B, A, X, L, R, ZL, ZR,
Minus, Plus, left stick click, right stick click, Home, Capture. `hat` is
0–7 clockwise from Up; 8 is released. Stick bytes are 0–255, with 128 at
center; X increases rightward and Y downward. Invalid or missing values
are sanitized to neutral or clamped by the host. The socket receives
`automation-status` messages containing `enabled`, `source`,
`serialConnected`, `bleConnected`, and `error`. It can optionally use the
existing `sid`/`edges` digital-edge envelope used by the browser; see
`apps/host/public/input-reliability.js`.

On source switch, automation input timeout, socket close, or serial failure,
the host sends neutral. Source switching is controlled by the page via
`/control`, not by the automation client. This release provides the local
endpoint and state contract; it does not implement a DQM3 client or modify
the DQM3 project.
