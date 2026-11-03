import { useQuery } from '@tanstack/react-query';
import { Card, Table, Tag } from 'antd';
import { Link } from 'react-router-dom';
import { api, type JobSummary } from '../api/client';
import { JobStatusTag } from '../components/StatusTag';

export default function JobsPage() {
  const jobs = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api<JobSummary[]>('/api/jobs'),
    refetchInterval: 5000,
  });

  return (
    <Card title="Storico porting">
      <Table
        rowKey="id"
        loading={jobs.isLoading}
        dataSource={jobs.data}
        columns={[
          {
            title: 'Data',
            dataIndex: 'createdAt',
            render: (v: string, j) => <Link to={`/jobs/${j.id}`}>{new Date(v).toLocaleString('it-IT')}</Link>,
          },
          { title: 'Tipo', dataIndex: 'mode', render: (m: string) => (m === 'PLAN' ? <Tag>Simulazione</Tag> : <Tag color="red">Porting</Tag>) },
          { title: 'Da', dataIndex: 'sourceName' },
          { title: 'A', dataIndex: 'targetName' },
          { title: 'Utente', dataIndex: 'createdBy' },
          { title: 'Stato', dataIndex: 'status', render: (s) => <JobStatusTag status={s} /> },
        ]}
      />
    </Card>
  );
}
