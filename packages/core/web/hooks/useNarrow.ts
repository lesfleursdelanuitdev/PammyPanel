// True on phones and narrow tablets, where the builder puts its lists and
// settings in a panel that slides in instead of a column of its own.
import { useEffect, useState } from 'react';

export const NARROW = '(max-width: 1023px)';

export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof matchMedia === 'function' && matchMedia(NARROW).matches);
  useEffect(() => {
    const mq = matchMedia(NARROW);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}
