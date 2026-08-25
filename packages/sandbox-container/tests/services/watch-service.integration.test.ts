import { describe, expect, it } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createNoOpLogger } from '@repo/shared';
import { WatchService } from '@sandbox-container/services/watch-service';

const hasInotifywait =
  Bun.spawnSync(['sh', '-c', 'command -v inotifywait']).exitCode === 0;

describe('WatchService mount integration', () => {
  it.skipIf(!hasInotifywait)(
    'establishes a real watch outside /workspace',
    async () => {
      const root = `/tmp/sandbox-mount-watch-${crypto.randomUUID()}`;
      await mkdir(root, { recursive: true });
      const service = new WatchService(createNoOpLogger());
      try {
        const result = await service.watchMountDirectory(root, {
          path: root,
          recursive: true
        });
        expect(result.success).toBe(true);
        if (!result.success) return;
        const reader = result.data.getReader();
        const decoder = new TextDecoder();
        const ready = await reader.read();
        expect(decoder.decode(ready.value)).toContain('"type":"watching"');
        const filePath = `${root}/created.txt`;
        await writeFile(filePath, 'created');
        let eventText = '';
        for (let attempt = 0; attempt < 10; attempt++) {
          const event = await reader.read();
          eventText += decoder.decode(event.value);
          if (eventText.includes(filePath)) break;
        }
        expect(eventText).toContain(filePath);
        await reader.cancel();
      } finally {
        await service.stopAllWatches();
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});
