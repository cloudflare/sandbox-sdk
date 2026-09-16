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
 * Attaches an S3-compatible bucket or prefix to a running Container.
 *
 * Use this for a few long-lived mounts in one job or session. Calling `mount()`
 * again with the same settings reuses the existing mount. `unmount()` stops
 * access and unmounts the path. It does not fully clean up the Container's
 * intercept. For a new job or tenant, use a new sandbox name.
 *
 * Start the Container before calling `mount()`. This class never starts,
 * monitors, or replaces it. The mounted path is not a POSIX filesystem. Do not
 * use it for locking or atomic rename.
 */
export class S3Mounts {
  readonly #container: S3MountContainer;
  readonly #gateway: S3GatewayBinding;

  constructor(container: S3MountContainer, gateway: S3GatewayBinding) {
    this.#container = container;
    this.#gateway = gateway;
  }

  /**
   * Creates the mount, reuses a matching mount, or repairs leftover state.
   *
   * Reuse does not consume another Container intercept. Use `inspect()` to read
   * current state without changing it.
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
   * Reports the current path without changing it.
   *
   * Waits for an in-flight `mount()` or `unmount()` on the same path first.
   * Gateway evidence can be newer than the guest snapshot. Pass `signal` when
   * the application needs a deadline.
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
   * Stops new access, then unmounts the path.
   *
   * This does not remove the Container intercept. If denying access fails, the
   * filesystem stays mounted. If the filesystem is busy, access stays denied
   * and you can retry. This never force-unmounts.
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
