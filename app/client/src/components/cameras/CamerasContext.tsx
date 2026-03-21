import { createContext, useContext } from 'react';
import type { useCameras } from './hooks/useCameras';

type CamerasContextValue = ReturnType<typeof useCameras>;

const CamerasContext = createContext<CamerasContextValue | null>(null);

export const CamerasProvider = CamerasContext.Provider;

export function useCamerasContext() {
  const ctx = useContext(CamerasContext);
  if (!ctx) throw new Error('useCamerasContext must be used within CamerasProvider');
  return ctx;
}
