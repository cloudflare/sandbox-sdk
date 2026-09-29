import * as z from "zod/mini";

import {
  SandboxS3MountError,
  type S3MountOperation,
  type SandboxS3MountErrorCode,
  protocolError,
  s3MountError,
} from "../shared/errors.js";
import {
  type S3MountFuseInspection,
  type S3MountGatewayInspection,
  type S3MountObservedConfiguration,
  type S3MountOperationOptions,
} from "./contracts.js";
import { S3_MOUNT_PROTOCOL_VERSION } from "./request.js";
import {
  type ContainerExecutor,
  type JsonValue,
  parseJsonPayload,
  SHIM_PATH,
  type ShimControl,
  ShimSession,
} from "../shared/shim.js";

interface S3MountMarker {
  readonly protocolVersion: 1;
  readonly routeId: string;
  readonly mountPath: string;
  readonly configuration: S3MountObservedConfiguration;
}

type GuestMountState =
  | { readonly kind: "absent" }
  | { readonly kind: "unmanaged"; readonly filesystemType: string }
  | { readonly kind: "incompatible" }
  | { readonly kind: "stale"; readonly marker: S3MountMarker }
  | {
      readonly kind: "managed";
      readonly marker: S3MountMarker;
      readonly fuse: S3MountFuseInspection;
    };

export type GuestInspectionEvidence =
  | { readonly state: Exclude<GuestMountState, { readonly kind: "stale" | "managed" }> }
  | {
      readonly state: Extract<GuestMountState, { readonly kind: "stale" | "managed" }>;
      readonly gateway: S3MountGatewayInspection;
    };

export interface GuestMountRequest {
  readonly protocolVersion: 1;
  readonly candidateRouteId: string;
  readonly mountPath: string;
  readonly configuration: S3MountObservedConfiguration;
}

type RouteCallback = (routeId: string) => Promise<void>;

const ROUTE_READY = new Uint8Array([1]);
const routeIdSchema = z.string().check(z.regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,58}[A-Za-z0-9])?$/));
const keyPrefixSchema = z.optional(z.string().check(z.refine((value) => value.endsWith("/"))));
const s3fsOptionSchema = z.object({ name: z.string(), value: z.optional(z.string()) });
const observedConfigurationSchema = z.object({
  source: z.object({
    type: z.literal("s3"),
    endpoint: z.string(),
    region: z.string(),
    bucket: z.string(),
  }),
  keyPrefix: keyPrefixSchema,
  access: z.union([z.literal("read-only"), z.literal("read-write")]),
  s3fsOptions: z.array(s3fsOptionSchema),
});
const markerSchema = z.object({
  protocolVersion: z.literal(S3_MOUNT_PROTOCOL_VERSION),
  routeId: routeIdSchema,
  mountPath: z.string(),
  configuration: observedConfigurationSchema,
});
const fuseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("connected") }),
  z.object({ status: z.literal("disconnected") }),
  z.object({ status: z.literal("indeterminate"), detail: z.string() }),
]);
const guestStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }),
  z.object({ kind: z.literal("unmanaged"), filesystemType: z.string() }),
  z.object({ kind: z.literal("incompatible"), protocolVersion: z.number().check(z.int()) }),
  z.object({ kind: z.literal("stale"), marker: markerSchema }),
  z.object({ kind: z.literal("managed"), marker: markerSchema, fuse: fuseSchema }),
]);
const gatewayStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("gatewayUnreachable"), detail: z.string() }),
  z.object({
    kind: z.literal("gatewayError"),
    reason: z.union([
      z.literal("credential-provider"),
      z.literal("protocol"),
      z.literal("internal"),
    ]),
    detail: z.string(),
  }),
  z.object({ kind: z.literal("usable") }),
  z.object({ kind: z.literal("upstreamUnavailable"), detail: z.string() }),
  z.object({
    kind: z.literal("upstreamRejected"),
    reason: z.union([
      z.literal("credentials"),
      z.literal("access"),
      z.literal("not-found"),
      z.literal("other"),
    ]),
    detail: z.string(),
  }),
]);
const inspectionEvidenceSchema = z.object({
  state: guestStateSchema,
  gateway: z.optional(gatewayStateSchema),
});
const envelopeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.json() }),
  z.object({
    ok: z.literal(false),
    error: z.object({ kind: z.string(), detail: z.string() }),
  }),
]);
const routeSelectionSchema = z.object({ kind: z.literal("route"), routeId: routeIdSchema });

