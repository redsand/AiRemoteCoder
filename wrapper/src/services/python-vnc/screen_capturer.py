"""
Cross-platform screen capture using mss library.
"""

import logging
from typing import Tuple, Optional
import io

import mss
from PIL import Image


logger = logging.getLogger(__name__)


class ScreenCapturer:
    """Captures screen frames and compares for delta detection."""

    def __init__(self, monitor: int = 1):
        """
        Initialize screen capturer.

        Args:
            monitor: Monitor index (1 = primary, 0 = all monitors)
        """
        self.mss = mss.mss()
        self.monitor = monitor
        self.last_frame = None
        self.width = None
        self.height = None
        self._init_dimensions()

    def _init_dimensions(self):
        """Initialize screen dimensions from monitor."""
        monitor = self.mss.monitors[self.monitor]
        self.width = monitor['width']
        self.height = monitor['height']
        logger.info(f'Screen dimensions: {self.width}x{self.height}')

    def capture_rgb(self) -> Tuple[bytes, int, int]:
        """
        Capture screen as RGB bytes.

        Returns:
            Tuple of (rgb_bytes, width, height)
        """
        try:
            screenshot = self.mss.grab(self.mss.monitors[self.monitor])

            # Convert BGRA to RGBA
            # mss returns BGRA format by default
            image_data = Image.frombytes('RGB', screenshot.size, screenshot.rgb)

            # For VNC, we need ARGB or RGBA 32-bit per pixel
            # Convert to RGBA
            rgba_image = image_data.convert('RGBA')
            rgba_bytes = rgba_image.tobytes()

            self.width = screenshot.width
            self.height = screenshot.height

            return rgba_bytes, self.width, self.height
        except Exception as e:
            logger.error(f'Failed to capture screen: {e}')
            raise

    def capture_pil(self) -> Image.Image:
        """
        Capture screen as PIL Image.

        Returns:
            PIL Image in RGB mode
        """
        try:
            screenshot = self.mss.grab(self.mss.monitors[self.monitor])
            image = Image.frombytes('RGB', screenshot.size, screenshot.rgb)
            self.width = screenshot.width
            self.height = screenshot.height
            return image
        except Exception as e:
            logger.error(f'Failed to capture screen: {e}')
            raise

    def get_dimensions(self) -> Tuple[int, int]:
        """Get screen dimensions (width, height)."""
        return self.width, self.height

    def detect_dirty_regions(self) -> list:
        """
        Detect regions that changed since last capture.

        Returns:
            List of (x, y, width, height) tuples for changed regions
        """
        current = self.capture_pil()

        if self.last_frame is None:
            self.last_frame = current
            return [(0, 0, self.width, self.height)]

        # For now, return full screen if any change detected
        # TODO: Implement actual delta detection using image diff
        self.last_frame = current
        return [(0, 0, self.width, self.height)]

    def cleanup(self):
        """Cleanup resources."""
        if self.mss:
            self.mss.close()


class ScreenCapturerDelta(ScreenCapturer):
    """Screen capturer with delta compression support."""

    def __init__(self, monitor: int = 1, block_size: int = 16):
        """
        Initialize with delta compression.

        Args:
            monitor: Monitor index
            block_size: Size of blocks for delta detection (16x16 pixels)
        """
        super().__init__(monitor)
        self.block_size = block_size
        self.last_frame_hash = None

    def detect_dirty_regions(self) -> list:
        """
        Detect changed regions using block-based comparison.

        Returns:
            List of (x, y, width, height) tuples for changed regions
        """
        current = self.capture_pil()

        if self.last_frame is None:
            self.last_frame = current
            self.last_frame_hash = None
            return [(0, 0, self.width, self.height)]

        # Get pixel data
        current_pixels = current.tobytes()
        last_pixels = self.last_frame.tobytes()

        # Simple comparison: if bytes differ, full redraw
        # TODO: Implement actual block-based delta detection
        if current_pixels != last_pixels:
            self.last_frame = current
            return [(0, 0, self.width, self.height)]

        return []

    def get_frame_bytes(self, bpp: int = 32) -> bytes:
        """
        Get current frame as raw bytes in specified format.

        Args:
            bpp: Bits per pixel (32 = RGBA)

        Returns:
            Raw pixel bytes
        """
        current = self.capture_pil()

        if bpp == 32:
            # Convert to RGBA
            rgba_image = current.convert('RGBA')
            return rgba_image.tobytes()
        elif bpp == 24:
            # Convert to RGB
            rgb_image = current.convert('RGB')
            return rgb_image.tobytes()
        else:
            raise ValueError(f'Unsupported bits per pixel: {bpp}')
