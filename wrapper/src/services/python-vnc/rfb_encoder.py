"""
RFB (Remote FrameBuffer) protocol implementation for VNC.
Handles RFB handshake and frame encoding.
"""

import struct
import logging
from typing import Tuple, Optional
from io import BytesIO


logger = logging.getLogger(__name__)


class RFBEncoder:
    """Encodes frames into RFB protocol format."""

    RFB_VERSION = b'RFB 003.008\n'
    AUTH_NONE = 1

    def __init__(self, width: int, height: int, bpp: int = 32):
        self.width = width
        self.height = height
        self.bpp = bpp
        self.bytes_per_pixel = bpp // 8

    def get_server_init(self) -> bytes:
        """Create RFB ServerInit message."""
        buf = BytesIO()

        # Server Init format (from RFB spec):
        # CARD16 framebuffer width
        # CARD16 framebuffer height
        # PIXEL_FORMAT pixel format (16 bytes)
        # CARD32 name length
        # STRING name

        buf.write(struct.pack('>HH', self.width, self.height))

        # Pixel format (16 bytes)
        # CARD8 bits per pixel
        # CARD8 color depth
        # CARD8 big endian flag
        # CARD8 true color flag
        # CARD16 red max, green max, blue max
        # CARD8 red shift, green shift, blue shift
        # CARD8 padding

        pixel_format = struct.pack(
            '>BBBBHHHBBBxxx',
            self.bpp,           # bits per pixel (32)
            self.bpp,           # color depth (32)
            0,                  # little endian
            1,                  # true color
            255,                # red max
            255,                # green max
            255,                # blue max
            16,                 # red shift
            8,                  # green shift
            0,                  # blue shift
        )
        buf.write(pixel_format)

        # Name
        name = b'Python VNC Server'
        buf.write(struct.pack('>I', len(name)))
        buf.write(name)

        return buf.getvalue()

    def get_handshake(self) -> bytes:
        """Return RFB protocol handshake sequence."""
        return self.RFB_VERSION

    def get_security_types(self) -> bytes:
        """Return supported security types."""
        # Number of security types (1 byte) + security types
        return struct.pack('BB', 1, self.AUTH_NONE)

    def get_security_result(self, success: bool = True) -> bytes:
        """Return security result (0 = OK, non-zero = error)."""
        return struct.pack('>I', 0 if success else 1)

    def encode_frame_update(
        self,
        frame_data: bytes,
        x: int = 0,
        y: int = 0,
        width: Optional[int] = None,
        height: Optional[int] = None,
        encoding: int = 0,  # 0 = Raw, 1 = CopyRect, 2 = RRE, 5 = Hextile, 6 = ZRLE
    ) -> bytes:
        """Encode a frame update with specified encoding."""
        if width is None:
            width = self.width
        if height is None:
            height = self.height

        buf = BytesIO()

        # FramebufferUpdate message:
        # CARD8 type (0)
        # CARD8 padding
        # CARD16 number of rectangles
        # Rectangles...

        buf.write(struct.pack('>B', 0))     # type: FramebufferUpdate
        buf.write(struct.pack('>B', 0))     # padding
        buf.write(struct.pack('>H', 1))     # number of rectangles (single rectangle)

        # Rectangle:
        # CARD16 x position
        # CARD16 y position
        # CARD16 width
        # CARD16 height
        # INT32 encoding type

        buf.write(struct.pack('>HHHHH', x, y, width, height))
        buf.write(struct.pack('>i', encoding))

        # Add frame data
        if encoding == 0:
            # Raw encoding: just the pixel data
            buf.write(frame_data)
        elif encoding == 2:
            # RRE encoding would go here (for future implementation)
            buf.write(frame_data)
        elif encoding == 5:
            # Hextile encoding would go here (for future implementation)
            buf.write(frame_data)
        else:
            # Default to raw for unknown encodings
            buf.write(frame_data)

        return buf.getvalue()

    def encode_multiple_rectangles(self, rectangles: list) -> bytes:
        """Encode multiple rectangles in a single update.

        Args:
            rectangles: List of (x, y, width, height, data, encoding) tuples

        Returns:
            RFB FramebufferUpdate with multiple rectangles
        """
        buf = BytesIO()

        buf.write(struct.pack('>B', 0))              # type: FramebufferUpdate
        buf.write(struct.pack('>B', 0))              # padding
        buf.write(struct.pack('>H', len(rectangles)))  # number of rectangles

        for rect in rectangles:
            x, y, width, height, data, encoding = rect
            buf.write(struct.pack('>HHHHH', x, y, width, height))
            buf.write(struct.pack('>i', encoding))
            buf.write(data)

        return buf.getvalue()

    def encode_bell(self) -> bytes:
        """Encode a bell (beep) message."""
        return struct.pack('>B', 2)  # type: Bell

    def encode_server_cut_text(self, text: str) -> bytes:
        """Encode server cut text message."""
        text_bytes = text.encode('utf-8')
        buf = BytesIO()
        buf.write(struct.pack('>B', 3))  # type: ServerCutText
        buf.write(struct.pack('>Bxx', 0))  # padding
        buf.write(struct.pack('>I', len(text_bytes)))
        buf.write(text_bytes)
        return buf.getvalue()

    @staticmethod
    def parse_client_init(data: bytes) -> bool:
        """Parse ClientInit message."""
        # ClientInit: CARD8 shared-flag
        if len(data) < 1:
            return False
        shared = data[0]
        logger.debug(f'ClientInit: shared={shared}')
        return True

    @staticmethod
    def parse_set_pixel_format(data: bytes) -> Optional[dict]:
        """Parse SetPixelFormat message."""
        if len(data) < 20:
            return None

        # SetPixelFormat:
        # CARD8 type (0)
        # CARD8 padding (3 bytes)
        # PIXEL_FORMAT pixel format (16 bytes)

        bpp, color_depth, big_endian, true_color = struct.unpack('>BBBB', data[:4])
        red_max, green_max, blue_max = struct.unpack('>HHH', data[4:10])
        red_shift, green_shift, blue_shift = struct.unpack('>BBB', data[10:13])

        return {
            'bpp': bpp,
            'color_depth': color_depth,
            'big_endian': bool(big_endian),
            'true_color': bool(true_color),
            'red_max': red_max,
            'green_max': green_max,
            'blue_max': blue_max,
            'red_shift': red_shift,
            'green_shift': green_shift,
            'blue_shift': blue_shift,
        }

    @staticmethod
    def parse_key_event(data: bytes) -> Optional[dict]:
        """Parse KeyEvent message."""
        if len(data) < 8:
            return None

        # KeyEvent:
        # CARD8 type (4)
        # CARD8 down-flag
        # CARD16 padding
        # CARD32 key

        down_flag = data[0]
        key = struct.unpack('>I', data[4:8])[0]

        return {
            'type': 'key',
            'down': bool(down_flag),
            'key': key,
        }

    @staticmethod
    def parse_pointer_event(data: bytes) -> Optional[dict]:
        """Parse PointerEvent message."""
        if len(data) < 6:
            return None

        # PointerEvent:
        # CARD8 type (5)
        # CARD8 button-mask
        # CARD16 x
        # CARD16 y

        button_mask = data[0]
        x, y = struct.unpack('>HH', data[1:5])

        buttons = {
            'left': bool(button_mask & 1),
            'middle': bool(button_mask & 2),
            'right': bool(button_mask & 4),
            'scroll_up': bool(button_mask & 8),
            'scroll_down': bool(button_mask & 16),
        }

        return {
            'type': 'pointer',
            'buttons': buttons,
            'x': x,
            'y': y,
        }

    @staticmethod
    def parse_client_cut_text(data: bytes) -> Optional[dict]:
        """Parse ClientCutText message."""
        if len(data) < 8:
            return None

        # ClientCutText:
        # CARD8 type (6)
        # CARD8 padding (3 bytes)
        # CARD32 length

        length = struct.unpack('>I', data[4:8])[0]
        if len(data) < 8 + length:
            return None

        text = data[8:8 + length].decode('utf-8', errors='replace')

        return {
            'type': 'cut_text',
            'text': text,
        }
