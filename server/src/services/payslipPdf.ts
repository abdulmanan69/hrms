/**
 * Payslip PDFs are generated on request from the payslip records and never
 * stored: the database already holds every figure (payslip, lines, frozen
 * snapshot), so a PDF is just a rendering of them. Re-downloading the same
 * payslip always gives the same figures.
 *
 * Layout follows the app's payslip view: a ruled ledger with A + B − C and a
 * double rule under the net. Built-in Helvetica keeps the file small (no
 * embedded fonts); only WinAnsi characters are used.
 */
import PDFDocument from 'pdfkit';

export interface PayslipPdfData {
  periodMonth: string;
  runStatus: string;
  paidAt: Date | string | null;
  sipId: string;
  company: string;
  name: string;
  departmentName: string | null;
  designationTitle: string | null;
  employmentStatus: string;
  dateOfJoining: string;
  bankName: string | null;
  accountNo: string | null;
  cnic: string | null;
  basis: 'calendar' | 'working';
  daysOfMonth: number;
  periods: Array<{ from: string; to: string; monthlyGross: number; paidDays: number }>;
  currentSalaryDays: number;
  newSalaryDays: number;
  notJoinedDays: number;
  unpaidDays: number;
  grossA: number;
  totalAdditionsB: number;
  totalDeductionsC: number;
  netTotal: number;
  lines: Array<{ section: 'A' | 'B' | 'C'; component: string; amount: number }>;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT = MONTHS.map((m) => m.slice(0, 3));

const INK = '#171717';
const INK2 = '#525252';
const INK3 = '#737373';
const LINE = '#e5e5e5';
const BRAND = '#3B4A9F';

const pkr = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 });
const money = (n: number) => pkr.format(Math.round(n));
const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const day = (iso: string) => `${SHORT[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
const dayShort = (iso: string) => `${SHORT[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
const label = (v: string) => (v ? v.charAt(0).toUpperCase() + v.slice(1).replace(/_/g, ' ') : '-');

/** Amount in words, Pakistani style (thousand, lakh, crore). */
export function amountInWords(n: number): string {
  const ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const two = (x: number) => (x < 20 ? ones[x] : `${tens[Math.floor(x / 10)]}${x % 10 ? `-${ones[x % 10]}` : ''}`);
  const three = (x: number) => [x >= 100 ? `${ones[Math.floor(x / 100)]} hundred` : '', two(x % 100)].filter(Boolean).join(' ');
  let v = Math.round(Math.abs(n));
  if (v === 0) return 'Zero rupees';
  const parts: string[] = [];
  const crore = Math.floor(v / 10_000_000);
  v %= 10_000_000;
  const lakh = Math.floor(v / 100_000);
  v %= 100_000;
  const thousand = Math.floor(v / 1000);
  v %= 1000;
  if (crore) parts.push(`${three(crore)} crore`);
  if (lakh) parts.push(`${two(lakh)} lakh`);
  if (thousand) parts.push(`${two(thousand)} thousand`);
  if (v) parts.push(three(v));
  const s = parts.join(' ');
  return `${s.charAt(0).toUpperCase()}${s.slice(1)} rupees only`;
}

function drawPayslip(doc: PDFKit.PDFDocument, p: PayslipPdfData): void {
  const L = 56;
  const R = doc.page.width - 56;
  const W = R - L;
  let y = 56;

  const text = (s: string, x: number, yy: number, o: { size?: number; color?: string; font?: string; width?: number; align?: 'left' | 'right' | 'center' } = {}) => {
    doc
      .font(o.font ?? 'Helvetica')
      .fontSize(o.size ?? 9)
      .fillColor(o.color ?? INK)
      .text(s, x, yy, { width: o.width, align: o.align ?? 'left', lineBreak: false });
  };
  const rule = (yy: number, color = LINE, w = 0.75) => doc.moveTo(L, yy).lineTo(R, yy).lineWidth(w).strokeColor(color).stroke();

  // header
  text(p.company, L, y, { size: 15, font: 'Helvetica-Bold' });
  text(`Payslip for ${monthLabel(p.periodMonth)}`, L, y + 21, { size: 10, color: INK2 });
  const status = p.runStatus === 'paid' ? 'Paid' : p.runStatus === 'approved' ? 'Approved' : 'Draft';
  text(status, R - 160, y + 2, { size: 9, color: p.runStatus === 'draft' ? '#9A5B0B' : BRAND, width: 160, align: 'right', font: 'Helvetica-Bold' });
  if (p.paidAt) {
    const d = typeof p.paidAt === 'string' ? p.paidAt.slice(0, 10) : p.paidAt.toISOString().slice(0, 10);
    text(`Paid ${day(d)}`, R - 160, y + 21, { size: 9, color: INK3, width: 160, align: 'right' });
  }
  y += 48;
  rule(y);
  y += 16;

  // employee details, three columns
  const fields: Array<[string, string]> = [
    ['Employee', p.name],
    ['SIP ID', p.sipId],
    ['Designation', p.designationTitle ?? '-'],
    ['Department', p.departmentName ?? '-'],
    ['Employment', label(p.employmentStatus)],
    ['Joined', day(p.dateOfJoining)],
    ...(p.cnic ? ([['CNIC', p.cnic]] as Array<[string, string]>) : []),
    ['Bank', p.bankName ?? '-'],
    ['Account', p.accountNo ?? '-'],
  ];
  const colW = W / 3;
  fields.forEach(([k, v], i) => {
    const cx = L + (i % 3) * colW;
    const cy = y + Math.floor(i / 3) * 34;
    text(k, cx, cy, { size: 8, color: INK3 });
    text(v, cx, cy + 12, { size: 9.5, width: colW - 12, font: ['SIP ID', 'CNIC', 'Account'].includes(k) ? 'Courier' : 'Helvetica' });
  });
  y += Math.ceil(fields.length / 3) * 34 + 6;
  rule(y);
  y += 14;

  // days
  const paid = p.currentSalaryDays + p.newSalaryDays;
  const dayCols: Array<[string, string]> = [
    [p.basis === 'working' ? 'Working days' : 'Days in month', num(p.daysOfMonth)],
    ['Paid days', num(paid)],
    ['Unpaid leave', num(p.unpaidDays)],
    ['Before joining', num(p.notJoinedDays)],
  ];
  dayCols.forEach(([k, v], i) => {
    const cx = L + i * (W / 4);
    text(k, cx, y, { size: 8, color: INK3 });
    text(v, cx, y + 12, { size: 9.5, font: 'Courier' });
  });
  y += 34;

  // rate periods, only when there is more than one (increment) or a partial month
  if (p.periods.length > 1 || p.notJoinedDays > 0 || p.unpaidDays > 0) {
    rule(y);
    y += 12;
    text('Rate periods', L, y, { size: 8, color: INK3 });
    y += 14;
    for (const per of p.periods) {
      text(`${dayShort(per.from)} - ${dayShort(per.to)}`, L, y, { size: 9 });
      text(`${money(per.monthlyGross)} a month`, L + 200, y, { size: 9, color: INK2 });
      text(`${num(per.paidDays)} paid days`, R - 120, y, { size: 9, width: 120, align: 'right', font: 'Courier' });
      y += 15;
    }
    y += 2;
  }
  rule(y);
  y += 18;

  // ledger: A and B on the left, C on the right
  const half = (W - 32) / 2;
  const section = (key: 'A' | 'B' | 'C', title: string, sign: string, total: number, x: number, startY: number) => {
    let yy = startY;
    text(key, x, yy + 1, { size: 8, color: INK3, font: 'Courier' });
    text(title, x + 16, yy, { size: 10, font: 'Helvetica-Bold' });
    text(`${sign}${money(total)}`, x, yy, { size: 10, width: half, align: 'right', font: 'Courier-Bold' });
    yy += 16;
    doc.moveTo(x, yy).lineTo(x + half, yy).lineWidth(0.5).strokeColor(LINE).stroke();
    yy += 7;
    const items = p.lines.filter((l) => l.section === key);
    if (items.length === 0) {
      text(key === 'B' ? 'No additions' : 'None', x + 16, yy, { size: 9, color: INK3 });
      yy += 14;
    }
    for (const l of items) {
      text(l.component, x + 16, yy, { size: 9, color: INK2, width: half - 110 });
      text(money(l.amount), x, yy, { size: 9, width: half, align: 'right', font: 'Courier' });
      yy += 14;
    }
    return yy + 10;
  };
  const leftEnd = section('B', 'Additions', '+ ', p.totalAdditionsB, L, section('A', 'Gross earned', '', p.grossA, L, y));
  const rightEnd = section('C', 'Deductions', '- ', p.totalDeductionsC, L + half + 32, y);
  y = Math.max(leftEnd, rightEnd) + 4;

  // net with a double rule, like the bottom of a salary sheet
  rule(y, '#bdbdbd', 0.75);
  rule(y + 2.5, '#bdbdbd', 0.75);
  y += 14;
  text('=', L, y + 2, { size: 9, color: INK3, font: 'Courier' });
  text('Net pay, PKR', L + 16, y, { size: 12, font: 'Helvetica-Bold' });
  text(money(p.netTotal), L, y - 1, { size: 14, width: W, align: 'right', font: 'Courier-Bold', color: BRAND });
  y += 22;
  text(amountInWords(p.netTotal), L + 16, y, { size: 9, color: INK2 });
  y += 14;
  rule(y, '#bdbdbd', 0.75);
  rule(y + 2.5, '#bdbdbd', 0.75);
  y += 22;
  text(`A + B - C = ${money(p.grossA)} + ${money(p.totalAdditionsB)} - ${money(p.totalDeductionsC)} = ${money(p.netTotal)}`, L, y, { size: 8.5, color: INK3, font: 'Courier' });

  // footer
  const fy = doc.page.height - 56;
  doc.moveTo(L, fy - 10).lineTo(R, fy - 10).lineWidth(0.5).strokeColor(LINE).stroke();
  text('Computer-generated payslip from payroll records. No signature required.', L, fy, { size: 7.5, color: INK3 });
  text(`${p.company} HRMS`, R - 200, fy, { size: 7.5, color: INK3, width: 200, align: 'right' });
}

/** One PDF with a page per payslip. */
export function renderPayslipsPdf(slips: PayslipPdfData[], title: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 0,
      compress: true,
      autoFirstPage: false,
      info: { Title: title, Author: slips[0]?.company ?? 'HRMS', Creator: 'WaveTech HRMS' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    for (const s of slips) {
      doc.addPage();
      drawPayslip(doc, s);
    }
    doc.end();
  });
}
