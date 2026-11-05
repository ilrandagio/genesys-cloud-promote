import { useEffect, useRef, useState } from 'react';

/**
 * Come useState, ma il valore resta salvato nella sessione del browser (sessionStorage):
 * sopravvive al cambio di pagina e al ricaricamento, e si perde chiudendo la scheda.
 * serialize/deserialize servono per i tipi non JSON (es. Map).
 */
export function useSessionState<T>(
  key: string,
  initial: T,
  options?: { serialize?: (v: T) => unknown; deserialize?: (raw: any) => T },
) {
  const storageKey = `gcpromote:${key}`;
  const opts = useRef(options);

  const [value, setValue] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw === null) return initial;
      const parsed = JSON.parse(raw);
      return opts.current?.deserialize ? opts.current.deserialize(parsed) : (parsed as T);
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      if (value === undefined) sessionStorage.removeItem(storageKey);
      else sessionStorage.setItem(storageKey, JSON.stringify(opts.current?.serialize ? opts.current.serialize(value) : value));
    } catch {
      // Spazio esaurito o storage non disponibile: lo stato resta valido finché la pagina è aperta
    }
  }, [storageKey, value]);

  return [value, setValue] as const;
}

/** Opzioni per salvare una Map come elenco di coppie */
export const mapCodec = <K, V>() => ({
  serialize: (m: Map<K, V>) => [...m],
  deserialize: (raw: [K, V][]) => new Map(raw),
});
