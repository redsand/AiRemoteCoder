"""
Gateway client for Python VNC runner.
Handles authentication, event sending, and command polling.
"""

import hashlib
import hmac
import json
import logging
import time
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional
import asyncio

import httpx


logger = logging.getLogger(__name__)


class RunAuth:
    """Manages authentication credentials for gateway communication."""

    def __init__(self, run_id: str, capability_token: str):
        self.run_id = run_id
        self.capability_token = capability_token
        self.hmac_secret = self._get_hmac_secret()

    @staticmethod
    def _get_hmac_secret() -> str:
        """Get HMAC secret from environment or use default."""
        import os
        return os.getenv('HMAC_SECRET', 'test-secret-key-min-32-chars-00000000')

    @staticmethod
    def _get_client_token() -> str:
        """Get client token from environment."""
        import os
        return os.getenv('AI_RUNNER_TOKEN', os.getenv('CLIENT_TOKEN', ''))

    def create_signature(
        self,
        method: str,
        path: str,
        body: str,
        timestamp: int,
        nonce: str,
    ) -> str:
        """Create SHA256 HMAC signature matching TypeScript implementation."""
        body_hash = hashlib.sha256(body.encode() if isinstance(body, str) else body).hexdigest()

        message = '\n'.join([
            method,
            path,
            body_hash,
            str(timestamp),
            nonce,
            self.run_id,
            self.capability_token,
        ])

        signature = hmac.new(
            self.hmac_secret.encode(),
            message.encode(),
            hashlib.sha256
        ).hexdigest()

        return signature


class Command:
    """Represents a command from gateway."""

    def __init__(self, command_id: str, command: str, arguments: Optional[Dict] = None):
        self.command_id = command_id
        self.command = command
        self.arguments = arguments or {}


