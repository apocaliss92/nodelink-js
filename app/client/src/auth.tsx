import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  clearStoredAuthToken,
  getStoredAuthToken,
  setStoredAuthToken,
} from "./authToken";

export type AuthUser = {
  username: string;
  kind: "env-admin" | "settings" | "trusted-proxy";
  role: "admin" | "user";
};

type AuthConfig = {
  enabled: boolean;
  adminUsername: string;
  hasAdminPassword: boolean;
};

type AuthState = {
  checked: boolean;
  enabled: boolean;
  user: AuthUser | null;
  config: AuthConfig | null;
};

type AuthContextValue = {
  state: AuthState;
  refresh: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const url = new URL(path, window.location.origin);
  const token = getStoredAuthToken();
  const res = await fetch(url.toString(), {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }

  return (await res.json()) as T;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    checked: false,
    enabled: false,
    user: null,
    config: null,
  });

  const refresh = useCallback(async () => {
    try {
      const config = await fetchJson<AuthConfig>("/api/auth/config");
      if (!config.enabled) {
        setState({ checked: true, enabled: false, user: null, config });
        return;
      }

      try {
        const me = await fetchJson<{ user: AuthUser }>("/api/auth/me");
        setState({
          checked: true,
          enabled: true,
          user: me.user,
          config,
        });
      } catch {
        // Invalid/expired token.
        clearStoredAuthToken();
        setState({ checked: true, enabled: true, user: null, config });
      }
    } catch {
      // If auth config can't be fetched, assume disabled to avoid bricking UI.
      setState((s) => ({ ...s, checked: true, enabled: false }));
    }
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const result = await fetchJson<{ user: AuthUser; token: string }>(
      "/api/auth/login",
      {
        method: "POST",
        body: JSON.stringify({ username, password }),
      },
    );

    setStoredAuthToken(result.token);

    setState((s) => ({
      ...s,
      checked: true,
      enabled: true,
      user: result.user,
    }));
  }, []);

  const logout = useCallback(async () => {
    await fetchJson("/api/auth/logout", { method: "POST", body: "{}" });
    clearStoredAuthToken();
    await refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onUnauthorized = () => {
      void refresh();
    };
    window.addEventListener("nodelink:unauthorized", onUnauthorized);
    return () =>
      window.removeEventListener("nodelink:unauthorized", onUnauthorized);
  }, [refresh]);

  const value = useMemo<AuthContextValue>(
    () => ({ state, refresh, login, logout }),
    [state, refresh, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
