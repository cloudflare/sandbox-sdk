import { collectFile, type Sandbox } from '@cloudflare/sandbox';

const OPENCODE_STORAGE_DIR = '~/.local/share/opencode/storage';
const BACKUP_KEY_PREFIX = 'opencode-backup';

function uint8ArrayToBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 0x8000;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    chunks.push(String.fromCharCode.apply(null, chunk as unknown as number[]));
  }
  return btoa(chunks.join(''));
}

export async function restoreOpencodeBackup(
  sandbox: Sandbox<unknown>,
  bucket: R2Bucket
): Promise<boolean> {
  try {
    console.log('[RESTORE] Fetching backup from R2...');
    const key = BACKUP_KEY_PREFIX;
    const object = await bucket.get(key);

    if (!object) {
      console.log('[RESTORE] Backup object not found in R2');
      return false;
    }

    console.log('[RESTORE] Backup found, downloading...');
    const data = await object.arrayBuffer();
    const bytes = new Uint8Array(data);
    console.log('[RESTORE] Backup size:', bytes.length, 'bytes');

    const base64Data = uint8ArrayToBase64(bytes);

    const chunkSize = 100000;
    if (base64Data.length > chunkSize) {
      console.log('[RESTORE] Large backup, writing to file...');
      await sandbox.writeFile('/tmp/opencode-backup.b64', base64Data, {
        encoding: 'utf-8'
      });
      console.log('[RESTORE] Decoding base64...');
      const decodeResult = await sandbox.exec(
        'base64 -d /tmp/opencode-backup.b64 > /tmp/opencode-backup.tar.gz'
      );
      if (decodeResult.exitCode !== 0) {
        console.error('[RESTORE] Base64 decode failed:', decodeResult.stderr);
        await sandbox
          .exec('rm -f /tmp/opencode-backup.b64 /tmp/opencode-backup.tar.gz')
          .catch(() => {});
        return false;
      }
      await sandbox.exec('rm -f /tmp/opencode-backup.b64');
    } else {
      console.log('[RESTORE] Writing base64 data to file...');
      await sandbox.writeFile('/tmp/opencode-backup.b64', base64Data, {
        encoding: 'utf-8'
      });
      console.log('[RESTORE] Decoding base64...');
      const decodeResult = await sandbox.exec(
        'base64 -d /tmp/opencode-backup.b64 > /tmp/opencode-backup.tar.gz'
      );
      if (decodeResult.exitCode !== 0) {
        console.error('[RESTORE] Base64 decode failed:', decodeResult.stderr);
        await sandbox
          .exec('rm -f /tmp/opencode-backup.b64 /tmp/opencode-backup.tar.gz')
          .catch(() => {});
        return false;
      }
      await sandbox.exec('rm -f /tmp/opencode-backup.b64');
    }

    console.log('[RESTORE] Creating directory structure...');
    await sandbox.exec('mkdir -p ~/.local/share/opencode');

    console.log('[RESTORE] Extracting archive...');
    const extractResult = await sandbox.exec(
      'tar -xzf /tmp/opencode-backup.tar.gz -C ~/.local/share/opencode'
    );

    if (extractResult.exitCode !== 0) {
      console.error(
        '[RESTORE] Archive extraction failed:',
        extractResult.stderr
      );
      await sandbox.exec('rm -f /tmp/opencode-backup.tar.gz').catch(() => {});
      return false;
    }

    console.log('[RESTORE] Cleanup...');
    await sandbox.exec('rm -f /tmp/opencode-backup.tar.gz');

    console.log('[RESTORE] Restore completed successfully');
    return true;
  } catch (error) {
    console.error('[RESTORE] Restore failed with error:', error);
    await sandbox
      .exec('rm -f /tmp/opencode-backup.b64 /tmp/opencode-backup.tar.gz')
      .catch(() => {});
    return false;
  }
}

export async function backupOpencodeStorage(
  sandbox: Sandbox<unknown>,
  bucket: R2Bucket
): Promise<void> {
  try {
    console.log('[BACKUP] Starting backup of OpenCode storage...');

    // Check if storage directory exists
    const dirCheck = await sandbox.exec(
      'if [ -d ~/.local/share/opencode/storage ]; then echo exists; else echo missing; fi'
    );

    if (dirCheck.stdout.trim() !== 'exists') {
      console.log('[BACKUP] Storage directory does not exist, skipping backup');
      return;
    }

    // Check if storage has content
    const contentCheck = await sandbox.exec(
      'if [ -n "$(ls -A ~/.local/share/opencode/storage 2>/dev/null)" ]; then echo has_content; else echo empty; fi'
    );

    if (contentCheck.stdout.trim() !== 'has_content') {
      console.log('[BACKUP] Storage directory is empty, skipping backup');
      return;
    }

    console.log('[BACKUP] Creating archive...');
    const archiveResult = await sandbox.exec(
      `tar -czf /tmp/opencode-backup.tar.gz -C ~/.local/share/opencode storage`
    );

    if (archiveResult.exitCode !== 0) {
      console.error(
        '[BACKUP] Failed to create archive, exit code:',
        archiveResult.exitCode,
        'stderr:',
        archiveResult.stderr
      );
      return;
    }

    const checkResult = await sandbox.exec(
      'test -f /tmp/opencode-backup.tar.gz && echo exists || echo missing'
    );

    if (checkResult.stdout.trim() !== 'exists') {
      console.error('[BACKUP] Archive file was not created');
      return;
    }

    console.log('[BACKUP] Reading archive file...');
    const fileStream = await sandbox.readFileStream(
      '/tmp/opencode-backup.tar.gz'
    );
    const { content } = await collectFile(fileStream);

    if (!(content instanceof Uint8Array)) {
      console.error('[BACKUP] Failed to read archive file content');
      return;
    }

    console.log('[BACKUP] Uploading to R2, size:', content.length, 'bytes');
    const key = BACKUP_KEY_PREFIX;
    await bucket.put(key, content);

    console.log('[BACKUP] Backup completed successfully');

    await sandbox.exec('rm -f /tmp/opencode-backup.tar.gz');
  } catch (error) {
    console.error('[BACKUP] Backup failed with error:', error);
    await sandbox.exec('rm -f /tmp/opencode-backup.tar.gz').catch(() => {});
  }
}
