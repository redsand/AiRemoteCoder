"""
Integration tests for Python VNC system
Tests end-to-end flow from gateway communication to screen capture
"""

import unittest
import asyncio
from unittest.mock import patch, MagicMock, AsyncMock
from gateway_client import GatewayClient, Command
from vnc_server import VNCServer
from screen_capturer import ScreenCapturer, ScreenCapturerDelta
from rfb_encoder import RFBEncoder


class TestVNCIntegration(unittest.TestCase):
    """Test VNC server integration"""

    def setUp(self):
        self.vnc_server = VNCServer(width=800, height=600, framerate=30)

    def test_vnc_server_initialization(self):
        """Test VNC server initializes correctly"""
        self.assertEqual(self.vnc_server.width, 800)
        self.assertEqual(self.vnc_server.height, 600)
        self.assertEqual(self.vnc_server.framerate, 30)
        self.assertEqual(self.vnc_server.frame_counter, 0)

    def test_rfb_handshake(self):
        """Test RFB handshake sequence"""
        handshake = self.vnc_server.get_rfb_handshake()
        self.assertIn(b'RFB', handshake)
        self.assertIn(b'003.008', handshake)

    def test_server_init_message(self):
        """Test ServerInit message generation"""
        init = self.vnc_server.get_server_init()
        self.assertGreater(len(init), 20)  # Should have at least header + dimensions

    @patch('vnc_server.ScreenCapturer')
    async def test_frame_capture(self, mock_capturer_class):
        """Test frame capture process"""
        # This would test the actual capture flow
        # In practice, we'd mock the screen capture
        pass


class TestScreenCapture(unittest.TestCase):
    """Test screen capture functionality"""

    @patch('screen_capturer.mss.mss')
    def test_screen_capture_initialization(self, mock_mss):
        """Test screen capture initializes"""
        mock_mss_instance = MagicMock()
        mock_mss.return_value = mock_mss_instance
        mock_mss_instance.monitors = [
            {'x': 0, 'y': 0, 'width': 1920, 'height': 1080}
        ]

        capturer = ScreenCapturer(monitor=1)
        self.assertIsNotNone(capturer)

    @patch('screen_capturer.mss.mss')
    def test_delta_capturer_initialization(self, mock_mss):
        """Test delta compression capturer"""
        mock_mss_instance = MagicMock()
        mock_mss.return_value = mock_mss_instance
        mock_mss_instance.monitors = [
            {'x': 0, 'y': 0, 'width': 1920, 'height': 1080}
        ]

        capturer = ScreenCapturerDelta(monitor=1, block_size=16)
        self.assertEqual(capturer.block_size, 16)


class TestRFBEncoder(unittest.TestCase):
    """Test RFB frame encoding"""

    def setUp(self):
        self.encoder = RFBEncoder(width=800, height=600, bpp=32)

    def test_encoder_initialization(self):
        """Test encoder initializes correctly"""
        self.assertEqual(self.encoder.width, 800)
        self.assertEqual(self.encoder.height, 600)
        self.assertEqual(self.encoder.bpp, 32)

    def test_server_init_generation(self):
        """Test ServerInit message generation"""
        init = self.encoder.get_server_init()
        self.assertGreater(len(init), 24)  # Minimum size

    def test_security_types(self):
        """Test security type message"""
        sec_types = self.encoder.get_security_types()
        self.assertEqual(len(sec_types), 2)  # Count + Type

    def test_frame_encoding(self):
        """Test frame encoding"""
        # Create dummy frame data (800x600, 4 bytes per pixel)
        frame_data = b'\x00' * (800 * 600 * 4)

        update = self.encoder.encode_frame_update(
            frame_data,
            x=0, y=0,
            width=800, height=600,
            encoding=0  # Raw
        )

        self.assertGreater(len(update), len(frame_data))

    def test_multiple_rectangles(self):
        """Test encoding multiple rectangles"""
        rectangles = [
            (0, 0, 400, 300, b'\x00' * (400 * 300 * 4), 0),
            (400, 300, 400, 300, b'\xFF' * (400 * 300 * 4), 0),
        ]

        update = self.encoder.encode_multiple_rectangles(rectangles)
        self.assertGreater(len(update), 100)

    def test_key_event_parsing(self):
        """Test KeyEvent message parsing"""
        # KeyEvent: type(1) + down(1) + padding(2) + keysym(4)
        key_event_data = b'\x00' + b'\x01' + b'\x00\x00' + b'\x00\x00\x00\x41'  # 'A' key

        event = RFBEncoder.parse_key_event(key_event_data)
        self.assertIsNotNone(event)
        self.assertEqual(event['type'], 'key')
        self.assertTrue(event['down'])
        self.assertEqual(event['key'], 0x41)

    def test_pointer_event_parsing(self):
        """Test PointerEvent message parsing"""
        # PointerEvent: button_mask(1) + x(2) + y(2)
        pointer_data = b'\x01' + b'\x03\xC0' + b'\x02\x58'  # Button 0, X=960, Y=600

        event = RFBEncoder.parse_pointer_event(pointer_data)
        self.assertIsNotNone(event)
        self.assertEqual(event['type'], 'pointer')
        self.assertEqual(event['x'], 960)
        self.assertEqual(event['y'], 600)


class TestGatewayClientAsync(unittest.IsolatedAsyncioTestCase):
    """Async tests for gateway client"""

    async def test_gateway_client_initialization(self):
        """Test gateway client async initialization"""
        client = GatewayClient(
            'http://localhost:3100',
            'test-run-123',
            'test-token-abc'
        )

        self.assertIsNotNone(client)
        self.assertEqual(client.sequence, 0)

        await client.close()

    @patch('gateway_client.httpx.AsyncClient.post')
    async def test_send_event(self, mock_post):
        """Test event sending"""
        mock_response = AsyncMock()
        mock_response.raise_for_status = MagicMock()
        mock_post.return_value = mock_response

        client = GatewayClient(
            'http://localhost:3100',
            'test-run-123',
            'test-token-abc'
        )

        # Override the client for testing
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.aclose = AsyncMock()
        client._client = mock_client

        await client.send_event('info', 'Test event')

        self.assertEqual(client.sequence, 1)
        await client.close()


class TestEndToEnd(unittest.TestCase):
    """End-to-end integration tests"""

    def test_vnc_system_components_exist(self):
        """Test that all VNC components are available"""
        from gateway_client import GatewayClient
        from vnc_server import VNCServer
        from rfb_encoder import RFBEncoder
        from screen_capturer import ScreenCapturer
        from input_handler import InputHandler

        self.assertIsNotNone(GatewayClient)
        self.assertIsNotNone(VNCServer)
        self.assertIsNotNone(RFBEncoder)
        self.assertIsNotNone(ScreenCapturer)
        self.assertIsNotNone(InputHandler)

    def test_vnc_server_message_flow(self):
        """Test message flow through VNC server"""
        vnc = VNCServer(1920, 1080, 30)

        # Simulate connection setup
        handshake = vnc.get_rfb_handshake()
        self.assertIn(b'RFB', handshake)

        sec_types = vnc.get_security_types()
        self.assertGreater(len(sec_types), 0)

        security_result = vnc.get_security_result(True)
        self.assertGreater(len(security_result), 0)

        server_init = vnc.get_server_init()
        self.assertGreater(len(server_init), 0)

        vnc.cleanup()


def run_async_test(coro):
    """Helper to run async tests"""
    loop = asyncio.get_event_loop()
    return loop.run_until_complete(coro)


if __name__ == '__main__':
    unittest.main()
