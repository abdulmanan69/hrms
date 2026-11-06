import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import { Card, CardHead, EmptyState, ErrorState, Field, FormError, ICON, Loading, Modal, PageHeader, StatusTag, toast } from '../../components/ui';
import { empKeys, employeesApi, type Department, type Designation } from '../../api/employees';
import { useInvalidateEmployees } from './parts';

export function Departments() {
  const depts = useQuery({ queryKey: empKeys.departments, queryFn: employeesApi.departments });
  const desigs = useQuery({ queryKey: empKeys.designations, queryFn: employeesApi.designations });

  return (
    <div className="rise">
      <PageHeader title="Departments and designations" subtitle="The lists used on employee records, payroll and leave. Retired entries stay on existing records" />
      <div className="grid gap-4 xl:grid-cols-2">
        {depts.isLoading ? (
          <Loading />
        ) : depts.error ? (
          <ErrorState message={depts.error.message} onRetry={() => depts.refetch()} />
        ) : (
          <DepartmentsCard rows={depts.data?.data ?? []} />
        )}
        {desigs.isLoading ? (
          <Loading />
        ) : desigs.error ? (
          <ErrorState message={desigs.error.message} onRetry={() => desigs.refetch()} />
        ) : (
          <DesignationsCard rows={desigs.data?.data ?? []} departments={depts.data?.data ?? []} />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function DepartmentsCard({ rows }: { rows: Department[] }) {
  const invalidate = useInvalidateEmployees();
  const [editing, setEditing] = useState<Department | 'new' | null>(null);
  const [name, setName] = useState('');
  const open = (d: Department | 'new') => {
    setEditing(d);
    setName(d === 'new' ? '' : d.name);
    save.reset();
  };
  const save = useMutation({
    mutationFn: () => (editing === 'new' ? employeesApi.createDepartment(name.trim()) : employeesApi.updateDepartment((editing as Department).id, { name: name.trim() })),
    onSuccess: () => {
      invalidate();
      toast(editing === 'new' ? `${name.trim()} added` : 'Department renamed');
      setEditing(null);
    },
  });
  const toggle = useMutation({
    mutationFn: (d: Department) => employeesApi.updateDepartment(d.id, { active: !d.active }),
    onSuccess: (d) => {
      invalidate();
      toast(d.active ? `${d.name} is back in use` : `${d.name} retired`);
    },
    onError: (e) => toast(e.message, 'bad'),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) save.mutate();
  };

  return (
    <Card className="overflow-hidden">
      <CardHead
        title="Departments"
        meta="Headcount counts active employees"
        actions={
          <button className="btn-secondary btn-sm" onClick={() => open('new')}>
            <Plus {...ICON} className="text-ink-3" />
            Add department
          </button>
        }
      />
      {rows.length === 0 ? (
        <EmptyState bare title="No departments yet" hint="Add one to start grouping employees" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th className="th">Name</th>
              <th className="th text-right">Headcount</th>
              <th className="th">Status</th>
              <th className="th" />
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id}>
                <td className="td font-medium">{d.name}</td>
                <td className="td num text-right">
                  <Link to={`/employees?departmentId=${d.id}&status=active`} className="transition-colors hover:text-brand">
                    {d.headcount}
                  </Link>
                </td>
                <td className="td">
                  <StatusTag value={d.active ? 'active' : 'inactive'} text={d.active ? 'In use' : 'Retired'} />
                </td>
                <td className="td">
                  <div className="flex justify-end gap-1">
                    <button className="icon-btn" onClick={() => open(d)} aria-label={`Rename ${d.name}`} title="Rename">
                      <Pencil {...ICON} />
                    </button>
                    <button className="btn-ghost btn-sm" disabled={toggle.isPending} onClick={() => toggle.mutate(d)}>
                      {d.active ? 'Retire' : 'Restore'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'Add department' : 'Rename department'}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button className="btn-primary" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
              {editing === 'new' ? 'Add department' : 'Save'}
            </button>
          </>
        }
      >
        <form onSubmit={submit} className="space-y-3">
          <Field label="Name" required>
            <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <FormError message={save.error?.message} />
        </form>
      </Modal>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function DesignationsCard({ rows, departments }: { rows: Designation[]; departments: Department[] }) {
  const invalidate = useInvalidateEmployees();
  const [editing, setEditing] = useState<Designation | 'new' | null>(null);
  const [title, setTitle] = useState('');
  const [deptId, setDeptId] = useState('');
  const [filter, setFilter] = useState('');
  const open = (d: Designation | 'new') => {
    setEditing(d);
    setTitle(d === 'new' ? '' : d.title);
    setDeptId(d === 'new' ? filter : d.departmentId == null ? '' : String(d.departmentId));
    save.reset();
  };
  const save = useMutation({
    mutationFn: () => {
      const departmentId = deptId ? Number(deptId) : null;
      return editing === 'new'
        ? employeesApi.createDesignation(title.trim(), departmentId)
        : employeesApi.updateDesignation((editing as Designation).id, { title: title.trim(), departmentId });
    },
    onSuccess: () => {
      invalidate();
      toast(editing === 'new' ? `${title.trim()} added` : 'Designation saved');
      setEditing(null);
    },
  });
  const toggle = useMutation({
    mutationFn: (d: Designation) => employeesApi.updateDesignation(d.id, { active: !d.active }),
    onSuccess: (d) => {
      invalidate();
      toast(d.active ? `${d.title} is back in use` : `${d.title} retired`);
    },
    onError: (e) => toast(e.message, 'bad'),
  });
  const shown = rows.filter((r) => !filter || String(r.departmentId) === filter);

  return (
    <Card className="overflow-hidden">
      <CardHead
        title="Designations"
        meta="A designation can belong to one department"
        actions={
          <>
            <select className="input h-8 w-44" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter by department">
              <option value="">All departments</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <button className="btn-secondary btn-sm" onClick={() => open('new')}>
              <Plus {...ICON} className="text-ink-3" />
              Add designation
            </button>
          </>
        }
      />
      {shown.length === 0 ? (
        <EmptyState bare title="No designations here" hint="Add a designation, then pick it on employee records" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th className="th">Title</th>
              <th className="th">Department</th>
              <th className="th">Status</th>
              <th className="th" />
            </tr>
          </thead>
          <tbody>
            {shown.map((d) => (
              <tr key={d.id}>
                <td className="td font-medium">{d.title}</td>
                <td className="td text-ink-2">{d.departmentName ?? 'Any department'}</td>
                <td className="td">
                  <StatusTag value={d.active ? 'active' : 'inactive'} text={d.active ? 'In use' : 'Retired'} />
                </td>
                <td className="td">
                  <div className="flex justify-end gap-1">
                    <button className="icon-btn" onClick={() => open(d)} aria-label={`Edit ${d.title}`} title="Rename or move">
                      <Pencil {...ICON} />
                    </button>
                    <button className="btn-ghost btn-sm" disabled={toggle.isPending} onClick={() => toggle.mutate(d)}>
                      {d.active ? 'Retire' : 'Restore'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'Add designation' : 'Rename or move designation'}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button className="btn-primary" disabled={!title.trim() || save.isPending} onClick={() => save.mutate()}>
              {editing === 'new' ? 'Add designation' : 'Save'}
            </button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) save.mutate();
          }}
          className="space-y-4"
        >
          <Field label="Title" required>
            <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Department" hint="Moving a designation does not change the department on existing records">
            <select className="input" value={deptId} onChange={(e) => setDeptId(e.target.value)}>
              <option value="">Any department</option>
              {departments
                .filter((d) => d.active || String(d.id) === deptId)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
            </select>
          </Field>
          <FormError message={save.error?.message} />
        </form>
      </Modal>
    </Card>
  );
}
