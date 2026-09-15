import {
  type S3GatewayBinding,
  type S3MountInspection,
  type S3MountOperationOptions,
  type S3MountRequest,
} from "./contracts.js";
import { inspectGuestMount, mountGuest, unmountGuest } from "./protocol.js";
import { assembleInspection } from "./reconcile.js";
import {
  S3_MOUNT_PROTOCOL_VERSION,
  canonicalizeMountPath,
  canonicalizeS3MountRequest,
  observedConfiguration,
} from "./request.js";
import { routeHost } from "./route.js";

type S3MountContainer = Pick<Container, "exec" | "interceptOutboundHttp">;

/**
 * Reconciles S3-compatible FUSE mounts in a caller-owned Container.
 *
 * The caller must start (or synchronously request the start of) the Container
 * before calling `mount()`. This class never starts, monitors, or replaces it.
 * Mounted data retains object-store and s3fs semantics; it is not a POSIX
 * filesystem and must not be used as one for locking or atomic rename designs.
 */
export class S3Mounts {
  readonly #container: S3MountContainer;
  readonly #gateway: S3GatewayBinding;

  constructor(container: S3MountContainer, gateway: S3GatewayBinding) {
    this.#container = container;
    this.#gateway = gateway;
  }

  /**
   * Creates, adopts, or safely repairs the requested mount.
   *
   * A compatible adoption refreshes gateway routing and verifies FUSE, but
   * does not add a fresh upstream metadata request. Use `inspect()` for that.
   */
  async mount(request: S3MountRequest, options: S3MountOperationOptions = {}): Promise<void> {
    const canonical = canonicalizeS3MountRequest(request);
    options.signal?.throwIfAborted();
    let installedRouteId: string | undefined;
    try {
      await mountGuest(
        this.#container,
        {
          protocolVersion: S3_MOUNT_PROTOCOL_VERSION,
          candidateRouteId: crypto.randomUUID(),
          mountPath: canonical.mountPath,
          configuration: observedConfiguration(canonical),
        },
        options,
        async (routeId) => {
          installedRouteId = routeId;
          const gateway = this.#gateway({
            props: {
              protocolVersion: S3_MOUNT_PROTOCOL_VERSION,
              mode: "active",
              routeId,
              source: canonical.source,
              keyPrefix: canonical.keyPrefix,
              access: canonical.access,
            },
          });
          try {
            await this.#container.interceptOutboundHttp(routeHost(routeId), gateway);
          } finally {
            if (options.signal?.aborted) {
              try {
                await this.#denyRoute(routeId);
              } catch {
                // The durable marker keeps the route discoverable for explicit cleanup.
              }
            }
          }
        },
      );
    } catch (error) {
      if (installedRouteId !== undefined) {
        try {
          await this.#denyRoute(installedRouteId);
        } catch {
          // Marker intent makes the route discoverable for later reconciliation.
        }
      }
      throw error;
    }
  }

  /**
   * Waits for an in-flight lifecycle operation on this path, captures serialized guest
   * attachment evidence, then probes its route without repairing it. Gateway and upstream
   * evidence may be newer than the guest snapshot. Use an AbortSignal to bound either wait.
   */
  async inspect(
    mountPath: string,
    options: S3MountOperationOptions = {},
  ): Promise<S3MountInspection> {
    const canonicalPath = canonicalizeMountPath(mountPath);
    const evidence = await inspectGuestMount(this.#container, canonicalPath, options);
    return assembleInspection(canonicalPath, evidence);
  }

  /**
   * Revokes a managed route before requesting a normal unmount.
   *
   * If route revocation fails, the guest mount is left untouched. If the normal
   * unmount fails, the route remains denied and a later call can safely retry.
   * This never falls back to force or lazy unmounting.
   */
  async unmount(mountPath: string, options: S3MountOperationOptions = {}): Promise<void> {
    const canonicalPath = canonicalizeMountPath(mountPath);
    await unmountGuest(this.#container, canonicalPath, options, (routeId) =>
      this.#denyRoute(routeId),
    );
  }

  async #denyRoute(routeId: string): Promise<void> {
    const denyGateway = this.#gateway({
      props: {
        protocolVersion: S3_MOUNT_PROTOCOL_VERSION,
        mode: "deny",
        routeId,
      },
    });
    await this.#container.interceptOutboundHttp(routeHost(routeId), denyGateway);
  }
}
