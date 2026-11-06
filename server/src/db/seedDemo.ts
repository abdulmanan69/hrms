/**
 * Sample data for local use and demos (SEED_DEMO=true, empty database only).
 * Everything here goes through the same services the app uses, so balances,
 * SIP IDs and payslips reconcile exactly as they would in real use.
 *
 * Sign-ins created (password: Demo1234!), for each demo company domain
 * (wavetech.pk, northwind.pk):
 *   admin@northwind.pk     HR admin of Northwind (WaveTech uses ADMIN_EMAIL)
 *   finance@<domain>       Payroll and finance
 *   recruiter@<domain>     Recruiter
 *   manager@<domain>       Manager (Sales team lead, linked to an employee)
 *   employee@<domain>      Employee self-service (linked)
 *   consultant@hrpartners.pk  Finance in both companies: sign-in asks which one
 */
import { eq } from 'drizzle-orm';
import { hashPassword } from '../lib/crypto.js';
import { addDays, todayISO, workingDaysBetween } from '../lib/dates.js';
import { createEmployee } from '../services/employees.js';
import { appendLedger, balanceOf } from '../services/leaveLedger.js';
import { db, rootDb, runInCompany, type Tx } from './client.js';
import { setupCompany } from '../services/companySetup.js';
import {
  applications,
  candidates,
  companies,
  communications,
  departments,
  designations,
  employees,
  interviews,
  leaveApplications,
  leaveTypes,
  loansAdvances,
  roles,
  salaryStructures,
  stageHistory,
  users,
  type PipelineStage,
} from './schema.js';
import { seedDemoPayroll } from './seedDemoPayroll.js';

/** Small deterministic PRNG so every demo database looks the same. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const rand = rng(20261106);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
const between = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));

const FIRST_M = ['Usman', 'Faisal', 'Bilal', 'Hamza', 'Zain', 'Saad', 'Imran', 'Kamran', 'Danish', 'Ali', 'Omer', 'Hassan', 'Raza', 'Asad', 'Tariq', 'Waqas', 'Junaid', 'Shahzad', 'Fahad', 'Adeel'];
const FIRST_F = ['Hira', 'Areeba', 'Sana', 'Ayesha', 'Nida', 'Mahnoor', 'Fatima', 'Zara', 'Mariam', 'Amna', 'Sadia', 'Rabia', 'Iqra', 'Komal', 'Saba'];
const LAST = ['Siddiqui', 'Tariq', 'Khalid', 'Mehmood', 'Javed', 'Raza', 'Farooq', 'Qureshi', 'Hussain', 'Abbas', 'Shah', 'Iqbal', 'Ali', 'Malik', 'Butt', 'Chaudhry', 'Sheikh', 'Akhtar', 'Aslam', 'Rana'];
const CITIES = ['Lahore', 'Karachi', 'Islamabad', 'Rawalpindi', 'Faisalabad'];
const BANKS = ['Meezan Bank', 'HBL', 'UBL', 'Allied Bank', 'Bank Alfalah', 'MCB'];

/** Monthly gross by designation (PKR). */
const PAY: Record<string, [number, number]> = {
  'Sales Associate': [55_000, 70_000],
  'Senior Sales Associate': [75_000, 95_000],
  'Team Lead, Sales': [120_000, 150_000],
  'Operations Executive': [60_000, 80_000],
  'Operations Manager': [170_000, 210_000],
  'QA Analyst': [60_000, 75_000],
  'QA Lead': [110_000, 135_000],
  'HR Officer': [70_000, 90_000],
  Recruiter: [65_000, 85_000],
  'HR Manager': [180_000, 220_000],
  Accountant: [80_000, 100_000],
  'Payroll Officer': [85_000, 105_000],
  'Finance Manager': [200_000, 240_000],
  'IT Support Engineer': [70_000, 90_000],
  'Software Engineer': [150_000, 220_000],
  'IT Manager': [250_000, 300_000],
};

