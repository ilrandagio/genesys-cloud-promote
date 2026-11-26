import {
  ApartmentOutlined,
  CloudServerOutlined,
  DesktopOutlined,
  HistoryOutlined,
  LogoutOutlined,
  MoonOutlined,
  SafetyCertificateOutlined,
  SaveOutlined,
  SunOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Dropdown, Layout, Menu, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, appUrl, type LoginOrg, type Me } from './api/client';
import EnvironmentsPage from './pages/Environments';
import JobDetailPage from './pages/JobDetail';
import JobsPage from './pages/Jobs';
import LoginPage from './pages/Login';
import BackupPage from './pages/Backup';
import PortingPage from './pages/Porting';
import { useThemeMode, type ThemeMode } from './theme';

const THEME_ICON: Record<ThemeMode, ReactNode> = { light: <SunOutlined />, dark: <MoonOutlined />, system: <DesktopOutlined /> };

export default function App() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const themeMode = useThemeMode();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<Me>('/api/auth/me'),
  });

  const orgs = useQuery({
    queryKey: ['login-orgs'],
    enabled: me.isSuccess,
    queryFn: () => api<LoginOrg[]>('/api/auth/orgs'),
  });

  if (me.isLoading) return <Spin fullscreen />;
  if (me.isError) return <LoginPage />;

  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    qc.clear();
    window.location.href = import.meta.env.BASE_URL;
  };

  const selected = '/' + (location.pathname.split('/')[1] || 'porting');

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Header style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <Typography.Text strong style={{ color: '#fff', fontSize: 16, whiteSpace: 'nowrap' }}>
          Genesys Cloud Promote
        </Typography.Text>
        <Menu
          theme="dark"
          mode="horizontal"
          selectedKeys={[selected]}
          style={{ flex: 1, background: 'transparent' }}
          onClick={(e) => navigate(e.key)}
          items={[
            { key: '/porting', icon: <SwapOutlined />, label: 'Porting' },
            { key: '/disaster-recovery', icon: <SafetyCertificateOutlined />, label: 'Disaster Recovery' },
            { key: '/backup', icon: <SaveOutlined />, label: 'Backup' },
            { key: '/jobs', icon: <HistoryOutlined />, label: 'Storico' },
            { key: '/environments', icon: <CloudServerOutlined />, label: 'Ambienti' },
          ]}
        />
        <Space>
          <Dropdown
            trigger={['click']}
            menu={{
              selectable: true,
              selectedKeys: [me.data?.envId ?? ''],
              items: [
                { key: 'title', type: 'group', label: "Cambia org (nuovo login nell'org scelta)" },
                ...(orgs.data ?? []).map((o) => ({ key: o.envId, label: `${o.name} (${o.region})` })),
              ],
              onClick: (e) => {
                if (e.key === (me.data?.envId ?? '')) return;
                qc.clear();
                window.location.href = appUrl(`/api/auth/login${e.key ? `?env=${encodeURIComponent(e.key)}` : ''}`);
              },
            }}
          >
            <Tooltip title={`Org di login: ${me.data?.org} (${me.data?.orgRegion}). Clic per cambiare org`}>
              <Tag icon={<ApartmentOutlined />} color="blue" style={{ cursor: 'pointer', marginInlineEnd: 0 }}>
                {me.data?.org}
              </Tag>
            </Tooltip>
          </Dropdown>
          <Typography.Text style={{ color: '#ccc' }} title={me.data?.username}>
            {me.data?.name}
          </Typography.Text>
          <Tooltip title="Permessi letti al login dai ruoli Genesys: per aggiornarli esci e rientra">
            <Space size={2}>
              {me.data?.canApply && <Tag color="red">esegue</Tag>}
              {me.data?.canApprove && <Tag color="purple">approva</Tag>}
              {!me.data?.canApply && !me.data?.canApprove && <Tag>solo simulazione</Tag>}
            </Space>
          </Tooltip>
          <Dropdown
            trigger={['click']}
            menu={{
              selectable: true,
              selectedKeys: [themeMode.mode],
              onClick: (e) => themeMode.setMode(e.key as ThemeMode),
              items: [
                { key: 'light', icon: THEME_ICON.light, label: 'Tema chiaro' },
                { key: 'dark', icon: THEME_ICON.dark, label: 'Tema scuro' },
                { key: 'system', icon: THEME_ICON.system, label: 'Come il sistema' },
              ],
            }}
          >
            <Tooltip title="Tema" placement="bottom">
              <Button icon={THEME_ICON[themeMode.mode]} aria-label="Tema" />
            </Tooltip>
          </Dropdown>
          <Button icon={<LogoutOutlined />} onClick={logout}>
            Esci
          </Button>
        </Space>
      </Layout.Header>
      <Layout.Content style={{ padding: 24 }}>
        <Routes>
          <Route path="/" element={<Navigate to="/porting" replace />} />
          <Route path="/porting" element={<PortingPage key="porting" />} />
          <Route path="/disaster-recovery" element={<PortingPage key="dr" mode="dr" />} />
          <Route path="/backup" element={<BackupPage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/jobs/:id" element={<JobDetailPage />} />
          <Route path="/environments" element={<EnvironmentsPage />} />
        </Routes>
      </Layout.Content>
    </Layout>
  );
}
