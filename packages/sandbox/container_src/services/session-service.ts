// Session Management Service with store abstraction
import { randomBytes } from "node:crypto";
import type { SessionData, Logger, ServiceResult, ServiceError } from '../core/types';

export interface SessionStore {
  create(session: SessionData): Promise<void>;
  get(id: string): Promise<SessionData | null>;
  update(id: string, data: Partial<SessionData>): Promise<void>;
  delete(id: string): Promise<void>;
  list(): Promise<SessionData[]>;
  cleanup(olderThan: Date): Promise<number>;
}

// In-memory implementation for now, can be swapped with SQLite later
export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionData>();

  async create(session: SessionData): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async get(id: string): Promise<SessionData | null> {
    return this.sessions.get(id) || null;
  }

  async update(id: string, data: Partial<SessionData>): Promise<void> {
    const existing = this.sessions.get(id);
    if (!existing) {
      throw new Error(`Session ${id} not found`);
    }
    
    const updated = { ...existing, ...data };
    this.sessions.set(id, updated);
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async list(): Promise<SessionData[]> {
    return Array.from(this.sessions.values());
  }

  async cleanup(olderThan: Date): Promise<number> {
    let cleaned = 0;
    for (const [id, session] of this.sessions.entries()) {
      if (session.createdAt < olderThan && !session.activeProcess) {
        this.sessions.delete(id);
        cleaned++;
      }
    }
    return cleaned;
  }

  // Helper method for testing
  clear(): void {
    this.sessions.clear();
  }

  size(): number {
    return this.sessions.size;
  }
}

export class SessionService {
  private cleanupInterval: Timer | null = null;

  constructor(
    private store: SessionStore,
    private logger: Logger
  ) {
    // Start cleanup process every 10 minutes
    this.startCleanupProcess();
  }

  async createSession(): Promise<ServiceResult<SessionData>> {
    try {
      const sessionId = this.generateSessionId();
      const session: SessionData = {
        id: sessionId,
        sessionId, // Keep for backwards compatibility
        activeProcess: null,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour from now
      };

      await this.store.create(session);
      
      this.logger.info('Session created', { sessionId });
      
      return {
        success: true,
        data: session,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to create session', error instanceof Error ? error : undefined);
      
      return {
        success: false,
        error: {
          message: 'Failed to create session',
          code: 'SESSION_CREATE_ERROR',
          details: { originalError: errorMessage },
        },
      };
    }
  }

  async getSession(id: string): Promise<ServiceResult<SessionData>> {
    try {
      const session = await this.store.get(id);
      
      if (!session) {
        return {
          success: false,
          error: {
            message: `Session ${id} not found`,
            code: 'SESSION_NOT_FOUND',
          },
        };
      }

      // Check if session is expired
      if (session.expiresAt && session.expiresAt < new Date()) {
        await this.store.delete(id);
        return {
          success: false,
          error: {
            message: `Session ${id} has expired`,
            code: 'SESSION_EXPIRED',
          },
        };
      }

      return {
        success: true,
        data: session,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to get session', error instanceof Error ? error : undefined, { sessionId: id });
      
      return {
        success: false,
        error: {
          message: 'Failed to get session',
          code: 'SESSION_GET_ERROR',
          details: { sessionId: id, originalError: errorMessage },
        },
      };
    }
  }

  async updateSession(id: string, data: Partial<SessionData>): Promise<ServiceResult<void>> {
    try {
      await this.store.update(id, data);
      
      this.logger.info('Session updated', { sessionId: id, updates: Object.keys(data) });
      
      return {
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to update session', error instanceof Error ? error : undefined, { sessionId: id });
      
      return {
        success: false,
        error: {
          message: 'Failed to update session',
          code: 'SESSION_UPDATE_ERROR',
          details: { sessionId: id, originalError: errorMessage },
        },
      };
    }
  }

  async deleteSession(id: string): Promise<ServiceResult<void>> {
    try {
      await this.store.delete(id);
      
      this.logger.info('Session deleted', { sessionId: id });
      
      return {
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to delete session', error instanceof Error ? error : undefined, { sessionId: id });
      
      return {
        success: false,
        error: {
          message: 'Failed to delete session',
          code: 'SESSION_DELETE_ERROR',
          details: { sessionId: id, originalError: errorMessage },
        },
      };
    }
  }

  async listSessions(): Promise<ServiceResult<SessionData[]>> {
    try {
      const sessions = await this.store.list();
      
      return {
        success: true,
        data: sessions,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to list sessions', error instanceof Error ? error : undefined);
      
      return {
        success: false,
        error: {
          message: 'Failed to list sessions',
          code: 'SESSION_LIST_ERROR',
          details: { originalError: errorMessage },
        },
      };
    }
  }

  async cleanupExpiredSessions(): Promise<ServiceResult<number>> {
    try {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const cleaned = await this.store.cleanup(oneHourAgo);
      
      if (cleaned > 0) {
        this.logger.info('Cleaned up expired sessions', { count: cleaned });
      }
      
      return {
        success: true,
        data: cleaned,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to cleanup sessions', error instanceof Error ? error : undefined);
      
      return {
        success: false,
        error: {
          message: 'Failed to cleanup sessions',
          code: 'SESSION_CLEANUP_ERROR',
          details: { originalError: errorMessage },
        },
      };
    }
  }

  private generateSessionId(): string {
    return `session_${Date.now()}_${randomBytes(6).toString('hex')}`;
  }

  private startCleanupProcess(): void {
    this.cleanupInterval = setInterval(async () => {
      await this.cleanupExpiredSessions();
    }, 10 * 60 * 1000); // 10 minutes
  }

  // Cleanup method for graceful shutdown
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}