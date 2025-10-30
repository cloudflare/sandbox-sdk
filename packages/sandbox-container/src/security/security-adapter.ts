// Security Service Adapter - provides simple interfaces for services
import type { SecurityService } from './security-service';

export class SecurityServiceAdapter {
  constructor(private securityService: SecurityService) {}

  // File service interface
  validatePath(path: string): { isValid: boolean; errors: string[] } {
    const result = this.securityService.validatePath(path);
    return {
      isValid: result.isValid,
      errors: result.errors.map((e) => e.message)
    };
  }

  // Port service interface
  validatePort(port: number): { isValid: boolean; errors: string[] } {
    const result = this.securityService.validatePort(port);
    return {
      isValid: result.isValid,
      errors: result.errors.map((e) => e.message)
    };
  }

  // Git service interface
  validateGitUrl(url: string): { isValid: boolean; errors: string[] } {
    const result = this.securityService.validateGitUrl(url);
    return {
      isValid: result.isValid,
      errors: result.errors.map((e) => e.message)
    };
  }

  // Command validation (for any service that needs it)
  validateCommand(command: string): { isValid: boolean; errors: string[] } {
    const result = this.securityService.validateCommand(command);
    return {
      isValid: result.isValid,
      errors: result.errors.map((e) => e.message)
    };
  }
}
