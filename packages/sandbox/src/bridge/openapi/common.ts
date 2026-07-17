/**
 * OpenAPI 3.1 schema for the Cloudflare Sandbox Service API.
 *
 * Served at GET /v1/openapi.json (requires Bearer token auth).
 */

export const OPENAPI_BASE = {
  openapi: '3.1.0',
  info: {
    title: 'Cloudflare Sandbox Service API',
    version: '1.0.0',
    description:
      'HTTP API consumed by the Python `CloudflareSandboxClient`. ' +
      'Forwards each operation to a named Cloudflare Sandbox Durable Object via the `@cloudflare/sandbox` SDK.'
  },
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description:
          'API token set via `wrangler secret put SANDBOX_API_KEY`. The /openapi.* routes also accept the token as a `?token=` query parameter.'
      }
    },
    schemas: {
      ProcessCreateRequest: {
        type: 'object',
        required: ['argv'],
        properties: {
          argv: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: 'Argv array to launch directly.',
            example: ['sh', '-lc', 'echo hello']
          },
          timeout: {
            type: 'integer',
            description:
              'Remote process lifetime deadline in milliseconds. When reached, the sandbox may stop the process and the process exit outcome reports `timedOut: true`; this is not caller-local observation cancellation.',
            example: 30000
          },
          cwd: {
            type: 'string',
            description:
              'Working directory for the command (defaults to sandbox cwd).',
            example: '/workspace'
          },
          env: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Environment overrides for the process.'
          }
        }
      },
      ProcessStatus: {
        oneOf: [
          {
            type: 'object',
            required: ['id', 'pid', 'command', 'state', 'startedAt'],
            properties: {
              id: { type: 'string' },
              pid: { type: 'integer' },
              command: { type: 'array', items: { type: 'string' } },
              cwd: { type: 'string' },
              state: { const: 'running' },
              startedAt: { type: 'string' }
            }
          },
          {
            type: 'object',
            required: [
              'id',
              'pid',
              'command',
              'state',
              'startedAt',
              'endedAt',
              'exit'
            ],
            properties: {
              id: { type: 'string' },
              pid: { type: 'integer' },
              command: { type: 'array', items: { type: 'string' } },
              cwd: { type: 'string' },
              state: { const: 'exited' },
              startedAt: { type: 'string' },
              endedAt: { type: 'string' },
              exit: {
                type: 'object',
                required: ['code', 'timedOut'],
                properties: {
                  code: { type: 'integer' },
                  signal: { type: 'integer' },
                  timedOut: { type: 'boolean' }
                }
              }
            }
          },
          {
            type: 'object',
            required: [
              'id',
              'pid',
              'command',
              'state',
              'startedAt',
              'endedAt',
              'error'
            ],
            properties: {
              id: { type: 'string' },
              pid: { type: 'integer' },
              command: { type: 'array', items: { type: 'string' } },
              cwd: { type: 'string' },
              state: { const: 'error' },
              startedAt: { type: 'string' },
              endedAt: { type: 'string' },
              error: {
                type: 'object',
                required: ['code', 'message'],
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' }
                }
              }
            }
          }
        ],
        discriminator: { propertyName: 'state' }
      },

      WriteResponse: {
        type: 'object',
        required: ['ok'],
        properties: {
          ok: {
            type: 'boolean',
            enum: [true],
            description: 'Always `true` on success.'
          }
        }
      },
      RunningResponse: {
        type: 'object',
        required: ['running'],
        properties: {
          running: {
            type: 'boolean',
            description:
              '`true` if the sandbox container is alive and responding.'
          }
        }
      },
      OkResponse: {
        type: 'object',
        required: ['ok'],
        properties: {
          ok: {
            type: 'boolean',
            enum: [true],
            description: 'Always `true` on success.'
          }
        }
      },
      MountBucketCredentials: {
        type: 'object',
        required: ['accessKeyId', 'secretAccessKey'],
        properties: {
          accessKeyId: {
            type: 'string',
            description: 'S3-compatible access key ID.'
          },
          secretAccessKey: {
            type: 'string',
            description: 'S3-compatible secret access key.'
          }
        }
      },
      MountBucketRequestOptions: {
        type: 'object',
        properties: {
          endpoint: {
            type: 'string',
            description:
              'S3-compatible endpoint URL for remote mounts. Mutually exclusive with top-level `binding`.',
            example: 'https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com'
          },
          readOnly: {
            type: 'boolean',
            description: 'Mount filesystem as read-only (default: false).',
            default: false
          },
          prefix: {
            type: 'string',
            description:
              'Optional prefix/subdirectory within the bucket to mount. Must start with `/`. Trailing slashes are stripped automatically.',
            example: '/uploads/images'
          },
          credentials: {
            $ref: '#/components/schemas/MountBucketCredentials',
            description:
              'Explicit credentials. When omitted, the SDK auto-detects from Worker secrets (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY or AWS equivalents).'
          },
          credentialProxy: {
            type: 'boolean',
            description:
              'Keep credentials in the Durable Object and sign intercepted s3fs requests from the Worker. Credentials may be explicit or auto-detected from Worker secrets.',
            default: false
          },
          s3fsOptions: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Advanced: Override or extend s3fs mount options for both remote mounts and R2 binding mounts.',
            example: ['nomultipart']
          }
        }
      },
      MountBucketRequest: {
        type: 'object',
        required: ['mountPath', 'options'],
        properties: {
          bucket: {
            type: 'string',
            description:
              'Remote bucket name for endpoint-based S3-compatible mounts.',
            example: 'my-r2-bucket'
          },
          binding: {
            type: 'string',
            description:
              'Worker R2 binding name for credential-less R2 binding mounts. Mutually exclusive with `options.endpoint`.',
            example: 'MY_BUCKET'
          },
          mountPath: {
            type: 'string',
            description: 'Absolute path in the container to mount at.',
            example: '/mnt/data'
          },
          options: {
            $ref: '#/components/schemas/MountBucketRequestOptions'
          }
        }
      },
      UnmountBucketRequest: {
        type: 'object',
        required: ['mountPath'],
        properties: {
          mountPath: {
            type: 'string',
            description: 'Absolute path where the bucket is currently mounted.',
            example: '/mnt/data'
          }
        }
      },
      TunnelRequest: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'Subdomain prefix for a named tunnel, such as `app`. Do not pass a full hostname. Omit to create or reuse an ephemeral tunnel.',
            example: 'app'
          }
        }
      },
      Tunnel: {
        type: 'object',
        required: ['id', 'port', 'url', 'hostname', 'createdAt'],
        properties: {
          id: { type: 'string' },
          port: {
            type: 'integer',
            description: 'Container port served by the tunnel.',
            example: 8080
          },
          url: {
            type: 'string',
            format: 'uri',
            example: 'https://app.example.com'
          },
          hostname: {
            type: 'string',
            example: 'app.example.com'
          },
          createdAt: {
            type: 'string',
            format: 'date-time'
          },
          name: {
            type: 'string',
            description: 'Present for named tunnels only.',
            example: 'app'
          }
        }
      },
      ErrorResponse: {
        type: 'object',
        required: ['error', 'code'],
        properties: {
          error: {
            type: 'string',
            description: 'Human-readable error description.'
          },
          code: {
            type: 'string',
            description: 'Stable machine-readable error code.',
            enum: [
              'unauthorized',
              'invalid_request',
              'exec_error',
              'exec_transport_error',
              'workspace_read_not_found',
              'workspace_archive_read_error',
              'workspace_archive_write_error',
              'capacity_exceeded',
              'pool_error',
              'mount_error',
              'unmount_error',
              'tunnel_error'
            ]
          }
        }
      },
      PoolStats: {
        type: 'object',
        required: ['warm', 'assigned', 'total', 'config', 'maxInstances'],
        properties: {
          warm: {
            type: 'integer',
            description: 'Number of warm (unassigned) containers ready for use.'
          },
          assigned: {
            type: 'integer',
            description: 'Number of containers assigned to sandbox IDs.'
          },
          total: {
            type: 'integer',
            description: 'Total containers tracked by the pool.'
          },
          config: {
            type: 'object',
            properties: {
              warmTarget: { type: 'integer' },
              refreshInterval: { type: 'integer' }
            }
          },
          maxInstances: {
            type: ['integer', 'null'],
            description:
              'Inferred max_instances limit, or null if not yet known.'
          }
        }
      }
    },
    responses: {
      Unauthorized: {
        description: 'Missing or invalid Bearer token.',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ErrorResponse' },
            example: { error: 'Unauthorized', code: 'unauthorized' }
          }
        }
      },
      InvalidRequest: {
        description: 'Malformed request body or missing required fields.',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ErrorResponse' },
            example: {
              error: 'argv must be a non-empty array',
              code: 'invalid_request'
            }
          }
        }
      },
      NotFound: {
        description: 'Requested resource was not found.',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ErrorResponse' },
            example: { error: 'Process not found', code: 'not_found' }
          }
        }
      },
      BadGateway: {
        description: 'Sandbox operation failed.',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ErrorResponse' },
            example: { error: 'process launch failed', code: 'process_error' }
          }
        }
      }
    }
  },
  security: [{ BearerAuth: [] }]
} as const;
