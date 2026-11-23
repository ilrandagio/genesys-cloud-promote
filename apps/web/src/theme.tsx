import { ConfigProvider, theme } from 'antd';
import itIT from 'antd/locale/it_IT';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'gcpromote:theme';

const ThemeContext = createContext<{ mode: ThemeMode; dark: boolean; setMode: (m: ThemeMode) => void }>({
  mode: 'system',
  dark: false,
  setMode: () => {},
});

export const useThemeMode = () => useContext(ThemeContext);

function readMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

const systemDark = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;

/**
 * Tema chiaro, scuro o come il sistema operativo. La scelta resta salvata nel browser; con "sistema" il tema
 * segue anche i cambi fatti mentre la pagina è aperta. I colori dei componenti arrivano dai token di Ant Design.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readMode);
  const [sysDark, setSysDark] = useState(systemDark);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = () => setSysDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const dark = mode === 'dark' || (mode === 'system' && sysDark);

  useEffect(() => {
    // Barre di scorrimento, campi nativi e sfondo della pagina coerenti con il tema
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    document.body.style.background = dark ? '#141414' : '#f5f5f5';
  }, [dark]);

  const setMode = (m: ThemeMode) => {
    setModeState(m);
    try {
      localStorage.setItem(STORAGE_KEY, m);
    } catch {
      // storage non disponibile: la scelta vale finché la pagina è aperta
    }
  };

  const value = useMemo(() => ({ mode, dark, setMode }), [mode, dark]);
  return (
    <ThemeContext.Provider value={value}>
      <ConfigProvider
        locale={itIT}
        theme={{
          algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
          token: { colorPrimary: '#ff4f1f' },
          components: dark ? { Layout: { headerBg: '#1f1f1f', bodyBg: '#141414' } } : undefined,
        }}
      >
        {children}
      </ConfigProvider>
    </ThemeContext.Provider>
  );
}
