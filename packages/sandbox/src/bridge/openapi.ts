/**
 * OpenAPI 3.1 schema for the Cloudflare Sandbox Service API.
 *
 * Served at GET /v1/openapi.json (requires Bearer token auth).
 */

export const OPENAPI_SCHEMA = {
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
      ExecRequest: {
        type: 'object',
        required: ['argv'],
        properties: {
          argv: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description:
              'Argv array — already shell-expanded by the Python layer if shell=True.',
            example: ['sh', '-lc', 'echo hello']
          },
          timeout_ms: {
            type: 'integer',
            description: 'Per-call timeout in milliseconds.',
            example: 30000
          },
          cwd: {
            type: 'string',
            description:
              'Working directory for the command (defaults to sandbox cwd).',
            example: '/workspace'
          }
        }
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
        required: ['endpoint'],
        properties: {
          endpoint: {
            type: 'string',
            description: 'S3-compatible endpoint URL.',
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
              'Optional prefix/subdirectory within the bucket to mount. Must start and end with `/`.',
            example: '/uploads/images/'
          },
          credentials: {
            $ref: '#/components/schemas/MountBucketCredentials',
            description:
              'Explicit credentials. When omitted, the SDK auto-detects from Worker secrets (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY or AWS equivalents).'
          }
        }
      },
      MountBucketRequest: {
        type: 'object',
        required: ['bucket', 'mountPath', 'options'],
        properties: {
          bucket: {
            type: 'string',
            description: 'Bucket name.',
            example: 'my-r2-bucket'
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
              'session_error'
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
      }
    }
  },
  security: [{ BearerAuth: [] }],
  paths: {
    '/v1/sandbox': {
      post: {
        operationId: 'createSandbox',
        summary: 'Create a new sandbox session',
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
            description: 'New sandbox session created.',
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
    '/v1/sandbox/{id}/exec': {
      post: {
        operationId: 'execCommand',
        summary: 'Execute a command in the sandbox',
        description:
          'Runs a shell command inside the named sandbox and streams output as Server-Sent Events (SSE). ' +
          'Events: `stdout` (base64 chunk), `stderr` (base64 chunk), `exit` (JSON with exit_code), `error` (JSON with error and code). ' +
          'The stream terminates after an `exit` or `error` event.',
        'x-codeSamples': [
          {
            lang: 'curl',
            label: 'cURL',
            source:
              'curl -N -X POST https://$HOST/v1/sandbox/my-sandbox/exec \\\n' +
              '  -H "Authorization: Bearer $SANDBOX_API_KEY" \\\n' +
              '  -H "Content-Type: application/json" \\\n' +
              '  -d \'{"argv":["sh","-lc","echo hello"]}\''
          }
        ],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Sandbox instance name (maps to a Durable Object key).'
          },
          {
            name: 'Session-Id',
            in: 'header',
            required: false,
            schema: { type: 'string', pattern: '^[a-zA-Z0-9._-]{1,128}$' },
            description:
              'Scope this operation to a specific session. Uses the default session if omitted.'
          }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ExecRequest' }
            }
          }
        },
        responses: {
          '200': {
            description:
              'SSE stream of command output. Events:\n' +
              '- `event: stdout` — data is a base64-encoded chunk of stdout\n' +
              '- `event: stderr` — data is a base64-encoded chunk of stderr\n' +
              '- `event: exit` — data is JSON `{"exit_code": N}` (terminal)\n' +
              '- `event: error` — data is JSON `{"error": "...", "code": "..."}` (terminal)',
            content: {
              'text/event-stream': {
                schema: { type: 'string' }
              }
            }
          },
          '400': { $ref: '#/components/responses/InvalidRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': {
            description: 'cwd resolves outside /workspace.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                example: {
                  error: 'cwd must resolve to a location within /workspace',
                  code: 'invalid_request'
                }
              }
            }
          },
          '502': {
            description:
              'SDK transport error before the SSE stream could be established. ' +
              'Once the stream is open, errors are delivered as `event: error` SSE events instead.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                example: {
                  error: 'exec failed: connection reset',
                  code: 'exec_transport_error'
                }
              }
            }
          }
        }
      }
    },
    '/v1/sandbox/{id}/file/{path}': {
      get: {
        operationId: 'readFile',
        summary: 'Read a file from the sandbox filesystem',
        'x-codeSamples': [
          {
            lang: 'curl',
            label: 'cURL',
            source:
              'curl -X GET https://$HOST/v1/sandbox/my-sandbox/file/workspace/main.py \\\n' +
              '  -H "Authorization: Bearer $SANDBOX_API_KEY" \\\n' +
              '  -o main.py'
          }
        ],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Sandbox instance name.'
          },
          {
            name: 'path',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description:
              'File path inside the sandbox, without leading slash (e.g. workspace/main.py). Must resolve within /workspace.'
          },
          {
            name: 'Session-Id',
            in: 'header',
            required: false,
            schema: { type: 'string', pattern: '^[a-zA-Z0-9._-]{1,128}$' },
            description:
              'Scope this operation to a specific session. Uses the default session if omitted.'
          }
        ],
        responses: {
          '200': {
            description: 'Raw file bytes.',
            content: {
              'application/octet-stream': {
                schema: { type: 'string', format: 'binary' }
              }
            }
          },
          '400': { $ref: '#/components/responses/InvalidRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': {
            description: 'Path resolves outside /workspace.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                example: {
                  error: 'path must resolve to a location within /workspace',
                  code: 'invalid_request'
                }
              }
            }
          },
          '404': {
            description: 'File not found in the sandbox.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                example: {
                  error: 'File not found: /workspace/foo.txt',
                  code: 'workspace_read_not_found'
                }
              }
            }
          },
          '502': {
            description: 'SDK read call failed.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                example: {
                  error: 'read failed: connection reset',
                  code: 'exec_transport_error'
                }
              }
            }
          }
        }
      },
      put: {
        operationId: 'writeFile',
        summary: 'Write a file into the sandbox filesystem',
        'x-codeSamples': [
          {
            lang: 'curl',
            label: 'cURL',
            source:
              'curl -X PUT https://$HOST/v1/sandbox/my-sandbox/file/workspace/main.py \\\n' +
              '  -H "Authorization: Bearer $SANDBOX_API_KEY" \\\n' +
              '  -H "Content-Type: application/octet-stream" \\\n' +
              '  --data-binary @main.py'
          }
        ],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Sandbox instance name.'
          },
          {
            name: 'path',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description:
              'File path inside the sandbox, without leading slash (e.g. workspace/main.py). Must resolve within /workspace.'
          },
          {
            name: 'Session-Id',
            in: 'header',
            required: false,
            schema: { type: 'string', pattern: '^[a-zA-Z0-9._-]{1,128}$' },
            description:
              'Scope this operation to a specific session. Uses the default session if omitted.'
          }
        ],
        requestBody: {
          required: true,
          description: 'Raw file content to write.',
          content: {
            'application/octet-stream': {
              schema: { type: 'string', format: 'binary' }
            }
          }
        },
        responses: {
          '200': {
            description: 'File written successfully.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/WriteResponse' }
              }
            }
          },
          '400': { $ref: '#/components/responses/InvalidRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': {
            description: 'Path resolves outside /workspace.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                example: {
                  error: 'path must resolve to a location within /workspace',
                  code: 'invalid_request'
                }
              }
            }
          },
          '502': {
            description: 'SDK write call failed.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                example: {
                  error: 'write failed: connection reset',
                  code: 'workspace_archive_write_error'
                }
              }
            }
          }
        }
      }
    },
    '/v1/sandbox/{id}/pty': {
      get: {
        operationId: 'ptyTerminal',
        summary: 'Open a PTY terminal session via WebSocket',
        description:
          'Upgrades the HTTP connection to a WebSocket and proxies it to a PTY shell inside the sandbox.\n\n' +
          '**WebSocket frame protocol:**\n\n' +
          '| Direction | Frame type | Content |\n' +
          '|-----------|------------|--------------------------------------------------|\n' +
          '| Client → Server | Binary | UTF-8 encoded keystrokes / input |\n' +
          '| Server → Client | Binary | Terminal output (including ANSI escape sequences) |\n' +
          '| Client → Server | Text (JSON) | Control messages, e.g. `{"type":"resize","cols":120,"rows":30}` |\n' +
          '| Server → Client | Text (JSON) | Status messages: `ready`, `exit`, `error` |\n\n' +
          '**Status messages (server → client):**\n' +
          '- `{"type":"ready"}` — PTY is accepting input\n' +
          '- `{"type":"exit","code":0,"signal":"SIGTERM"}` — PTY exited\n' +
          '- `{"type":"error","message":"..."}` — error occurred\n\n' +
          'If the client disconnects, the PTY stays alive; reconnecting replays buffered output.',
        'x-codeSamples': [
          {
            lang: 'JavaScript',
            label: 'WebSocket',
            source:
              'const ws = new WebSocket("wss://$HOST/v1/sandbox/my-sandbox/pty?cols=120&rows=30");\n' +
              'ws.binaryType = "arraybuffer";\n' +
              'ws.onmessage = (e) => { /* handle binary output or JSON status */ };'
          }
        ],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Sandbox instance name.'
          },
          {
            name: 'cols',
            in: 'query',
            required: false,
            schema: { type: 'integer', default: 80 },
            description: 'Terminal width in columns.'
          },
          {
            name: 'rows',
            in: 'query',
            required: false,
            schema: { type: 'integer', default: 24 },
            description: 'Terminal height in rows.'
          },
          {
            name: 'shell',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description:
              'Shell binary to run (e.g. `/bin/bash`). Uses the container default if omitted.'
          },
          {
            name: 'session',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description:
              'SDK session ID. If provided, the PTY is scoped to this session.'
          },
          {
            name: 'Session-Id',
            in: 'header',
            required: false,
            schema: { type: 'string', pattern: '^[a-zA-Z0-9._-]{1,128}$' },
            description:
              'Scope this operation to a specific session. Uses the default session if omitted.'
          }
        ],
        responses: {
          '101': {
            description:
              'WebSocket upgrade successful. Binary and text frames flow bidirectionally as described above.'
          },
          '400': {
            description:
              'Missing `Upgrade: websocket` header or invalid query parameters.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                example: {
                  error: 'WebSocket upgrade required',
                  code: 'invalid_request'
                }
              }
            }
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '502': {
            description: 'SDK terminal() call failed.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                example: {
                  error: 'terminal failed: connection reset',
                  code: 'exec_transport_error'
                }
              }
            }
          }
        }
      }
    },
    '/v1/sandbox/{id}/running': {
      get: {
        operationId: 'isSandboxRunning',
        summary: 'Check whether the sandbox container is alive',
        description:
          'Executes a no-op command inside the sandbox. Always returns HTTP 200; inspect the `running` field.',
        'x-codeSamples': [
          {
            lang: 'curl',
            label: 'cURL',
            source:
              'curl -X GET https://$HOST/v1/sandbox/my-sandbox/running \\\n' +
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
          '200': {
            description:
              'Liveness status (always returned, even when not running).',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RunningResponse' }
              }
            }
          },
          '401': { $ref: '#/components/responses/Unauthorized' }
        }
      }
    },
    '/v1/sandbox/{id}/persist': {
      post: {
        operationId: 'persistWorkspace',
        summary: 'Serialize the sandbox workspace to a tar archive',
        description:
          'Archives the /workspace directory inside the sandbox and streams the resulting tar back as raw bytes.',
        'x-codeSamples': [
          {
            lang: 'curl',
            label: 'cURL',
            source:
              'curl -X POST https://$HOST/v1/sandbox/my-sandbox/persist \\\n' +
              '  -H "Authorization: Bearer $SANDBOX_API_KEY" \\\n' +
              '  -o workspace.tar'
          }
        ],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Sandbox instance name.'
          },
          {
            name: 'excludes',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description:
              'Comma-separated list of relative paths to exclude from the archive.',
            example: '__pycache__,.venv'
          }
        ],
        responses: {
          '200': {
            description: 'Raw tar archive bytes.',
            content: {
              'application/octet-stream': {
                schema: { type: 'string', format: 'binary' }
              }
            }
          },
          '400': {
            description: 'Invalid exclude paths (e.g. path traversal).',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                example: {
                  error: 'exclude paths must not contain ".."',
                  code: 'invalid_request'
                }
              }
            }
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '502': {
            description: 'tar command failed inside the sandbox.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                example: {
                  error: 'tar failed (exit 1): ...',
                  code: 'workspace_archive_read_error'
                }
              }
            }
          }
        }
      }
    },
    '/v1/sandbox/{id}/hydrate': {
      post: {
        operationId: 'hydrateWorkspace',
        summary: 'Populate the sandbox workspace from a tar archive',
        description:
          'Accepts a raw tar archive as the request body and extracts it into /workspace inside the sandbox.',
        'x-codeSamples': [
          {
            lang: 'curl',
            label: 'cURL',
            source:
              'curl -X POST https://$HOST/v1/sandbox/my-sandbox/hydrate \\\n' +
              '  -H "Authorization: Bearer $SANDBOX_API_KEY" \\\n' +
              '  -H "Content-Type: application/octet-stream" \\\n' +
              '  --data-binary @workspace.tar'
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
        requestBody: {
          required: true,
          description: 'Raw tar archive bytes.',
          content: {
            'application/octet-stream': {
              schema: { type: 'string', format: 'binary' }
            }
          }
        },
        responses: {
          '200': {
            description: 'Archive extracted successfully.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/OkResponse' }
              }
            }
          },
          '400': { $ref: '#/components/responses/InvalidRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '502': {
            description: 'tar extract failed inside the sandbox.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                example: {
                  error: 'tar extract failed (exit 1): ...',
                  code: 'workspace_archive_write_error'
                }
              }
            }
          }
        }
      }
    },
    '/v1/sandbox/{id}/mount': {
      post: {
        operationId: 'mountBucket',
        summary: 'Mount an S3-compatible bucket into the container',
        description:
          'Mounts an S3-compatible bucket (R2, S3, GCS, etc.) as a local directory via s3fs-FUSE. ' +
          'Credentials are optional — the SDK auto-detects from Worker secrets when omitted.',
        'x-codeSamples': [
          {
            lang: 'curl',
            label: 'cURL',
            source:
              'curl -X POST https://$HOST/v1/sandbox/my-sandbox/mount \\\n' +
              '  -H "Authorization: Bearer $SANDBOX_API_KEY" \\\n' +
              '  -H "Content-Type: application/json" \\\n' +
              '  -d \'{"bucket":"my-bucket","mountPath":"/mnt/data","options":{"endpoint":"https://ACCT.r2.cloudflarestorage.com"}}\''
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
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/MountBucketRequest' }
            }
          }
        },
        responses: {
          '200': {
            description: 'Bucket mounted successfully.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/OkResponse' }
              }
            }
          },
          '400': { $ref: '#/components/responses/InvalidRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '502': {
            description:
              'SDK mount call failed (invalid config, duplicate mount, or s3fs error).',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                example: {
                  error: 'mount failed: Mount path already in use',
                  code: 'mount_error'
                }
              }
            }
          }
        }
      }
    },
    '/v1/sandbox/{id}/unmount': {
      post: {
        operationId: 'unmountBucket',
        summary: 'Unmount a previously mounted bucket',
        description:
          'Unmounts a bucket filesystem that was previously mounted via `/v1/sandbox/{id}/mount`.',
        'x-codeSamples': [
          {
            lang: 'curl',
            label: 'cURL',
            source:
              'curl -X POST https://$HOST/v1/sandbox/my-sandbox/unmount \\\n' +
              '  -H "Authorization: Bearer $SANDBOX_API_KEY" \\\n' +
              '  -H "Content-Type: application/json" \\\n' +
              '  -d \'{"mountPath":"/mnt/data"}\''
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
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/UnmountBucketRequest' }
            }
          }
        },
        responses: {
          '200': {
            description: 'Bucket unmounted successfully.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/OkResponse' }
              }
            }
          },
          '400': { $ref: '#/components/responses/InvalidRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '502': {
            description:
              'SDK unmount call failed (no active mount or unmount error).',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                example: {
                  error: 'unmount failed: No active mount found',
                  code: 'unmount_error'
                }
              }
            }
          }
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
    '/v1/sandbox/{id}/session': {
      post: {
        operationId: 'createSession',
        summary: 'Create an execution session',
        description:
          'Sessions isolate working directory and environment variables across commands. ' +
          'The returned session ID is used with the `Session-Id` header on exec, file, and PTY endpoints.',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Sandbox instance name.'
          }
        ],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    description: 'Custom session ID. Auto-generated if omitted.'
                  },
                  cwd: {
                    type: 'string',
                    description: 'Initial working directory for the session.'
                  },
                  env: {
                    type: 'object',
                    additionalProperties: { type: 'string' },
                    description: 'Environment variables scoped to this session.'
                  }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Session created.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id'],
                  properties: {
                    id: {
                      type: 'string',
                      description: 'Session ID to pass via `Session-Id` header.'
                    }
                  }
                }
              }
            }
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '502': {
            description: 'Session creation failed.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                example: {
                  error: 'session creation failed',
                  code: 'session_error'
                }
              }
            }
          }
        }
      }
    },
    '/v1/sandbox/{id}/session/{sid}': {
      delete: {
        operationId: 'deleteSession',
        summary: 'Delete an execution session',
        description:
          'Removes a named session. The default session cannot be deleted.',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Sandbox instance name.'
          },
          {
            name: 'sid',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Session ID to delete.'
          }
        ],
        responses: {
          '200': {
            description: 'Session deleted.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['success', 'sessionId'],
                  properties: {
                    success: {
                      type: 'boolean',
                      description: '`true` if the session was deleted.'
                    },
                    sessionId: {
                      type: 'string',
                      description: 'ID of the deleted session.'
                    }
                  }
                }
              }
            }
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '502': {
            description:
              'Session deletion failed (e.g. cannot delete default session).',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                example: {
                  error: 'cannot delete the default session',
                  code: 'session_error'
                }
              }
            }
          }
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
          'Stops all idle (unassigned) warm containers. Does not affect containers assigned to sandbox sessions.',
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
            description: 'All pre-warmed containers stopped.',
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
  }
} as const;
