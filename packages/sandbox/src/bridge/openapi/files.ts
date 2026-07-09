export const FILESPaths = {
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
  }
} as const;