/** Head count per designation; leads are created first and manage their department. */
const PLAN: Array<[string, number]> = [
  ['Team Lead, Sales', 2],
  ['Operations Manager', 1],
  ['QA Lead', 1],
  ['HR Manager', 1],
  ['Finance Manager', 1],
  ['IT Manager', 1],
  ['Sales Associate', 14],
  ['Senior Sales Associate', 5],
  ['Operations Executive', 5],
  ['QA Analyst', 4],
  ['HR Officer', 2],
  ['Recruiter', 1],
  ['Accountant', 1],
  ['Payroll Officer', 1],
  ['IT Support Engineer', 2],
  ['Software Engineer', 2],
];
const LEADS = new Set(['Team Lead, Sales', 'Operations Manager', 'QA Lead', 'HR Manager', 'Finance Manager', 'IT Manager']);

function cnic(): string {
  const d = (n: number) => Array.from({ length: n }, () => between(0, 9)).join('');
  return `3${d(4)}-${d(7)}-${between(1, 9)}`;
}

/** Splits a gross into the usual components; the remainder lands on basic. */
function components(gross: number) {
  const house = Math.round(gross * 0.3);
  const medical = Math.round(gross * 0.06);
  const petrol = gross >= 100_000 ? 8_000 : 4_000;
  return { basicSalary: gross - house - medical - petrol, houseRent: house, medicalAllowance: medical, petrolAllowance: petrol, otherAllowance: 0, grossSalary: gross };
}

function roundTo(n: number, step: number) {
  return Math.round(n / step) * step;
}

/** Per-company demo options; set by seedDemo before each company is loaded. */
let D = { domain: 'wavetech.pk', scale: 1, months: 12 };

/** staff[i], wrapping for the smaller demo company */
const at = <T,>(xs: T[], i: number): T => xs[i % xs.length];

/**
 * Two demo companies, to show that each one sees only its own people:
 * WaveTech (larger, 12 months of payroll) and Northwind Contact Center.
 * consultant@hrpartners.pk has an account in both: sign-in asks which one.
 */
export async function seedDemo(firstCompanyId: number): Promise<void> {
  D = { domain: 'wavetech.pk', scale: 1, months: 12 };
  await runInCompany(firstCompanyId, () => seedCompanyDemo());

  const [nw] = await rootDb
    .insert(companies)
    .values({ name: 'Northwind Contact Center', slug: 'northwind' })
    .onConflictDoNothing()
    .returning();
  if (nw) {
    D = { domain: 'northwind.pk', scale: 0.3, months: 4 };
    await runInCompany(nw.id, async () => {
      await setupCompany(nw.name);
      await seedCompanyDemo();
    });
  }
}

