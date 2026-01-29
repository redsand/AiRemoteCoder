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
from datetime import datetime
from typing import Optional

import websockets
import websockets.exceptions

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

        # Generate unique agent ID
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
                display_name=f'Python VNC - {self.agent_id}',
                agent_id=self.agent_id,
                capabilities=capabilities,
            )
            logger.info('Client registered successfully')
        except Exception as e:
            logger.error(f'Failed to register client: {e}')
            raise

    async def _send_started_marker(self):
        """Send started marker indicating VNC is ready."""
        marker = f'vnc_started:width={self.args.width},height={self.args.height},'
        marker += f'framerate={self.args.framerate},agent={self.agent_id}'

        try:
            await self.gateway.send_event('marker', marker)
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
                logger.error(f'Error polling commands: {e}')

            await asyncio.sleep(2)

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
        logger.info(f'Received command: {cmd.command}')

        try:
            if cmd.command == '__START_VNC_STREAM__':
                await self._start_vnc_streaming()
                await self.gateway.ack_command(cmd.command_id, result='VNC streaming started')

            elif cmd.command == '__STOP__':
                logger.info('Stop command received')
                self.shutdown_event.set()
                await self.gateway.ack_command(cmd.command_id, result='Stopping')

            else:
                # VNC doesn't execute arbitrary commands
                await self.gateway.ack_command(
                    cmd.command_id,
                    error='VNC runner does not execute commands',
                )

        except Exception as e:
            logger.error(f'Error handling command: {e}')
            await self.gateway.ack_command(cmd.command_id, error=str(e))

    async def _start_vnc_streaming(self):
        """Start VNC streaming over WebSocket."""
        if self.streaming:
            logger.warning('VNC streaming already active')
            return

        logger.info('Starting VNC streaming')

        try:
            # Open WebSocket to gateway
            ws_url = f'{self.args.gateway_url.replace("http", "ws")}/ws/vnc/{self.args.run_id}'
            logger.info(f'Connecting to {ws_url}')

            # Add custom header to identify as Python VNC client
            extra_headers = {'X-VNC-Client': 'true'}

            self.ws_connection = await websockets.connect(
                ws_url,
                ping_interval=30,
                ping_timeout=10,
                extra_headers=extra_headers,
            )

            self.streaming = True

            # Start streaming loop
            await self._stream_frames()

        except Exception as e:
            logger.error(f'Failed to start VNC streaming: {e}')
            self.streaming = False
            raise

    async def _stop_vnc_streaming(self):
        """Stop VNC streaming."""
        logger.info('Stopping VNC streaming')
        self.streaming = False

        if self.ws_connection:
            await self.ws_connection.close()
            self.ws_connection = None

    async def _stream_frames(self):
        """Stream VNC frames over WebSocket."""
        frame_interval = 1.0 / self.vnc.framerate

        try:
            while self.streaming and self.is_running:
                try:
                    # Capture and encode frame
                    frame_data = await self.vnc.capture_frame()

                    # Send over WebSocket (binary frame)
                    await self.ws_connection.send(frame_data)

                    # Control framerate
                    await asyncio.sleep(frame_interval)

                except websockets.exceptions.ConnectionClosed:
                    logger.info('WebSocket connection closed')
                    self.streaming = False
                    break

        except Exception as e:
            logger.error(f'Error streaming frames: {e}')
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
            loop.add_signal_handler(sig, _signal_handler, sig)

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
