const sandboxIdParameter = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description: 'Sandbox instance name.'
} as const;

const processIdParameter = {
  name: 'processId',
  in: 'path',
  required: true,
  schema: { type: 'string' }
} as const;

const processStatusResponse = {
  description: 'Process status.',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ProcessStatus' }
    }
  }
} as const;

export const PROCESSESPaths = {
  '/v1/sandbox/{id}/processes': {
    post: {
      operationId: 'createProcess',
      summary: 'Launch a sandbox process',
      parameters: [sandboxIdParameter],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ProcessCreateRequest' }
          }
        }
      },
      responses: {
        '200': processStatusResponse,
        '400': { $ref: '#/components/responses/InvalidRequest' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/InvalidRequest' },
        '502': { $ref: '#/components/responses/BadGateway' }
      }
    },
    get: {
      operationId: 'listProcesses',
      summary: 'List sandbox processes',
      parameters: [sandboxIdParameter],
      responses: {
        '200': {
          description: 'Process statuses.',
          content: {
            'application/json': {
              schema: {
                type: 'array',
                items: { $ref: '#/components/schemas/ProcessStatus' }
              }
            }
          }
        },
        '401': { $ref: '#/components/responses/Unauthorized' }
      }
    }
  },
  '/v1/sandbox/{id}/processes/{processId}': {
    get: {
      operationId: 'getProcess',
      summary: 'Get a sandbox process',
      parameters: [sandboxIdParameter, processIdParameter],
      responses: {
        '200': processStatusResponse,
        '401': { $ref: '#/components/responses/Unauthorized' },
        '404': { $ref: '#/components/responses/NotFound' }
      }
    }
  },
  '/v1/sandbox/{id}/processes/{processId}/logs': {
    get: {
      operationId: 'readProcessLogs',
      summary: 'Stream sandbox process logs',
      description:
        'Returns Server-Sent Events. stdout/stderr event data is base64-encoded at the bridge boundary only.',
      parameters: [
        sandboxIdParameter,
        processIdParameter,
        { name: 'since', in: 'query', schema: { type: 'string' } },
        { name: 'replay', in: 'query', schema: { type: 'boolean' } },
        { name: 'follow', in: 'query', schema: { type: 'boolean' } }
      ],
      responses: {
        '200': {
          description: 'SSE stream of process log events.',
          content: { 'text/event-stream': { schema: { type: 'string' } } }
        },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '404': { $ref: '#/components/responses/NotFound' }
      }
    }
  },
  '/v1/sandbox/{id}/processes/{processId}/kill': {
    post: {
      operationId: 'signalSandboxProcess',
      summary: 'Signal a sandbox process',
      parameters: [sandboxIdParameter, processIdParameter],
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                signal: {
                  type: 'integer',
                  minimum: 1,
                  maximum: 64,
                  default: 15
                }
              }
            }
          }
        }
      },
      responses: {
        '204': { description: 'Signal sent.' },
        '400': { $ref: '#/components/responses/InvalidRequest' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '404': { $ref: '#/components/responses/NotFound' }
      }
    }
  },
  '/v1/sandbox/{id}/tunnel/{port}': {
    post: {
      operationId: 'createTunnel',
      summary: 'Create or reuse a tunnel for a sandbox port',
      parameters: [
        sandboxIdParameter,
        {
          name: 'port',
          in: 'path',
          required: true,
          schema: { type: 'integer', minimum: 1024, maximum: 65535 }
        }
      ],
      responses: {
        '200': { description: 'Tunnel created or reused.' },
        '400': { $ref: '#/components/responses/InvalidRequest' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '502': { $ref: '#/components/responses/BadGateway' }
      }
    },
    delete: {
      operationId: 'deleteTunnel',
      summary: 'Delete the tunnel for a sandbox port',
      parameters: [
        sandboxIdParameter,
        {
          name: 'port',
          in: 'path',
          required: true,
          schema: { type: 'integer', minimum: 1024, maximum: 65535 }
        }
      ],
      responses: {
        '204': { description: 'Tunnel deleted or already absent.' },
        '400': { $ref: '#/components/responses/InvalidRequest' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '502': { $ref: '#/components/responses/BadGateway' }
      }
    }
  },
  '/v1/sandbox/{id}/running': {
    get: {
      operationId: 'isSandboxRunning',
      summary: 'Check whether the sandbox container is alive',
      parameters: [sandboxIdParameter],
      responses: {
        '200': {
          description: 'Liveness status.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/RunningResponse' }
            }
          }
        },
        '401': { $ref: '#/components/responses/Unauthorized' }
      }
    }
  }
} as const;
