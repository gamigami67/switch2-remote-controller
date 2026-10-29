# Switch 2 Remote Controller

[日本語](README.ja.md)

An experimental remote controller built around an ESP32-C3. A browser sends
controller state to a local Node.js bridge, the bridge writes compact EasyCon
frames over USB Serial/JTAG, and the ESP32-C3 presents the controller to a
Nintendo Switch 2 over Bluetooth LE.

> This is an unofficial community project and is not affiliated with or
> endorsed by Nintendo. Console updates may change controller compatibility.

## Architecture

```text
remote browser -- WebRTC DataChannel --> host browser
                                          |
                                          | loopback WebSocket
                                          v
                                    Node.js host bridge
                                          |
                                          | USB Serial/JTAG
                                          v
                                       ESP32-C3
                                          |
                                          | Bluetooth LE
                                          v
                                    Nintendo Switch 2

Cloudflare Worker: signaling and optional TURN credentials only
```

Controller input normally travels directly between browsers. The Cloudflare
Worker coordinates WebRTC setup and can provide TURN credentials; it does not
process the local USB connection.

## Supported hardware

- Generic ESP32-C3 boards with 4 MB flash and USB Serial/JTAG: headless profile.
- 2424S012C ESP32-C3 board with a 240x240 GC9A01 round LCD: optional LCD profile.
- A computer running Windows, macOS, or Linux with Node.js 24 and `uv`.

The headless build is the default and does not initialize the LCD SPI bus or
GPIOs. The 2424S012C display is already wired on-board as follows:

| GC9A01 signal | ESP32-C3 GPIO |
| --- | ---: |
| RST | 1 |
| DC | 2 |
| BL | 3 |
| SCK | 6 |
| MOSI | 7 |
| CS | 10 |

These pins are configured only by the LCD profile. Do not attach conflicting
peripherals when using that profile.

## Firmware

Install [uv](https://docs.astral.sh/uv/), then run:

```sh
uv sync --frozen
uv run --frozen python scripts/firmware.py build --profile headless
```

For the 2424S012C display build:

```sh
uv run --frozen python scripts/firmware.py build --profile lcd-2424s012c
```

Upload after replacing the port with your device path:

```sh
uv run --frozen python scripts/firmware.py upload --profile headless --port COM3
```

Use `/dev/ttyACM0` on many Linux systems or `/dev/cu.usbmodem*` on macOS. The
upload command verifies that the selected device is an ESP32-C3 before writing.
PlatformIO and the patched ESP-IDF package are isolated under `.cache`.

## Host application

```sh
npm ci
cp apps/host/.env.example apps/host/.env
# Edit ESP32_SERIAL_PORT in apps/host/.env
npm run start:host
```

Open `http://127.0.0.1:8787`. The bridge accepts local WebSocket clients only,
reconnects the configured serial port, preserves digital button edges, and
sends neutral input when the controller page disconnects.

For the browser, Pro Controller, and local automation input routes, see
[v2 input routes](docs/v2-input.md).

## Pairing

1. Flash either firmware profile and reconnect the ESP32-C3 with a USB data
   cable.
2. Start the host application and open its local URL.
3. Open the controller pairing screen on the Switch 2.
4. Press the on-screen or mapped **L** and **R** controls until the emulated
   controller appears, then complete pairing on the console.
5. Confirm buttons and sticks locally before creating a remote guest link.

Pairing data is saved in ESP32 flash. Keep the board powered and close the host
page before disconnecting the serial cable so the neutral-state safety path can
run.

## Remote access

```sh
npm run dev:signaling
```

The local Worker listens on `http://127.0.0.1:8788`, so it can run alongside
the host bridge on port 8787.

Deploy the Worker from the repository root with:

```sh
npm run deploy
```

For deployment, see [services/signaling/README.md](services/signaling/README.md).
TURN credentials must be stored with Wrangler secrets rather than committed to
the repository. The Worker configuration provides static assets, one Durable
Object binding named `ROOMS`, and optional `TURN_KEY_ID` / `TURN_KEY_API_TOKEN`
secrets. Controller input remains peer-to-peer even when signaling is deployed.

## Troubleshooting

- **Serial port is missing or rejected:** set `ESP32_SERIAL_PORT` in
  `apps/host/.env`; use Device Manager on Windows, `/dev/ttyACM*` on Linux, or
  `/dev/cu.*` on macOS. Linux users may also need serial-device group access.
- **Upload refuses the device:** the wrapper intentionally stops unless
  `esptool` identifies an ESP32-C3. Recheck the port and put the board in its
  bootloader mode if required by the board.
- **Controller is not discovered:** reopen the console pairing screen, power
  cycle the ESP32-C3, and check the serial diagnostics for BLE state changes.
- **LCD is blank:** build and upload `lcd-2424s012c`; the default headless image
  deliberately leaves its SPI bus and GPIOs untouched.
- **Remote guest cannot connect:** test on the same network first. Cross-NAT
  connections commonly require the TURN secrets described above.
- **Input returns to neutral:** this is expected after the host page disconnects
  or firmware receives no fresh input for 1.2 seconds.

## Verification

```sh
npm test
npm run check:signaling
uv run --frozen python scripts/check_public_tree.py
```

CI runs host tests on Windows, macOS, and Linux and builds both firmware
profiles on Linux. Hardware pairing, input, rumble, and watchdog behavior must
still be checked on a physical console before publishing a release binary.

## Safety and limitations

- Firmware clears queued input after 1.2 seconds without a fresh host frame.
- The host sends neutral state when its active controller page disconnects.
- BLE queue stalls and failed notifications have bounded recovery paths.
- ESP32-C3 support uses a non-standard 5 ms BLE interval and remains experimental.

Media intended for the README belongs in `docs/assets`; keep raw video outside
Git and commit only optimized images or poster frames.

## License

Project code is available under the MIT License. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for upstream firmware and
Espressif library attribution.
