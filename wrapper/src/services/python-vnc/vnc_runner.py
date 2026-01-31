#!/usr/bin/env python3
"""
Main Python VNC Runner - streams desktop via RFB protocol over WebSocket.

Usage:
    python vnc_runner.py --run-id <id> --capability-token <token> --gateway-url <url>
"""

import asyncio
import argparse
import logging
import os
import signal
import socket
import sys
import json
import ssl
import struct
from datetime import datetime
from typing import Optional

import websockets
import websockets.exceptions
import inspect

deps_dir = os.path.join(os.path.dirname(__file__), '.deps')
if os.path.isdir(deps_dir):
    sys.path.insert(0, deps_dir)

from gateway_client import GatewayClient
from vnc_server import VNCServer
from rfb_encoder import RFBEncoder


# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(name)s] %(levelname)s: %(message)s',
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)


class PythonVNCRunner:
    """Main VNC runner integrating gateway communication with VNC server."""

    def __init__(self, args):
        """Initialize runner."""
        self.args = args
        self.gateway = GatewayClient(
            args.gateway_url,
            args.run_id,
            args.capability_token,
            verify_ssl=not args.insecure,
        )
        self.vnc = VNCServer(
            width=int(args.width),
            height=int(args.height),
            framerate=int(args.framerate),
        )

        # Use provided agent ID if set, otherwise generate one
        if args.agent_id:
            self.agent_id = args.agent_id
        else:
            hostname = socket.gethostname()
            self.agent_id = f'{hostname}-{os.urandom(4).hex()}'

        self.is_running = False
        self.streaming = False
        self.ws_connection = None

        # Event handles for graceful shutdown
        self.shutdown_event = asyncio.Event()

    async def start(self):
        """Start the VNC runner."""
        logger.info(f'Starting Python VNC Runner')
        logger.info(f'Gateway URL: {self.args.gateway_url}')
        logger.info(f'Run ID: {self.gateway.auth.run_id}')
        logger.info(f'Agent ID: {self.agent_id}')

        self.is_running = True

        try:
            # Register with gateway
            await self._register_client()

            # Send started marker with capabilities
            await self._send_started_marker()

            # Start background tasks
            tasks = [
                asyncio.create_task(self._command_poll_loop()),
                asyncio.create_task(self._heartbeat_loop()),
            ]

            # Wait for shutdown signal
            await self.shutdown_event.wait()

            # Cancel tasks
            for task in tasks:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

        except Exception as e:
            logger.error(f'Fatal error: {e}', exc_info=True)
            raise
        finally:
            await self.stop()

    async def stop(self):
        """Stop the VNC runner."""
        logger.info('Stopping VNC Runner')
        self.is_running = False

        if self.streaming:
            await self._stop_vnc_streaming()

        if self.ws_connection:
            await self.ws_connection.close()

        await self.gateway.close()
        self.vnc.cleanup()

    async def _register_client(self):
        """Register client with gateway."""
        capabilities = [
            'vnc_access',
            'remote_desktop',
            'mouse_control',
            'keyboard_control',
        ]

        try:
            await self.gateway.register_client(
                display_name=self.args.agent_label or f'Python VNC - {self.agent_id}',
                agent_id=self.agent_id,
                capabilities=capabilities,
            )
            logger.info('Client registered successfully')
        except Exception as e:
            logger.error(f'Failed to register client: {e}')
            raise

    async def _send_started_marker(self):
        """Send started marker indicating VNC is ready."""
        marker = {
            'event': 'started',
            'command': 'vnc',
            'workerType': 'vnc',
            'displayMode': self.args.display_mode,
            'resolution': f'{self.args.width}x{self.args.height}',
            'capabilities': ['vnc_access', 'remote_desktop', 'mouse_control', 'keyboard_control'],
            'agentId': self.agent_id,
        }

        try:
            await self.gateway.send_event('marker', json.dumps(marker))
            logger.info('Sent started marker')
        except Exception as e:
            logger.error(f'Failed to send started marker: {e}')
            raise

    async def _command_poll_loop(self):
        """Poll gateway for commands every 2 seconds."""
        while self.is_running:
            try:
                commands = await self.gateway.poll_commands()

                for cmd in commands:
                    await self._handle_command(cmd)

            except Exception as e:
                msg = str(e)
                if '429' in msg:
                    logger.warning('Rate limited while polling commands; backing off')
                    await asyncio.sleep(10)
                else:
                    logger.error(f'Error polling commands: {e}')

            await asyncio.sleep(int(os.getenv('VNC_COMMAND_POLL_INTERVAL', '5')))

    async def _heartbeat_loop(self):
        """Send heartbeat every 30 seconds."""
        while self.is_running:
            try:
                await self.gateway.send_heartbeat(self.agent_id)
            except Exception as e:
                logger.error(f'Error sending heartbeat: {e}')

            await asyncio.sleep(30)

    async def _handle_command(self, cmd):
        """Handle command from gateway."""
        command_id = getattr(cmd, 'command_id', None)
        if command_id is None:
            command_id = getattr(cmd, 'id', None)
        if command_id is None and isinstance(cmd, dict):
            command_id = cmd.get('id')
        command = getattr(cmd, 'command', None)
        if command is None and isinstance(cmd, dict):
            command = cmd.get('command')

        if not command_id:
            logger.error('Received command without command_id; skipping ack')
            return
        if not command:
            logger.error('Received command without command; skipping')
            return

        logger.info(f'Received command: {command}')

        try:
            if command == '__START_VNC_STREAM__':
                await self._start_vnc_streaming()
                await self.gateway.ack_command(command_id, result='VNC streaming started')

            elif command == '__STOP__':
                logger.info('Stop command received')
                self.shutdown_event.set()
                await self.gateway.ack_command(command_id, result='Stopping')

            else:
                # VNC doesn't execute arbitrary commands
                await self.gateway.ack_command(
                    command_id,
                    error='VNC runner does not execute commands',
                )

        except Exception as e:
            logger.error(f'Error handling command: {e}')
            await self.gateway.ack_command(command_id, error=str(e))

    async def _start_vnc_streaming(self):
        """Start VNC streaming over WebSocket with reconnection logic."""
        if self.streaming:
            logger.warning('VNC streaming already active')
            return

        logger.info('Starting VNC streaming')
        max_retries = 5
        retry_delay = 2

        for attempt in range(max_retries):
            try:
                # Open WebSocket to gateway
                ws_url = f'{self.args.gateway_url.replace("http", "ws")}/ws/vnc/{self.args.run_id}'
                logger.info(f'Connecting to {ws_url} (attempt {attempt + 1}/{max_retries})')

                # Add custom header to identify as Python VNC client
                extra_headers = {'X-VNC-Client': 'true'}
                connect_kwargs = {
                    'ping_interval': 30,
                    'ping_timeout': 10,
                }
                if self.args.insecure:
                    ctx = ssl.create_default_context()
                    ctx.check_hostname = False
                    ctx.verify_mode = ssl.CERT_NONE
                    connect_kwargs['ssl'] = ctx
                signature = inspect.signature(websockets.connect)
                params = signature.parameters
                if 'additional_headers' in params:
                    connect_kwargs['additional_headers'] = extra_headers
                elif 'extra_headers' in params:
                    connect_kwargs['extra_headers'] = extra_headers
                if 'user_agent_header' in params:
                    connect_kwargs['user_agent_header'] = 'python-vnc-runner'

                self.ws_connection = await websockets.connect(
                    ws_url,
                    **connect_kwargs,
                )

                self.streaming = True
                logger.info('WebSocket connected successfully')

                # Perform RFB handshake
                await self._perform_rfb_handshake()

                # Start message loop
                await self._message_loop()
                return

            except Exception as e:
                self.streaming = False
                if attempt < max_retries - 1:
                    logger.warning(f'Connection attempt {attempt + 1} failed: {e}. Retrying in {retry_delay}s...')
                    await asyncio.sleep(retry_delay)
                    retry_delay = min(retry_delay * 2, 30)  # Exponential backoff, max 30s
                else:
                    logger.error(f'Failed to start VNC streaming after {max_retries} attempts: {e}')
                    raise

    async def _stop_vnc_streaming(self):
        """Stop VNC streaming."""
        logger.info('Stopping VNC streaming')
        self.streaming = False

        if self.ws_connection:
            await self.ws_connection.close()
            self.ws_connection = None

    async def _perform_rfb_handshake(self):
        """Perform RFB protocol handshake with client."""
        if not self.ws_connection:
            raise RuntimeError('WebSocket not connected')

        await self.ws_connection.send(self.vnc.get_rfb_handshake())
        client_version = await self.ws_connection.recv()
        if isinstance(client_version, str):
            client_version = client_version.encode('utf-8')
        if not client_version or not client_version.startswith(b'RFB'):
            raise RuntimeError('Invalid client handshake')

        await self.ws_connection.send(self.vnc.get_security_types())
        _ = await self.ws_connection.recv()  # selected security type

        await self.ws_connection.send(self.vnc.get_security_result(True))
        client_init = await self.ws_connection.recv()
        if isinstance(client_init, str):
            client_init = client_init.encode('utf-8')
        self.vnc.rfb_encoder.parse_client_init(client_init)

        await self.ws_connection.send(self.vnc.get_server_init())

    async def _message_loop(self):
        """Handle incoming RFB messages and send frame updates."""
        if not self.ws_connection:
            return

        buffer = bytearray()

        try:
            while self.streaming and self.is_running:
                try:
                    data = await self.ws_connection.recv()
                except websockets.exceptions.ConnectionClosed:
                    logger.info('WebSocket connection closed')
                    self.streaming = False
                    break

                if isinstance(data, str):
                    continue

                buffer.extend(data)

                while True:
                    if len(buffer) < 1:
                        break

                    msg_type = buffer[0]

                    if msg_type == 0:
                        if len(buffer) < 20:
                            break
                        payload = bytes(buffer[:20])
                        del buffer[:20]
                        self.vnc.rfb_encoder.parse_set_pixel_format(payload)
                        continue

                    if msg_type == 2:
                        if len(buffer) < 4:
                            break
                        enc_count = struct.unpack('>H', buffer[2:4])[0]
                        total = 4 + enc_count * 4
                        if len(buffer) < total:
                            break
                        payload = bytes(buffer[:total])
                        del buffer[:total]
                        # encodings = [struct.unpack('>i', payload[4+i*4:8+i*4])[0] for i in range(enc_count)]
                        continue

                    if msg_type == 3:
                        if len(buffer) < 10:
                            break
                        incremental = buffer[1] == 1
                        x, y, w, h = struct.unpack('>HHHH', buffer[2:10])
                        del buffer[:10]
                        frame_data = await self.vnc.handle_framebuffer_update_request(incremental, x, y, w, h)
                        await self.ws_connection.send(frame_data)
                        continue

                    if msg_type == 4:
                        if len(buffer) < 8:
                            break
                        payload = bytes(buffer[:8])
                        del buffer[:8]
                        await self.vnc.handle_input_event(payload)
                        continue

                    if msg_type == 5:
                        if len(buffer) < 6:
                            break
                        payload = bytes(buffer[:6])
                        del buffer[:6]
                        await self.vnc.handle_input_event(payload)
                        continue

                    if msg_type == 6:
                        if len(buffer) < 8:
                            break
                        length = struct.unpack('>I', buffer[4:8])[0]
                        total = 8 + length
                        if len(buffer) < total:
                            break
                        payload = bytes(buffer[:total])
                        del buffer[:total]
                        await self.vnc.handle_input_event(payload)
                        continue

                    # Unknown message type; drop one byte to resync
                    buffer.pop(0)

        except Exception as e:
            logger.error(f'Error in message loop: {e}')
            self.streaming = False
            raise
        finally:
            await self._stop_vnc_streaming()

    async def run(self):
        """Run the VNC runner (entry point)."""
        # Setup signal handlers
        loop = asyncio.get_event_loop()

        def _signal_handler(sig):
            logger.info(f'Received signal {sig}')
            self.shutdown_event.set()

        for sig in [signal.SIGINT, signal.SIGTERM]:
            try:
                loop.add_signal_handler(sig, _signal_handler, sig)
            except NotImplementedError:
                signal.signal(sig, lambda s, f: _signal_handler(s))

        try:
            await self.start()
        except KeyboardInterrupt:
            logger.info('Interrupted')
        finally:
            await self.stop()


async def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description='Python VNC Runner - RFB-compatible remote desktop streaming'
    )
    parser.add_argument('--run-id', required=True, help='Run ID from gateway')
    parser.add_argument('--capability-token', required=True, help='Capability token for authentication')
    parser.add_argument('--gateway-url', required=True, help='Gateway server URL')
    parser.add_argument('--width', default='1920', help='Screen width')
    parser.add_argument('--height', default='1080', help='Screen height')
    parser.add_argument('--framerate', default='30', help='Target framerate')
    parser.add_argument('--display-mode', default='screen', help='Display mode (screen or window)')
    parser.add_argument('--insecure', action='store_true', help='Skip SSL verification (dev only)')
    parser.add_argument('--agent-id', default='', help='Agent ID for client registration')
    parser.add_argument('--agent-label', default='', help='Agent display label for client registration')

    args = parser.parse_args()

    runner = PythonVNCRunner(args)
    await runner.run()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info('Shutdown')
        sys.exit(0)
    except Exception as e:
        logger.error(f'Fatal error: {e}', exc_info=True)
        sys.exit(1)
