import { EventEmitter } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { SessionExtensionBridge } from '@octopus/engine';
import type {
  Command,
  CommandResponse,
  ExtensionEvent,
  ExtensionRegistrationMessage,
  ExtensionRuntimeConfig
} from '@octopus/engine';

interface HubSessionEntry {
  bridge: SessionExtensionBridge;
  ws: WebSocket | null;
  connected: boolean;
  connectedAt?: string;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRegistrationMessage(message: unknown): message is ExtensionRegistrationMessage {
  return isObjectRecord(message) && message.type === 'register' && typeof message.sessionId === 'string';
}

export class BridgeHub extends EventEmitter {
  private readonly host = '127.0.0.1';
  private readonly sessions = new Map<string, HubSessionEntry>();
  private readonly wss: WebSocketServer;
  private readonly ready: Promise<string>;

  constructor() {
    super();
    this.wss = new WebSocketServer({ host: this.host, port: 0 });
    this.ready = new Promise((resolve, reject) => {
      const handleReadyError = (error: Error) => {
        this.wss.off('listening', handleListening);
        this.emit('bridge.error', { message: error.message });
        reject(error);
      };
      const handleListening = () => {
        this.wss.off('error', handleReadyError);
        const wsUrl = this.getWsUrl();
        this.emit('bridge.listening', { wsUrl });
        resolve(wsUrl);
      };

      this.wss.once('listening', handleListening);
      this.wss.once('error', handleReadyError);
    });

    this.wss.on('connection', (ws) => this.handleConnection(ws));
    this.wss.on('error', (error) => {
      this.emit('bridge.error', { message: error.message });
    });
  }

  async createSessionBridge(runId: string): Promise<SessionExtensionBridge> {
    const wsUrl = await this.ready;
    const runtimeConfig: ExtensionRuntimeConfig = { sessionId: runId, wsUrl };
    const bridge = new SessionExtensionBridge({
      runtimeConfig,
      dispatchCommand: (sessionId: string, message: Command) => {
        this.dispatchCommand(sessionId, message);
      },
      onClose: (sessionId: string) => {
        this.removeSession(sessionId);
      }
    });
    this.sessions.set(runtimeConfig.sessionId, { bridge, ws: null, connected: false });
    this.emit('bridge.session.created', { sessionId: runtimeConfig.sessionId, wsUrl });
    return bridge;
  }

  isSessionConnected(sessionId: string): boolean {
    return Boolean(this.sessions.get(sessionId)?.connected);
  }

  waitForSessionConnected(sessionId: string, timeoutMs: number): Promise<void> {
    if (this.isSessionConnected(sessionId)) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Extension did not register within ${timeoutMs}ms`));
      }, timeoutMs);

      const handleRegistered = (event: { sessionId: string; success: boolean }) => {
        if (event.sessionId !== sessionId) return;
        cleanup();
        event.success ? resolve() : reject(new Error('Extension registration failed'));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.off('bridge.registered', handleRegistered);
      };

      this.on('bridge.registered', handleRegistered);
    });
  }

  close(): void {
    for (const sessionId of this.sessions.keys()) {
      this.removeSession(sessionId);
    }
    this.wss.close();
  }

  private getWsUrl(): string {
    const address = this.wss.address();
    if (!address || typeof address === 'string') {
      throw new Error('failed to resolve bridge server address');
    }
    return `ws://${this.host}:${address.port}`;
  }

  private handleConnection(ws: WebSocket): void {
    let currentSessionId: string | null = null;
    this.emit('bridge.connection', {});

    ws.on('message', (raw) => {
      let message: unknown;
      try {
        message = JSON.parse(raw.toString()) as unknown;
      } catch {
        this.emit('bridge.message.invalid', {});
        return;
      }

      if (isRegistrationMessage(message)) {
        const entry = this.sessions.get(message.sessionId);
        if (!entry) {
          ws.send(JSON.stringify({
            type: 'registered',
            sessionId: message.sessionId,
            success: false,
            error: 'Unknown session'
          }));
          this.emit('bridge.registered', {
            sessionId: message.sessionId,
            success: false,
            error: 'Unknown session'
          });
          ws.close();
          return;
        }

        if (entry.ws && entry.ws !== ws) {
          entry.ws.close();
        }

        entry.ws = ws;
        entry.connected = true;
        entry.connectedAt = new Date().toISOString();
        entry.bridge.handleHubConnected();
        currentSessionId = message.sessionId;
        ws.send(JSON.stringify({ type: 'registered', sessionId: message.sessionId, success: true }));
        this.emit('bridge.registered', { sessionId: message.sessionId, success: true });
        return;
      }

      if (!currentSessionId) return;
      const entry = this.sessions.get(currentSessionId);
      if (isObjectRecord(message) && typeof message.id === 'string') {
        this.emit('bridge.response', { sessionId: currentSessionId, id: message.id, success: message.success });
      } else if (isObjectRecord(message) && typeof message.type === 'string') {
        this.emit('bridge.event', { sessionId: currentSessionId, type: message.type });
      }
      entry?.bridge.handleHubMessage(message as CommandResponse | ExtensionEvent);
    });

    ws.on('close', () => {
      if (!currentSessionId) return;
      const entry = this.sessions.get(currentSessionId);
      if (!entry || entry.ws !== ws) return;
      entry.ws = null;
      entry.connected = false;
      entry.bridge.handleHubDisconnected();
      this.emit('bridge.disconnected', { sessionId: currentSessionId });
    });

    ws.on('error', (error) => {
      this.emit('bridge.error', { sessionId: currentSessionId, message: error.message });
    });
  }

  private dispatchCommand(sessionId: string, message: Command): void {
    const socket = this.sessions.get(sessionId)?.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('No extension connected for session');
    }
    this.emit('bridge.command', { sessionId, id: message.id, action: message.action });
    socket.send(JSON.stringify(message));
  }

  private removeSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.ws?.close();
    this.sessions.delete(sessionId);
  }
}
