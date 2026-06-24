import { Sandbox } from '../../src/sandbox';

export { Sandbox };

export default {
  async fetch(): Promise<Response> {
    return new Response('test worker');
  }
};
