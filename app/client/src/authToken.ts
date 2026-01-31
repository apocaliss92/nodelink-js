const LOCAL_STORAGE_TOKEN_KEY = "nodelink.auth.token";

export function getStoredAuthToken(): string | null {
  try {
    const t = window.localStorage.getItem(LOCAL_STORAGE_TOKEN_KEY);
    return t && t.trim() ? t : null;
  } catch {
    return null;
  }
}

export function setStoredAuthToken(token: string) {
  window.localStorage.setItem(LOCAL_STORAGE_TOKEN_KEY, token);
}

export function clearStoredAuthToken() {
  window.localStorage.removeItem(LOCAL_STORAGE_TOKEN_KEY);
}
