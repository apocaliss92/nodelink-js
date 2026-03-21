import { describe, it, expect, vi } from "vitest";
import * as net from "net";

describe("RtspProxyServer directHandoff mode", () => {
  it("calls acceptConnection on registered server when directHandoff is true", () => {
    const mockServer = { acceptConnection: vi.fn() };
    const registry = new Map<string, typeof mockServer>();
    registry.set("/camera/main", mockServer);

    const path = "/camera/main";
    const server = registry.get(path);
    expect(server).toBeDefined();

    const fakeSocket = {} as net.Socket;
    const initialBuffer = Buffer.from("OPTIONS rtsp://host/camera/main RTSP/1.0\r\n\r\n");
    server!.acceptConnection(fakeSocket, initialBuffer);
    expect(mockServer.acceptConnection).toHaveBeenCalledWith(fakeSocket, initialBuffer);
  });

  it("returns undefined for unregistered paths", () => {
    const registry = new Map();
    expect(registry.get("/unknown/path")).toBeUndefined();
  });

  it("register and unregister work correctly", () => {
    const registry = new Map<string, { acceptConnection: (...args: unknown[]) => void }>();
    const mockServer = { acceptConnection: vi.fn() };

    registry.set("/camera/main", mockServer);
    expect(registry.has("/camera/main")).toBe(true);

    registry.delete("/camera/main");
    expect(registry.has("/camera/main")).toBe(false);
  });
});