async function seedCompanyDemo(): Promise<void> {
  console.log(`Loading demo data for ${D.domain}`);
  const today = todayISO();
  const year = Number(today.slice(0, 4));
  const actor = { userId: null };

  await db.transaction(async (tx) => {
    const depts = await tx.select().from(departments);
    const desigs = await tx.select().from(designations);

    const staff: Array<{ sipId: string; title: string; departmentId: number; gross: number; joined: string; gender: string }> = [];
    const leadOf = new Map<number, string[]>(); // department → lead SIP IDs

    let n = 0;
    for (const [title, planned] of PLAN) {
      const howMany = LEADS.has(title) ? planned : Math.max(1, Math.round(planned * D.scale));
      const des = desigs.find((d) => d.title === title)!;
      for (let i = 0; i < howMany; i++) {
        n++;
        const female = rand() < 0.38;
        const first = female ? pick(FIRST_F) : pick(FIRST_M);
        const last = pick(LAST);
        // leads joined early; most staff over the last three years; a few this year
        const joinYear = LEADS.has(title) ? year - between(3, 5) : rand() < 0.2 ? year : year - between(1, 3);
        const joinMonth = joinYear === year ? between(1, Math.max(1, Number(today.slice(5, 7)) - 1)) : between(1, 12);
        const joined = `${joinYear}-${String(joinMonth).padStart(2, '0')}-${String(between(1, 25)).padStart(2, '0')}`;
        const leads = leadOf.get(des.departmentId!) ?? [];
        const [lo, hi] = PAY[title];
        const emp = await createEmployee(
          tx,
          {
            firstName: first,
            middleInitial: rand() < 0.3 ? pick(['A', 'M', 'R', 'S', 'K']) : null,
            lastName: last,
            cnic: cnic(),
            email: `${first}.${last}${n}@${D.domain}`.toLowerCase(),
            phone: `+92 3${between(0, 4)}${between(0, 9)} ${between(1000000, 9999999)}`,
            address1: `House ${between(1, 400)}, Street ${between(1, 40)}`,
            city: pick(CITIES),
            country: 'Pakistan',
            postalCode: String(between(10000, 79999)).padStart(5, '0'),
            gender: female ? 'Female' : 'Male',
            dateOfBirth: `${between(1980, 2002)}-${String(between(1, 12)).padStart(2, '0')}-${String(between(1, 28)).padStart(2, '0')}`,
            departmentId: des.departmentId,
            designationId: des.id,
            managerSipId: LEADS.has(title) ? null : leads.length ? pick(leads) : null,
            employmentStatus: joinYear >= year ? 'probation' : rand() < 0.15 ? 'contractual' : 'permanent',
            dateOfJoining: joined,
            bankName: pick(BANKS),
            accountNo: `PK${between(10, 99)}${pick(['MEZN', 'HABB', 'UNIL', 'ABPA', 'ALFH', 'MUCB'])}${String(between(10 ** 9, 10 ** 10 - 1))}${between(100000, 999999)}`,
          },
          actor,
        );
        if (LEADS.has(title)) leadOf.set(des.departmentId!, [...leads, emp.sipId]);
        staff.push({ sipId: emp.sipId, title, departmentId: des.departmentId!, gross: roundTo(between(lo, hi), 500), joined, gender: female ? 'Female' : 'Male' });
      }
    }

    // documents are not part of demo data: mark everyone active except three recent hires
    await tx.update(employees).set({ status: 'active' });
    await tx.update(employees).set({ status: 'inactive', deactivatedAt: new Date(`${year}-0${between(2, 8)}-15T09:00:00Z`) }).where(eq(employees.sipId, at(staff, 12).sipId));

    // salary structures: one row from joining; some got a raise this year, two get a mid-month raise last month
    const lastMonth = new Date(Date.UTC(year, Number(today.slice(5, 7)) - 2, 16)).toISOString().slice(0, 10);
    for (const [i, s] of staff.entries()) {
      const firstRate = roundTo(s.gross * 0.88, 500);
      const raised = rand() < 0.35 || i === 7 || i === 9;
      await tx.insert(salaryStructures).values({ sipId: s.sipId, effectiveFrom: s.joined, ...components(raised ? firstRate : s.gross), note: 'Joining salary' });
      if (raised) {
        const effective = i === 7 || i === 9 ? lastMonth : `${year}-0${between(1, 6)}-01`;
        if (effective > s.joined) {
          await tx.insert(salaryStructures).values({ sipId: s.sipId, effectiveFrom: effective, ...components(s.gross), note: 'Annual increment' });
        }
      }
    }

    // three hires waiting for documents (pending, joined this month)
    const newHires = [
      { firstName: 'Danish', lastName: 'Ali', missing: 'cnic' },
      { firstName: 'Mahnoor', lastName: 'Iqbal', missing: 'contract' },
      { firstName: 'Kamran', lastName: 'Shah', missing: 'both' },
    ];
    const sales = desigs.find((d) => d.title === 'Sales Associate')!;
    const salesLead = leadOf.get(sales.departmentId!)?.[0] ?? null;
    for (const h of newHires) {
      const emp = await createEmployee(
        tx,
        {
          firstName: h.firstName,
          lastName: h.lastName,
          cnic: h.missing === 'cnic' ? null : cnic(),
          phone: `+92 30${between(0, 9)} ${between(1000000, 9999999)}`,
          email: `${h.firstName}.${h.lastName}@${D.domain}`.toLowerCase(),
          city: 'Lahore',
          country: 'Pakistan',
          departmentId: sales.departmentId,
          designationId: sales.id,
          managerSipId: salesLead,
          employmentStatus: 'probation',
          dateOfJoining: addDays(today, -between(1, 4)),
          bankName: pick(BANKS),
        },
        actor,
      );
      await tx.insert(salaryStructures).values({ sipId: emp.sipId, effectiveFrom: emp.dateOfJoining, ...components(60_000), note: 'Joining salary' });
    }

    // loans and advances
    for (const s of [at(staff, 15), at(staff, 22)]) {
      await tx.insert(loansAdvances).values({
        sipId: s.sipId,
        entryType: 'loan',
        amount: 60_000,
        installment: 5_000,
        entryDate: `${year}-0${between(2, 5)}-05`,
        note: 'Personal loan',
        balanceAfter: 60_000,
      });
    }
    await tx.insert(loansAdvances).values({ sipId: at(staff, 30).sipId, entryType: 'advance', amount: 20_000, installment: 10_000, entryDate: addDays(today, -20), note: 'Salary advance', balanceAfter: 20_000 });

    await seedUsers(tx, staff[0].sipId, at(staff, 8).sipId);
    await seedLeave(tx, today);
    await seedRecruitment(tx, today, depts.find((d) => d.name === 'Sales')!.id);
    console.log(`Demo data: ${staff.length + newHires.length} employees`);
  });

  // payroll history uses the real engine, one run per month
  await seedDemoPayroll(D.months);
}

