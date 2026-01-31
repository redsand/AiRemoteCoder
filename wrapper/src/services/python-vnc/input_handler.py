"""
Cross-platform input simulation using pynput.
Handles mouse and keyboard events.
"""

import logging
from typing import Dict, Optional

from pynput.mouse import Controller as MouseController, Button
from pynput.keyboard import Controller as KeyController, Key, KeyCode


logger = logging.getLogger(__name__)

def _key_attr(name: str, fallback: Optional[str] = None):
    if hasattr(Key, name):
        return getattr(Key, name)
    if fallback and hasattr(Key, fallback):
        return getattr(Key, fallback)
    return None


class InputHandler:
    """Simulates mouse and keyboard input."""

    # Mapping of VNC key codes to pynput.keyboard.Key
    KEY_MAP = {
        65307: _key_attr('esc', 'escape'),
        65289: Key.tab,
        65299: Key.print_screen,
        65300: Key.scroll_lock,
        65301: Key.pause,

        65535: Key.delete,
        65288: Key.backspace,
        65293: Key.enter,
        65535: Key.delete,

        65361: Key.left,
        65362: Key.up,
        65363: Key.right,
        65364: Key.down,

        65365: Key.page_up,
        65366: Key.page_down,
        65367: Key.end,
        65368: Key.home,

        65470: Key.f1,
        65471: Key.f2,
        65472: Key.f3,
        65473: Key.f4,
        65474: Key.f5,
        65475: Key.f6,
        65476: Key.f7,
        65477: Key.f8,
        65478: Key.f9,
        65479: Key.f10,
        65480: Key.f11,
        65481: Key.f12,

        65505: Key.shift,
        65506: Key.shift,
        65507: Key.ctrl,
        65508: Key.ctrl,
        65513: Key.alt,
        65514: Key.alt,

        65511: Key.cmd,
        65512: Key.cmd,
    }

    def __init__(self):
        """Initialize input controllers."""
        self.mouse = MouseController()
        self.keyboard = KeyController()
        self.pressed_keys = set()

    def handle_pointer_event(self, event: Dict) -> None:
        """
        Handle pointer (mouse) event.

        Args:
            event: Dict with 'x', 'y', 'buttons' keys
        """
        try:
            x = event.get('x', 0)
            y = event.get('y', 0)
            buttons = event.get('buttons', {})

            # Move mouse
            self.mouse.position = (x, y)

            # Handle button clicks
            left = buttons.get('left', False)
            middle = buttons.get('middle', False)
            right = buttons.get('right', False)
            scroll_up = buttons.get('scroll_up', False)
            scroll_down = buttons.get('scroll_down', False)

            # Click buttons (simplified: just track state)
            if left:
                self.mouse.click(Button.left)
            if middle:
                self.mouse.click(Button.middle)
            if right:
                self.mouse.click(Button.right)

            # Handle scroll
            if scroll_up:
                self.mouse.scroll(0, 3)
            elif scroll_down:
                self.mouse.scroll(0, -3)

            logger.debug(f'Pointer event: ({x}, {y}) buttons={buttons}')
        except Exception as e:
            logger.error(f'Failed to handle pointer event: {e}')

    def handle_key_event(self, event: Dict) -> None:
        """
        Handle keyboard event.

        Args:
            event: Dict with 'key', 'down' keys
        """
        try:
            key_code = event.get('key', 0)
            is_down = event.get('down', False)

            # Convert VNC key code to pynput key
            key = self._vnckey_to_pynput(key_code)

            if key is None:
                logger.warning(f'Unknown key code: {key_code}')
                return

            if is_down:
                if key_code not in self.pressed_keys:
                    self.keyboard.press(key)
                    self.pressed_keys.add(key_code)
            else:
                if key_code in self.pressed_keys:
                    self.keyboard.release(key)
                    self.pressed_keys.discard(key_code)

            logger.debug(f'Key event: key={key_code} down={is_down}')
        except Exception as e:
            logger.error(f'Failed to handle key event: {e}')

    def _vnckey_to_pynput(self, vnc_key: int) -> Optional[any]:
        """
        Convert VNC key code to pynput Key or KeyCode.

        Args:
            vnc_key: VNC key code (X11 keysym)

        Returns:
            pynput Key/KeyCode or None
        """
        # Check special key map first
        if vnc_key in self.KEY_MAP:
            return self.KEY_MAP[vnc_key]

        # ASCII characters
        if 32 <= vnc_key <= 126:
            return chr(vnc_key)

        # Unicode characters (extended)
        if vnc_key > 255:
            return chr(vnc_key)

        return None

    def release_all(self) -> None:
        """Release all pressed keys."""
        for key_code in list(self.pressed_keys):
            try:
                key = self._vnckey_to_pynput(key_code)
                if key:
                    self.keyboard.release(key)
            except Exception as e:
                logger.error(f'Failed to release key {key_code}: {e}')

        self.pressed_keys.clear()


class SpecialKeys:
    """Helper for common key combinations."""

    @staticmethod
    def ctrl_alt_del(keyboard: KeyController) -> None:
        """Send Ctrl+Alt+Del."""
        keyboard.press(Key.ctrl)
        keyboard.press(Key.alt)
        keyboard.press(Key.delete)
        keyboard.release(Key.delete)
        keyboard.release(Key.alt)
        keyboard.release(Key.ctrl)

    @staticmethod
    def alt_tab(keyboard: KeyController) -> None:
        """Send Alt+Tab."""
        keyboard.press(Key.alt)
        keyboard.press(Key.tab)
        keyboard.release(Key.tab)
        keyboard.release(Key.alt)

    @staticmethod
    def alt_f4(keyboard: KeyController) -> None:
        """Send Alt+F4."""
        keyboard.press(Key.alt)
        keyboard.press(Key.f4)
        keyboard.release(Key.f4)
        keyboard.release(Key.alt)

    @staticmethod
    def windows_key(keyboard: KeyController) -> None:
        """Press Windows key."""
        keyboard.press(Key.cmd)
        keyboard.release(Key.cmd)
