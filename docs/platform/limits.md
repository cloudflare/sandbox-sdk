# Platform Limits

This document outlines the limits and constraints when using the Cloudflare Sandbox SDK, which runs on Cloudflare's Container platform.

## Container Instance Types

The Sandbox SDK runs on Cloudflare Containers with three predefined instance types:

| Instance Type | Memory | vCPU | Disk Space | Use Case |
|---------------|--------|------|------------|----------|
| **dev** | 256 MiB | 1/16 | 2 GB | Development, testing, light workloads |
| **basic** | 1 GiB | 1/4 | 4 GB | Small applications, prototypes |
| **standard** | 4 GiB | 1/2 | 4 GB | Production workloads, resource-intensive tasks |

> **Note**: These limits are per container instance. Each sandbox runs in its own isolated container.

## Account-Level Limits (Open Beta)

During the open beta period, the following limits apply to your entire Cloudflare account:

### Compute Resources
- **Total Memory**: 40 GB for all concurrent live Container instances
- **Total vCPUs**: 20 vCPUs for all concurrent live Container instances  
- **Total Disk**: 100 GB for all concurrent live Container instances

### Storage
- **Container Images**: 50 GB total image storage per account

> � **Beta Notice**: These limits are expected to change as the platform evolves. Cloudflare is actively gathering feedback about desired instance sizes and limits.

## SDK-Specific Limits

The Sandbox SDK enforces additional limits on top of the platform constraints:

### Execution Limits
- **Command Timeout**: 30 seconds (default, configurable via `COMMAND_TIMEOUT_MS`)
- **Process Initialization**: 5 seconds timeout for control process startup
- **Temp File Cleanup**: Files older than 60 seconds are automatically cleaned up

### Port Restrictions
- **Allowed Ports**: 1024-65535 (non-system ports only)
- **Reserved Ports**: 3000 (control plane), 8787 (wrangler dev) are blocked
- **Port Validation**: All exposed ports are validated before assignment

### Sandbox Constraints
- **Sandbox ID Length**: 1-63 characters (DNS compliance)
- **Sandbox ID Format**: Cannot start/end with hyphens, no reserved names
- **Reserved Names**: `www`, `api`, `admin`, `root`, `system`, `cloudflare`, `workers`

## Durable Objects Limits

Since sandboxes are implemented as Durable Objects, they inherit standard Durable Object limitations:

### Request and Performance Limits
- **Request Rate**: Soft limit of 1,000 requests per second per individual Durable Object
- **CPU Time**: 30 seconds per request (default), configurable up to 5 minutes
- **WebSocket Messages**: 1 MiB maximum size for received messages

### Storage Limits (SQLite-backed)
- **Storage per Durable Object**: 10 GB maximum
- **Storage per Account**: Unlimited (Paid plans) / 5 GB (Free plans)
- **Key/Value Combined Size**: 2 MB maximum per entry
- **Maximum Durable Object Classes**: 500 (Paid) / 100 (Free)

### SQL Database Constraints
- **Maximum Columns per Table**: 100
- **Maximum String/BLOB Size**: 2 MB
- **Maximum SQL Statement Length**: 100 KB
- **Maximum Bound Parameters**: 100 per query

### Legacy Key-Value Storage
- **Storage per Account**: 50 GB (can be raised on request)
- **Key Size**: 2 KiB (2,048 bytes) maximum
- **Value Size**: 128 KiB (131,072 bytes) maximum

## Code Interpreter Limits

The built-in code interpreter has additional constraints:

### Execution Environment
- **Languages**: Python, JavaScript/TypeScript supported
- **Internet Access**: None (sandboxed execution)
- **Pre-installed Packages**: Limited to container image contents
- **Execution Context**: Persistent across requests within same session

### Resource Constraints
- **Memory Usage**: Limited by container instance memory allocation
- **Processing Time**: Subject to command timeout limits
- **File System**: Shared with container file system limits

## Network and Connectivity

### Preview URLs
- **Subdomain Length**: 63 characters maximum (DNS limit)
- **URL Format**: `{port}-{sandbox-id}.{worker-domain}`
- **Protocol Support**: HTTP/HTTPS (WebSocket support planned)

### Outbound Requests
- **From Sandbox**: Subject to Durable Object subrequest limits
- **DNS Resolution**: Standard Cloudflare DNS resolution
- **Rate Limiting**: Inherits Workers platform rate limits


## Future Considerations

As Cloudflare Containers moves beyond beta:

1. **Instance Types**: Additional instance types may become available
2. **Account Limits**: Limits will likely change based on usage patterns
3. **Regional Availability**: Container placement and edge distribution may expand
4. **Billing Model**: Current beta limits may transition to usage-based billing

For the most current information about limits and pricing, check the [Cloudflare Containers documentation](https://developers.cloudflare.com/containers/).