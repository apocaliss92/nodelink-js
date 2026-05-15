import { StreamSettingsPanel } from "../StreamSettingsPanel";
import type { TabProps } from "./shared";

/**
 * Reuses the standalone StreamSettingsPanel — it already has the right
 * shape (one editor per profile, dropdowns populated from getEncOptions).
 * The settings modal embeds it without a chrome (the panel renders its
 * own close button which we hide here since the modal has its own close).
 */
export function StreamsTab({ cameraId, channel }: TabProps) {
  return (
    <div>
      <StreamSettingsPanel
        cameraId={cameraId}
        channel={channel}
        onClose={() => {
          // No-op: the modal owns the close button.
        }}
      />
    </div>
  );
}
