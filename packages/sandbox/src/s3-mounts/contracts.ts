type S3MountAccess = "read-only" | "read-write";

type S3MountCredentials =
  | {
      readonly type: "static";
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
      readonly sessionToken?: string;
    }
  | {
      readonly type: "provider";
      readonly fetcher: Pick<Fetcher, "fetch">;
    };

type S3MountSource = {
  readonly type: "s3";
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly credentials: S3MountCredentials;
};

type S3fsOptionValue = string | number | boolean;

export interface S3MountRequest {
  readonly mountPath: string;
  readonly source: S3MountSource;
  /** Optional object-key prefix. A non-empty value ends in `/`. */
  readonly keyPrefix?: string;
  readonly access: S3MountAccess;
  readonly s3fsOptions?: Readonly<Record<string, S3fsOptionValue>>;
}

interface S3MountOperationOptions {
  readonly signal?: AbortSignal;
}

interface S3MountObservedConfiguration {
  readonly source: {
    readonly type: "s3";
    readonly endpoint: string;
    readonly region: string;
    readonly bucket: string;
  };
  /** Omitted for the bucket root; otherwise canonical and slash-terminated. */
  readonly keyPrefix?: string;
  readonly access: S3MountAccess;
  readonly s3fsOptions: readonly {
    readonly name: string;
    readonly value?: string;
  }[];
}

type S3MountFuseInspection =
  | { readonly status: "connected" }
  | { readonly status: "disconnected" }
  | { readonly status: "indeterminate"; readonly detail: string };

type S3MountGatewayInspection =
  | { readonly status: "unreachable"; readonly detail: string }
  | {
      readonly status: "error";
      readonly reason: "credential-provider" | "protocol" | "internal";
      readonly detail: string;
    }
  | {
      readonly status: "reachable";
      readonly upstream:
        | { readonly status: "usable" }
        | { readonly status: "unavailable"; readonly detail: string }
        | {
            readonly status: "rejected";
            readonly reason: "credentials" | "access" | "not-found" | "other";
            readonly detail: string;
          };
    };

export type S3MountInspection =
  | {
      readonly mountPath: string;
      readonly attachment: { readonly status: "absent" };
    }
  | {
      readonly mountPath: string;
      readonly attachment: {
        readonly status: "unmanaged";
        readonly filesystemType: string;
      };
    }
  | {
      readonly mountPath: string;
      readonly attachment: { readonly status: "incompatible" };
    }
  | {
      readonly mountPath: string;
      readonly attachment: {
        readonly status: "stale";
        readonly configuration: S3MountObservedConfiguration;
      };
      readonly gateway: S3MountGatewayInspection;
    }
  | {
      readonly mountPath: string;
      readonly attachment: {
        readonly status: "managed";
        readonly configuration: S3MountObservedConfiguration;
      };
      readonly fuse: S3MountFuseInspection;
      readonly gateway: S3MountGatewayInspection;
    };

/** Props passed only to an active route-scoped `S3Gateway` service instance. */
interface ActiveS3GatewayProps {
  readonly protocolVersion: 1;
  readonly mode: "active";
  readonly routeId: string;
  readonly source: S3MountSource;
  readonly keyPrefix?: string;
  readonly access: S3MountAccess;
}

/** Props that deny requests after the matching mount is removed. */
interface DenyS3GatewayProps {
  readonly protocolVersion: 1;
  readonly mode: "deny";
  readonly routeId: string;
}

type S3GatewayProps = ActiveS3GatewayProps | DenyS3GatewayProps;

interface S3GatewayBinding {
  (options: { readonly props: S3GatewayProps }): Fetcher;
}

export type {
  ActiveS3GatewayProps,
  S3GatewayBinding,
  S3GatewayProps,
  S3MountAccess,
  S3MountCredentials,
  S3MountFuseInspection,
  S3MountGatewayInspection,
  S3MountObservedConfiguration,
  S3MountOperationOptions,
  S3MountSource,
  S3fsOptionValue,
};
