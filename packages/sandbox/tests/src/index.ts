export { OpenCodeFixture } from '../../../../extensions/opencode/tests/eviction-fixture';
export { Sandbox } from '../../src/sandbox';
export { ProcessCapabilityRPCTestDO } from '../fixtures/process-capability-rpc';

export default {
  async fetch(): Promise<Response> {
    return new Response('sandbox test worker');
  }
};
