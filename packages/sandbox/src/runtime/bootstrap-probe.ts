import type { RuntimeMetadata } from '@repo/shared';
import {
  ContainerControlConnection,
  type ContainerFetchStub
} from '../container-control/connection';
import { RuntimeControlProtocolError } from '../errors';
import type { RuntimeBootstrapProbe as RuntimeBootstrapProbeContract } from './types';

const CONTROL_PROTOCOL_VERSION = 1;

export type RuntimeBootstrapProbeOptions = {
  getTcpPort: (port: number) => ContainerFetchStub;
};

export function validateRuntimeMetadata(
  value: unknown,
  operation: string
): RuntimeMetadata {
  if (value == null) {
    throw new RuntimeControlProtocolError('Runtime metadata is missing', {
      reason: 'missing-metadata',
      operation
    });
  }
  if (typeof value !== 'object') {
    throw new RuntimeControlProtocolError('Runtime metadata is malformed', {
      reason: 'malformed-metadata',
      operation
    });
  }
  const metadata = value as Partial<RuntimeMetadata>;
  if (
    typeof metadata.runtimeIncarnationID !== 'string' ||
    metadata.runtimeIncarnationID.length === 0 ||
    typeof metadata.sandboxVersion !== 'string' ||
    metadata.sandboxVersion.length === 0
  ) {
    throw new RuntimeControlProtocolError('Runtime metadata is malformed', {
      reason: 'malformed-metadata',
      operation
    });
  }
  if (metadata.controlProtocolVersion !== CONTROL_PROTOCOL_VERSION) {
    throw new RuntimeControlProtocolError(
      'Runtime control protocol version is unsupported',
      {
        reason: 'unsupported-protocol-version',
        operation
      }
    );
  }
  return metadata as RuntimeMetadata;
}

export class RuntimeBootstrapProbe implements RuntimeBootstrapProbeContract {
  constructor(private readonly options: RuntimeBootstrapProbeOptions) {}

  async probe(): Promise<RuntimeMetadata> {
    const connection = new ContainerControlConnection({
      stub: this.options.getTcpPort(3000),
      retryTimeoutMs: 0
    });
    try {
      await connection.connect();
      return validateRuntimeMetadata(
        await connection.getRuntimeMetadata(),
        'utils.getRuntimeMetadata'
      );
    } finally {
      connection.disconnect();
    }
  }
}
