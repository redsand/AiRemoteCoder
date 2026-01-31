"""
Cross-platform screen capture using mss library.
"""

import logging
from typing import Tuple, Optional
import io

try:
    import mss
except Exception as e:
    raise RuntimeError(
        "Missing Python dependency 'mss'. Rebuild the wrapper with "
        "'npm run build -w wrapper' or install with 'pip install mss'."
    ) from e
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

        # Quick check: if sizes differ or content identical
        if len(current_pixels) != len(last_pixels):
            self.last_frame = current
            return [(0, 0, self.width, self.height)]

        if current_pixels == last_pixels:
            return []

        # Block-based delta detection
        dirty_regions = self._find_dirty_blocks(current, self.last_frame)
        self.last_frame = current

        # Merge adjacent dirty regions for efficiency
        return self._merge_regions(dirty_regions)

    def _find_dirty_blocks(self, current_img: Image.Image, last_img: Image.Image) -> list:
        """
        Find dirty blocks by comparing pixel data.

        Args:
            current_img: Current frame as PIL Image
            last_img: Last frame as PIL Image

        Returns:
            List of (x, y, width, height) tuples
        """
        dirty_regions = []
        current_pixels = current_img.tobytes()
        last_pixels = last_img.tobytes()
        bytes_per_pixel = self.vnc.bytes_per_pixel if hasattr(self, 'vnc') else 4

        # Scan blocks
        for block_y in range(0, self.height, self.block_size):
            for block_x in range(0, self.width, self.block_size):
                block_h = min(self.block_size, self.height - block_y)
                block_w = min(self.block_size, self.width - block_x)

                # Check if block changed
                if self._block_changed(
                    current_pixels, last_pixels,
                    block_x, block_y, block_w, block_h,
                    bytes_per_pixel
                ):
                    dirty_regions.append((block_x, block_y, block_w, block_h))

        return dirty_regions

    def _block_changed(
        self,
        current: bytes,
        last: bytes,
        x: int,
        y: int,
        w: int,
        h: int,
        bytes_per_pixel: int
    ) -> bool:
        """Check if a block changed."""
        stride = self.width * bytes_per_pixel

        for row in range(h):
            row_start = (y + row) * stride + x * bytes_per_pixel
            row_end = row_start + w * bytes_per_pixel

            if current[row_start:row_end] != last[row_start:row_end]:
                return True

        return False

    def _merge_regions(self, regions: list) -> list:
        """
        Merge overlapping or adjacent regions to reduce overhead.

        Args:
            regions: List of (x, y, width, height) tuples

        Returns:
            Merged region list
        """
        if not regions:
            return []

        # Sort by position
        sorted_regions = sorted(regions, key=lambda r: (r[1], r[0]))

        merged = [sorted_regions[0]]
        for current in sorted_regions[1:]:
            last = merged[-1]

            # Check if regions can be merged (overlapping or adjacent)
            if self._can_merge(last, current):
                # Merge regions
                x1, y1, w1, h1 = last
                x2, y2, w2, h2 = current

                new_x = min(x1, x2)
                new_y = min(y1, y2)
                new_w = max(x1 + w1, x2 + w2) - new_x
                new_h = max(y1 + h1, y2 + h2) - new_y

                merged[-1] = (new_x, new_y, new_w, new_h)
            else:
                merged.append(current)

        return merged

    def _can_merge(self, r1: tuple, r2: tuple) -> bool:
        """Check if two regions can be merged."""
        x1, y1, w1, h1 = r1
        x2, y2, w2, h2 = r2

        # Check if regions overlap or are close (within block_size)
        margin = self.block_size

        return not (
            x1 + w1 + margin < x2 or
            x2 + w2 + margin < x1 or
            y1 + h1 + margin < y2 or
            y2 + h2 + margin < y1
        )

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
