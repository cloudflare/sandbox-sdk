/**
 * Core SDK Types - Public API interfaces for Cloudflare Sandbox SDK consumers
 */
// Type guards for runtime validation
export function isExecResult(value) {
    return value &&
        typeof value.success === 'boolean' &&
        typeof value.exitCode === 'number' &&
        typeof value.stdout === 'string' &&
        typeof value.stderr === 'string';
}
export function isProcess(value) {
    return value &&
        typeof value.id === 'string' &&
        typeof value.command === 'string' &&
        typeof value.status === 'string';
}
export function isProcessStatus(value) {
    return ['starting', 'running', 'completed', 'failed', 'killed', 'error'].includes(value);
}
export { Execution, ResultImpl } from './interpreter-types.js';
//# sourceMappingURL=types.js.map