import { useEffect, useState } from 'react';

import { Icon } from './Icon';

export interface CleanedPreviewProps {
  buffer: Uint8Array | null;
  mime: string;
  alt: string;
}

/**
 * Preview for the cleaned bytes.
 *
 * The object URL is created in an effect and revoked in its cleanup, so
 * re-cleaning a file (or leaving the page) never leaks a blob URL — which is the
 * usual way an image tool slowly eats memory during a long session.
 */
export function CleanedPreview({ buffer, mime, alt }: CleanedPreviewProps) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!buffer) {
      setUrl(null);
      return;
    }
    const blob = new Blob([buffer.slice().buffer as ArrayBuffer], { type: mime });
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [buffer, mime]);

  if (!url) {
    return (
      <div className="preview-placeholder">
        <Icon name="shield" size={22} />
        <span>清理后在这里预览</span>
      </div>
    );
  }

  return <img src={url} alt={alt} data-testid="preview-cleaned" />;
}
