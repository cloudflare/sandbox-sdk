export class RuntimeIdentityInactiveError extends Error {
  constructor() {
    super('Runtime identity is no longer active');
    this.name = 'RuntimeIdentityInactiveError';
  }
}