export function mountGuest(
  container: ContainerExecutor,
  request: GuestMountRequest,
  options: S3MountOperationOptions,
  installRoute: RouteCallback,
): Promise<void> {
  return invokeInteractive(
    container,
    ["mount", JSON.stringify(request)],
    "mount",
    request.mountPath,
    options,
    false,
    installRoute,
  );
}

export function inspectGuestMount(
  container: ContainerExecutor,
  mountPath: string,
  options: S3MountOperationOptions,
): Promise<GuestInspectionEvidence> {
  return invokeOnce(container, ["inspect", mountPath], "inspect", mountPath, options, (value) =>
    parseInspectionEvidence(value, mountPath),
  );
}

export function unmountGuest(
  container: ContainerExecutor,
  mountPath: string,
  options: S3MountOperationOptions,
  denyRoute: RouteCallback,
): Promise<void> {
  return invokeInteractive(
    container,
    ["unmount", mountPath],
    "unmount",
    mountPath,
    options,
    true,
    denyRoute,
  );
}

async function invokeInteractive(
  container: ContainerExecutor,
  command: readonly string[],
  operation: S3MountOperation,
  mountPath: string,
  options: S3MountOperationOptions,
  allowImmediateCompletion: boolean,
  handleRoute: RouteCallback,
): Promise<void> {
  const session = await startSession(container, command, options, true);
  let control: ShimControl | undefined;
  let input: WritableStreamDefaultWriter<Uint8Array> | undefined;

  try {
    control = session.openStdoutControl();
    const first = await readEnvelope(control, operation, mountPath);
    if (first === null) {
      if (!allowImmediateCompletion) {
        throw protocolError("sandbox-shim returned invalid S3 mount route selection");
      }
      await finishSession(session, control);
      session.finish();
      return;
    }
    const routeId = parseRouteSelection(first);
    if (routeId === undefined) {
      throw protocolError("sandbox-shim returned invalid S3 mount route selection");
    }

    await session.waitFor(handleRoute(routeId));
    options.signal?.throwIfAborted();
    input = session.openStdinWriter();
    await session.waitFor(input.write(ROUTE_READY));
    await session.waitFor(input.close());
    input.releaseLock();
    input = undefined;

    let terminal: JsonValue;
    try {
      terminal = await readEnvelope(control, operation, mountPath);
    } catch (error) {
      if (!SandboxS3MountError.is(error)) throw error;
      await finishSession(session, control);
      session.finish();
      control = undefined;
      throw error;
    }
    if (terminal !== null) {
      throw protocolError("sandbox-shim returned invalid S3 mount completion data");
    }
    await finishSession(session, control);
    session.finish();
  } catch (error) {
    session.terminate();
    if (input !== undefined) {
      void input.abort(error).then(
        () => input?.releaseLock(),
        () => input?.releaseLock(),
      );
    }
    control?.discard(error);
    throw error;
  }
}

async function invokeOnce<Value>(
  container: ContainerExecutor,
  command: readonly string[],
  operation: S3MountOperation,
  mountPath: string,
  options: S3MountOperationOptions,
  parseValue: (value: JsonValue) => Value | undefined,
): Promise<Value> {
  const session = await startSession(container, command, options, false);
  let control: ShimControl | undefined;

  try {
    control = session.openStdoutControl();
    const value = await readEnvelope(control, operation, mountPath);
    const parsed = parseValue(value);
    if (parsed === undefined) {
      throw protocolError("sandbox-shim returned invalid S3 mount command data");
    }
    await finishSession(session, control);
    session.finish();
    return parsed;
  } catch (error) {
    session.terminate();
    control?.discard(error);
    throw error;
  }
}

function startSession(
  container: ContainerExecutor,
  command: readonly string[],
  options: S3MountOperationOptions,
  interactive: boolean,
): Promise<ShimSession> {
  const execOptions: ContainerExecOptions = {
    signal: options.signal,
    stdout: "pipe",
    stderr: "ignore",
  };
  if (interactive) execOptions.stdin = "pipe";
  return ShimSession.start(container, [SHIM_PATH, "s3-mount", ...command], execOptions);
}

async function finishSession(session: ShimSession, control: ShimControl): Promise<void> {
  await control.expectEnd();
  const exitCode = await session.waitFor(session.process.exitCode);
  if (exitCode !== 0) throw protocolError(`sandbox-shim exited with code ${exitCode}`);
  control.releaseLock();
}