async function seedUsers(tx: Tx, managerSip: string, employeeSip: string): Promise<void> {
  const roleId = async (name: string) => (await tx.select().from(roles).where(eq(roles.name, name)))[0].id;
  const passwordHash = await hashPassword('Demo1234!');
  const nameOf = async (sip: string) => {
    const [e] = await tx.select().from(employees).where(eq(employees.sipId, sip));
    return `${e.firstName} ${e.lastName}`;
  };
  await tx.insert(users).values([
    ...(D.domain === 'wavetech.pk' ? [] : [{ email: `admin@${D.domain}`, name: 'HR admin', roleId: await roleId('admin'), passwordHash }]),
    { email: 'consultant@hrpartners.pk', name: 'Bilal Consultant', roleId: await roleId('finance'), passwordHash },
    { email: `finance@${D.domain}`, name: D.domain === 'wavetech.pk' ? 'Saad Hussain' : 'Rabia Akhtar', roleId: await roleId('finance'), passwordHash },
    { email: `recruiter@${D.domain}`, name: D.domain === 'wavetech.pk' ? 'Ayesha Raza' : 'Omer Malik', roleId: await roleId('recruiter'), passwordHash },
    { email: `manager@${D.domain}`, name: await nameOf(managerSip), roleId: await roleId('manager'), sipId: managerSip, passwordHash },
    { email: `employee@${D.domain}`, name: await nameOf(employeeSip), roleId: await roleId('employee'), sipId: employeeSip, passwordHash },
  ]);
}

