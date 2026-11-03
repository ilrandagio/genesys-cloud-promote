import { Alert, Button, Card, Form, Input } from 'antd';
import { useState } from 'react';
import { api } from '../api/client';

export default function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const submit = async (values: { username: string; password: string }) => {
    setLoading(true);
    setError(undefined);
    try {
      await api('/api/auth/login', { method: 'POST', body: values });
      onLogin();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#f0f2f5' }}>
      <Card title="Genesys Cloud Promote" style={{ width: 380 }}>
        <Form layout="vertical" onFinish={submit}>
          <Form.Item name="username" label="Utente" rules={[{ required: true }]}>
            <Input autoFocus />
          </Form.Item>
          <Form.Item name="password" label="Password" rules={[{ required: true }]}>
            <Input.Password />
          </Form.Item>
          {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} />}
          <Button type="primary" htmlType="submit" block loading={loading}>
            Accedi
          </Button>
        </Form>
      </Card>
    </div>
  );
}
