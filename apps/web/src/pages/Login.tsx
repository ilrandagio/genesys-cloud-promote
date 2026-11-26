import { LoginOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Select, Space, Typography } from 'antd';
import { useState } from 'react';
import { api, loginUrl, type LoginOptions } from '../api/client';

const LAST = 'gcpromote:login';

/** Scelta salvata: org di un ambiente ("env:<id>"), org predefinita ("env:") o altra org in una regione ("region:<dominio>") */
export default function LoginPage() {
  const error = new URLSearchParams(window.location.search).get('loginError');
  const opts = useQuery({ queryKey: ['login-orgs'], queryFn: () => api<LoginOptions>('/api/auth/orgs'), retry: false });
  const [choice, setChoice] = useState<string>(() => {
    try {
      return localStorage.getItem(LAST) ?? 'env:';
    } catch {
      return 'env:';
    }
  });
  const options = [
    {
      label: 'Org',
      options: (opts.data?.orgs ?? []).map((o) => ({ value: `env:${o.envId}`, label: `${o.name} (${o.region})` })),
    },
    {
      label: 'Altra org nella regione',
      options: (opts.data?.regions ?? []).map((r) => ({ value: `region:${r}`, label: r })),
    },
  ];
  const valid = options.some((g) => g.options.some((o) => o.value === choice)) ? choice : 'env:';

  const login = () => {
    try {
      localStorage.setItem(LAST, valid);
    } catch {
      // storage non disponibile
    }
    const [kind, value] = [valid.slice(0, valid.indexOf(':')), valid.slice(valid.indexOf(':') + 1)];
    window.location.href = kind === 'env' ? loginUrl({ envId: value }) : loginUrl({ region: value, switch: true });
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', }}>
      <Card style={{ width: 420 }}>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div>
            <Typography.Title level={3} style={{ marginBottom: 4 }}>
              Genesys Cloud Promote
            </Typography.Title>
            <Typography.Text type="secondary">Promozione di oggetti tra ambienti Genesys Cloud</Typography.Text>
          </div>
          {error && <Alert type="error" showIcon message={error} />}
          {opts.data && (
            <div>
              <Typography.Text type="secondary">Org Genesys Cloud</Typography.Text>
              <Select style={{ width: '100%', marginTop: 4 }} value={valid} onChange={setChoice} options={options} showSearch optionFilterProp="label" />
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
