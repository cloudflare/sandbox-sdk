import type {
  CreateWorkspaceArchiveRequest,
  CreateWorkspaceArchiveResult,
  ExtractWorkspaceArchiveRequest,
  SandboxWorkspaceAPI
} from '@repo/shared';
import { RpcTarget } from 'capnweb';
import type { WorkspaceArchiveService } from '../services/workspace-archive-service';

export class WorkspaceRPCAPI extends RpcTarget implements SandboxWorkspaceAPI {
  readonly #service: WorkspaceArchiveService;

  constructor(service: WorkspaceArchiveService) {
    super();
    this.#service = service;
  }

  createArchive(
    request: CreateWorkspaceArchiveRequest
  ): Promise<CreateWorkspaceArchiveResult> {
    return this.#service.createArchive(request);
  }

  extractArchive(request: ExtractWorkspaceArchiveRequest): Promise<void> {
    return this.#service.extractArchive(request);
  }

  cleanupArchive(archivePath: string): Promise<void> {
    return this.#service.cleanupArchive(archivePath);
  }
}
