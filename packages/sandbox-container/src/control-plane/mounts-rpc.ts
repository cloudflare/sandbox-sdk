import type {
  MountCommandResult,
  MountS3FSRequest,
  RemoveMountDirectoryRequest,
  SandboxMountsAPI
} from '@repo/shared';
import { RpcTarget } from 'capnweb';
import type { MountService } from '../services/mount-service';

type MountServiceAPI = Pick<
  MountService,
  | 'pathExists'
  | 'ensureDirectory'
  | 'chmodOwnerOnly'
  | 'deleteFile'
  | 'mountS3FS'
  | 'mountS3FSAndVerify'
  | 'isMountpoint'
  | 'unmountFuse'
  | 'unmountFuseIfMounted'
  | 'removeMountDirectory'
>;

export class MountsRPCAPI extends RpcTarget implements SandboxMountsAPI {
  readonly #service: MountServiceAPI;

  constructor(service: MountServiceAPI) {
    super();
    this.#service = service;
  }

  pathExists(path: string): Promise<boolean> {
    return this.#service.pathExists(path);
  }

  ensureDirectory(path: string): Promise<void> {
    return this.#service.ensureDirectory(path);
  }

  chmodOwnerOnly(path: string): Promise<void> {
    return this.#service.chmodOwnerOnly(path);
  }

  deleteFile(path: string): Promise<void> {
    return this.#service.deleteFile(path);
  }

  mountS3FS(request: MountS3FSRequest): Promise<MountCommandResult> {
    return this.#service.mountS3FS(request);
  }

  mountS3FSAndVerify(request: MountS3FSRequest): Promise<MountCommandResult> {
    return this.#service.mountS3FSAndVerify(request);
  }

  isMountpoint(path: string): Promise<boolean> {
    return this.#service.isMountpoint(path);
  }

  unmountFuse(path: string): Promise<MountCommandResult> {
    return this.#service.unmountFuse(path);
  }

  unmountFuseIfMounted(path: string): Promise<void> {
    return this.#service.unmountFuseIfMounted(path);
  }

  removeMountDirectory(
    request: RemoveMountDirectoryRequest
  ): Promise<MountCommandResult> {
    return this.#service.removeMountDirectory(request);
  }
}
