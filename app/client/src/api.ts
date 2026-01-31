export type TrpcMethod = "GET" | "POST";

import { getStoredAuthToken } from "./authToken";

export async function trpcCall<T>(
  path: string,
  method: TrpcMethod,
  input?: unknown,
): Promise<T> {
  const url = new URL(`/api/trpc/${path}`, window.location.origin);
  if (method === "GET" && input !== undefined) {
    url.searchParams.set("input", JSON.stringify(input));
  }

  const res = await fetch(url.toString(), {
    method,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(getStoredAuthToken()
        ? { Authorization: `Bearer ${getStoredAuthToken()}` }
        : {}),
    },
    body: method === "POST" ? JSON.stringify(input ?? {}) : undefined,
  });

  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent("nodelink:unauthorized"));
    throw new Error("UNAUTHORIZED");
  }

  const data = await res.json();
  if (data?.error) {
    throw new Error(data.error.message || "API Error");
  }

  return data?.result?.data as T;
}

export function trpcQuery<T>(path: string, input?: unknown): Promise<T> {
  return trpcCall<T>(path, "GET", input);
}

export function trpcMutation<T>(path: string, input?: unknown): Promise<T> {
  return trpcCall<T>(path, "POST", input);
}

async function apiGetJson<T>(path: string): Promise<T> {
  const url = new URL(path, window.location.origin);
  const token = getStoredAuthToken();

  const res = await fetch(url.toString(), {
    method: "GET",
    credentials: "include",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent("nodelink:unauthorized"));
    throw new Error("UNAUTHORIZED");
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }

  return (await res.json()) as T;
}

export type UpdateInfo = {
  currentVersion: string | null;
  latestVersion: string | null;
  latestTag: string | null;
  releaseUrl: string | null;
  updateAvailable: boolean;
  checkedAt: string;
  error?: string;
};

export function fetchUpdates(opts?: { force?: boolean }): Promise<UpdateInfo> {
  const force = opts?.force === true;
  return apiGetJson<UpdateInfo>(
    force ? "/api/updates?force=1" : "/api/updates",
  );
}