async function readEnvelope(
  control: ShimControl,
  operation: S3MountOperation,
  mountPath: string,
): Promise<JsonValue> {
  const frame = await control.readFrame();
  if (frame.kind !== "data") {
    throw protocolError("sandbox-shim did not return S3 mount command data");
  }

  const value = parseJsonPayload(
    frame.payload,
    "sandbox-shim returned invalid S3 mount command data",
  );
  return decodeEnvelope(value, operation, mountPath);
}

function decodeEnvelope(
  value: JsonValue,
  operation: S3MountOperation,
  mountPath: string,
): JsonValue {
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) {
    throw protocolError("sandbox-shim returned an invalid S3 mount result");
  }
  if (!parsed.data.ok) {
    const { detail, kind } = parsed.data.error;
    if (kind === "protocol") throw protocolError(detail);
    const code = errorCode(kind);
    if (code === undefined) {
      throw protocolError(`sandbox-shim returned unknown S3 mount error kind "${kind}"`);
    }
    throw s3MountError(code, operation, mountPath, detail);
  }
  return parsed.data.value;
}

function errorCode(kind: string): SandboxS3MountErrorCode | undefined {
  switch (kind) {
    case "busy":
      return "S3_MOUNT_BUSY";
    case "conflict":
      return "S3_MOUNT_CONFLICT";
    case "failed":
      return "S3_MOUNT_FAILED";
    case "incompatible":
      return "S3_MOUNT_INCOMPATIBLE";
    default:
      return undefined;
  }
}

function parseRouteSelection(value: JsonValue): string | undefined {
  const selection = routeSelectionSchema.safeParse(value);
  return selection.success ? selection.data.routeId : undefined;
}

function parseInspectionEvidence(
  value: JsonValue,
  expectedMountPath: string,
): GuestInspectionEvidence | undefined {
  const evidence = inspectionEvidenceSchema.safeParse(value);
  if (!evidence.success) return undefined;
  const state = parseGuestMountState(evidence.data.state, expectedMountPath);
  if (state === undefined) return undefined;
  if (state.kind !== "stale" && state.kind !== "managed") {
    return evidence.data.gateway === undefined ? { state } : undefined;
  }
  return evidence.data.gateway === undefined
    ? undefined
    : { state, gateway: parseGatewayState(evidence.data.gateway) };
}

function parseGuestMountState(
  state: z.infer<typeof guestStateSchema>,
  expectedMountPath: string,
): GuestMountState | undefined {
  switch (state.kind) {
    case "absent":
      return { kind: "absent" };
    case "unmanaged":
      return { kind: "unmanaged", filesystemType: state.filesystemType };
    case "incompatible":
      return { kind: "incompatible" };
    case "stale": {
      const marker = parseMarker(state.marker, expectedMountPath);
      return marker === undefined ? undefined : { kind: "stale", marker };
    }
    case "managed": {
      const marker = parseMarker(state.marker, expectedMountPath);
      const fuse = parseFuseState(state.fuse);
      return marker === undefined || fuse === undefined
        ? undefined
        : { kind: "managed", marker, fuse };
    }
    default:
      return undefined;
  }
}

function parseMarker(
  marker: z.infer<typeof markerSchema>,
  expectedMountPath: string,
): S3MountMarker | undefined {
  if (marker.mountPath !== expectedMountPath) return undefined;
  return {
    protocolVersion: S3_MOUNT_PROTOCOL_VERSION,
    routeId: marker.routeId,
    mountPath: expectedMountPath,
    configuration: marker.configuration,
  };
}

function parseFuseState(state: z.infer<typeof fuseSchema>): S3MountFuseInspection {
  return state;
}

function parseGatewayState(state: z.infer<typeof gatewayStateSchema>): S3MountGatewayInspection {
  switch (state.kind) {
    case "gatewayUnreachable":
      return { status: "unreachable", detail: state.detail };
    case "gatewayError":
      return { status: "error", reason: state.reason, detail: state.detail };
    case "usable":
      return { status: "reachable", upstream: { status: "usable" } };
    case "upstreamUnavailable":
      return {
        status: "reachable",
        upstream: { status: "unavailable", detail: state.detail },
      };
    case "upstreamRejected":
      return {
        status: "reachable",
        upstream: { status: "rejected", reason: state.reason, detail: state.detail },
      };
  }
}
