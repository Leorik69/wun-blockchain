/**
 * Key-management controllers.
 *
 * Extracted from `server.ts`. POST /api/keys/generate returns a fresh ECDSA key
 * pair; the response envelope is unchanged.
 */
import type { RequestHandler } from 'express';
import { generateKeyPair } from '../signature';

/** Create the keys controller handlers. */
export function createKeysController(): { generate: RequestHandler } {
  const generate: RequestHandler = (_req, res) => {
    try {
      const keyPair = generateKeyPair();
      res.json({
        success: true,
        keyPair,
        message: 'New key pair generated. Store privateKey securely!',
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  return { generate };
}
