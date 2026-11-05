import { useNavigate, useParams } from 'react-router-dom';
import JobView from '../components/JobView';

export default function JobDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  if (!id) return null;
  return <JobView key={id} id={id} onApplied={(applyId) => navigate(`/jobs/${applyId}`)} />;
}
