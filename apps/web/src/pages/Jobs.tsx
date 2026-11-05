import { useQuery } from '@tanstack/react-query';
import { Card, Space, Table, Tag } from 'antd';
import { Link } from 'react-router-dom';
import { api, type JobSummary } from '../api/client';
import { JobStatusTag, PlanStateTag } from '../components/StatusTag';

export default function JobsPage() {
  const jobs = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api<JobSummary[]>('/api/jobs'),
    refetchInterval: 5000,
  });

  return (
    <Card title="Storico: simulazioni ed esecuzioni">
      <Table<JobSummary>
        rowKey="id"
        loading={jobs.isLoading}
        dataSource={jobs.data}
        columns={[
          {
            title: 'Data',
            dataIndex: 'createdAt',
            render: (v: string, j) => <Link to={`/jobs/${j.id}`}>{new Date(v).toLocaleString('it-IT')}</Link>,
          },
          {
            title: 'Tipo',
            dataIndex: 'mode',
            render: (m: string) => (m === 'PLAN' ? <Tag>Simulazione</Tag> : <Tag color="red">Esecuzione</Tag>),
          },
          { title: 'Da', dataIndex: 'sourceName' },
          {
            title: 'A',
            dataIndex: 'targetName',
            render: (t: string, j) => (
              <Space size={4}>
                {t}
                {j.targetRequireApproval && <Tag color="purple">protetto</Tag>}
              </Space>
            ),
          },
          {
            title: 'Modifiche',
            render: (_, j) =>
              j.planSummary ? (
                <Space size={4}>
                  <Tag color="green">+{j.planSummary.add}</Tag>
                  <Tag color="blue">~{j.planSummary.change}</Tag>
                  {j.planSummary.destroy + j.planSummary.replace > 0 && (
                    <Tag color="red">-{j.planSummary.destroy + j.planSummary.replace}</Tag>
                  )}
                </Space>
              ) : null,
          },
          { title: 'Utente', dataIndex: 'createdBy' },
          { title: 'Approvato da', dataIndex: 'approvedBy', render: (a?: string) => a ?? '' },
          {
            title: 'Stato',
            render: (_, j) => (j.plan ? <PlanStateTag state={j.plan.state} /> : <JobStatusTag status={j.status} />),
          },
        ]}
      />
    </Card>
  );
}
