/**
 * WebSocket connection hub and broadcaster.
 *
 * The broadcaster is created BEFORE the Express app and the ws server so that
 * both the HTTP controllers (which emit `transaction_added` / `block_mined`)
 * and the WebSocket hub (which owns the client set) share a single sink. This
 * breaks the circular dependency that the monolithic `server.ts` resolved with
 * module-level mutable state.
 */
import http from 'http';
import WebSocket from 'ws';
import type { AppConfig } from '../config';
import type { AppContext } from '../context';
import { handleProtocols, createVerifyClient } from './auth';
import { sendConnected, handleProtocolMessage } from './protocol';

/** A connected client and the event types it is subscribed to. */
export interface WebSocketClient {
  ws: WebSocket;
  subscriptions: Set<string>;
}

/** Shared broadcast sink + client registry. */
export interface Broadcaster {
  clients: Set<WebSocketClient>;
  broadcast(message: unknown, eventType?: string): void;
}

/**
 * Create an empty broadcaster. The client set is populated by
 * {@link attachWebSocket} as connections arrive.
 */
export function createBroadcaster(): Broadcaster {
  const clients = new Set<WebSocketClient>();
  return {
    clients,
    broadcast(message: unknown, eventType?: string): void {
      const messageStr = JSON.stringify(message);
      clients.forEach((client) => {
        try {
          // When an event type is given, deliver only to subscribed clients.
          if (eventType && !client.subscriptions.has(eventType)) {
            return;
          }
          client.ws.send(messageStr);
        } catch (error) {
          console.error('Error sending message to client:', error);
          clients.delete(client);
        }
      });
    },
  };
}

/** Options for {@link attachWebSocket}. */
export interface AttachWebSocketOptions {
  server: http.Server;
  config: AppConfig;
  ctx: AppContext;
  broadcaster: Broadcaster;
}

/**
 * M3: cap inbound WS frames at 64 KB (the ws default of 100 MiB is a
 * memory-exhaustion vector — protocol messages are tiny JSON commands) and
 * disable per-message deflate (compression bombs + CPU amplification).
 */
const WS_MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * Attach the WebSocket server to an existing HTTP server, wiring the origin +
 * API-key handshake, the connection lifecycle and the message protocol.
 */
export function attachWebSocket(opts: AttachWebSocketOptions): WebSocket.Server {
  const { server, config, ctx, broadcaster } = opts;

  const wss = new WebSocket.Server({
    server,
    handleProtocols,
    verifyClient: createVerifyClient(config),
    maxPayload: WS_MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });

  // M3: a server-level error (e.g. upgrade socket failure) must be logged —
  // an unhandled 'error' event on the wss would throw and crash the process.
  wss.on('error', (err: Error) => {
    console.error('WebSocket server error:', err);
  });

  wss.on('connection', (ws: WebSocket) => {
    console.log('New WebSocket connection');

    const client: WebSocketClient = {
      ws,
      subscriptions: new Set(['blockchain_info']), // subscribed to info by default
    };

    broadcaster.clients.add(client);

    // Push current state on connect.
    sendConnected(ws, ctx);

    ws.on('message', (message: string) => {
      handleProtocolMessage(ctx, client, ws, message);
    });

    ws.on('close', () => {
      console.log('WebSocket disconnected');
      broadcaster.clients.delete(client);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      broadcaster.clients.delete(client);
    });
  });

  return wss;
}