async function seedLeave(tx: Tx, today: string): Promise<void> {
  const types = await tx.select().from(leaveTypes);
  const t = (name: string) => types.find((x) => x.name === name)!;
  const staff = await tx.select({ sipId: employees.sipId }).from(employees).where(eq(employees.status, 'active'));
  const approver = (await tx.select({ id: users.id }).from(users).where(eq(users.email, `manager@${D.domain}`)))[0]?.id ?? null;
  const weekend = [0, 6];

  // next working day on or after d
  const work = (d: string) => {
    let x = d;
    while (weekend.includes(new Date(`${x}T00:00:00Z`).getUTCDay())) x = addDays(x, 1);
    return x;
  };

  const plans: Array<{ type: string; startOffset: number; len: number; status: 'approved' | 'pending' | 'rejected'; reason: string }> = [
    { type: 'Casual', startOffset: -40, len: 2, status: 'approved', reason: 'Family wedding' },
    { type: 'Sick', startOffset: -25, len: 1, status: 'approved', reason: 'Fever' },
    { type: 'Vacation', startOffset: -18, len: 5, status: 'approved', reason: 'Trip to the northern areas' },
    { type: 'Unpaid', startOffset: -30, len: 3, status: 'approved', reason: 'Personal matter' },
    { type: 'Casual', startOffset: 0, len: 1, status: 'approved', reason: 'Bank work' },
    { type: 'Sick', startOffset: -1, len: 2, status: 'approved', reason: 'Flu' },
    { type: 'Unpaid', startOffset: 0, len: 2, status: 'approved', reason: 'Exam preparation' },
    { type: 'Casual', startOffset: 4, len: 2, status: 'pending', reason: 'Moving house' },
    { type: 'Vacation', startOffset: 11, len: 5, status: 'pending', reason: 'Family visit to Karachi' },
    { type: 'Unpaid', startOffset: 6, len: 3, status: 'pending', reason: 'Extended family event' },
    { type: 'Sick', startOffset: 1, len: 1, status: 'pending', reason: 'Dentist appointment' },
    { type: 'Casual', startOffset: 7, len: 1, status: 'pending', reason: 'Child school meeting' },
    { type: 'Vacation', startOffset: -60, len: 3, status: 'rejected', reason: 'Short break' },
  ];

  for (const [i, p] of plans.entries()) {
    const sipId = staff[(i * 7 + 3) % staff.length].sipId;
    const startDate = work(addDays(today, p.startOffset));
    let endDate = startDate;
    while (workingDaysBetween(startDate, endDate, weekend) < p.len) endDate = addDays(endDate, 1);
    const type = t(p.type);
    const total = workingDaysBetween(startDate, endDate, weekend);
    const balance = type.isPaid ? await balanceOf(tx, sipId, type.id) : 0;
    const unpaid = type.isPaid ? Math.max(0, total - balance) : total;
    const sentOn = p.status === 'pending' ? addDays(today, -((i % 4) + 1)) : addDays(startDate, -between(3, 10));
    const createdAt = new Date(`${sentOn < today ? sentOn : addDays(today, -1)}T0${between(5, 9)}:${between(10, 59)}:00Z`);
    const [app] = await tx
      .insert(leaveApplications)
      .values({
        sipId,
        leaveTypeId: type.id,
        startDate,
        endDate,
        totalDays: total,
        unpaidDays: unpaid,
        reason: p.reason,
        status: p.status,
        approverId: p.status === 'pending' ? null : approver,
        decidedAt: p.status === 'pending' ? null : new Date(createdAt.getTime() + 86_400_000),
        decisionComment: p.status === 'rejected' ? 'Peak week for the team, please pick other dates' : null,
        createdAt,
      })
      .returning();
    if (p.status === 'approved' && type.isPaid && total - unpaid > 0) {
      await appendLedger(tx, {
        sipId,
        leaveTypeId: type.id,
        entryType: 'application',
        days: -(total - unpaid),
        entryDate: startDate,
        reference: `leave_application:${app.id}`,
        note: `${p.type} leave ${startDate} to ${endDate}`,
      });
    }
  }
}

