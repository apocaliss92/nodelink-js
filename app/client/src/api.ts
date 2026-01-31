export type TrpcMethod = "GET" | "POST";

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
    headers: { "Content-Type": "application/json" },
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
