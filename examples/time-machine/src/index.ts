/**
 * Time Machine - Save checkpoints, run dangerous commands, travel back in time
 *
 * A visual demo of Sandbox SDK's snapshot/restore feature.
 * Create save points like in a video game, experiment freely, restore when needed.
 */

import {
  handleExec,
  handleListCheckpoints,
  handleRestore,
  handleSaveCheckpoint
} from './api';
import { getHTML } from './ui/html';

export { Sandbox } from '@cloudflare/sandbox';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      // API routes
      if (url.pathname === '/api/exec' && request.method === 'POST') {
        return handleExec(request, env);
      }

      if (url.pathname === '/api/checkpoint' && request.method === 'POST') {
        return handleSaveCheckpoint(request, env);
      }

      if (url.pathname === '/api/restore' && request.method === 'POST') {
        return handleRestore(request, env);
      }

      if (url.pathname === '/api/checkpoints' && request.method === 'GET') {
        return handleListCheckpoints(env);
      }

      // Serve UI
      return new Response(getHTML(), {
        headers: { 'Content-Type': 'text/html' }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return Response.json({ error: message }, { status: 500 });
    }
  }
};
