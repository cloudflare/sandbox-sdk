import { protocolError } from "../shared/errors.js";
import { type S3MountInspection } from "./contracts.js";
import { type GuestInspectionEvidence } from "./protocol.js";

export function assembleInspection(
  mountPath: string,
  evidence: GuestInspectionEvidence,
): S3MountInspection {
  const state = evidence.state;
  switch (state.kind) {
    case "absent":
      return { mountPath, attachment: { status: "absent" } };
    case "unmanaged":
      return {
        mountPath,
        attachment: { status: "unmanaged", filesystemType: state.filesystemType },
      };
    case "incompatible":
      return { mountPath, attachment: { status: "incompatible" } };
    case "stale":
      return {
        mountPath,
        attachment: { status: "stale", configuration: state.marker.configuration },
        gateway: gatewayFor(evidence),
      };
    case "managed":
      return {
        mountPath,
        attachment: { status: "managed", configuration: state.marker.configuration },
        fuse: state.fuse,
        gateway: gatewayFor(evidence),
      };
  }
}

function gatewayFor(
  evidence: GuestInspectionEvidence,
): Extract<GuestInspectionEvidence, { readonly gateway: object }>["gateway"] {
  if ("gateway" in evidence) return evidence.gateway;
  throw protocolError("sandbox-shim omitted managed mount gateway evidence");
}
