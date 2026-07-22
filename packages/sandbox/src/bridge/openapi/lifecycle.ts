export const LIFECYCLEPaths = {
  '/v1/sandbox': {
    post: {
      operationId: 'createSandbox',
      summary: 'Create a new sandbox',
      description:
        'Generates a new unique sandbox ID. Use this ID with all `/v1/sandbox/{id}/*` routes.',
      'x-codeSamples': [
        {
          lang: 'curl',
          label: 'cURL',
          source:
            'curl -X POST https://$HOST/v1/sandbox \\\n  -H "Authorization: Bearer $SANDBOX_API_KEY"'
        }
      ],
      responses: {
        '200': {
          description: 'New sandbox created.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['id'],
                properties: {
                  id: {
                    type: 'string',
                    description:
                      'Unique sandbox ID for use with `/v1/sandbox/{id}/*` routes.',
                    example: 'mfrggzdfmy2tqnrzgezdgnbv'
                  }
                }
              }
            }
          }
        },
        '401': { $ref: '#/components/responses/Unauthorized' }
      }
    }
  },
  '/v1/sandbox/{id}': {
    delete: {
      operationId: 'deleteSandbox',
      summary: 'Destroy a sandbox instance (best-effort)',
      description:
        'Calls destroy() on the sandbox Durable Object to release container resources. ' +
        'Best-effort: unknown sandbox IDs return 204 without allocating a container.',
      'x-codeSamples': [
        {
          lang: 'curl',
          label: 'cURL',
          source:
            'curl -X DELETE https://$HOST/v1/sandbox/my-sandbox \\\n' +
            '  -H "Authorization: Bearer $SANDBOX_API_KEY"'
        }
      ],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
          description: 'Sandbox instance name.'
        }
      ],
      responses: {
        '204': {
          description:
            'Sandbox destroyed (best-effort). Container resources are released.'
        },
        '401': { $ref: '#/components/responses/Unauthorized' }
      }
    }
  },
  '/health': {
    get: {
      operationId: 'healthCheck',
      summary: 'Worker health check',
      description: 'Simple liveness probe. Not protected by authentication.',
      'x-codeSamples': [
        {
          lang: 'curl',
          label: 'cURL',
          source: 'curl https://$HOST/health'
        }
      ],
      security: [],
      responses: {
        '200': {
          description: 'Worker is up.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OkResponse' }
            }
          }
        }
      }
    }
  },
  '/v1/openapi.json': {
    get: {
      operationId: 'getOpenApiSchema',
      summary: 'OpenAPI schema',
      description: 'Returns this OpenAPI 3.1 schema document.',
      'x-codeSamples': [
        {
          lang: 'curl',
          label: 'cURL',
          source:
            'curl https://$HOST/v1/openapi.json \\\n' +
            '  -H "Authorization: Bearer $SANDBOX_API_KEY"'
        }
      ],
      responses: {
        '200': {
          description: 'OpenAPI schema document.',
          content: {
            'application/json': {
              schema: { type: 'object' }
            }
          }
        },
        '401': { $ref: '#/components/responses/Unauthorized' }
      }
    }
  },
  '/v1/pool/stats': {
    get: {
      operationId: 'getPoolStats',
      summary: 'Pool statistics',
      description:
        'Returns current warm pool statistics including warm/assigned counts and configuration.',
      'x-codeSamples': [
        {
          lang: 'curl',
          label: 'cURL',
          source:
            'curl https://$HOST/v1/pool/stats \\\n' +
            '  -H "Authorization: Bearer $SANDBOX_API_KEY"'
        }
      ],
      responses: {
        '200': {
          description: 'Pool statistics.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/PoolStats' }
            }
          }
        },
        '401': { $ref: '#/components/responses/Unauthorized' }
      }
    }
  },
  '/v1/pool/shutdown-prewarmed': {
    post: {
      operationId: 'shutdownPrewarmed',
      summary: 'Shutdown pre-warmed containers',
      description:
        'Destroys all idle (unassigned) warm containers. Does not affect containers assigned to sandbox instances.',
      'x-codeSamples': [
        {
          lang: 'curl',
          label: 'cURL',
          source:
            'curl -X POST https://$HOST/v1/pool/shutdown-prewarmed \\\n' +
            '  -H "Authorization: Bearer $SANDBOX_API_KEY"'
        }
      ],
      responses: {
        '200': {
          description: 'All pre-warmed containers destroyed.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OkResponse' }
            }
          }
        },
        '401': { $ref: '#/components/responses/Unauthorized' }
      }
    }
  },
  '/v1/pool/prime': {
    post: {
      operationId: 'primePool',
      summary: 'Prime the warm pool',
      description:
        'Pushes the current pool configuration and starts the alarm loop. ' +
        'Called automatically by the cron trigger; can also be called manually after deploy.',
      'x-codeSamples': [
        {
          lang: 'curl',
          label: 'cURL',
          source:
            'curl -X POST https://$HOST/v1/pool/prime \\\n' +
            '  -H "Authorization: Bearer $SANDBOX_API_KEY"'
        }
      ],
      responses: {
        '200': {
          description: 'Pool primed successfully.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OkResponse' }
            }
          }
        },
        '401': { $ref: '#/components/responses/Unauthorized' }
      }
    }
  }
} as const;
