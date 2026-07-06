// Worker entry for OpenCode DO-eviction tests.
//
// Re-exports the full SDK worker surface (so the container binding's `Sandbox`
// class resolves) and the OpenCode fixture DO the eviction test drives.

export * from '../../../packages/sandbox/src/index';
export { OpenCodeFixture } from './eviction-fixture';

export default {
  async fetch(): Promise<Response> {
    return new Response('opencode eviction test worker');
  }
};
