/**
 * WebSocket message protocol handlers.
 *
 * Extracted verbatim from the monolithic `server.ts` `wss.on('connection')`
 * body: the initial state push and the subscribe/unsubscribe/get_info message
 * switch. Behaviour and message shapes are unchanged.
 */
import type WebSocket from 'ws';
import type { AppContext } from '../context';
import { requireBlockchain } from '../context';
import type { WebSocketClient } from './hub';

/** Send the initial `connected` frame with the current blockchain info. */
export function sendConnected(ws: WebSocket, ctx: AppContext): void {
  ws.send(
    JSON.stringify({
      type: 'connected',
      data: requireBlockchain(ctx).getBlockchainInfo(),
      message: 'Connected to blockchain. Use subscribe/unsubscribe to manage subscriptions',
    })
  );
}

/** Handle a single inbound text message from a connected client. */
export function handleProtocolMessage(
  ctx: AppContext,
  client: WebSocketClient,
  ws: WebSocket,
  message: string
): void {
  try {
    const data = JSON.parse(message);

    switch (data.type) {
      case 'get_info':
        ws.send(
          JSON.stringify({
            type: 'blockchain_info',
            data: requireBlockchain(ctx).getBlockchainInfo(),
          })
        );
        break;

      case 'subscribe_blocks':
        client.subscriptions.add('block_mined');
        ws.send(
          JSON.stringify({
            type: 'subscribed',
            message: 'You are now subscribed to block_mined events',
            subscriptions: Array.from(client.subscriptions),
          })
        );
        break;

      case 'subscribe_transactions':
        client.subscriptions.add('transaction_added');
        ws.send(
          JSON.stringify({
            type: 'subscribed',
            message: 'You are now subscribed to transaction_added events',
            subscriptions: Array.from(client.subscriptions),
          })
        );
        break;

      case 'unsubscribe_blocks':
        client.subscriptions.delete('block_mined');
        ws.send(
          JSON.stringify({
            type: 'unsubscribed',
            message: 'You are now unsubscribed from block_mined events',
            subscriptions: Array.from(client.subscriptions),
          })
        );
        break;

      case 'unsubscribe_transactions':
        client.subscriptions.delete('transaction_added');
        ws.send(
          JSON.stringify({
            type: 'unsubscribed',
            message: 'You are now unsubscribed from transaction_added events',
            subscriptions: Array.from(client.subscriptions),
          })
        );
        break;

      case 'get_subscriptions':
        ws.send(
          JSON.stringify({
            type: 'subscriptions',
            subscriptions: Array.from(client.subscriptions),
          })
        );
        break;

      default:
        ws.send(
          JSON.stringify({
            type: 'error',
            message:
              'Unknown message type. Available: get_info, subscribe_blocks, subscribe_transactions, unsubscribe_blocks, unsubscribe_transactions, get_subscriptions',
          })
        );
    }
  } catch (error) {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
      })
    );
  }
}
