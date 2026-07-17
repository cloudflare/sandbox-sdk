/**
 * Checkpoint metadata displayed in the UI.
 */
export interface Checkpoint {
  id: string;
  name: string;
  createdAt: string;
  dir: string;
}

/**
 * Metadata stored by the SDK in R2 at backups/{id}/meta.json
 */
export interface BackupMetadata {
  id: string;
  dir: string;
  name: string | null;
  sizeBytes: number;
  ttl: number;
  createdAt: string;
}
