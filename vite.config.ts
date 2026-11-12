import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * The standalone demo: one process serves the page and the two API routes.
 * The routes are the same Web-standard handlers a host app would mount.
 */
function liveVisionApi(): Plugin {
  return {
    name: 'live-vision-api',
    configureServer(server) {
      Object.assign(process.env, loadEnv(server.config.mode, process.cwd(), ''));

      const route = (name: 'turn' | 'watch') =>
        async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.end();
            return;
          }
          const { createLiveVisionHandlers } = (await server.ssrLoadModule(
            '/src/server/index.ts',
          )) as typeof import('./src/server/index');
          const abort = new AbortController();
          res.on('close', () => abort.abort());

          const response = await createLiveVisionHandlers()[name](
            new Request(`http://localhost${req.url ?? '/'}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: Readable.toWeb(req) as ReadableStream,
              duplex: 'half',
              signal: abort.signal,
            } as RequestInit),
          );

          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          if (!response.body) {
            res.end();
            return;
          }
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
          res.end();
        };

      server.middlewares.use('/api/turn', route('turn'));
      server.middlewares.use('/api/watch', route('watch'));
    },
  };
}

export default defineConfig({
  plugins: [react(), liveVisionApi()],
  server: { port: 8000 },
});
