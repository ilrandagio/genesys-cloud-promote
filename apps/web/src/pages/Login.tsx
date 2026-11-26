import { LoginOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Select, Space, Typography } from 'antd';
import { useState } from 'react';
import { api, appUrl, type LoginOrg } from '../api/client';

const LAST_ORG = 'gcpromote:loginOrg';

export default function LoginPage() {
  const error = new URLSearchParams(window.location.search).get('loginError');
  const orgs = useQuery({ queryKey: ['login-orgs'], queryFn: () => api<LoginOrg[]>('/api/auth/orgs'), retry: false });
  const [envId, setEnvId] = useState<string>(() => {
    try {
      return localStorage.getItem(LAST_ORG) ?? '';
    } catch {
      return '';
    }
  });
  const known = orgs.data?.some((o) => o.envId === envId) ? envId : '';

  const login = () => {
    try {
      localStorage.setItem(LAST_ORG, known);
    } catch {
      // storage non disponibile: si ricomincia dall'org predefinita
    }
    window.location.href = appUrl(`/api/auth/login${known ? `?env=${encodeURIComponent(known)}` : ''}`);
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', }}>
      <Card style={{ width: 400 }}>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div>
            <Typography.Title level={3} style={{ marginBottom: 4 }}>
              Genesys Cloud Promote
            </Typography.Title>
            <Typography.Text type="secondary">Promozione di oggetti tra ambienti Genesys Cloud</Typography.Text>
          </div>
          {error && <Alert type="error" showIcon message={error} />}
          {(orgs.data?.length ?? 0) > 1 && (
            <div>
              <Typography.Text type="secondary">Org Genesys Cloud</Typography.Text>
              <Select
                style={{ width: '100%', marginTop: 4 }}
                value={known}
                onChange={setEnvId}
                options={orgs.data!.map((o) => ({ value: o.envId, label: `${o.name} (${o.region})` }))}
              />
            </div>
          )}
          <Button type="primary" size="large" icon={<LoginOutlined />} block onClick={login}>
            Accedi con Genesys Cloud
          </Button>
        </Space>
      </Card>
    </div>
  );
}