async function seedRecruitment(tx: Tx, today: string, salesDeptId: number): Promise<void> {
  const recruiter = (await tx.select({ id: users.id }).from(users).where(eq(users.email, `recruiter@${D.domain}`)))[0]?.id ?? null;
  const positions = ['Sales Associate', 'Sales Associate', 'Sales Associate', 'QA Analyst', 'Operations Executive', 'Software Engineer'];
  const sources = ['Rozee.pk', 'LinkedIn', 'Referral', 'Walk-in', 'Facebook jobs', 'Indeed'];
  const STAGES: PipelineStage[] = [
    'application_received',
    'screening',
    'interview_scheduled',
    'interview_completed',
    'feedback_received',
    'offer_made',
    'offer_accepted',
  ];
  const counts = [14, 11, 7, 4, 3, 2, 1].map((c) => Math.max(1, Math.round(c * D.scale)));
  const statusOf: Record<string, 'pending' | 'screening' | 'interviewed' | 'offered'> = {
    application_received: 'pending',
    screening: 'screening',
    interview_scheduled: 'interviewed',
    interview_completed: 'interviewed',
    feedback_received: 'interviewed',
    offer_made: 'offered',
    offer_accepted: 'offered',
  };

  for (const [si, stage] of STAGES.entries()) {
    for (let i = 0; i < counts[si]; i++) {
      const female = rand() < 0.4;
      const first = female ? pick(FIRST_F) : pick(FIRST_M);
      const last = pick(LAST);
      const applied = addDays(today, -between(si * 3 + 1, si * 5 + 12));
      const [c] = await tx
        .insert(candidates)
        .values({
          firstName: first,
          lastName: last,
          email: `${first}.${last}.${si}${i}@gmail.com`.toLowerCase(),
          phone: `+92 3${between(0, 4)}${between(0, 9)} ${between(1000000, 9999999)}`,
          city: pick(CITIES),
          country: 'Pakistan',
          gender: female ? 'Female' : 'Male',
          source: pick(sources),
          createdBy: recruiter,
          createdAt: new Date(`${applied}T10:00:00Z`),
        })
        .returning();
      const position = pick(positions);
      const [a] = await tx
        .insert(applications)
        .values({
          candidateId: c.id,
          positionApplied: position,
          departmentId: position.startsWith('Sales') ? salesDeptId : null,
          applicationDate: applied,
          status: statusOf[stage],
          currentStage: stage,
          ownerRecruiterId: recruiter,
          nextFollowupDate: rand() < 0.3 ? addDays(today, between(-2, 5)) : null,
          createdAt: new Date(`${applied}T10:00:00Z`),
          updatedAt: new Date(`${addDays(applied, si * 2)}T10:00:00Z`),
        })
        .returning();
      // walk the history up to the current stage
      let prev: PipelineStage | null = null;
      for (let k = 0; k <= si; k++) {
        await tx.insert(stageHistory).values({
          applicationId: a.id,
          fromStage: prev,
          toStage: STAGES[k],
          userId: recruiter,
          createdAt: new Date(`${addDays(applied, k * 2)}T11:00:00Z`),
        });
        prev = STAGES[k];
      }
      if (si >= 2) {
        const when = si === 2 ? addDays(today, between(1, 6)) : addDays(applied, 5);
        await tx.insert(interviews).values({
          applicationId: a.id,
          scheduledAt: new Date(`${when}T${String(between(10, 16)).padStart(2, '0')}:00:00+05:00`),
          interviewerIds: recruiter ? [recruiter] : [],
          mode: pick(['phone', 'online', 'in_person'] as const),
          outcome: si >= 3 ? pick(['positive', 'positive', 'neutral'] as const) : null,
          rating: si >= 3 ? between(3, 5) : null,
          feedbackNotes: si >= 3 ? 'Clear communication, good product sense' : null,
          createdBy: recruiter,
        });
      }
      if (rand() < 0.5) {
        await tx.insert(communications).values({
          candidateId: c.id,
          channel: pick(['email', 'whatsapp', 'call'] as const),
          direction: 'outbound',
          subject: stage === 'application_received' ? 'Application received' : 'Next steps',
          summary: 'Shared the timeline and confirmed availability',
          occurredAt: new Date(`${addDays(applied, 1)}T12:00:00Z`),
          userId: recruiter,
        });
      }
    }
  }
}
