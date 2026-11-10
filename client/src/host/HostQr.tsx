import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/** Same renderer/settings as the guest Share dialog, no second QR library. */
export function HostQr({ url, label }: { url: string; label: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    void QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 480,
      color: { dark: '#0b1218', light: '#eef3f8' },
    })
      .then((data) => {
        if (!cancelled) setSrc(data);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (!src) {
    return <div className="hostQr hostQr--pending" aria-label={label} />;
  }
  return <img className="hostQr" src={src} alt={label} width={144} height={144} />;
}
