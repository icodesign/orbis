import type {
  WebSocketEvent,
  WebSocketEventListener,
  WebSocketEventType,
  WebSocketFactory,
  WebSocketLike,
} from "@orbisapp/transport";
import { WebSocket as NodeWsSocket } from "ws";

type Listener = (...args: unknown[]) => void;

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(value as Uint8Array);
  }
  return String(value);
}

/** Adapts a Node `ws` peer to the portable transport socket contract. */
export class NodeWebSocketAdapter implements WebSocketLike {
  private readonly listeners = new Map<WebSocketEventType, Map<WebSocketEventListener, Listener>>();

  constructor(private readonly socket: NodeWsSocket) {}

  get readyState(): number {
    return this.socket.readyState;
  }

  get protocol(): string {
    return this.socket.protocol;
  }

  addEventListener(type: WebSocketEventType, listener: WebSocketEventListener): void {
    const registered = this.listeners.get(type) ?? new Map<WebSocketEventListener, Listener>();
    if (registered.has(listener)) return;
    const callback = this.callback(type, listener);
    registered.set(listener, callback);
    this.listeners.set(type, registered);
    this.socket.on(type, callback);
  }

  removeEventListener(type: WebSocketEventType, listener: WebSocketEventListener): void {
    const registered = this.listeners.get(type);
    const callback = registered?.get(listener);
    if (!registered || !callback) return;
    registered.delete(listener);
    this.socket.off(type, callback);
    if (registered.size === 0) this.listeners.delete(type);
  }

  send(data: string): void {
    this.socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  private callback(type: WebSocketEventType, listener: WebSocketEventListener): Listener {
    if (type === "message") {
      return (data: unknown, isBinary: unknown) => {
        const event: WebSocketEvent = { data: isBinary === true ? data : text(data) };
        listener(event);
      };
    }
    if (type === "close") {
      return (code: unknown, reason: unknown) => {
        listener({
          code: typeof code === "number" ? code : undefined,
          reason: reason === undefined ? undefined : text(reason),
          wasClean: true,
        });
      };
    }
    if (type === "error") {
      return (error: unknown) => listener({ error });
    }
    return () => listener({});
  }
}

/** Adapts an accepted Node `ws` peer to the portable transport socket contract. */
export function adaptNodeWebSocket(socket: NodeWsSocket): WebSocketLike {
  return new NodeWebSocketAdapter(socket);
}

/** Loads the Node ws implementation only in the DSH host process. */
export async function createNodeWebSocketFactory(): Promise<WebSocketFactory> {
  const { WebSocket: Constructor } = await import("ws");
  return ({ url, protocols, headers }) =>
    adaptNodeWebSocket(new Constructor(url, [...protocols], { headers }));
}
