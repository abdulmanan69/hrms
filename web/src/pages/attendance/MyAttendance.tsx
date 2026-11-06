import { Card, PageHeader } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { AttendancePanel } from './AttendancePanel';

export function MyAttendance() {
  const { user } = useAuth();
  return (
    <div>
      <PageHeader eyebrow="My space" title="My attendance" subtitle="Your shift days from the dialer: first and last call, late and absent days" />
      <Card className="p-5">
        <AttendancePanel sipId={user!.sipId!} />
      </Card>
    </div>
  );
}
