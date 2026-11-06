import { Card, PageHeader } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { SalesPanel } from './SalesPanel';

export function MySales() {
  const { user } = useAuth();
  return (
    <div>
      <PageHeader eyebrow="My space" title="My sales" subtitle="Sales credited to you and the incentive they earn this month" />
      <Card className="p-5">
        <SalesPanel sipId={user!.sipId!} />
      </Card>
    </div>
  );
}
