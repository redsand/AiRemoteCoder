"""
Unit tests for gateway_client.py
Tests authentication, HTTP communication, and event streaming
"""

import unittest
import hashlib
import hmac
from unittest.mock import patch, MagicMock
from gateway_client import RunAuth, GatewayClient


class TestRunAuth(unittest.TestCase):
    """Test HMAC signature generation"""

    def setUp(self):
        self.run_id = 'test-run-123'
        self.token = 'test-token-abc'
        self.auth = RunAuth(self.run_id, self.token)

    def test_signature_generation(self):
        """Test HMAC SHA256 signature creation"""
        method = 'POST'
        path = '/api/ingest/event'
        body = '{"test": "data"}'
        timestamp = 1609459200
        nonce = 'abcd1234'

        sig = self.auth.create_signature(method, path, body, timestamp, nonce)

        # Verify signature is 64 character hex string
        self.assertEqual(len(sig), 64)
        self.assertTrue(all(c in '0123456789abcdef' for c in sig))

    def test_body_hash_consistency(self):
        """Test that body hash is consistent"""
        method = 'GET'
        path = '/api/runs/test-run-123/commands'
        body = ''
        timestamp = 1609459200
        nonce = 'nonce123'

        sig1 = self.auth.create_signature(method, path, body, timestamp, nonce)
        sig2 = self.auth.create_signature(method, path, body, timestamp, nonce)

        self.assertEqual(sig1, sig2)

    def test_different_body_different_signature(self):
        """Test that different bodies produce different signatures"""
        method = 'POST'
        path = '/api/ingest/event'
        timestamp = 1609459200
        nonce = 'nonce123'

        sig1 = self.auth.create_signature(method, path, '{"data": "1"}', timestamp, nonce)
        sig2 = self.auth.create_signature(method, path, '{"data": "2"}', timestamp, nonce)

        self.assertNotEqual(sig1, sig2)


class TestGatewayClient(unittest.TestCase):
    """Test GatewayClient HTTP communication"""

    def setUp(self):
        self.gateway_url = 'http://localhost:3100'
        self.run_id = 'test-run-123'
        self.token = 'test-token-abc'
        self.client = GatewayClient(self.gateway_url, self.run_id, self.token)

    @patch('gateway_client.httpx.AsyncClient')
    def test_client_initialization(self, mock_async_client):
        """Test client initialization"""
        self.assertEqual(self.client.gateway_url, self.gateway_url)
        self.assertEqual(self.client.auth.run_id, self.run_id)
        self.assertEqual(self.client.sequence, 0)

    def test_gateway_url_normalization(self):
        """Test that trailing slashes are removed"""
        client = GatewayClient('http://localhost:3100/', self.run_id, self.token)
        self.assertEqual(client.gateway_url, 'http://localhost:3100')


if __name__ == '__main__':
    unittest.main()
