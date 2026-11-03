import { CloudServerOutlined, HistoryOutlined, LogoutOutlined, SwapOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Layout, Menu, Space, Spin, Typography } from 'antd';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api/client';
import EnvironmentsPage from './pages/Environments';
import JobDetailPage from './pages/JobDetail';
import JobsPage from './pages/Jobs';
import LoginPage from './pages/Login';
import PortingPage from './pages/Porting';

export default function App() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<{ username: string; name: string; org: string }>('/api/auth/me'),
  });

  if (me.isLoading) return <Spin fullscreen />;
  if (me.isError) return <LoginPage />;

  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    qc.clear();
    window.location.href = '/';
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
          style={{ flex: 1 }}
          onClick={(e) => navigate(e.key)}
          items={[
            { key: '/porting', icon: <SwapOutlined />, label: 'Porting' },
            { key: '/jobs', icon: <HistoryOutlined />, label: 'Storico' },
            { key: '/environments', icon: <CloudServerOutlined />, label: 'Ambienti' },
          ]}
        />
        <Space>
          <Typography.Text style={{ color: '#ccc' }} title={me.data?.username}>
            {me.data?.name}
          </Typography.Text>
          <Button icon={<LogoutOutlined />} onClick={logout}>
            Esci
          </Button>
        </Space>
      </Layout.Header>
      <Layout.Content style={{ padding: 24 }}>
        <Routes>
          <Route path="/" element={<Navigate to="/porting" replace />} />
          <Route path="/porting" element={<PortingPage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/jobs/:id" element={<JobDetailPage />} />
          <Route path="/environments" element={<EnvironmentsPage />} />
        </Routes>
      </Layout.Content>
    </Layout>
  );
}
