"""
VNC server implementation for Python-based remote desktop.
Handles RFB protocol and frame streaming.
"""

import asyncio
import logging
import struct
from typing import Optional
from io import BytesIO

from screen_capturer import ScreenCapturer
from rfb_encoder import RFBEncoder
from input_handler import InputHandler


logger = logging.getLogger(__name__)


class VNCServer:
    """RFB-compatible VNC server for screen streaming."""

    def __init__(
        self,
        width: int = 1920,
        height: int = 1080,
        framerate: int = 30,
        bpp: int = 32,
    ):
        """
        Initialize VNC server.

        Args:
            width: Screen width
            height: Screen height
            framerate: Target framerate
            bpp: Bits per pixel (32 for RGBA)
        """
        self.width = width
        self.height = height
        self.framerate = framerate
        self.bpp = bpp
        self.bytes_per_pixel = bpp // 8

        self.screen_capturer = ScreenCapturer()
        self.rfb_encoder = RFBEncoder(width, height, bpp)
        self.input_handler = InputHandler()

        self.last_frame = None
        self.frame_counter = 0

    async def capture_frame(self) -> bytes:
        """
        Capture and encode a screen frame as RFB update.

        Returns:
            RFB FramebufferUpdate message bytes
        """
        try:
            # Capture screen
            rgb_bytes, cap_width, cap_height = self.screen_capturer.capture_rgb()

            # Resize to target dimensions if needed
            if cap_width != self.width or cap_height != self.height:
                logger.warning(
                    f'Screen size mismatch: {cap_width}x{cap_height} '
                    f'vs {self.width}x{self.height}'
                )

            # Create frame update
            frame_data = self.rfb_encoder.encode_frame_update(
                rgb_bytes,
                x=0,
                y=0,
                width=self.width,
                height=self.height,
            )

            self.last_frame = rgb_bytes
            self.frame_counter += 1

            return frame_data
        except Exception as e:
            logger.error(f'Failed to capture frame: {e}')
            raise

    async def handle_input_event(self, rfb_event: bytes) -> None:
        """
        Parse and handle RFB input event.

        Args:
            rfb_event: Raw RFB input event bytes
        """
        if not rfb_event or len(rfb_event) < 1:
            return

        event_type = rfb_event[0]

        try:
            if event_type == 4:  # KeyEvent
                event = self.rfb_encoder.parse_key_event(rfb_event[1:])
                if event:
                    self.input_handler.handle_key_event(event)

            elif event_type == 5:  # PointerEvent
                event = self.rfb_encoder.parse_pointer_event(rfb_event[1:])
                if event:
                    self.input_handler.handle_pointer_event(event)

            elif event_type == 6:  # ClientCutText
                event = self.rfb_encoder.parse_client_cut_text(rfb_event[1:])
                if event:
                    logger.debug(f'Clipboard: {event["text"][:50]}...')

            else:
                logger.warning(f'Unknown RFB event type: {event_type}')
        except Exception as e:
            logger.error(f'Failed to handle input event: {e}')

    async def handle_set_encodings(self, encodings: list) -> None:
        """
        Handle SetEncodings message from client.

        Args:
            encodings: List of encoding types
        """
        logger.debug(f'Client requested encodings: {encodings}')
        # Currently only support Raw encoding (0)

    async def handle_framebuffer_update_request(
        self,
        incremental: bool,
        x: int,
        y: int,
        width: int,
        height: int,
    ) -> bytes:
        """
        Handle FramebufferUpdateRequest from client.

        Args:
            incremental: If True, only send changed regions
            x, y, width, height: Update region

        Returns:
            RFB FramebufferUpdate message
        """
        return await self.capture_frame()

    def get_rfb_handshake(self) -> bytes:
        """Get RFB protocol handshake."""
        return self.rfb_encoder.get_handshake()

    def get_security_types(self) -> bytes:
        """Get supported security types."""
        return self.rfb_encoder.get_security_types()

    def get_security_result(self, success: bool = True) -> bytes:
        """Get security result."""
        return self.rfb_encoder.get_security_result(success)

    def get_server_init(self) -> bytes:
        """Get server init message."""
        return self.rfb_encoder.get_server_init()

    def cleanup(self):
        """Cleanup resources."""
        self.input_handler.release_all()
        self.screen_capturer.cleanup()


class RFBClientConnection:
    """Manages individual client connection state."""

    def __init__(self, client_id: str, vnc_server: VNCServer):
        """
        Initialize client connection.

        Args:
            client_id: Unique client identifier
            vnc_server: VNCServer instance
        """
        self.client_id = client_id
        self.vnc_server = vnc_server
        self.authenticated = False
        self.pixel_format = None
        self.encodings = []
        self.buffer = BytesIO()

    async def handle_client_init(self, data: bytes) -> bytes:
        """Handle ClientInit message."""
        self.rfb_encoder.parse_client_init(data)
        return self.vnc_server.get_server_init()

    async def handle_set_pixel_format(self, data: bytes) -> None:
        """Handle SetPixelFormat message."""
        self.pixel_format = self.rfb_encoder.parse_set_pixel_format(data)
        logger.debug(f'Client {self.client_id}: pixel format set to {self.pixel_format}')

    async def handle_set_encodings(self, data: bytes) -> None:
        """Handle SetEncodings message."""
        # Parse encoding list from data
        # For now, just log
        logger.debug(f'Client {self.client_id}: set encodings')

    async def send_update(self) -> bytes:
        """Send framebuffer update to client."""
        return await self.vnc_server.capture_frame()
