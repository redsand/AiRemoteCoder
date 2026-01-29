# Python VNC Server

A cross-platform, pure Python VNC (Virtual Network Computing) server implementation with RFB (Remote FrameBuffer) protocol support. Designed as a replacement for binary VNC server dependencies (x11vnc, vncserver).

## Features

- **Cross-Platform**: Works on Windows, macOS, and Linux
- **Pure Python**: No external binary dependencies
- **RFB 3.8 Protocol**: Full compatibility with VNC clients
- **Screen Capture**: Fast cross-platform screen capture using mss
- **Input Simulation**: Mouse and keyboard control using pynput
- **Delta Compression**: Bandwidth optimization with region-based delta detection
- **Async Gateway Communication**: HMAC-authenticated HTTP client for gateway integration
- **Event Streaming**: Real-time event logging and status updates
- **Graceful Shutdown**: Signal handling for clean termination

## Architecture

### Module Structure

```
vnc_runner.py          # Main entry point and async event loop
├── gateway_client.py  # HMAC-authenticated HTTP client
├── vnc_server.py      # Core VNC server implementation
├── rfb_encoder.py     # RFB 3.8 protocol encoding
├── screen_capturer.py # Cross-platform screen capture
└── input_handler.py   # Mouse/keyboard input simulation
```

### Communication Flow

```
┌─────────────────────────────────┐
│  vnc_runner.py                  │
│  - Async event loop             │
│  - Command polling (2s)         │
│  - Heartbeat (30s)              │
└──────────────┬──────────────────┘
               │ HTTP (Events, Commands, Heartbeat)
               │ HMAC-signed requests
               ▼
┌──────────────────────────────────┐
│  Gateway                         │
│  - VNC Routes                    │
│  - WebSocket Tunneling           │
│  - Tunnel Manager                │
└──────────────┬──────────────────┘
               │ WebSocket (Binary RFB frames)
               │
               ▼
┌──────────────────────────────────┐
│  Web UI                          │
│  - noVNC Viewer                  │
│  - Input handling                │
└──────────────────────────────────┘
```

## Installation

### Prerequisites

- Python 3.8+
- pip package manager

### Setup

```bash
# Install dependencies
pip install -r requirements.txt
```

### Requirements

- **mss** 9.0+ - Ultra-fast cross-platform screen capture
- **httpx** 0.27+ - Async HTTP client
- **pynput** 1.7+ - Cross-platform input simulation
- **pillow** 10.0+ - Image processing
- **cryptography** 42.0+ - HMAC signatures
- **websockets** 12.0+ - WebSocket client

## Usage

### Running as VNC Runner

The script is spawned by the TypeScript `vnc-runner.ts` wrapper:

```bash
python3 vnc_runner.py \
  --run-id <RUN_ID> \
  --capability-token <TOKEN> \
  --gateway-url http://localhost:3100 \
  --width 1920 \
  --height 1080 \
  --framerate 30 \
  --display-mode screen
```

### Arguments

| Argument | Description | Default |
|----------|-------------|---------|
| `--run-id` | Unique run identifier (required) | - |
| `--capability-token` | Gateway authentication token (required) | - |
| `--gateway-url` | Gateway server URL (required) | - |
| `--width` | Screen width in pixels | 1920 |
| `--height` | Screen height in pixels | 1080 |
| `--framerate` | Target frames per second | 30 |
| `--display-mode` | `screen` or `window` | screen |
| `--insecure` | Skip SSL verification (dev only) | false |

## Configuration

### Environment Variables

```bash
export HMAC_SECRET="your-32-character-secret-key-here"
export GATEWAY_URL="http://localhost:3100"
```

### Screen Capture

The default monitor is the primary display (index 1). To capture a specific monitor:

```python
from screen_capturer import ScreenCapturer
capturer = ScreenCapturer(monitor=2)  # Second monitor
```

### Frame Rate & Performance

Target: 30 FPS with <100ms latency

```python
vnc = VNCServer(
    width=1920,
    height=1080,
    framerate=30,
    bpp=32  # 32-bit RGBA
)
```

## RFB Protocol Details

### Supported Encodings

- **Raw (0)**: Uncompressed pixel data
- **RRE (2)**: Run-Length Encoding (planned)
- **Hextile (5)**: Tile-based encoding (planned)
- **ZRLE (6)**: ZLIB RLE (planned)

### Current Implementation

Currently implements RFB 3.8 with Raw encoding. Frame updates are sent as:

```
FramebufferUpdate (type 0)
  └─ Rectangle
      ├─ Position (x, y)
      ├─ Size (width, height)
      ├─ Encoding (0 = Raw)
      └─ Pixel Data (RGBA, 4 bytes per pixel)
```

