const terminalSnapshotSchema = {
  type: 'object',
  required: ['id', 'command', 'status'],
  properties: {
    id: { type: 'string' },
    pid: { type: 'integer' },
    command: { type: 'array', items: { type: 'string' } },
    cwd: { type: 'string' },
    status: { type: 'string', enum: ['running', 'exited'] },
    exit: {
      type: 'object',
      properties: {
        code: { type: 'integer', nullable: true },
        signal: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        timedOut: { type: 'boolean' }
      }
    }
  }
} as const;

const terminalIdParameter = {
  name: 'terminalId',
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: '^[a-zA-Z0-9._-]{1,128}$' }
} as const;

const sandboxIdParameter = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description: 'Sandbox instance name.'
} as const;

const terminalErrorResponses = {
  '400': {
    description: 'Invalid request.',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/ErrorResponse' }
      }
    }
  },
  '401': { $ref: '#/components/responses/Unauthorized' },
  '502': {
    description: 'Terminal operation failed.',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/ErrorResponse' }
      }
    }
  }
} as const;

export const TERMINALSPaths = {
  '/v1/sandbox/{id}/terminals': {
    post: {
      operationId: 'createTerminal',
      summary: 'Create a terminal',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['argv'],
              properties: {
                argv: { type: 'array', items: { type: 'string' }, minItems: 1 },
                cwd: { type: 'string' },
                env: {
                  type: 'object',
                  additionalProperties: { type: 'string' }
                },
                cols: { type: 'integer' },
                rows: { type: 'integer' }
              }
            }
          }
        }
      },
      parameters: [sandboxIdParameter],
      responses: {
        '200': {
          description: 'Terminal created with a generated ID.',
          content: { 'application/json': { schema: terminalSnapshotSchema } }
        },
        ...terminalErrorResponses
      }
    },
    get: {
      operationId: 'listTerminals',
      summary: 'List terminals',
      parameters: [sandboxIdParameter],
      responses: {
        '200': {
          description: 'Terminal snapshots.',
          content: {
            'application/json': {
              schema: { type: 'array', items: terminalSnapshotSchema }
            }
          }
        },
        ...terminalErrorResponses
      }
    }
  },
  '/v1/sandbox/{id}/terminals/{terminalId}': {
    get: {
      operationId: 'getTerminal',
      summary: 'Get a terminal snapshot',
      parameters: [sandboxIdParameter, terminalIdParameter],
      responses: {
        '200': {
          description: 'Terminal snapshot.',
          content: { 'application/json': { schema: terminalSnapshotSchema } }
        },
        '404': { description: 'Terminal not found.' },
        ...terminalErrorResponses
      }
    }
  },
  '/v1/sandbox/{id}/terminals/{terminalId}/connect': {
    get: {
      operationId: 'connectTerminal',
      summary: 'Connect to a terminal WebSocket',
      description:
        'WebSocket binary client frames are terminal input bytes. JSON client controls are resize, interrupt, and terminate. Server output is a JSON chunk control immediately followed by one binary frame. Cursor advances after the binary frame is consumed.',
      parameters: [
        sandboxIdParameter,
        terminalIdParameter,
        {
          name: 'cursor',
          in: 'query',
          required: false,
          schema: { type: 'string' }
        },
        {
          name: 'cols',
          in: 'query',
          required: false,
          schema: { type: 'integer' }
        },
        {
          name: 'rows',
          in: 'query',
          required: false,
          schema: { type: 'integer' }
        }
      ],
      responses: {
        '101': { description: 'WebSocket upgrade successful.' },
        '404': { description: 'Terminal not found.' },
        ...terminalErrorResponses
      }
    }
  },
  '/v1/sandbox/{id}/terminals/{terminalId}/interrupt': {
    post: {
      operationId: 'interruptTerminal',
      summary: 'Interrupt a terminal',
      parameters: [sandboxIdParameter, terminalIdParameter],
      responses: {
        '204': { description: 'Interrupt signal sent.' },
        '404': { description: 'Terminal not found.' },
        ...terminalErrorResponses
      }
    }
  },
  '/v1/sandbox/{id}/terminals/{terminalId}/terminate': {
    post: {
      operationId: 'terminateTerminal',
      summary: 'Terminate a terminal',
      parameters: [sandboxIdParameter, terminalIdParameter],
      responses: {
        '204': { description: 'Terminate signal sent.' },
        '404': { description: 'Terminal not found.' },
        ...terminalErrorResponses
      }
    }
  }
} as const;
