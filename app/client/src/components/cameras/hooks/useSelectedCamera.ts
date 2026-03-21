import { useSearchParams } from 'react-router-dom';
import { useMemo, useCallback } from 'react';
import type { CameraInfo } from '../types';

export function useSelectedCamera(cameras: CameraInfo[]) {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedName = searchParams.get('camera');

  const selectedCamera = useMemo(
    () => cameras.find((c) => c.name === selectedName) ?? null,
    [cameras, selectedName]
  );

  const selectCamera = useCallback((camera: CameraInfo | null) => {
    if (camera) {
      setSearchParams({ camera: camera.name });
    } else {
      setSearchParams({});
    }
  }, [setSearchParams]);

  return { selectedCamera, selectCamera };
}