### Input Events

Supported input events:

- **KeyEvent (4)**: Keyboard input (X11 keysyms)
- **PointerEvent (5)**: Mouse movement and button clicks

## Performance Optimization

### Delta Compression

The `ScreenCapturerDelta` class implements block-based delta detection:

```python
from screen_capturer import ScreenCapturerDelta

capturer = ScreenCapturerDelta(
    monitor=1,
    block_size=16  # 16x16 pixel blocks
)

# Get only changed regions
dirty_regions = capturer.detect_dirty_regions()
```

### Frame Encoding

Multiple rectangles can be sent in a single update for efficiency:

```python
rectangles = [
    (x1, y1, w1, h1, data1, encoding1),
    (x2, y2, w2, h2, data2, encoding2),
    # ...
]
update = rfb_encoder.encode_multiple_rectangles(rectangles)
```

## Gateway Integration

### Event Types

The runner sends events to the gateway:

| Event | Description |
|-------|-------------|
| `marker` | Status markers (startup, shutdown) |
| `info` | Informational messages |
| `error` | Error messages |
| `stdout` | Standard output |
| `stderr` | Standard error |

### Commands

The runner handles these commands:

| Command | Effect |
|---------|--------|
| `__START_VNC_STREAM__` | Begin streaming RFB frames over WebSocket |
| `__STOP__` | Gracefully shutdown the runner |

## Testing

### Unit Tests

```bash
python -m unittest test_gateway_client.py
```

### Integration Test

```bash
# Start gateway
cd gateway && npm start

# Start wrapper
cd wrapper && npm start

# Create VNC run
curl -X POST http://localhost:3100/api/runs \
  -H "Content-Type: application/json" \
  -d '{"worker_type": "vnc"}'

# Start VNC runner (or use CLI)
python vnc_runner.py \
  --run-id <ID> \
  --capability-token <TOKEN> \
  --gateway-url http://localhost:3100

# Start streaming
curl -X POST http://localhost:3100/api/runs/<ID>/vnc/start

# Open web UI to view
open http://localhost:3000/runs/<ID>
```

## Security Considerations

### Authentication

- All gateway communication uses HMAC-SHA256 signatures
- Each request includes a unique nonce for replay protection
- Capability tokens are per-run credentials
- Timestamps validated with 5-minute clock skew tolerance

### Input Simulation

- Input events are simulated locally
- No remote execution capabilities
- Limited to mouse/keyboard operations
- Special keys require explicit keysym mapping

### Network Security

- WebSocket connections are validated against run database
- Only authenticated clients can access VNC streams
- Binary frames are not interpreted, only forwarded

## Troubleshooting

### Screen Capture Issues

**Problem**: "No monitor found" error

**Solution**: Verify monitor index
```python
import mss
mss_obj = mss.mss()
for i, monitor in enumerate(mss_obj.monitors):
    print(f"Monitor {i}: {monitor}")
```

### Gateway Connection Issues

**Problem**: "Failed to connect to gateway" error

**Solution**: Check gateway URL and HMAC_SECRET
```bash
export GATEWAY_URL="http://localhost:3100"
export HMAC_SECRET="your-32-character-secret-key"
```

### Input Not Working

**Problem**: Mouse/keyboard input not registered

**Solution**: May require elevated privileges (admin/sudo) on some systems
```bash
# Windows (run as Administrator)
python vnc_runner.py ...

# macOS/Linux (if needed)
sudo python3 vnc_runner.py ...
```

## Future Enhancements

### Protocol Improvements
- [ ] RRE (Run-Length Encoding)
- [ ] Hextile encoding
- [ ] ZLIB compression
- [ ] JPEG encoding for video content

### Performance
- [ ] Multi-threaded frame capture
- [ ] GPU-accelerated screen capture
- [ ] Adaptive frame rate
- [ ] Quality-based encoding selection

### Features
- [ ] Window-specific capture
- [ ] Multi-monitor support with selection
- [ ] Clipboard synchronization
- [ ] Audio passthrough
- [ ] Session recording

## References

- [RFB Protocol Specification](https://tools.ietf.org/html/rfc6143)
- [X11 Keysym Reference](https://cgit.freedesktop.org/xorg/proto/x11proto/tree/keysymdef.h)
- [mss Documentation](https://python-mss.readthedocs.io/)
- [pynput Documentation](https://pynput.readthedocs.io/)

## License

Part of the AiRemoteCoder project.

## Contributing

When contributing improvements:

1. Maintain cross-platform compatibility
2. Add unit tests for new functionality
3. Document configuration changes
4. Follow existing code style
5. Test on Windows, macOS, and Linux
