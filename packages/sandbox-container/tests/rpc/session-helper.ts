import type { RuntimeMetadata } from '@repo/shared';
import type { SandboxAPIDeps } from '@sandbox-container/control-plane';
import { SandboxControlAPI } from '@sandbox-container/control-plane';
import { ControlSession } from '@sandbox-container/control-plane/session';

const metadata: RuntimeMetadata = {
  runtimeIncarnationID: 'test-runtime',
  sandboxVersion: 'test-version',
  controlProtocolVersion: 1
};

export async function createActivatedSandboxControlAPI(
  deps: SandboxAPIDeps
): Promise<SandboxControlAPI> {
  const session = new ControlSession({
    metadata,
    connectionID: 'test-connection',
    peerCallback: undefined,
    registerControlCallback: () => {},
    clearControlCallback: () => {}
  });
  await session.activate(metadata.runtimeIncarnationID);
  return new SandboxControlAPI(deps, session);
}
