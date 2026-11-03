import { LoginOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Space, Typography } from 'antd';

export default function LoginPage() {
  const error = new URLSearchParams(window.location.search).get('loginError');

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#f0f2f5' }}>
      <Card style={{ width: 400 }}>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div>
            <Typography.Title level={3} style={{ marginBottom: 4 }}>
              Genesys Cloud Promote
            </Typography.Title>
            <Typography.Text type="secondary">Promozione di oggetti tra ambienti Genesys Cloud</Typography.Text>
          </div>
          {error && <Alert type="error" showIcon message={error} />}
          <Button
            type="primary"
            size="large"
            icon={<LoginOutlined />}
            block
            onClick={() => {
              window.location.href = '/api/auth/login';
            }}
          >
            Accedi con Genesys Cloud
          </Button>
        </Space>
      </Card>
    </div>
  );
}