class GatewayClient:
    """Async HTTP client for gateway communication."""

    def __init__(self, gateway_url: str, run_id: str, capability_token: str, verify_ssl: bool = True):
        self.gateway_url = gateway_url.rstrip('/')
        self.auth = RunAuth(run_id, capability_token)
        self.sequence = 0
        self.verify_ssl = verify_ssl
        self._client: Optional[httpx.AsyncClient] = None

    async def get_client(self) -> httpx.AsyncClient:
        """Lazy initialize and return HTTP client."""
        if self._client is None:
            self._client = httpx.AsyncClient(verify=self.verify_ssl, timeout=30.0)
        return self._client

    async def close(self):
        """Close HTTP client."""
        if self._client is not None:
            await self._client.aclose()

    async def send_event(
        self,
        event_type: str,
        data: str,
    ) -> None:
        """Send event to gateway."""
        timestamp = int(time.time())
        nonce = uuid.uuid4().hex[:16]
        body = json.dumps({
            'type': event_type,
            'data': data,
            'sequence': self.sequence,
        })

        signature = self.auth.create_signature('POST', '/api/ingest/event', body, timestamp, nonce)

        client = await self.get_client()
        headers = {
            'X-Signature': signature,
            'X-Timestamp': str(timestamp),
            'X-Nonce': nonce,
            'X-Run-Id': self.auth.run_id,
            'X-Capability-Token': self.auth.capability_token,
            'Content-Type': 'application/json',
        }

        try:
            response = await client.post(
                f'{self.gateway_url}/api/ingest/event',
                content=body,
                headers=headers,
            )
            response.raise_for_status()
            self.sequence += 1
            logger.debug(f'Event sent: {event_type}')
        except httpx.HTTPError as e:
            logger.error(f'Failed to send event: {e}')
            raise

    async def poll_commands(self) -> List[Command]:
        """Poll gateway for pending commands."""
        timestamp = int(time.time())
        nonce = uuid.uuid4().hex[:16]
        body = ''

        signature = self.auth.create_signature('GET', f'/api/runs/{self.auth.run_id}/commands', body, timestamp, nonce)

        client = await self.get_client()
        headers = {
            'X-Signature': signature,
            'X-Timestamp': str(timestamp),
            'X-Nonce': nonce,
            'X-Run-Id': self.auth.run_id,
            'X-Capability-Token': self.auth.capability_token,
        }

        try:
            response = await client.get(
                f'{self.gateway_url}/api/runs/{self.auth.run_id}/commands',
                headers=headers,
            )
            response.raise_for_status()
            data = response.json()
            command_list = data if isinstance(data, list) else data.get('commands', [])
            commands = [
                Command(cmd['id'], cmd['command'], cmd.get('arguments'))
                for cmd in command_list
            ]
            logger.debug(f'Polled {len(commands)} commands')
            return commands
        except httpx.HTTPError as e:
            logger.error(f'Failed to poll commands: {e}')
            return []

    async def ack_command(
        self,
        command_id: str,
        result: Optional[str] = None,
        error: Optional[str] = None,
    ) -> None:
        """Acknowledge command execution."""
        timestamp = int(time.time())
        nonce = uuid.uuid4().hex[:16]
        body = json.dumps({
            'result': result,
            'error': error,
        })

        signature = self.auth.create_signature(
            'POST',
            f'/api/runs/{self.auth.run_id}/commands/{command_id}/ack',
            body,
            timestamp,
            nonce,
        )

        client = await self.get_client()
        headers = {
            'X-Signature': signature,
            'X-Timestamp': str(timestamp),
            'X-Nonce': nonce,
            'X-Run-Id': self.auth.run_id,
            'X-Capability-Token': self.auth.capability_token,
            'Content-Type': 'application/json',
        }

        try:
            response = await client.post(
                f'{self.gateway_url}/api/runs/{self.auth.run_id}/commands/{command_id}/ack',
                content=body,
                headers=headers,
            )
            response.raise_for_status()
            logger.debug(f'Command acknowledged: {command_id}')
        except httpx.HTTPError as e:
            logger.error(f'Failed to acknowledge command: {e}')
            raise

    async def register_client(
        self,
        display_name: str,
        agent_id: str,
        capabilities: List[str],
    ) -> None:
        """Register client with gateway."""
        timestamp = int(time.time())
        nonce = uuid.uuid4().hex[:16]
        body = json.dumps({
            'displayName': display_name,
            'agentId': agent_id,
            'capabilities': capabilities,
        })

        signature = self.auth.create_signature('POST', '/api/clients/register', body, timestamp, nonce)

        client = await self.get_client()
        headers = {
            'X-Signature': signature,
            'X-Timestamp': str(timestamp),
            'X-Nonce': nonce,
            'X-Run-Id': self.auth.run_id,
            'X-Capability-Token': self.auth.capability_token,
            'X-Client-Token': self.auth._get_client_token(),
            'Content-Type': 'application/json',
        }

        try:
            response = await client.post(
                f'{self.gateway_url}/api/clients/register',
                content=body,
                headers=headers,
            )
            response.raise_for_status()
            logger.debug(f'Client registered: {agent_id}')
        except httpx.HTTPError as e:
            logger.error(f'Failed to register client: {e}')
            raise

    async def send_heartbeat(self, agent_id: str) -> None:
        """Send heartbeat to gateway."""
        timestamp = int(time.time())
        nonce = uuid.uuid4().hex[:16]
        body = json.dumps({'agentId': agent_id})

        signature = self.auth.create_signature('POST', '/api/clients/heartbeat', body, timestamp, nonce)

        client = await self.get_client()
        headers = {
            'X-Signature': signature,
            'X-Timestamp': str(timestamp),
            'X-Nonce': nonce,
            'X-Run-Id': self.auth.run_id,
            'X-Capability-Token': self.auth.capability_token,
            'X-Client-Token': self.auth._get_client_token(),
            'Content-Type': 'application/json',
        }

        try:
            response = await client.post(
                f'{self.gateway_url}/api/clients/heartbeat',
                content=body,
                headers=headers,
            )
            response.raise_for_status()
            logger.debug(f'Heartbeat sent')
        except httpx.HTTPError as e:
            logger.error(f'Failed to send heartbeat: {e}')
