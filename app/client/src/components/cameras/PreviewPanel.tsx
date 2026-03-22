import { FloatingPanel } from './FloatingPanel';
import { WebRTCInlinePlayer } from './WebRTCInlinePlayer';
import type { PreviewModalState } from './types';

interface PreviewPanelProps {
  state: PreviewModalState & { open: true };
  onClose: () => void;
}

export function PreviewPanel({ state, onClose }: PreviewPanelProps) {
  return (
    <FloatingPanel
      title={state.title}
      onClose={onClose}
      defaultWidth={480}
      defaultHeight={310}
      minWidth={320}
      minHeight={200}
    >
      <div className="h-full bg-black">
        <WebRTCInlinePlayer
          streamName={state.streamName ?? `${state.cameraName}_${state.profile}`}
          go2rtcApiPort={state.go2rtcApiPort}
          serviceIp={state.serviceIp}
        />
      </div>
    </FloatingPanel>
  );
}
